import { expect, spyOn, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import * as migration from "../crypto/migrationOrigin";
import { copyProtectedSingletons } from "./copyCollection";

test.each(["lost reply", "different body", "different signature", "changed target"])(
  "singleton copies check the guarded publication after %s",
  async (outcome) => {
    const signal = new AbortController().signal;
    const area = { domain: "fixture:records", prefix: "record:" };
    const row = { id: "record:1", value: { total: 32 } };
    const unrelated = { envelope: { object: "record:10" }, value: { total: 2 } };
    const packet = {
      domain: area.domain,
      envelope: { object: row.id, signature: "expected", ciphertext: "encrypted" },
      migrationOrigin: { signature: "source-authority" },
    };
    const saved = { envelope: packet.envelope, value: row.value };

    let existing = outcome === "changed target"
      ? [{ ...saved, value: { total: 31 } }, unrelated]
      : [unrelated];
    const pages = [];
    let closed = 0;
    const open = Object.assign(() => ({
      read: async () => existing,
      packet: async () => ({ domain: area.domain, envelope: packet.envelope }),
      snapshot: () => "7",
      close() { closed++; },
    }), {
      async prefetch([{ area }]) { pages.push(area.prefix); },
    });
    const lostReply = new Error("Reply lost after write");
    const commits = [];
    const client = {
      async invalidate() {},
      async mutate(path, input) {
        expect(path).toBe("zerotrust.objects.batch");
        commits.push(input);

        const confirmed = outcome === "different signature"
          ? { ...saved, envelope: { ...saved.envelope, signature: "other" } }
          : outcome === "different body"
            ? { ...saved, value: { total: 31 } }
            : saved;
        existing = [confirmed, unrelated];
        throw lostReply;
      },
    };
    const attest = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
      async (value) => ({ ...value, migrationOrigin: packet.migrationOrigin }),
    );
    const entries = [{ area, row, partial: true, validate: (value) => value }];
    const copy = () => copyProtectedSingletons(client, entries, signal, open);

    try {
      if (outcome === "changed target") {
        await expect(copy()).rejects.toBeInstanceOf(InvalidProtectedData);
        expect(pages).toEqual([row.id]);
        expect(commits).toHaveLength(0);
        expect(attest).not.toHaveBeenCalled();
        expect(closed).toBe(1);
        return;
      }

      if (outcome === "lost reply") {
        await copy();
        await copy(); // Exact replay reads but neither signs nor writes again.
      } else {
        await expect(copy()).rejects.toBe(lostReply);
      }

      const attempts = outcome === "lost reply" ? 2 : 1;
      expect(pages).toEqual(Array(attempts + 1).fill(row.id));
      expect(commits).toHaveLength(1);
      expect(commits[0].heads).toEqual([{ domain: area.domain, sequence: "7" }]);
      expect(commits[0].objects).toEqual([packet]);
      expect(attest).toHaveBeenCalledTimes(1);
      expect(closed).toBe(attempts);
      expect(existing[1]).toBe(unrelated);
    } finally {
      attest.mockRestore();
    }
  },
);
