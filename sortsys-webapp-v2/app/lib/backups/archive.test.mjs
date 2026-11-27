import { expect, test } from "bun:test";
import { base64, InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { readArchiveFileIndex } from "./archive";

const context = `backup:${base64(new Uint8Array(32).fill(252))}`;

function archivedPages(count) {
  const calls = [];
  const pages = Array.from({ length: count }, (_, index) => {
    const id = (index + 1).toString(32);
    return {
      envelope: { object: `${context}:files:${id}`, signature: `page-${id}` },
      value: {
        format: "sortsys-backup-files-v1",
        entries: [
          {
            bucket: "archive-test",
            key: `plans/${id}.pdf`,
            size: 0,
            id,
            content: { version: "a".repeat(32), size: 0, parts: [] },
          },
        ],
      },
    };
  });
  const references = pages.map(({ envelope }) => ({
    id: envelope.object,
    signature: envelope.signature,
  }));
  const selected = async (ids) => {
    calls.push(ids);
    return ids.map((id) => pages.find(({ envelope }) => envelope.object === id));
  };

  return { calls, pages, references, selected };
}

test("opens signed archive pages in bounded selections in manifest order", async () => {
  const archive = archivedPages(17);
  const index = await readArchiveFileIndex(context, archive.references, archive);

  expect(archive.calls.map((ids) => ids.length)).toEqual([16, 1]);
  expect([...index.values()].map(({ id }) => id)).toEqual(
    archive.pages.map(({ value }) => value.entries[0].id),
  );
});

test("rejects missing, replaced and duplicate archive records", async () => {
  const missing = archivedPages(2);
  await expect(
    readArchiveFileIndex(context, missing.references, {
      selected: async () => missing.pages.slice(1),
    }),
  ).rejects.toBeInstanceOf(InvalidProtectedData);

  const replaced = archivedPages(2);
  replaced.pages[1].envelope.signature = "replaced";
  await expect(
    readArchiveFileIndex(context, replaced.references, replaced),
  ).rejects.toBeInstanceOf(InvalidProtectedData);

  const wrongObject = archivedPages(2);
  await expect(
    readArchiveFileIndex(context, wrongObject.references, {
      selected: async () => [
        wrongObject.pages[0],
        {
          ...wrongObject.pages[1],
          envelope: {
            ...wrongObject.pages[1].envelope,
            object: wrongObject.pages[0].envelope.object,
          },
        },
      ],
    }),
  ).rejects.toBeInstanceOf(InvalidProtectedData);

  const duplicate = archivedPages(17);
  duplicate.pages[16].value.entries[0] = duplicate.pages[0].value.entries[0];
  await expect(
    readArchiveFileIndex(context, duplicate.references, duplicate),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
});
