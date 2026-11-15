import { expect, test } from "bun:test";
import { base64 } from "@sortsys/zerotrust/sortsys";
import {
  chunkCollection,
  content,
  contentId,
  FILE_CHUNK_BYTES,
  itemName,
  parsePrivateFileUrl,
  privateFileUrl,
} from "./projectFileData";

const version = "a".repeat(32),
  hash = base64(new Uint8Array(32));
test("migration archives bind their own domain and source ID, including empty originals", () => {
  const namespace = "archive:migration:test";
  expect(chunkCollection(namespace)).toEqual({
    domain: namespace,
    scope: "migration:migration:test",
    facet: "attachment",
    prefix: "file-data:archive:migration:test:",
  });
  const manifest = {
    version: "legacy",
    size: 7,
    parts: [{ id: contentId(namespace, "5", "legacy", 0), hash }],
  };
  expect(content(manifest, namespace, "5")).toEqual(manifest);
  expect(() => content(manifest, "archive:migration:other", "5")).toThrow();
  expect(() => content(manifest, namespace, "6")).toThrow();
  expect(() => content(manifest, "organization", "5")).toThrow();
  expect(
    content({ version: "legacy", size: 0, parts: [] }, namespace, "5"),
  ).toEqual({
    version: "legacy",
    size: 0,
    parts: [],
  });
  for (const invalid of [
    "archive:",
    "archive:../other",
    "archive:with space",
  ]) {
    expect(() => chunkCollection(invalid)).toThrow();
    expect(() =>
      content({ version: "legacy", size: 0, parts: [] }, invalid, "5"),
    ).toThrow();
  }
  expect(() =>
    content({ version: "../other", size: 0, parts: [] }, namespace, "5"),
  ).toThrow();
});
test("file manifests bind exact project, file, ordered blocks and final byte length", () => {
  const input = {
    version,
    size: FILE_CHUNK_BYTES + 7,
    parts: [0, 1].map((index) => ({
      id: contentId("4", "5", version, index),
      hash,
    })),
  };
  expect(content(input, "4", "5")).toEqual(input);
  for (const changed of [
    { ...input, parts: [...input.parts].reverse() },
    { ...input, parts: input.parts.slice(0, 1) },
    { ...input, size: 0 },
    {
      ...input,
      parts: [input.parts[0], { ...input.parts[1], hash: hash + "=" }],
    },
    { ...input, unexpected: "field" },
  ])
    expect(() => content(changed, "4", "5")).toThrow();
  expect(() => content(input, "6", "5")).toThrow();
  expect(() => content(input, "4", "6")).toThrow();
  expect(() =>
    content({ version: "../other", size: 0, parts: [] }, "4", "5"),
  ).toThrow();
  expect(() =>
    content({ version, size: 536870913, parts: [] }, "4", "5"),
  ).toThrow();
});
test("private resource identifiers cannot redirect to remote locations or smuggle malformed IDs", () => {
  const url = privateFileUrl("4", "5", "13", true);
  expect(parsePrivateFileUrl(url)).toEqual({
    projectId: "4",
    fileId: "5",
    revision: "13",
    thumbnail: true,
  });
  for (const invalid of [
    "https://tracker.invalid/file",
    "sortsys-private:04/5/13/original",
    "sortsys-private:4/5/0/original",
    "sortsys-private:4/5/9223372036854775808/original",
    url + "?url=https://tracker.invalid/",
    url + "/../other",
  ])
    expect(() => parsePrivateFileUrl(invalid)).toThrow();
  for (const name of [
    "..",
    ".",
    "folder/file.pdf",
    "folder\\file.pdf",
    "invalid\0name",
  ])
    expect(() => itemName(name)).toThrow();
  expect(itemName("  Grundriss Erdgeschoss.pdf  ")).toBe(
    "Grundriss Erdgeschoss.pdf",
  );
});
