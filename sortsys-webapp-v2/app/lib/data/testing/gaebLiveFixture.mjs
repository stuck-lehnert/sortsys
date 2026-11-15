import { SharedFields, createGaebXml } from "@sortsys/gaeb";
import { lockCryptoSession } from "../../crypto/session";
import { commercialCollection, COMMERCIAL_FACETS } from "../commercialAreas";
import { protectedTenant } from "./protectedTenant.mjs";
import { announceDocumentMessage } from "../documentMessageHints";
import { connectProtectedGaebLive } from "../gaebLive";

async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("Live peers did not converge");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export async function createGaebLiveFixture() {
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("4", facet)),
  );
  const room = { scope: "commercial:4", document: "5", facet: "scope" };
  const messages = [];
  const presence = new Map();
  const requests = [];
  const state = {
    beforeQuery: async () => {},
    afterPost: async () => {},
  };
  const queryOriginal = tenant.client.query;
  const mutateOriginal = tenant.client.mutate;
  tenant.client.query = async (path, input, options) => {
    await state.beforeQuery(path, input);
    if (path !== "zerotrust.documents.messages.read") {
      return queryOriginal(path, input, options);
    }
    const selected = messages.filter(
      (message) =>
        message.channel === input.room.facet &&
        BigInt(message.sequence) > BigInt(input.after),
    );
    const page = selected.slice(0, 32);
    return [
      {
        messages: structuredClone(page),
        presence: structuredClone(
          [...presence.values()].filter(
            (message) => message.channel === input.room.facet,
          ),
        ),
        after: page.at(-1)?.sequence ?? input.after,
        more: selected.length > 32,
      },
      null,
    ];
  };
  tenant.client.mutate = async (path, input, options) => {
    if (path !== "zerotrust.documents.messages.post") {
      return mutateOriginal(path, input, options);
    }
    requests.push(structuredClone(input));
    const message = {
      ...structuredClone(input),
      channel: input.room.facet,
      sequence: input.kind === "presence" ? "0" : String(messages.length + 1),
    };
    delete message.room;
    if (input.kind === "presence") {
      presence.set(`${input.room.facet}:${input.key}`, message);
    } else {
      const previous = messages.find(
        (entry) =>
          entry.channel === input.room.facet &&
          entry.kind === input.kind &&
          entry.key === input.key,
      );
      if (!previous) {
        messages.push(message);
      } else if (
        input.kind === "update" &&
        previous.envelope.signature !== input.envelope.signature
      ) {
        return [
          null,
          Object.assign(new Error("Conflicting live retry"), {
            code: "CONFLICT",
          }),
        ];
      }
    }
    queueMicrotask(() => announceDocumentMessage(tenant.client, input.room));
    await state.afterPost(input);
    return [{ success: true }, null];
  };
  const close = [];
  function peer(
    name,
    initial = "Hallo Welt",
    {
      extraFields = [],
      readableFacets = ["scope"],
      xml = createGaebXml("84", "Beispiel", "2026-11-12"),
    } = {},
  ) {
    const sharedFields = new SharedFields();
    sharedFields.register(
      new Map([
        ...extraFields.map((field) => [field.key, field]),
        [
          "item-a:text:0",
          {
            key: "item-a:text:0",
            value: initial,
            multiline: true,
            editable: true,
            label: "Text",
            commit() {},
          },
        ],
      ]),
    );
    let people = [];
    const peopleUpdates = [];
    let status = "connecting";
    let rejected = 0;
    const lifetime = new AbortController();
    const connection = connectProtectedGaebLive(tenant.client, {
      room: { scope: room.scope, document: room.document },
      readableFacets,
      initial: {
        xml,
        fileName: "Angebot.x84",
        version: 1n,
        canEdit: true,
      },
      sharedFields,
      signal: lifetime.signal,
      name,
      onParticipants(value) {
        people = value;
        peopleUpdates.push(structuredClone(value));
      },
      onStatus(value) {
        status = value;
      },
      onRejectedMessage() {
        rejected += 1;
      },
    });
    close.push(() => {
      lifetime.abort();
      connection.close();
      sharedFields.destroy();
    });
    return {
      sharedFields,
      connection,
      people: () => people,
      peopleUpdates: () => peopleUpdates,
      status: () => status,
      rejected: () => rejected,
    };
  }
  return {
    peer,
    tenant,
    room,
    state,
    presence,
    requests,
    messages,
    close() {
      for (const cleanup of close) {
        cleanup();
      }
    },
  };
}

export async function encryptedGaebLiveScenario() {
  const session = await createGaebLiveFixture();
  try {
    const first = session.peer("Erste Bearbeiterin 726491");
    const second = session.peer("Zweiter Bearbeiter 892461");
    await first.connection.flush();
    await second.connection.flush();
    const initializerCandidates = session.messages.filter(
      (message) => message.kind === "initialize",
    ).length;
    const baseline = [
      first.sharedFields.value("item-a:text:0"),
      second.sharedFields.value("item-a:text:0"),
    ];
    first.sharedFields.edit("item-a:text:0", "Hallo Welt", "Hallo schöne Welt");
    second.sharedFields.edit("item-a:text:0", "Hallo Welt", "Hallo 👋 Welt");
    await first.connection.flush();
    await second.connection.flush();
    await waitFor(
      () =>
        first.sharedFields.value("item-a:text:0") ===
        second.sharedFields.value("item-a:text:0"),
    );
    const writesBeforeTyping = session.requests.filter(
      (request) => request.kind === "update",
    ).length;
    for (const character of "12345678901234567890") {
      const previous = first.sharedFields.value("item-a:text:0");
      first.sharedFields.edit("item-a:text:0", previous, previous + character);
    }
    await first.connection.flush();
    await waitFor(
      () =>
        first.sharedFields.value("item-a:text:0") ===
        second.sharedFields.value("item-a:text:0"),
    );
    const typingWrites =
      session.requests.filter((request) => request.kind === "update").length -
      writesBeforeTyping;
    const merged = first.sharedFields.value("item-a:text:0");
    const late = session.peer("Später Beitritt");
    await late.connection.flush();
    first.connection.selection({ field: "item-a:text:0", start: 6, end: 12 });
    await waitFor(() =>
      second
        .people()
        .some(
          (person) =>
            person.name === "Erste Bearbeiterin 726491" &&
            person.field === "item-a:text:0",
        ),
    );
    const wire = JSON.stringify(session.requests);
    return {
      initializerCandidates,
      baseline,
      merged,
      typingWrites,
      late: late.sharedFields.value("item-a:text:0"),
      participants: second.people(),
      leaks: ["Hallo", "schöne", "Bearbeiterin 726491", "item-a:text:0"].filter(
        (secret) => wire.includes(secret),
      ),
    };
  } finally {
    session.close();
    await lockCryptoSession();
  }
}
