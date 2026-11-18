import { afterEach, expect, test } from "bun:test";
import { TOMBSTONE_FORMAT } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import {
  createProtectedAddressBook,
  CUSTOMER_COLLECTION,
  CONTACT_COLLECTION,
} from "./addressBook";
import { createProtectedProjects } from "./projects";
import { projectCollection } from "./projectData";
import { row } from "./rowCodec.test.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { createProtectedProjectFiles } from "./projectFiles";
import {
  fileCollection,
  fileObject,
  folderObject,
  contentId,
} from "./projectFileData";
import { protectedCollection } from "./protectedObjects";

afterEach(() => lockCryptoSession());
async function fixture(kind) {
  const area =
    kind === "projects"
      ? projectCollection("2")
      : kind === "customers"
        ? CUSTOMER_COLLECTION
        : CONTACT_COLLECTION;
  const f = await protectedTenant([area], () => ["read", "delete"]),
    id = area.prefix + (kind === "projects" ? "" : "2");
  const value =
    kind === "projects"
      ? {
          format: "sortsys-project-v1",
          project: row("projects", { id: "2", title: "Fenstersanierung" }),
          contacts: [],
        }
      : {
          format: "sortsys-address-v1",
          kind,
          row: row(kind, {
            id: "2",
            phone_numbers: "[]",
            email_addresses: "[]",
            ...(kind === "customers"
              ? { name: "Musterkunde" }
              : { first_name: "Anna" }),
          }),
          links: [],
        };
  await f.seed(area, id, value);
  const store =
    kind === "projects"
      ? createProtectedProjects(
          f.client,
          new AbortController().signal,
          async () => {
            throw new Error("Directory not needed");
          },
          duckDriver,
        )
      : createProtectedAddressBook(
          f.client,
          new AbortController().signal,
          duckDriver,
        );
  return { ...f, area, id, value, store };
}
for (const kind of ["projects", "customers", "contacts"])
  test(`${kind} deletion works with read/delete only and an exact encrypted readback`, async () => {
    const f = await fixture(kind);
    try {
      expect(await f.store.query(`${kind}.list`, {})).toHaveLength(1);
      f.state.loseReply = true;
      expect(await f.store.mutate(`${kind}.delete`, { id: "2" })).toEqual({
        success: true,
      });
      expect(f.objects.get(f.id).format).toBe(TOMBSTONE_FORMAT);
      expect(await f.store.query(`${kind}.list`, {})).toEqual([]);
      const raw = await protectedCollection(
        f.client,
        f.area,
        new AbortController().signal,
      );
      try {
        const deleted = await raw.get(f.id);
        expect(deleted.value).toBeNull();
        expect(await raw.selected([f.id])).toEqual([]);
        expect(await raw.read()).toEqual([]);
        await expect(
          raw.packet(f.id, f.value, deleted.envelope),
        ).rejects.toThrow();
      } finally {
        raw.close();
      }
    } finally {
      f.store.close();
    }
  }, 20000);
test("a false deletion acknowledgement leaves the original visible object intact", async () => {
  const f = await fixture("projects"),
    native = f.client.mutate;
  f.client.mutate = async (path, input) =>
    path === "zerotrust.objects.batch"
      ? [
          {
            success: true,
            heads: input.heads.map((head) => ({
              ...head,
              sequence: String(Number(head.sequence) + 1),
            })),
          },
          null,
        ]
      : native(path, input);
  try {
    await expect(
      f.store.mutate("projects.delete", { id: "2" }),
    ).rejects.toThrow();
    expect(f.objects.get(f.id).format).toBe("sortsys-object-v1");
    expect(await f.store.query("projects.list", {})).toHaveLength(1);
  } finally {
    f.store.close();
  }
}, 20000);

test("project files and empty folders use delete-only proofs without opening their content blocks", async () => {
  const area = fileCollection("2"),
    f = await protectedTenant([area], () => ["read", "delete"]);
  const file = fileObject("2", "3"),
    folder = folderObject("2", "4");
  await f.seed(area, folder, {
    format: "sortsys-project-folder-v1",
    folder: row("project_file_folders", {
      id: "4",
      project_id: "2",
      name: "Baupläne",
    }),
  });
  await f.seed(area, file, {
    format: "sortsys-project-file-v1",
    file: row("project_files", {
      id: "3",
      project_id: "2",
      folder_id: "4",
      file_name: "Baustelle.jpg",
      mime_type: "image/jpeg",
      kind: "image",
      status: "uploaded",
      size_bytes: "1",
      thumbnail_status: "none",
      text_extraction_status: "ready",
    }),
    original: {
      version: "legacy",
      size: 1,
      parts: [{ id: contentId("2", "3", "legacy", 0), hash: "A".repeat(43) }],
    },
    thumbnail: null,
    office: null,
  });
  const store = createProtectedProjectFiles(
    f.client,
    new AbortController().signal,
    async () => {
      throw new Error("Project names not needed");
    },
    duckDriver,
  );
  try {
    await expect(
      store.mutate("projects.files.folders.delete", {
        projectId: "2",
        folderId: "4",
      }),
    ).rejects.toThrow();
    f.state.loseReply = true;
    expect(
      await store.mutate("projects.files.delete", {
        projectId: "2",
        fileId: "3",
      }),
    ).toEqual({ success: true });
    expect(
      await store.query("projects.files.list", { projectId: "2" }),
    ).toEqual([]);
    expect(
      await store.mutate("projects.files.folders.delete", {
        projectId: "2",
        folderId: "4",
      }),
    ).toEqual({ success: true });
    expect(
      await store.query("projects.files.folders.list", { projectId: "2" }),
    ).toEqual([]);
    expect(f.objects.get(file).format).toBe(TOMBSTONE_FORMAT);
    expect(f.objects.get(folder).format).toBe(TOMBSTONE_FORMAT);
    expect(
      f.calls.some((call) => call.path.startsWith("zerotrust.fileChunks.get")),
    ).toBe(false);
  } finally {
    await store.close();
  }
}, 20000);
