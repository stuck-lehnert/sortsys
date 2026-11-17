import type { Client } from "@sortsys/v2-client";
import { DEFAULT_GAEB_VIEW } from "@sortsys/gaeb";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { required, type Collection } from "./protectedObjects";
import { provisionOwnedCollections } from "./prepareCollections";
import {
  accountLocale,
  gaebView,
  gaebViewCollection,
  gaebViewObject,
  preferencePayload,
} from "./preferenceData";
import { defineDataModel } from "./runtime/model";
import { acquireDataRuntime } from "./runtime/session";
import type { DuckDriver } from "./database";
import { unlockedAccount } from "../crypto/session";

const model = defineDataModel({
  name: "preferences",
  decode(value: unknown, id: string, area: Collection) {
    return preferencePayload(
      value,
      id,
      area.scope.slice("preferences:".length),
    );
  },
});
export function createProtectedPreferences(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime;
  async function request() {
    lease.live();
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    lease.live();
    const subject = `user:${session.user.id}`,
      area = gaebViewCollection(subject);
    const domains = await required(
      client.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    );
    lease.live();
    if (!domains.some((domain) => domain.id === area.domain)) {
      if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
      await provisionOwnedCollections(client, subject, [area], signal);
      lease.live();
    }
    return { model, area };
  }
  return {
    async setLanguage(input: unknown, cancellation?: AbortSignal) {
      const locale = accountLocale(input);
      const lifetime = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      const live = () => {
        lifetime.throwIfAborted();
        lease.live();
      };
      live();
      const before = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      if (unlockedAccount()?.vault.subject !== `user:${before.user.id}`)
        throw new InvalidProtectedData();
      let failure: unknown;
      try {
        await required(
          client.mutate(
            "settings.language.set",
            { locale },
            { signal: lifetime },
          ),
        );
      } catch (error) {
        failure = error;
      }
      live();
      const saved = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      if (
        saved.user.id !== before.user.id ||
        saved.user.username !== before.user.username ||
        saved.user.locale !== locale
      ) {
        throw failure ?? new InvalidProtectedData();
      }
      await client.invalidate("auth.sessionInfo");
      live();
      return { success: true as const };
    },
    async get() {
      const selected = await request();
      const value = await runtime.read(
        [selected],
        (view) =>
          view.documents(selected)[0]?.value.view ?? { ...DEFAULT_GAEB_VIEW },
      );
      lease.live();
      return value;
    },
    async set(input: unknown) {
      const view = gaebView(input),
        selected = await request(),
        subject = selected.area.scope.slice("preferences:".length),
        id = gaebViewObject(subject);
      await runtime.transaction(
        [selected],
        (tx) => {
          const previous = tx.documents(selected);
          if (previous.length > 1) throw new InvalidProtectedData();
          if (previous[0]) {
            if (JSON.stringify(previous[0].value.view) !== JSON.stringify(view))
              tx.edit(selected, id, (value) => {
                value.view = view;
              });
          } else
            tx.create(selected, id, {
              format: "sortsys-preferences-v1",
              subject,
              view,
            });
        },
        { retries: 2 },
      );
      lease.live();
      return { success: true as const };
    },
    async refresh() {
      lease.live();
      runtime.invalidate();
    },
    close: lease.close,
  };
}
