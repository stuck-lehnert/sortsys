import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

import { generateTypedContract } from "./typed_contract.mjs";

const catalog = JSON.parse(
  fs.readFileSync(
    new URL("../lib/api/generated/contract.json", import.meta.url),
    "utf8",
  ),
);

function generated(data) {
  return new Map(generateTypedContract(data));
}

function coverage(data) {
  return JSON.parse(generated(data).get("models.coverage.json"));
}

test("generates every unique object and every real procedure", () => {
  const report = coverage(catalog);
  const objects = report.definitions.filter(
    (definition) => definition.kind === "object",
  );

  assert.equal(objects.length, report.objectShapes);
  assert.equal(report.objectShapes, 312);
  assert.equal(report.procedures.length, catalog.procedures.length);
  assert.equal(
    new Set(report.procedures.map((procedure) => procedure.name)).size,
    240,
  );
  assert.equal(report.contractSha256, catalog.contractSha256);
});

test("gives optional root input aliases a separate object payload class", () => {
  const report = coverage(catalog);
  const procedure = report.procedures.find((row) => {
    return row.name === "personalization.activity.list";
  });

  assert.equal(procedure.input, "PersonalizationActivityListInput");
  assert.equal(
    procedure.inputType,
    "RpcOptional<PersonalizationActivityListRequest>",
  );
});

test("links resource list and detail results to the same generated model", () => {
  const report = coverage(catalog);
  const get = report.procedures.find((row) => row.name === "projects.get");
  const list = report.procedures.find((row) => row.name === "projects.list");

  assert.equal(get.outputType, "Project");
  assert.equal(list.outputType, "List<Project>");
});

test("defaults nullable constructor fields and keeps non-nullable requirements", () => {
  const output = generated(catalog).get("models.g.dart");
  const constructor = output.match(
    /const SessionInfoUser\(\{([\s\S]*?)\}\);/,
  )[1];

  for (const name of ["salutation", "lastName", "phone", "email"]) {
    assert.match(constructor, new RegExp(`\\bthis\\.${name},`));
    assert.doesNotMatch(
      constructor,
      new RegExp(`\\brequired\\s+this\\.${name}\\b`),
    );
  }

  for (const name of [
    "id",
    "username",
    "firstName",
    "contractType",
    "locale",
  ]) {
    assert.match(constructor, new RegExp(`\\brequired\\s+this\\.${name}\\b`));
  }
});

test("keeps recursive JSON records and nullable values in the model", () => {
  const output = generated(catalog).get("models.g.dart");

  assert.match(output, /sealed class JsonValue implements RpcValue/);
  assert.match(output, /Map<String, JsonValue> values/);
  assert.match(output, /final Null value/);
});

test("rejects unresolved contract references instead of generating unknown", () => {
  const invalid = structuredClone(catalog);
  invalid.procedures[0].output = { kind: "ref", name: "MissingContractType" };

  assert.throws(() => generated(invalid), /UNRESOLVED_DART_REFERENCE/);
});

test("fails closed on unsupported contract shapes", () => {
  const invalid = structuredClone(catalog);
  invalid.procedures[0].input = { kind: "unsupported-test-shape" };

  assert.throws(() => generated(invalid), /UNSUPPORTED_DART_SHAPE/);
});
