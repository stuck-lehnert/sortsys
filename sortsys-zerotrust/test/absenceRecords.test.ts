import { expect, test } from "bun:test";
import { absenceDomain, absenceRecord, objectWriteAction, TOMBSTONE_FORMAT } from "../src/sortsys";
const request = { scope: "absence:2", facet: "master-data" as const, object: "absence:2:request:3", format: "sortsys-object-v1", revision: "1" };
const decision = { ...request, facet: "personnel" as const, object: "absence:2:decision:3" };
test("absence actions are immutable and separate from ordinary create/update rights", () => {
  expect(objectWriteAction(request)).toBe("create"); expect(objectWriteAction(decision)).toBe("approve");
  expect(objectWriteAction({ ...request, format: TOMBSTONE_FORMAT, revision: "2" })).toBe("delete");
  expect(absenceRecord(decision)?.requestDomain).toBe("absence:2:master-data");
  expect(absenceDomain("absence:2:personnel")).toEqual({ user: "2", scope: "absence:2", facet: "personnel" });
  expect(absenceDomain("personnel:2:personnel")).toBeNull();
  for (const input of [{ ...request, revision: "2" }, { ...request, revision: "3", format: TOMBSTONE_FORMAT }, { ...decision, revision: "2" },
    { ...decision, revision: "2", format: TOMBSTONE_FORMAT }]) expect(() => objectWriteAction(input)).toThrow();
});
test("reserved objects cannot be laundered through another owner, facet, scope or ambiguous identifier", () => {
  for (const input of [{ ...decision, scope: "absence:4" }, { ...decision, scope: "catalog:products" }, { ...decision, facet: "master-data" as const },
    { ...request, object: "unreserved:3" }, { ...request, object: "absence:02:request:3" }, { ...request, object: "absence:2:request:0" },
    { ...request, object: "absence:2:request:8000000000000" }, { ...request, object: "absence:2:request:3:extra" }]) expect(() => objectWriteAction(input)).toThrow();
  expect(objectWriteAction({ ...request, scope: "project:2", object: "project:2:record", revision: "2" })).toBe("update");
});
test("authority-attested history can share an absence key without becoming an editable application or decision",()=>{
  const history={...request,object:"legacy-activity:absence:2:master-data:101:event"};
  expect(absenceRecord(history)).toBeNull();expect(objectWriteAction(history)).toBe("create");
  for(const input of [{...history,revision:"2"},{...history,format:TOMBSTONE_FORMAT},{...history,revision:"2",format:TOMBSTONE_FORMAT}])expect(()=>objectWriteAction(input)).toThrow();
});
