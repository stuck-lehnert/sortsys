import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { createBusinessClient } from "./businessClient";
import { accountLocale } from "./preferenceData";
import { createProtectedPreferences } from "./preferences";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture() {
  const f = await protectedTenant([]);
  const metadata = {
    locale: "de",
    username: "owner",
    id: "1",
    loseReply: false,
    discard: false,
    afterSave: async () => {},
  };
  const query = f.client.query;
  f.client.query = async (path, input, options) => {
    const response = await query(path, input, options);
    if (path !== "auth.sessionInfo") return response;
    return [
      {
        ...response[0],
        user: {
          ...response[0].user,
          locale: metadata.locale,
          username: metadata.username,
          id: metadata.id,
        },
      },
      null,
    ];
  };
  const invalidate = [];
  f.client.invalidate = async (path) => {
    invalidate.push(path);
  };
  const mutate = f.client.mutate;
  f.client.mutate = async (path, input, options) => {
    if (path !== "settings.language.set") return mutate(path, input, options);
    f.calls.push({ path, input: structuredClone(input) });
    if (!metadata.discard) metadata.locale = input.locale;
    await metadata.afterSave();
    if (metadata.loseReply) throw new Error("Lost language acknowledgement");
    return [{ success: true }, null];
  };
  const controller = new AbortController();
  const driver = async () => {
    throw new Error("Account language must not open the private database");
  };
  const store = createProtectedPreferences(f.client, controller.signal, driver);
  return { ...f, metadata, invalidate, controller, driver, store };
}

test("language input is a closed metadata enum with no target user or business fields", () => {
  expect(accountLocale({ locale: "de" })).toBe("de");
  expect(accountLocale({ locale: "en" })).toBe("en");
  for (const input of [
    null,
    {},
    { locale: "fr" },
    { locale: 1 },
    { locale: "en", userId: "2" },
    { locale: "en", firstName: "Forged" },
  ]) {
    expect(() => accountLocale(input)).toThrow();
  }
});

test("ordinary accounts can change language without personnel or encrypted preference grants", async () => {
  const f = await fixture();
  try {
    expect(await f.store.setLanguage({ locale: "en" })).toEqual({
      success: true,
    });
    expect(f.metadata.locale).toBe("en");
    expect(f.invalidate).toEqual(["auth.sessionInfo"]);
    expect(f.calls.map((call) => call.path)).toEqual([
      "auth.sessionInfo",
      "settings.language.set",
      "auth.sessionInfo",
    ]);
    expect(f.objects.size).toBe(0);
  } finally {
    f.store.close();
  }
});

test("lost replies are confirmed by own-session metadata and false acknowledgements fail", async () => {
  const f = await fixture();
  try {
    f.metadata.loseReply = true;
    await f.store.setLanguage({ locale: "en" });
    f.metadata.loseReply = false;
    f.metadata.discard = true;
    await expect(f.store.setLanguage({ locale: "de" })).rejects.toThrow();
    expect(f.metadata.locale).toBe("en");
    expect(f.invalidate).toEqual(["auth.sessionInfo"]);
  } finally {
    f.store.close();
  }
});

test("a response for a different authenticated account never confirms the language change", async () => {
  const f = await fixture();
  try {
    f.metadata.id = "2";
    await expect(f.store.setLanguage({ locale: "en" })).rejects.toThrow();
    expect(f.calls.some((call) => call.path === "settings.language.set")).toBe(
      false,
    );
    f.metadata.id = "1";
    f.metadata.afterSave = async () => {
      f.metadata.id = "2";
    };
    await expect(f.store.setLanguage({ locale: "en" })).rejects.toThrow();
    expect(f.invalidate).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("a renamed account keeps its language preference through its stable identity", async () => {
  const f = await fixture();
  try {
    f.metadata.username = "renamed-owner";
    await expect(f.store.setLanguage({ locale: "en" })).resolves.toEqual({
      success: true,
    });
    expect(f.metadata.locale).toBe("en");
    expect(f.invalidate).toEqual(["auth.sessionInfo"]);
  } finally {
    f.store.close();
  }
});

test("locking during a pending change discards the late acknowledgement", async () => {
  const f = await fixture();
  let release;
  let admitted;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    admitted = resolve;
  });
  try {
    f.metadata.afterSave = async () => {
      admitted();
      await waiting;
    };
    const operation = f.store.setLanguage({ locale: "en" });
    await started;
    await lockCryptoSession();
    release();
    await expect(operation).rejects.toThrow();
    expect(f.invalidate).toEqual([]);
    expect(
      f.calls.filter((call) => call.path === "auth.sessionInfo"),
    ).toHaveLength(1);
  } finally {
    release();
    f.store.close();
  }
});

test("explicit cancellation prevents a pending reply from refreshing the new view", async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  try {
    f.metadata.afterSave = async () => {
      cancellation.abort();
    };
    await expect(
      f.store.setLanguage({ locale: "en" }, cancellation.signal),
    ).rejects.toThrow();
    expect(f.invalidate).toEqual([]);
  } finally {
    f.store.close();
  }
});

test("the application facade validates language instead of allowing arbitrary settings traffic", async () => {
  const f = await fixture();
  const business = createBusinessClient(f.client, { productDriver: f.driver });
  try {
    expect(
      (await business.mutate("settings.language.set", { locale: "en" }))[1],
    ).toBeNull();
    expect(f.metadata.locale).toBe("en");
    const count = f.calls.length;
    expect(
      (
        await business.mutateDynamic("settings.language.set", {
          locale: "de",
          firstName: "Forged",
        })
      )[1],
    ).not.toBeNull();
    expect(
      (
        await business.mutateDynamic("settings.unreviewed.set", {
          locale: "de",
        })
      )[1],
    ).not.toBeNull();
    expect(f.calls).toHaveLength(count);
  } finally {
    business.dispose();
    f.store.close();
  }
});
