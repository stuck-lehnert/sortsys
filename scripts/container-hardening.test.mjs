import assert from "node:assert/strict";
import { lstatSync, readFileSync } from "node:fs";
import { YAML } from "bun";
import { test } from "bun:test";

const root = new URL("../", import.meta.url);
const applications = ["api", "job-runner", "webapp"];
const filenames = ["compose.yaml", "ghcr-compose.yaml"];

function read(filename) {
  return readFileSync(new URL(filename, root), "utf8");
}

function networks(service) {
  return service.networks ?? ["default"];
}

function shareNetwork(services, first, second) {
  return networks(services[first]).some((name) => {
    return networks(services[second]).includes(name);
  });
}

for (const filename of filenames) {
  const compose = YAML.parse(read(filename));
  const { services } = compose;

  test(`${filename}: application processes cannot acquire container privileges`, () => {
    for (const name of applications) {
      const service = services[name];

      assert.deepEqual(service.cap_drop, ["ALL"], name);
      assert.equal(service.cap_add, undefined, name);
      assert.deepEqual(service.security_opt, ["no-new-privileges:true"], name);
      assert.equal(service.init, true, name);
      assert.equal(service.privileged, undefined, name);
      assert.equal(
        service.user,
        undefined,
        "Preserve the image's non-root user",
      );
    }
  });

  test(`${filename}: PostgreSQL retains its existing network and API connection`, () => {
    assert.equal(services.postgres.networks, undefined);
    assert.deepEqual(networks(services.postgres), ["default"]);
    assert.equal(shareNetwork(services, "postgres", "api"), true);
  });

  test(`${filename}: runner connectivity is limited to the API and outbound services`, () => {
    assert.equal(shareNetwork(services, "job-runner", "api"), true);

    for (const name of ["postgres", "webapp", "onlyoffice", "drawio"]) {
      assert.equal(shareNetwork(services, "job-runner", name), false, name);
    }

    for (const name of applications) {
      assert.ok(
        networks(services[name]).some((network) => {
          return !compose.networks[network]?.internal;
        }),
        `${name} retains external connectivity for S3, LLM or proxy traffic`,
      );
    }
  });

  test(`${filename}: editor proxying and callbacks remain on a shared network`, () => {
    for (const pair of [
      ["webapp", "api"],
      ["webapp", "onlyoffice"],
      ["webapp", "drawio"],
      ["api", "onlyoffice"],
    ]) {
      assert.equal(shareNetwork(services, ...pair), true, pair.join(" -> "));
    }

    assert.equal(services.webapp.environment.SERVICE_URL_WEBAPP_80, "/");
    assert.deepEqual(services.webapp.expose, ["80"]);
  });

  test(`${filename}: nginx has a read-only root and a configurable writable temporary area`, () => {
    const webapp = services.webapp;

    assert.equal(webapp.read_only, true);
    assert.deepEqual(webapp.tmpfs, [
      "/tmp:rw,noexec,nosuid,nodev,size=${WEBAPP_TMPFS_SIZE:-256m},mode=1777",
    ]);
    assert.equal(webapp.sysctls["net.ipv4.ip_unprivileged_port_start"], "0");

    for (const name of ["api", "job-runner"]) {
      assert.equal(
        services[name].tmpfs,
        undefined,
        "Large backup/OCR files stay on disk",
      );
    }
  });

  test(`${filename}: no service exposes host ports, namespaces or host paths`, () => {
    for (const [name, service] of Object.entries(services)) {
      assert.equal(service.ports, undefined, name);
      assert.equal(service.network_mode, undefined, name);
      assert.equal(service.pid, undefined, name);
      assert.equal(service.privileged, undefined, name);

      for (const mount of service.volumes ?? []) {
        const source = mount.split(":")[0];

        assert.ok(Object.hasOwn(compose.volumes, source), `${name}: ${mount}`);
      }
    }
  });
}

test("build and prebuilt deployments retain the same runtime configuration", () => {
  const documents = filenames.map((filename) => {
    return YAML.parse(read(filename));
  });

  for (const document of documents) {
    for (const service of Object.values(document.services)) {
      delete service.build;
      delete service.image;
      delete service.pull_policy;
    }
  }

  assert.deepEqual(documents[0], documents[1]);
});

test("each build context has independent Docker exclusions, without changing Git rules", () => {
  const paths = [
    ".dockerignore",
    "sortsys-api-v2/.dockerignore",
    "sortsys-v2-job_runner/.dockerignore",
    "sortsys-webapp-v2/.dockerignore",
  ];

  for (const filename of paths) {
    assert.equal(
      lstatSync(new URL(filename, root)).isSymbolicLink(),
      false,
      filename,
    );

    const rules = read(filename).split("\n");

    for (const rule of [
      "**/.git",
      "**/.env",
      "**/.env.*",
      "**/.compose-env",
      "**/.compose-env.*",
      "**/.npmrc",
      "**/*.key",
      "**/node_modules",
      "**/target",
      "**/build",
      "**/dist",
    ]) {
      assert.ok(rules.includes(rule), `${filename}: ${rule}`);
    }
  }
});

test("production images retain non-root users and the core-only nginx base", () => {
  for (const [directory, user] of [
    ["sortsys-api-v2", "sortsys"],
    ["sortsys-v2-job_runner", "runner"],
    ["sortsys-webapp-v2", "nginx"],
  ]) {
    const finalStage = read(`${directory}/Dockerfile`)
      .split(/^FROM /m)
      .at(-1);

    assert.match(finalStage, new RegExp(`^USER ${user}$`, "m"));
  }

  assert.match(
    read("sortsys-webapp-v2/Dockerfile"),
    /^FROM nginx:1\.\d+\.\d+-alpine-slim$/m,
  );
});

test("the API keeps one PostgreSQL client library and explicit runtime dependencies", () => {
  const dockerfile = read("sortsys-api-v2/Dockerfile");
  const runtime = dockerfile.split(/^FROM /m).at(-1);
  const packages = runtime.split(/\s+/);

  assert.equal(packages.includes("libpq5"), false);

  for (const name of [
    "ca-certificates",
    "curl",
    "libgssapi-krb5-2",
    "libldap-2.5-0",
    "liblz4-1",
    "libreadline8",
    "libssl3",
    "libzstd1",
    "zlib1g",
  ]) {
    assert.ok(packages.includes(name), name);
  }

  assert.equal(runtime.match(/^COPY .*libpq\./gm)?.length, 1);
  assert.ok(runtime.includes("libpq.so.5.* /usr/local/lib/"));
  assert.match(runtime, /^RUN ldconfig$/m);
  assert.doesNotMatch(runtime, /system_libpq/);

  for (const tool of ["pg_dump", "psql"]) {
    assert.ok(runtime.includes(`/usr/lib/postgresql/17/bin/${tool}`), tool);
  }
});

test("the worker's smaller runtime retains its required image, PDF and language packages", () => {
  const dockerfile = read("sortsys-v2-job_runner/Dockerfile");
  const runtime = dockerfile.split(/^FROM /m).at(-1);
  const packages = runtime.split(/\s+/);

  assert.match(runtime, /^alpine:3\.24 AS runtime$/m);
  assert.match(runtime, /^RUN apk add --no-cache/m);
  assert.ok(dockerfile.includes("FROM ${GO_IMAGE} AS development"));
  assert.ok(
    dockerfile.includes('CGO_ENABLED=0 GOOS="$TARGETOS" GOARCH="$TARGETARCH"'),
  );
  assert.ok(dockerfile.includes("go build -trimpath -ldflags='-s -w'"));

  for (const name of [
    "ca-certificates",
    "font-dejavu",
    "imagemagick",
    "imagemagick-jpeg",
    "imagemagick-webp",
    "poppler-utils",
    "tesseract-ocr",
    "tesseract-ocr-data-deu",
    "tesseract-ocr-data-eng",
  ]) {
    assert.ok(packages.includes(name), name);
  }

  assert.doesNotMatch(runtime, /tesseract-ocr-data-osd/);
  assert.doesNotMatch(runtime, /ocr-runtime\.test/);
  assert.match(
    runtime,
    /^COPY policy\.xml \/etc\/ImageMagick-7\/policy\.xml$/m,
  );
});

test("CI exports genuine worker tests separately and requires exact runtime selection", () => {
  const workflow = YAML.parse(read(".github/workflows/ci.yml"));
  const steps = workflow.jobs.containers.steps;
  const exported = steps.find((step) => {
    return step.with?.target === "runtime-test-binary";
  });
  const runtime = steps.find((step) => {
    return step.run?.includes("test-container-runtime");
  });
  const harness = read("scripts/test-container-runtime");
  const dockerfile = read("sortsys-v2-job_runner/Dockerfile");

  assert.equal(exported.if, "matrix.image == 'jobrunner'");
  assert.equal(exported.with.push, false);
  assert.equal(
    exported.with.outputs,
    "type=local,dest=${{ runner.temp }}/sortsys-jobrunner-tests",
  );
  assert.equal(
    runtime.env.JOBRUNNER_RUNTIME_TEST,
    "${{ runner.temp }}/sortsys-jobrunner-tests/ocr-runtime.test",
  );
  assert.match(dockerfile, /^FROM scratch AS runtime-test-binary$/m);
  assert.ok(
    dockerfile.includes(
      "go test -c -o /out/ocr-runtime.test ./internal/runner",
    ),
  );
  assert.ok(harness.includes("dst=/fixtures/ocr-runtime.test,readonly"));
  assert.ok(harness.includes("-e SORTSYS_TEST_OCR_TOOLS=1"));
  assert.ok(harness.includes('-test.list "^TestOCRRuntime$"'));
  assert.ok(harness.includes('test "$tests" = TestOCRRuntime'));
  assert.ok(harness.includes('-test.run "^TestOCRRuntime$"'));
});

test("nginx only renders upstream/body-size variables into its writable configuration", () => {
  const dockerfile = read("sortsys-webapp-v2/Dockerfile");
  const config = read("sortsys-webapp-v2/nginx.conf");

  assert.match(dockerfile, /NGINX_ENVSUBST_OUTPUT_DIR=\/tmp/);

  const filterValue = dockerfile.match(/NGINX_ENVSUBST_FILTER=(\S+)/)?.[1];

  assert.ok(filterValue);

  const filter = new RegExp(filterValue);

  for (const name of [
    "API_UPSTREAM",
    "ONLYOFFICE_UPSTREAM",
    "DRAWIO_UPSTREAM",
    "CLIENT_MAX_BODY_SIZE",
  ]) {
    assert.equal(filter.test(name), true, name);
  }

  for (const name of [
    "host",
    "scheme",
    "uri",
    "JWT_SECRET",
    "API_UPSTREAM_SUFFIX",
  ]) {
    assert.equal(filter.test(name), false, name);
  }

  assert.match(config, /^pid \/tmp\/nginx.pid;$/m);
  assert.match(config, /^  include \/tmp\/default.conf;$/m);
  assert.doesNotMatch(config, /^user /m);

  for (const kind of ["client_body", "proxy", "fastcgi", "uwsgi", "scgi"]) {
    assert.match(config, new RegExp(`^  ${kind}_temp_path /tmp/`, "m"));
  }
});

test("the local environment example documents nginx temporary-space sizing", () => {
  assert.match(read(".compose-env.example"), /^WEBAPP_TMPFS_SIZE=256m$/m);
});

test("prebuilt image references can be pinned without changing production defaults", () => {
  const compose = YAML.parse(read("ghcr-compose.yaml"));

  for (const [service, variable, image] of [
    ["api", "SORTSYS_API_IMAGE", "api"],
    ["job-runner", "SORTSYS_JOBRUNNER_IMAGE", "jobrunner"],
    ["webapp", "SORTSYS_WEBAPP_IMAGE", "webapp"],
  ]) {
    assert.equal(
      compose.services[service].image,
      `\${${variable}:-ghcr.io/stuck-lehnert/sortsys-${image}:latest}`,
    );
  }
});

test("CI checks every production image without publishing and gates promotion", () => {
  const workflow = YAML.parse(read(".github/workflows/ci.yml"));
  const job = workflow.jobs.containers;
  const matrix = job.strategy.matrix.include;
  const build = job.steps.find((step) => {
    return step.uses?.startsWith("docker/build-push-action@");
  });
  const runtime = job.steps.find((step) => {
    return step.run?.includes("test-container-runtime");
  });

  const images = matrix.map((entry) => {
    return entry.image;
  });

  assert.deepEqual(images.sort(), ["api", "jobrunner", "webapp"]);
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, true);
  assert.ok(
    runtime.run.includes("\\\n"),
    "Shell continuation retains its newline",
  );
  assert.deepEqual(workflow.jobs.promote.needs, [
    "test",
    "upgrade",
    "containers",
  ]);
  assert.ok(
    read("scripts/ci").includes("./scripts/container-hardening.test.mjs"),
  );
});

test("the publishing workflow requests an SBOM and minimal provenance", () => {
  const workflow = YAML.parse(read(".github/workflows/publish-containers.yml"));
  const build = workflow.jobs.publish.steps.find((step) => {
    return step.uses?.startsWith("docker/build-push-action@");
  });

  assert.equal(build.with.sbom, true);
  assert.equal(build.with.provenance, "mode=min");
});
