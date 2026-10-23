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

function developmentFunction(name) {
  const definition = development.match(
    new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, "m"),
  )?.[0];

  assert.ok(definition, `${name} is defined in scripts/dev`);

  return definition;
}

const environmentFunctions = [
  developmentFunction("prepare_llm_environment"),
  developmentFunction("cleanup_llm_environment"),
].join("\n\n");

function loadEnvironment(content, exported = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sortsys-dev-llm-"));
  const envFile = join(directory, ".env");
  const environmentCapture = join(directory, "environment");
  const argumentsCapture = join(directory, "arguments");
  const executionMarker = join(directory, "must-not-exist");

  try {
    if (content !== undefined) {
      writeFileSync(envFile, content.replaceAll("<MARKER>", executionMarker));
    }

    const result = spawnSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
umask 077
${environmentFunctions}

prepare_llm_environment
printf '%s' "$DEV_LLM_ENV_CONTENT" > "$DEV_TEST_ENV_CAPTURE"
printf '%s\\n' "\${runtime_llm_env_args[@]}" > "$DEV_TEST_ARGS_CAPTURE"
cleanup_llm_environment

if [ -n "$DEV_LLM_ENV_CONTENT" ] || [ "\${#runtime_llm_env_args[@]}" -ne 0 ]; then
  echo "Development LLM credentials were not cleared after handoff" >&2
  exit 1
fi
`,
      ],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          DEV_ENV_FILE: envFile,
          DEV_TEST_ENV_CAPTURE: environmentCapture,
          DEV_TEST_ARGS_CAPTURE: argumentsCapture,
          ...exported,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);

    const environment = new Map();
    const captured = readFileSync(environmentCapture, "utf8");

    for (const line of captured.split("\n").filter(Boolean)) {
      const separator = line.indexOf("=");
      environment.set(line.slice(0, separator), line.slice(separator + 1));
    }

    return {
      environment,
      arguments: readFileSync(argumentsCapture, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean),
      executed: existsSync(executionMarker),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("root dotenv OpenRouter settings reach the API without logging their values", () => {
  const key = "fixture-openrouter-secret";
  const result = loadEnvironment(
    `# Local credentials\r\nexport OPENROUTER_API_KEY = '${key}'\r\n` +
      'OPENROUTER_MODEL="deepseek/deepseek-v4.1-flash-1017"\r\n' +
      "UNRELATED_SECRET=not-forwarded\r\n",
  );

  assert.equal(result.environment.get("OPENROUTER_API_KEY"), key);
  assert.equal(
    result.environment.get("OPENROUTER_MODEL"),
    "deepseek/deepseek-v4.1-flash-1017",
  );
  assert.equal(result.environment.has("UNRELATED_SECRET"), false);
  assert.deepEqual(result.arguments, ["--env-file", "/dev/stdin"]);
  assert.equal(result.stdout.includes(key), false);
  assert.equal(result.stderr.includes(key), false);
});

test("exported OpenRouter settings override dotenv values, including explicit empty values", () => {
  for (const key of ["fixture-exported-secret", ""]) {
    const result = loadEnvironment(
      "OPENROUTER_API_KEY=fixture-file-secret\nOPENROUTER_MODEL=file-model\n",
      { OPENROUTER_API_KEY: key, OPENROUTER_MODEL: "exported-model" },
    );

    assert.equal(result.environment.get("OPENROUTER_API_KEY"), key);
    assert.equal(result.environment.get("OPENROUTER_MODEL"), "exported-model");
    assert.equal(result.stdout.includes("fixture-file-secret"), false);
    assert.equal(result.stdout.includes("fixture-exported-secret"), false);
  }
});

test("OpenAI fallback and MCP endpoint settings remain available", () => {
  const result = loadEnvironment(
    "OPENAI_API_KEY=fixture-openai-secret\n" +
      "OPENAI_MODEL=gpt-6-luna\n" +
      "LLM_MCP_URL=https://mcp.example.test/internal/llm/mcp\n",
  );

  assert.equal(
    result.environment.get("OPENAI_API_KEY"),
    "fixture-openai-secret",
  );
  assert.equal(result.environment.get("OPENAI_MODEL"), "gpt-6-luna");
  assert.equal(
    result.environment.get("LLM_MCP_URL"),
    "https://mcp.example.test/internal/llm/mcp",
  );
  assert.equal(result.stdout.includes("fixture-openai-secret"), false);
});

test("exported OpenRouter credentials work without a dotenv file", () => {
  const result = loadEnvironment(undefined, {
    OPENROUTER_API_KEY: "fixture-export-only-secret",
  });

  assert.equal(
    result.environment.get("OPENROUTER_API_KEY"),
    "fixture-export-only-secret",
  );
  assert.deepEqual(result.arguments, ["--env-file", "/dev/stdin"]);
});

test("a missing dotenv file without credentials leaves the assistant disabled", () => {
  const result = loadEnvironment(undefined);

  assert.equal(result.environment.size, 0);
  assert.deepEqual(result.arguments, []);
  assert.match(result.stdout, /assistant remains disabled/);
});

test("dotenv values are parsed as data and never executed as shell code", () => {
  const result = loadEnvironment("OPENROUTER_API_KEY=$(touch <MARKER>)\n");

  assert.match(
    result.environment.get("OPENROUTER_API_KEY"),
    /^\$\(touch .+\)$/,
  );
  assert.equal(result.executed, false);
  assert.equal(result.stdout.includes("$(touch"), false);
});
