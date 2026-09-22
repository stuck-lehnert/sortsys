#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputPath = join(
  root,
  "sortsys-webapp-v2/app/generated/license-inventory.generated.json",
);
const checkOnly = process.argv.includes("--check");

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
}

function sortEntries(entries) {
  return entries.sort((left, right) =>
    left.name.localeCompare(right.name, "en")
    || left.version.localeCompare(right.version, "en")
    || left.ecosystem.localeCompare(right.ecosystem, "en"));
}

function deduplicate(entries) {
  const unique = new Map();

  for (const entry of entries) {
    unique.set(
      [entry.ecosystem, entry.name, entry.version].join("\0"),
      entry,
    );
  }

  return sortEntries([...unique.values()]);
}

function cargoLicenses(manifestPath) {
  const metadata = JSON.parse(run("cargo", [
    "metadata",
    "--manifest-path",
    manifestPath,
    "--format-version",
    "1",
    "--locked",
  ]));
  const packages = new Map(metadata.packages.map(pkg => [pkg.id, pkg]));
  const nodes = new Map((metadata.resolve?.nodes ?? []).map(node => [node.id, node]));
  const roots = new Set(metadata.workspace_members);
  const visited = new Set();
  const queue = [...roots];

  while (queue.length) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);

    const node = nodes.get(id);
    for (const dependency of node?.deps ?? []) {
      const isRuntimeDependency = dependency.dep_kinds.some(kind => kind.kind === null);
      if (isRuntimeDependency) queue.push(dependency.pkg);
    }
  }

  return deduplicate([...visited]
    .filter(id => !roots.has(id))
    .map(id => packages.get(id))
    .filter(Boolean)
    .map(pkg => ({
      ecosystem: "Rust",
      name: pkg.name,
      version: pkg.version,
      license: pkg.license ?? "UNKNOWN",
      source: pkg.repository
        ?? `https://crates.io/crates/${encodeURIComponent(pkg.name)}/${encodeURIComponent(pkg.version)}`,
    })));
}

function npmPackageName(packagePath) {
  const marker = "node_modules/";
  const index = packagePath.lastIndexOf(marker);
  return index === -1 ? null : packagePath.slice(index + marker.length);
}

function npmLicenses(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const entries = [];

  for (const [packagePath, pkg] of Object.entries(lock.packages ?? {})) {
    const name = npmPackageName(packagePath);
    if (!name || pkg.dev === true || pkg.link === true || !pkg.version) continue;

    entries.push({
      ecosystem: "npm",
      name,
      version: pkg.version,
      license: typeof pkg.license === "string" ? pkg.license : "UNKNOWN",
      source: `https://www.npmjs.com/package/${encodeURIComponent(name)}/v/${encodeURIComponent(pkg.version)}`,
    });
  }

  return deduplicate(entries);
}

function detectLicense(text) {
  if (/Apache License\s+Version 2\.0/i.test(text)) return "Apache-2.0";
  if (/MIT License/i.test(text) || /Permission is hereby granted, free of charge/i.test(text)) return "MIT";
  if (/Mozilla Public License\s+Version 2\.0/i.test(text)) return "MPL-2.0";
  if (/ISC License/i.test(text)) return "ISC";
  if (/Redistribution and use in source and binary forms/i.test(text)) {
    return /Neither the name/i.test(text) ? "BSD-3-Clause" : "BSD-2-Clause";
  }

  return "UNKNOWN";
}

function moduleLicense(directory) {
  if (!directory || !existsSync(directory)) return "UNKNOWN";

  const fileName = readdirSync(directory).find(name =>
    /^(license|licence|copying)(\.|$)/i.test(name));
  if (!fileName) return "UNKNOWN";

  return detectLicense(readFileSync(join(directory, fileName), "utf8"));
}

function goLicenses(moduleDirectory) {
  run("go", ["mod", "download", "all"], moduleDirectory);
  const modules = run(
    "go",
    ["list", "-m", "-f", "{{.Path}}\t{{.Version}}\t{{.Dir}}\t{{.Main}}", "all"],
    moduleDirectory,
  ).trim().split("\n").filter(Boolean).map(line => {
    const [path, version, directory, main] = line.split("\t");
    return { path, version, directory, main: main === "true" };
  });

  return deduplicate(modules
    .filter(module => !module.main && module.version)
    .map(module => ({
      ecosystem: "Go",
      name: module.path,
      version: module.version,
      license: moduleLicense(module.directory),
      source: module.path.startsWith("github.com/")
        ? `https://${module.path}`
        : `https://pkg.go.dev/${module.path}@${module.version}`,
    })));
}

const clientNpm = npmLicenses(join(root, "sortsys-webapp-v2/package-lock.json"));
const dwgNpm = npmLicenses(join(root, "sortsys-dwgviewer/package-lock.json"));
const inventory = {
  server: {
    api: cargoLicenses(join(root, "sortsys-api-v2/Cargo.toml")),
    jobRunner: goLicenses(join(root, "sortsys-v2-job_runner")),
  },
  client: {
    webapp: deduplicate([
      ...clientNpm,
      ...dwgNpm,
      ...cargoLicenses(join(root, "sortsys-dwgviewer/lib/Cargo.toml")),
    ]),
  },
};
const generated = `${JSON.stringify(inventory, null, 2)}\n`;

if (checkOnly) {
  const current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  if (current !== generated) {
    console.error(
      "License inventory is outdated. Run: node scripts/generate-license-inventory.mjs",
    );
    process.exit(1);
  }
} else {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated, "utf8");
  console.log(`Updated ${outputPath}`);
}
