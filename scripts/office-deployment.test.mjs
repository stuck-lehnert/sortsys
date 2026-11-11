import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { YAML } from "bun";
import { test } from "bun:test";

const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
for (const filename of ["compose.yaml", "ghcr-compose.yaml"]) {
  const { services, volumes } = YAML.parse(read(filename));
  test(`${filename}: private Office uses isolated origins and ciphertext storage without a document-server callback`, () => {
    const service = services.office;
    assert.equal(service.read_only, true);
    assert.deepEqual(service.cap_drop, ["ALL"]);
    assert.deepEqual(service.expose, ["8080"]);
    assert.equal(service.environment.OFFICE_PUBLIC_ORIGIN, "${OFFICE_PUBLIC_ORIGIN}");
    assert.equal(service.environment.OFFICE_SANDBOX_ORIGIN, "${OFFICE_SANDBOX_ORIGIN}");
    assert.equal(service.environment.SORTSYS_PUBLIC_ORIGIN, "${SORTSYS_PUBLIC_ORIGIN}");
    assert.equal(services.api.environment.OFFICE_PUBLIC_ORIGIN, "${OFFICE_PUBLIC_ORIGIN}");
    assert.deepEqual(service.volumes, ["private-office-data:/var/lib/sortsys-office"]);
    assert.ok(Object.hasOwn(volumes, "private-office-data"));
    assert.equal(Object.keys(service.environment).some(key => /JWT|CALLBACK|INTERNAL_URL/.test(key)), false);
    assert.equal(services.onlyoffice, undefined);
    assert.equal(Object.keys(volumes).some(name => name.startsWith("euro-office")), false);
    assert.equal(Object.keys(services.api.environment).some(key => key.startsWith("ONLYOFFICE_")), false);
    assert.equal(Object.keys(services.webapp.environment).some(key => key.startsWith("ONLYOFFICE_")), false);
    assert.equal("office" in services.api.depends_on, false);
    assert.equal("office" in services.webapp.depends_on, false);
  });
}

test("development uses the private Office service without plaintext callbacks", () => {
  const development = read("scripts/dev");
  assert.match(development, /-e OFFICE_PUBLIC_ORIGIN="\$DEV_OFFICE_PUBLIC_ORIGIN"/);
  assert.match(development, /-e OFFICE_SANDBOX_ORIGIN="\$DEV_OFFICE_SANDBOX_ORIGIN"/);
  assert.match(development, /-e SORTSYS_PUBLIC_ORIGIN="\$DEV_SORTSYS_PUBLIC_ORIGIN"/);
  assert.match(development, /\$ROOT_DIR\/sortsys-office/);
  assert.match(development, /:\/var\/lib\/sortsys-office\$\{runtime_mount_suffix\}/);
  assert.match(development, /--read-only --init --cap-drop ALL --security-opt no-new-privileges/);
  assert.doesNotMatch(development, /ONLYOFFICE|Document Server|dev-office-start|dev-office-init/);
});

test("the webapp has no proxy or secret for the obsolete plaintext document server", () => {
  for (const file of [".compose-env.example", "sortsys-webapp-v2/Dockerfile", "sortsys-webapp-v2/nginx.conf.template"]) {
    assert.doesNotMatch(read(file), /ONLYOFFICE_|onlyoffice_upstream|onlyoffice_request_uri/);
  }
});
