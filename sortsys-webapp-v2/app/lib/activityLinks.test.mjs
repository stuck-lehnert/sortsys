import { describe, expect, test } from "bun:test";
import { activityProjectFileHref } from "./activityLinks";

const fileActivity = {
  entityTable: "project_files",
  entityId: "7777778",
  resourceType: "project",
  resourceId: "2ofbll96a9lqj",
  action: "created",
};

const filesPath = "/projects/2ofbll96a9lqj/files";

describe("activity file links", () => {
  test("converts database IDs to public file IDs without losing precision", () => {
    for (const [entityId, publicId] of [
      ["32", "10"],
      ["7777778", "7dbfi"],
      ["9007199254740993", "80000000001"],
      ["9223372036854775807", "7vvvvvvvvvvvv"],
    ]) {
      expect(activityProjectFileHref({ ...fileActivity, entityId })).toBe(
        `${filesPath}?file=${publicId}`,
      );
    }
  });

  test("opens created and updated file references in the owning project", () => {
    for (const action of ["created", "updated"]) {
      expect(
        activityProjectFileHref({
          ...fileActivity,
          action,
          contextId: "different-project",
        }),
      ).toBe(`${filesPath}?file=7dbfi`);
    }
  });

  test("does not link a deletion event to a missing file", () => {
    expect(
      activityProjectFileHref({ ...fileActivity, action: "deleted" }),
    ).toBeNull();
  });

  test("does not interpret folder, root-resource or association keys as files", () => {
    for (const entityTable of [
      "projects",
      "project_file_folders",
      "daily_project_report_files",
    ]) {
      expect(
        activityProjectFileHref({ ...fileActivity, entityTable }),
      ).toBeNull();
    }
  });

  test("requires a project owner", () => {
    expect(
      activityProjectFileHref({ ...fileActivity, resourceType: "tool" }),
    ).toBeNull();
    expect(
      activityProjectFileHref({ ...fileActivity, resourceId: "" }),
    ).toBeNull();
  });

  test("leaves invalid, composite and overflowing database keys unlinked", () => {
    for (const entityId of [
      "",
      "-1",
      "1.5",
      "1e3",
      "+32",
      " 32 ",
      "7dbfi",
      "../Plan.pdf",
      '{"project_id":32,"file_id":64}',
      "9223372036854775808",
      "100000000000000000000",
    ]) {
      expect(activityProjectFileHref({ ...fileActivity, entityId })).toBeNull();
    }
  });
});
