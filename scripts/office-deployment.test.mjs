import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { YAML } from "bun";
import { test } from "bun:test";

const projectRoot = new URL("../", import.meta.url);

function readProjectFile(relativePath) {
  return readFileSync(new URL(relativePath, projectRoot), "utf8");
}

const catalog = readProjectFile("scripts/Dockerfile.images");
const image = catalog.match(/^FROM (\S+) AS onlyoffice$/m)?.[1];
const development = readProjectFile("scripts/dev");
const example = readProjectFile(".compose-env.example");
const officeSecret = "${SERVICE_BASE64_64_ONLYOFFICE}";
const mounts = [
  "euro-office-data:/var/www/euro-office/Data",
  "euro-office-state:/var/lib/euro-office/documentserver",
  "euro-office-database:/var/lib/postgresql",
  "euro-office-logs:/var/log/euro-office/documentserver",
];

for (const filename of ["compose.yaml", "ghcr-compose.yaml"]) {
  const compose = YAML.parse(readProjectFile(filename));
  const office = compose.services.onlyoffice;
  const api = compose.services.api;
  const webapp = compose.services.webapp;

  test(`${filename}: pinned image and shared JWT configuration`, () => {
    assert.match(
      image,
      /^ghcr\.io\/euro-office\/documentserver:latest@sha256:[a-f0-9]{64}$/,
    );
    assert.equal(office.image, `\${ONLYOFFICE_IMAGE:-${image}}`);
    assert.equal(office.environment.JWT_SECRET, officeSecret);
    assert.equal(api.environment.ONLYOFFICE_JWT_SECRET, officeSecret);
    assert.notEqual(api.environment.JWT_SECRET, officeSecret);
    assert.equal(office.environment.JWT_ENABLED, "true");
    assert.equal(office.environment.JWT_HEADER, "Authorization");
    assert.equal(office.environment.JWT_IN_BODY, "false");
  });

  test(`${filename}: isolated editor with private API access`, () => {
    assert.equal(office.environment.ALLOW_PRIVATE_IP_ADDRESS, "true");
    assert.equal(office.environment.EXAMPLE_ENABLED, "false");
    assert.equal(office.ports, undefined);
    assert.equal(api.environment.ONLYOFFICE_INTERNAL_URL, "http://onlyoffice");
    assert.equal(api.environment.ONLYOFFICE_PUBLIC_URL, "/office");
    assert.equal(
      api.environment.ONLYOFFICE_CALLBACK_URL,
      "http://api:3000/internal/onlyoffice/callback",
    );
    assert.equal(webapp.environment.ONLYOFFICE_UPSTREAM, "http://onlyoffice");
    assert.equal(api.depends_on.onlyoffice.condition, "service_healthy");
    assert.equal(webapp.depends_on.onlyoffice.condition, "service_healthy");
    assert.deepEqual(office.healthcheck.test, [
      "CMD",
      "curl",
      "--fail",
      "--silent",
      "http://127.0.0.1/healthcheck",
    ]);
  });

  test(`${filename}: fresh persistent volumes without old state reuse`, () => {
    assert.deepEqual(office.volumes, mounts);

    for (const mount of mounts) {
      const [name] = mount.split(":");
      assert.ok(Object.hasOwn(compose.volumes, name));
    }
  });
}

test("local environment example matches the pinned deployment image", () => {
  assert.equal(example.match(/^ONLYOFFICE_IMAGE=(.+)$/m)?.[1], image);
  assert.match(example, /^SERVICE_BASE64_64_ONLYOFFICE=.+$/m);
  assert.match(example, /at least 32 characters/);
});

test("development uses Euro-Office paths and the same secret for both services", () => {
  assert.match(development, /sortsys_container_image onlyoffice/);
  assert.match(development, /-e JWT_SECRET="\$DEV_ONLYOFFICE_JWT_SECRET"/);
  assert.match(
    development,
    /-e ONLYOFFICE_JWT_SECRET="\$DEV_ONLYOFFICE_JWT_SECRET"/,
  );
  assert.match(development, /-e ALLOW_PRIVATE_IP_ADDRESS="true"/);
  assert.match(development, /-e EXAMPLE_ENABLED="false"/);

  for (const mount of mounts) {
    const [, target] = mount.split(":");
    assert.ok(development.includes(`:${target}"`));
  }

  assert.doesNotMatch(development, /\/var\/(?:www|lib|log)\/onlyoffice/);
  assert.doesNotMatch(development, /sortsys-dev-onlyoffice-9-3-1/);
});

// Execute only the secret initialization block, never the stack launcher.
const secretBlock = development.match(
  /^(DEV_ONLYOFFICE_JWT_SECRET=[\s\S]+?)\n# Development global-admin password/m,
)?.[1];
assert.ok(secretBlock, "Development JWT setup block is present");

function initializeSecret(secret) {
  const env = { PATH: process.env.PATH };

  if (secret !== undefined) {
    env.DEV_ONLYOFFICE_JWT_SECRET = secret;
  }

  return spawnSync(
    "bash",
    [
      "-c",
      `set -euo pipefail\n${secretBlock}\nprintf '%s' "$DEV_ONLYOFFICE_JWT_SECRET"`,
    ],
    { encoding: "utf8", env },
  );
}

test("development generates a fresh 256-bit secret when none is supplied", () => {
  const first = initializeSecret();
  const second = initializeSecret();

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.match(first.stdout, /^[a-f0-9]{64}$/);
  assert.match(second.stdout, /^[a-f0-9]{64}$/);
  assert.notEqual(first.stdout, second.stdout);
});

test("development preserves an explicit secret at the 32-character boundary", () => {
  const secret = "x".repeat(32);
  const result = initializeSecret(secret);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, secret);
});

test("development rejects a short explicit secret without printing its value", () => {
  const secret = "x".repeat(31);
  const result = initializeSecret(secret);

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /must contain at least 32 characters/);
  assert.ok(!result.stderr.includes(secret));
});
