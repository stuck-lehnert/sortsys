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
  "postgres",
  "s3",
  "go-build",
  "go-modules",
  "webapp-dependencies",
  "dwgviewer-dependencies",
  "euro-office/data",
  "euro-office/state",
  "euro-office/database",
  "euro-office/logs",
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
  const dependencies = names.includes("start_onlyoffice")
    ? ["prepare_onlyoffice_storage"]
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
runtime_pull_args=()
runtime_user_args=()
runtime_env_args=()
DEV_JOB_RUNNER_CONTAINERS=(runner-1 runner-2)
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
      const directory = join(root, ".dev-data", folder);
      assert.ok(existsSync(directory), `${folder} was prepared`);
      writeFileSync(join(directory, "preserved"), folder);
    }

    runStorageFunctions(root, "", ["prepare_development_directories"]);

    for (const folder of folders) {
      assert.equal(
        readFileSync(join(root, ".dev-data", folder, "preserved"), "utf8"),
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
        "start_postgres",
        "start_s3",
        "start_onlyoffice",
        "start_job_runner_containers",
        "start_webapp_container",
      ]);
      const initialization = calls.find((call) =>
        call.includes("DEV_ONLYOFFICE_INIT_CONTAINER"),
      );
      assert.ok(initialization, "Office storage is initialized before startup");
      assert.ok(initialization.includes("--rm"));
      assert.equal(
        initialization[initialization.indexOf("--network") + 1],
        "none",
      );
      assert.equal(initialization.at(-2), "DEV_ONLYOFFICE_IMAGE");
      assert.equal(initialization.at(-1), "/sortsys-dev-office-init");
      const initializationMounts = initialization.filter(
        (argument, index) => initialization[index - 1] === "-v",
      );
      const helperOptions = suffix ? `ro,${suffix.slice(1)}` : "ro";

      assert.deepEqual(initializationMounts, [
        `${root}/scripts/dev-office-init:/sortsys-dev-office-init:${helperOptions}`,
        ...["data", "state", "database", "logs"].map(
          (name) =>
            `${root}/.dev-data/euro-office/${name}:/sortsys-dev-office/${name}${suffix}`,
        ),
      ]);

      const runs = calls.filter(
        (call) => call[0] === "run" && call !== initialization,
      );
      const office = runs.find((call) =>
        call.includes("DEV_ONLYOFFICE_CONTAINER"),
      );
      assert.ok(
        office && !office.includes("--rm"),
        "Office failure logs survive exit",
      );
      assert.ok(calls.indexOf(initialization) < calls.indexOf(office));
      assert.equal(office[office.indexOf("--entrypoint") + 1], "sh");
      assert.equal(office.at(-2), "DEV_ONLYOFFICE_IMAGE");
      assert.equal(office.at(-1), "/sortsys-dev-office-start");
      const startupMount = [
        `${root}/scripts/dev-office-start`,
        "/sortsys-dev-office-start",
        helperOptions,
      ].join(":");
      assert.ok(office.includes(startupMount));

      const mounts = runs.flatMap((call) =>
        call.filter((argument, index) => call[index - 1] === "-v"),
      );
      const expected = new Map([
        ["postgres", "/var/lib/postgresql/data"],
        ["s3", "/data"],
        ["go-build", "/tmp/go-build"],
        ["go-modules", "/tmp/go"],
        ["webapp-dependencies", "/workspace/sortsys-webapp-v2/node_modules"],
        ["dwgviewer-dependencies", "/workspace/sortsys-dwgviewer/node_modules"],
        ["euro-office/data", "/var/www/euro-office/Data"],
        ["euro-office/state", "/var/lib/euro-office/documentserver"],
        ["euro-office/database", "/var/lib/postgresql"],
        ["euro-office/logs", "/var/log/euro-office/documentserver"],
      ]);

      assert.equal(
        runs.length,
        6,
        "PostgreSQL, S3, Office, two runners and webapp",
      );

      for (const [folder, destination] of expected) {
        const source = join(root, ".dev-data", folder);
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
            mount === `${root}:/workspace${suffix}` ||
            mount === startupMount,
        ),
        "only local data, workspace and the read-only Office startup script are mounted",
      );

      if (suffix) {
        assert.ok(
          mounts.every(
            (mount) => mount === startupMount || mount.endsWith(suffix),
          ),
        );
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
      development.indexOf("runtime_pull_args=()"),
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
      runtime === "podman" ? [":z", "--pull=never"] : [":z"],
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
      startup.indexOf("start_postgres"),
  );
  assert.doesNotMatch(development, /_VOLUME\b|\bvolume (?:create|rm)\b/);

  for (const name of ["cleanup_containers", "cleanup", "force_shutdown"]) {
    assert.doesNotMatch(developmentFunction(name), /DEV_\w+_DIR|\brm\s+-rf\b/);
  }
});
