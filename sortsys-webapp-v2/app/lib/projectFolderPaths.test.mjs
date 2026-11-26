import { expect, test } from "bun:test";
import {
  projectFolderDestinations,
  projectFolderLabel,
  projectFolderTrail,
} from "./projectFolderPaths";

const folders = [
  { id: "detail", parentFolderId: "plans", name: "Details" },
  { id: "plans", parentFolderId: null, name: "Plans" },
  { id: "archive", parentFolderId: null, name: "Archive" },
  { id: "section", parentFolderId: "detail", name: "Sections" },
];

test("folder paths order parents before children and omit a moving subtree", () => {
  expect(projectFolderDestinations(folders)).toEqual([
    { id: "archive", label: "Archive" },
    { id: "plans", label: "Plans" },
    { id: "detail", label: "Plans / Details" },
    { id: "section", label: "Plans / Details / Sections" },
  ]);
  expect(projectFolderDestinations(folders, "detail")).toEqual([
    { id: "archive", label: "Archive" },
    { id: "plans", label: "Plans" },
  ]);
});

test("folder paths stop at an absent parent and do not repeat cycles", () => {
  const incomplete = [
    { id: "orphan", parentFolderId: "absent", name: "Orphan" },
    { id: "a", parentFolderId: "b", name: "A" },
    { id: "b", parentFolderId: "a", name: "B" },
  ];
  const byId = new Map(incomplete.map((folder) => [folder.id, folder]));

  expect(projectFolderTrail(byId, null)).toEqual([]);
  expect(projectFolderTrail(byId, "absent")).toEqual([]);
  expect(projectFolderLabel(projectFolderTrail(byId, "orphan"))).toBe("Orphan");
  expect(projectFolderLabel(projectFolderTrail(byId, "a"))).toBe("B / A");
  expect(projectFolderDestinations(incomplete, "a")).toEqual([
    { id: "orphan", label: "Orphan" },
  ]);
});
