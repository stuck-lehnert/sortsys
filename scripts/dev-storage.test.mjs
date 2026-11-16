import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

const development = readFileSync(new URL("./dev", import.meta.url), "utf8");
const directoryDefinitions = development.match(/^DEV_\w+_DIR=.*$/gm).join("\n");
const folders = [
  "seeded-duckdb",
  "webapp-dependencies",
  "dwgviewer-dependencies",
  "gaeb-dependencies",
  "private-office",
  "seed",
];

function developmentFunction(name) {
  const definition = development.match(
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
  )?.[0];

  assert.ok(definition, `${name} is defined in scripts/dev`);

  return definition;
}

function runStorageFunctions(root, suffix, names) {
  const capture = join(root, "runtime-arguments");
  const dependencies = names.includes("start_private_office")
    ? ["build_private_office_image"]
    : [];
  const definitions = [...dependencies, ...names]
    .map(developmentFunction)
    .join("\n\n");
  const variables = [...new Set(definitions.match(/\bDEV_[A-Z0-9_]+\b/g))];
  const environment = Object.fromEntries(variables.map((name) => [name, name]));
  const script = `
set -euo pipefail
${directoryDefinitions}
SCRIPT_DIR="$ROOT_DIR/scripts"
${definitions}
runtime_mount_suffix="$DEV_TEST_SUFFIX"
runtime_pull_args=(--pull=missing)
runtime_env_args=(-e HOME=/tmp)
CONTAINER_RUNTIME=record_runtime
record_runtime() {
  printf '%s\\0' "$@" >> "$DEV_TEST_CAPTURE"
  printf '\\0' >> "$DEV_TEST_CAPTURE"
}
ensure_network() {
  return 0
}
container_is_running() {
  return 0
}
wait_for_tcp_port() {
  return 0
}
wait_for_editor_ready() {
  return 0
}
${names.join("\n")}
`;
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...environment,
      ROOT_DIR: root,
      DEV_TEST_SUFFIX: suffix,
      DEV_TEST_CAPTURE: capture,
    },
  });

  assert.equal(result.status, 0, result.stderr);

  if (!existsSync(capture)) {
    return [];
  }

  return readFileSync(capture, "utf8")
    .split("\0\0")
    .filter(Boolean)
    .map((call) => call.split("\0"));
}

test("development storage initialization preserves existing local data", () => {
  const root = mkdtempSync(join(tmpdir(), "sortsys dev storage "));

  try {
    runStorageFunctions(root, "", ["prepare_development_directories"]);

    for (const folder of folders) {
      const directory = join(root, ".dev-data", "zerotrust", folder);
      assert.ok(existsSync(directory), `${folder} was prepared`);
      writeFileSync(join(directory, "preserved"), folder);
    }

    runStorageFunctions(root, "", ["prepare_development_directories"]);

    for (const folder of folders) {
      assert.equal(
        readFileSync(
          join(root, ".dev-data", "zerotrust", folder, "preserved"),
          "utf8",
        ),
        folder,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const suffix of ["", ":z"]) {
  test(`all development data/cache mounts are local binds (${suffix || "Docker"})`, () => {
    const root = mkdtempSync(join(tmpdir(), "sortsys dev mounts "));

    try {
      const calls = runStorageFunctions(root, suffix, [
        "prepare_development_directories",
        "start_duckdb_container",
        "start_private_office",
        "start_webapp_container",
        "seed_development_tenant",
      ]);
      const build = calls.find((call) => call[0] === "build");
      assert.ok(build, "Private Office is built before startup");
      const runs = calls.filter((call) => call[0] === "run");
      const office = runs.find((call) => call.includes("DEV_OFFICE_CONTAINER"));
      assert.ok(
        office && !office.includes("--rm"),
        "Office failure logs survive exit",
      );
      assert.ok(calls.indexOf(build) < calls.indexOf(office));
      assert.equal(office.at(-1), "DEV_OFFICE_IMAGE");
      assert.ok(office.includes("--read-only"));
      assert.ok(
        office.includes("OFFICE_PUBLIC_ORIGIN=DEV_OFFICE_PUBLIC_ORIGIN"),
      );
      assert.ok(
        office.includes("OFFICE_SANDBOX_ORIGIN=DEV_OFFICE_SANDBOX_ORIGIN"),
      );
      assert.ok(
        office.includes("SORTSYS_PUBLIC_ORIGIN=DEV_SORTSYS_PUBLIC_ORIGIN"),
      );

      const mounts = runs.flatMap((call) =>
        call.filter((argument, index) => call[index - 1] === "-v"),
      );
      const expected = new Map([
        ["seeded-duckdb", "/data"],
        ["gaeb-dependencies", "/workspace/sortsys-gaeb/node_modules"],
        ["webapp-dependencies", "/workspace/sortsys-webapp-v2/node_modules"],
        ["dwgviewer-dependencies", "/workspace/sortsys-dwgviewer/node_modules"],
        ["private-office", "/var/lib/sortsys-office"],
        ["seed", "/seed"],
      ]);

      assert.equal(
        runs.length,
        4,
        "DuckDB, Office, webapp and the seed client",
      );
      const seed = runs.find((call) => call.includes("DEV_SEED_CONTAINER"));
      assert.ok(seed.includes("SORTSYS_DEVELOPMENT_SEED=1"));
      assert.ok(seed.includes("SORTSYS_DEV_ADMIN_PASSWORD=DEV_ADMIN_PASSWORD"));
      assert.equal(seed.at(-1), "scripts/seed-development.ts");

      for (const [folder, destination] of expected) {
        const source = join(root, ".dev-data", "zerotrust", folder);
        assert.ok(
          existsSync(source),
          `${folder} exists before service startup`,
        );
        assert.ok(mounts.includes(`${source}:${destination}${suffix}`));
      }

      assert.ok(
        mounts.every(
          (mount) =>
            mount.startsWith(`${root}/.dev-data/`) ||
            mount === `${root}:/workspace${suffix}`,
        ),
        "only local data and workspace are mounted",
      );

      if (suffix) {
        assert.ok(mounts.every((mount) => mount.endsWith(suffix)));
      }

      assert.ok(!calls.some((call) => call[0] === "volume"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const runtime of ["docker", "podman"]) {
  test(`${runtime} development binds request shared SELinux labels`, () => {
    const setup = development.slice(
      development.indexOf("runtime_pull_args=(--pull=missing)"),
      development.indexOf("\nprepare_llm_environment()"),
    );
    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
CONTAINER_RUNTIME=${runtime}
${setup}
printf '%s\\0' "$runtime_mount_suffix" "\${runtime_pull_args[@]}"
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(
      result.stdout.split("\0").filter(Boolean),
      runtime === "podman" ? [":z", "--pull=never"] : [":z", "--pull=missing"],
    );
  });
}

test("development folders are ignored and prepared before startup", () => {
  const ignore = readFileSync(
    new URL("../.gitignore", import.meta.url),
    "utf8",
  );
  const startup = development.slice(
    development.indexOf("\ncleanup_containers\n"),
  );

  assert.match(ignore, /^\.dev-data\/$/m);
  assert.match(
    startup,
    /cleanup_containers\nprepare_development_directories\n/,
  );
  assert.ok(
    startup.indexOf("prepare_development_directories") <
      startup.indexOf("start_duckdb_container"),
  );
  assert.doesNotMatch(development, /_VOLUME\b|\bvolume (?:create|rm)\b/);

  for (const name of ["cleanup_containers", "cleanup", "force_shutdown"]) {
    assert.doesNotMatch(developmentFunction(name), /DEV_\w+_DIR|\brm\s+-rf\b/);
  }
});
