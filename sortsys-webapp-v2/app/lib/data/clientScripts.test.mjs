import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import {
  CLIENT_SCRIPT_COLLECTION,
  CLIENT_SCRIPT_MODEL,
  clientScriptChanges,
  clientScriptObject,
  clientScriptPayload,
} from "./clientScriptData";
import { createProtectedClientScripts } from "./clientScripts";
import { copyClientScripts } from "./migrateClientScripts";
import { row } from "./rowCodec.test.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";

afterEach(() => lockCryptoSession());

const code = "// Vertrauliche Regel 628491\nconst amount = 37.125;\n";
function scriptRow(id = "7", changes = {}) {
  return row("client_scripts", {
    id,
    name: "Aufmaß prüfen",
    description: "Fensterflächen zusammenstellen",
    code,
    enabled: true,
    created_by_user_id: "2",
    modified_by_user_id: "3",
    created_at: "2026-01-02T10:00:00.123456Z",
    modified_at: "2026-01-03T10:00:00.123457Z",
    ...changes,
  });
}
async function fixture(actions, backup = false) {
  const f = await protectedTenant([CLIENT_SCRIPT_COLLECTION], actions, {
    backup,
  });
  const controller = new AbortController();
  const store = createProtectedClientScripts(
    f.client,
    controller.signal,
    duckDriver,
  );
  const seedScript = (source) =>
    f.seed(CLIENT_SCRIPT_COLLECTION, clientScriptObject(source.values.id), {
      format: "sortsys-client-script-v1",
      row: source,
    });
  return { ...f, store, controller, seedScript };
}

test("script models bind their area and identity, preserve code and reject invalid fields", () => {
  const source = scriptRow();
  const payload = { format: "sortsys-client-script-v1", row: source };
  expect(clientScriptPayload(payload, "client-script:7").row.values.code).toBe(
    code,
  );
  for (const source of [
    scriptRow("0"),
    scriptRow("8"),
    scriptRow("7", { name: " " }),
    scriptRow("7", { code: "x\0y" }),
    row("users"),
  ]) {
    expect(() =>
      clientScriptPayload({ ...payload, row: source }, "client-script:7"),
    ).toThrow();
  }
  expect(() =>
    CLIENT_SCRIPT_MODEL.decode(payload, "client-script:7", {
      ...CLIENT_SCRIPT_COLLECTION,
      scope: "organization",
    }),
  ).toThrow();
  expect(
    clientScriptChanges({ name: "  Neu  ", code, description: " " }, true),
  ).toEqual({ name: "Neu", code, description: null, enabled: true });
  expect(clientScriptChanges({ description: null }, false)).toEqual({
    description: null,
  });
  for (const data of [
    {},
    { enabled: null },
    { code: "ä".repeat(100001) },
    { createdByUserId: "1" },
    { name: "" },
  ]) {
    expect(() => clientScriptChanges(data, false)).toThrow();
  }
});

test("local script lists search descriptions, omit code, respect enabled filters and select exact IDs", async () => {
  const f = await fixture();
  try {
    await f.seedScript(scriptRow());
    await f.seedScript(
      scriptRow("8", { name: "Archiviertes Skript", enabled: false }),
    );
    const all = await f.store.query("clientScripts.list", {
      search: "Fensterfläch",
    });
    expect(all).toHaveLength(2);
    expect(all.every((script) => !("code" in script))).toBe(true);
    expect(
      await f.store.query("clientScripts.list", { includeDisabled: false }),
    ).toHaveLength(1);
    expect(
      await f.store.query("clientScripts.list", { limit: 1 }),
    ).toHaveLength(1);
    const detail = await f.store.query("clientScripts.get", { id: "7" });
    expect(detail.code).toBe(code);
    expect(detail.createdByUserId).toBe("2");
    expect(await f.store.query("clientScripts.get", { id: "9" })).toBeNull();
    for (const input of [
      { limit: 0 },
      { limit: 201 },
      { includeDisabled: null },
      { search: 3 },
    ]) {
      await expect(
        f.store.query("clientScripts.list", input),
      ).rejects.toThrow();
    }
  } finally {
    f.store.close();
  }
});

test("create, narrow patches and signed deletion keep code, names and descriptions off the transport", async () => {
  const f = await fixture();
  try {
    const created = await f.store.mutate("clientScripts.create", {
      name: "  Vertraulicher Ablauf 472619 ",
      code,
    });
    expect(created.name).toBe("Vertraulicher Ablauf 472619");
    expect(created.createdByUserId).toBe("1");
    const updated = await f.store.mutate("clientScripts.update", {
      id: created.id,
      data: { description: "Interne Materialauswertung 812973" },
    });
    expect(updated.code).toBe(code);
    expect(updated.createdAt).toEqual(created.createdAt);
    expect(updated.modifiedByUserId).toBe("1");
    expect(
      (
        await f.store.mutate("clientScripts.update", {
          id: created.id,
          data: { description: null, enabled: false },
        })
      ).description,
    ).toBeNull();
    await f.store.mutate("clientScripts.delete", { id: created.id });
    expect(
      await f.store.query("clientScripts.get", { id: created.id }),
    ).toBeNull();
    await f.store.mutate("clientScripts.delete", { id: created.id });
    expect(await f.store.query("clientScripts.list", {})).toEqual([]);
    const sent = JSON.stringify(f.calls);
    for (const secret of [
      "Vertraulicher Ablauf",
      "Materialauswertung",
      "628491",
      "37.125",
    ])
      expect(sent.includes(secret)).toBe(false);
    expect(f.calls.some((call) => call.path.startsWith("clientScripts."))).toBe(
      false,
    );
  } finally {
    f.store.close();
  }
});

test("script creation, editing and deletion need separate grants even for an administrator", async () => {
  for (const action of ["create", "update", "delete"]) {
    const f = await fixture(() => ["read", action]);
    f.state.roles = [":admin"];
    try {
      await f.seedScript(scriptRow());
      const work = {
        create: () =>
          f.store.mutate("clientScripts.create", {
            name: "Neues Skript",
            code: "",
          }),
        update: () =>
          f.store.mutate("clientScripts.update", {
            id: "7",
            data: { name: "Änderung" },
          }),
        delete: () => f.store.mutate("clientScripts.delete", { id: "7" }),
      };
      for (const operation of ["create", "update", "delete"]) {
        if (operation === action) await work[operation]();
        else await expect(work[operation]()).rejects.toThrow();
      }
    } finally {
      f.store.close();
    }
  }
});

test("verified source migration retains original authors and microseconds and resumes unchanged", async () => {
  const f = await fixture(undefined, true);
  try {
    const source = scriptRow();
    await copyClientScripts(f.client, [source], f.controller.signal);
    const original = structuredClone(f.objects.get("client-script:7"));
    await copyClientScripts(f.client, [source], f.controller.signal);
    expect(f.objects.get("client-script:7")).toEqual(original);
    expect(
      (await f.plain(CLIENT_SCRIPT_COLLECTION, "client-script:7")).row,
    ).toEqual(source);
    await expect(
      copyClientScripts(
        f.client,
        [scriptRow("7", { code: "changed source" })],
        f.controller.signal,
      ),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
});

test("a lost commit acknowledgement is verified, while a false acknowledgement fails", async () => {
  const f = await fixture();
  try {
    f.state.loseReply = true;
    const created = await f.store.mutate("clientScripts.create", {
      name: "Fortsetzbar",
      code,
    });
    expect(await f.store.query("clientScripts.list", {})).toHaveLength(1);
    const mutate = f.client.mutate;
    f.client.mutate = (path, input, options) =>
      path === "zerotrust.objects.batch"
        ? Promise.resolve([{ success: true }, null])
        : mutate(path, input, options);
    await expect(
      f.store.mutate("clientScripts.update", {
        id: created.id,
        data: { name: "Nicht bestätigt" },
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("clientScripts.get", { id: created.id })).name,
    ).toBe("Fortsetzbar");
  } finally {
    f.store.close();
  }
});

test("the application facade routes script operations through the shared encrypted adapter", async () => {
  const f = await fixture();
  const business = createBusinessClient(f.client, {
    productDriver: duckDriver,
  });
  try {
    const [created, error] = await business.mutate("clientScripts.create", {
      name: "Fassade",
      code,
    });
    expect(error).toBeNull();
    expect(created.name).toBe("Fassade");
    const [listed, listError] = await business.query("clientScripts.list", {});
    expect(listError).toBeNull();
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    expect(f.calls.some((call) => call.path.startsWith("clientScripts."))).toBe(
      false,
    );
  } finally {
    business.dispose();
    f.store.close();
  }
});
