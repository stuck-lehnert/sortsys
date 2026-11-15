import { expect, test } from "bun:test";
import { localBackupFiles } from "./files";

const signal = new AbortController().signal;
function file(path, text = "private original") {
  const result = new File([text], path.split("/").at(-1));
  Object.defineProperty(result, "webkitRelativePath", { value: path });
  return result;
}

test("a selected directory retains bucket and object paths without using filename matching", async () => {
  const original = file("snapshot/bucket-one/plans/ground-floor.pdf");
  const provider = localBackupFiles([original]);
  expect(
    await provider.read(
      {
        bucket: "bucket-one",
        key: "plans/ground-floor.pdf",
        size: original.size,
      },
      signal,
    ),
  ).toBe(original);
  await expect(
    provider.read(
      { bucket: "bucket-one", key: "ground-floor.pdf", size: original.size },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    provider.read(
      {
        bucket: "bucket-two",
        key: "plans/ground-floor.pdf",
        size: original.size,
      },
      signal,
    ),
  ).rejects.toThrow();
  await expect(
    provider.read(
      {
        bucket: "bucket-one",
        key: "plans/ground-floor.pdf",
        size: original.size + 1,
      },
      signal,
    ),
  ).rejects.toThrow();
});

test("ambiguous aliases and repeated selected paths cannot silently select a different original", async () => {
  const sameName = file("snapshot/plans/ground-floor.pdf");
  const bucketName = file(
    "snapshot/bucket-one/plans/ground-floor.pdf",
    "different original",
  );
  const provider = localBackupFiles([sameName, bucketName]);
  await expect(
    provider.read(
      { bucket: "bucket-one", key: "plans/ground-floor.pdf", size: null },
      signal,
    ),
  ).rejects.toThrow();
  expect(() => localBackupFiles([sameName, sameName])).toThrow();
});

test("source paths reject traversal, absolute paths and ambiguous separators before reading", async () => {
  const provider = localBackupFiles([file("original.pdf")]);
  for (const key of [
    "../original.pdf",
    "/original.pdf",
    "./original.pdf",
    "a//original.pdf",
    "a\\original.pdf",
    "a/../original.pdf",
    "original.pdf\0",
  ]) {
    await expect(
      provider.read({ bucket: null, key, size: null }, signal),
    ).rejects.toThrow();
    expect(() => localBackupFiles([file(key)])).toThrow();
  }
});

test("cancellation stops source reads and a bare object path remains usable", async () => {
  const original = file("plans/ground-floor.pdf");
  const provider = localBackupFiles([original]);
  expect(
    await provider.read(
      { bucket: null, key: "plans/ground-floor.pdf", size: null },
      signal,
    ),
  ).toBe(original);
  await expect(
    provider.read(
      { bucket: null, key: "plans/ground-floor.pdf", size: null },
      AbortSignal.abort(),
    ),
  ).rejects.toThrow();
});
