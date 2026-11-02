import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const initializer = fileURLToPath(
  new URL("./dev-office-init", import.meta.url),
);
const imagePaths = {
  data: "var/www/euro-office/Data",
  state: "var/lib/euro-office/documentserver",
  database: "var/lib/postgresql",
  logs: "var/log/euro-office/documentserver",
};

function withStorageFixture(check) {
  const root = mkdtempSync(join(tmpdir(), "sortsys office binds "));
  const image = join(root, "image");
  const data = join(root, "binds");

  try {
    for (const [name, path] of Object.entries(imagePaths)) {
      const source = join(image, path);
      mkdirSync(source, { recursive: true });
      mkdirSync(join(data, name), { recursive: true });
      writeFileSync(join(source, "image-default"), `${name} default`);
      chmodSync(source, 0o750);
    }

    const cluster = join(image, imagePaths.database, "16/main");
    mkdirSync(cluster, { recursive: true });
    writeFileSync(join(cluster, "PG_VERSION"), "16\n");
    chmodSync(cluster, 0o700);

    for (const name of ["converter", "docservice", "adminpanel"]) {
      mkdirSync(join(image, imagePaths.logs, name));
    }

    mkdirSync(join(image, imagePaths.state, "App_Data/cache"), {
      recursive: true,
    });
    check({ root, image, data });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function initialize({ image, data }) {
  return spawnSync("bash", [initializer, image, data], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
    timeout: 5000,
  });
}

function directoryMetadata(path) {
  const { mode, uid, gid } = statSync(path);

  return { mode: mode & 0o7777, uid, gid };
}

test("fresh binds inherit defaults and directory ownership/modes from the image", () => {
  withStorageFixture((fixture) => {
    const { image, data } = fixture;
    const result = initialize(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    for (const [name, path] of Object.entries(imagePaths)) {
      assert.equal(
        readFileSync(join(data, name, "image-default"), "utf8"),
        `${name} default`,
      );
      assert.deepEqual(
        directoryMetadata(join(data, name)),
        directoryMetadata(join(image, path)),
      );
    }

    assert.equal(
      readFileSync(join(data, "database/16/main/PG_VERSION"), "utf8"),
      "16\n",
    );
    assert.deepEqual(
      directoryMetadata(join(data, "database/16/main")),
      directoryMetadata(join(image, imagePaths.database, "16/main")),
    );
    assert.ok(existsSync(join(data, "logs/adminpanel")));
    assert.ok(existsSync(join(data, "state/App_Data/cache")));
  });
});

test("fresh binds keep destination labels without copying image xattrs", () => {
  withStorageFixture((fixture) => {
    const { image, data } = fixture;
    const source = join(image, imagePaths.data);
    const destination = join(data, "data");
    const prepare = spawnSync(
      "python3",
      [
        "-c",
        [
          "import os, sys",
          "os.setxattr(sys.argv[1], 'user.sortsys_image', b'image context')",
          "os.setxattr(sys.argv[2], 'user.sortsys_bind', b'bind context')",
        ].join("\n"),
        source,
        destination,
      ],
      { encoding: "utf8" },
    );
    assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr);

    const result = initialize(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    const inspect = spawnSync(
      "python3",
      [
        "-c",
        [
          "import json, os, sys",
          "print(json.dumps(os.listxattr(sys.argv[1])))",
        ].join("\n"),
        destination,
      ],
      { encoding: "utf8" },
    );
    assert.equal(inspect.status, 0, inspect.stdout + inspect.stderr);
    const attributes = JSON.parse(inspect.stdout);

    assert.equal(attributes.includes("user.sortsys_image"), false);
    assert.equal(attributes.includes("user.sortsys_bind"), true);
  });
});

test("restarts preserve every existing file and never merge a nonempty database", () => {
  withStorageFixture((fixture) => {
    const { image, data } = fixture;
    assert.equal(initialize(fixture).status, 0);

    for (const name of Object.keys(imagePaths)) {
      writeFileSync(join(data, name, "image-default"), `${name} user content`);
    }

    writeFileSync(
      join(data, "database/16/main/PG_VERSION"),
      "existing cluster\n",
    );
    chmodSync(join(data, "database"), 0o710);
    const metadata = directoryMetadata(join(data, "database"));
    const newCluster = join(image, imagePaths.database, "17/main");
    mkdirSync(newCluster, { recursive: true });
    writeFileSync(join(newCluster, "PG_VERSION"), "17\n");
    const result = initialize(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    for (const name of Object.keys(imagePaths)) {
      assert.equal(
        readFileSync(join(data, name, "image-default"), "utf8"),
        `${name} user content`,
      );
    }

    assert.equal(
      readFileSync(join(data, "database/16/main/PG_VERSION"), "utf8"),
      "existing cluster\n",
    );
    assert.equal(existsSync(join(data, "database/17")), false);
    assert.deepEqual(directoryMetadata(join(data, "database")), metadata);
  });
});

test("partial startup restores log/state directories without replacing existing files", () => {
  withStorageFixture((fixture) => {
    const { image, data } = fixture;
    mkdirSync(join(data, "logs/converter"));
    writeFileSync(
      join(data, "logs/converter/error.log"),
      "preserved diagnostics\n",
    );
    writeFileSync(
      join(data, "state/runtime.json"),
      "existing runtime config\n",
    );
    chmodSync(join(data, "logs/converter"), 0o700);
    const result = initialize(fixture);
    assert.equal(result.status, 0, result.stdout + result.stderr);

    assert.ok(existsSync(join(data, "logs/adminpanel")));
    assert.ok(existsSync(join(data, "state/App_Data/cache")));
    assert.deepEqual(
      directoryMetadata(join(data, "logs/converter")),
      directoryMetadata(join(image, imagePaths.logs, "converter")),
    );
    assert.equal(
      readFileSync(join(data, "logs/converter/error.log"), "utf8"),
      "preserved diagnostics\n",
    );
    assert.equal(
      readFileSync(join(data, "state/runtime.json"), "utf8"),
      "existing runtime config\n",
    );
    assert.equal(existsSync(join(data, "state/image-default")), false);
  });
});

test("initialization refuses symlinked target directories", () => {
  withStorageFixture((fixture) => {
    const { root, data } = fixture;
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "preserved"), "unchanged");
    symlinkSync(outside, join(data, "logs/adminpanel"));
    const result = initialize(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected a Euro-Office directory/);
    assert.equal(readFileSync(join(outside, "preserved"), "utf8"), "unchanged");
    assert.equal(existsSync(join(outside, "image-default")), false);
  });
});

test("missing baked defaults fail visibly instead of silently starting an empty editor", () => {
  withStorageFixture((fixture) => {
    rmSync(join(fixture.image, imagePaths.data), { recursive: true });
    const result = initialize(fixture);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Cannot initialize Euro-Office directory/);
    assert.equal(
      existsSync(join(fixture.data, "database/image-default")),
      false,
    );
  });
});
