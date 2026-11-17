import { initializeSharedField, SharedFields } from "@sortsys/gaeb";
import { signPolicy } from "@sortsys/zerotrust/sortsys";
import { announceDataChanges } from "../runtime/changes";
import { protectedTenant } from "./protectedTenant.mjs";
import { commercialCollection, COMMERCIAL_FACETS } from "../commercialAreas";
import { lockCryptoSession } from "../../crypto/session";
import { createGaebLiveFixture } from "./gaebLiveFixture.mjs";
import { openDocumentMessages } from "../documentMessages";
import { announceDocumentMessage } from "../documentMessageHints";

const FIELD = "item-a:text:0";
async function waitFor(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("Live synchronization timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
async function failureOf(operation) {
  try {
    await operation();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
async function writerFor(session) {
  const writer = await openDocumentMessages(
    session.tenant.client,
    session.room,
    new AbortController().signal,
  );
  return {
    ...writer,
    post(kind, value, ...options) {
      return writer.post(kind, { facet: "scope", ...value }, ...options);
    },
  };
}
function appendTextUpdate(initial, text) {
  const fields = new SharedFields();
  const messages = [];
  try {
    fields.register(
      new Map([
        [
          FIELD,
          {
            key: FIELD,
            value: "Hallo Welt",
            multiline: true,
            editable: true,
            label: "Text",
            commit() {},
          },
        ],
      ]),
    );
    fields.receiveInitialization(FIELD, "Hallo Welt", initial);
    fields.connect((message) => messages.push(message), true);
    messages.length = 0;
    fields.edit(FIELD, "Hallo Welt", text);
    return messages.find((message) => message.type === "update").data;
  } finally {
    fields.destroy();
  }
}
async function recoverBootstrap() {
  const session = await createGaebLiveFixture();
  let fail = true;
  session.state.beforeQuery = async (path) => {
    if (path === "zerotrust.policy.get" && fail) {
      throw new Error("Temporary policy outage");
    }
  };
  try {
    const peer = session.peer("Bearbeiterin");
    const failure = await failureOf(() => peer.connection.flush());
    peer.sharedFields.edit(FIELD, "Hallo Welt", "Hallo offline Welt");
    fail = false;
    await waitFor(() => peer.status() === "online");
    await peer.connection.flush();
    const late = session.peer("Später Beitritt");
    await late.connection.flush();
    return {
      failure,
      text: peer.sharedFields.value(FIELD),
      late: late.sharedFields.value(FIELD),
      rejected: peer.rejected(),
    };
  } finally {
    session.close();
  }
}
async function poisonedInitializer() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  try {
    await writer.post("initialize", {
      field: FIELD,
      value: "Falsche Grundlage",
      data: initializeSharedField(FIELD, "Anderer Text"),
    });
    const peer = session.peer("Bearbeiter");
    const covered = (await peer.connection.flush()).scope;
    const initial = peer.sharedFields.value(FIELD);
    const count = session.messages.length;
    peer.sharedFields.edit(FIELD, "Hallo Welt", "Hallo Baustelle");
    await peer.connection.flush();
    const late = session.peer("Später Beitritt");
    await late.connection.flush();
    return {
      initial,
      covered,
      count,
      rejected: peer.rejected(),
      late: late.sharedFields.value(FIELD),
    };
  } finally {
    writer.close();
    session.close();
  }
}
async function corruptPackets() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  try {
    const initial = initializeSharedField(FIELD, "Hallo Welt");
    await writer.post("initialize", {
      field: FIELD,
      value: "Hallo Welt",
      data: initial,
    });
    await writer.post("update", { data: "not CRDT data" });
    await writer.post("update", { data: "AAAA" });
    session.messages.at(-1).envelope.signature = "A".repeat(86);
    await writer.post("presence", {
      name: 37,
      selection: { field: FIELD },
      left: false,
    });
    await writer.post("update", {
      data: appendTextUpdate(initial, "Hallo gültige Welt"),
    });
    const peer = session.peer("Bearbeiterin");
    const covered = (await peer.connection.flush()).scope;
    return {
      text: peer.sharedFields.value(FIELD),
      people: peer.people(),
      rejected: peer.rejected(),
      covered,
      count: session.messages.length,
      status: peer.status(),
    };
  } finally {
    writer.close();
    session.close();
  }
}
async function unavailableProof() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  let fail = true;
  let messageReads = 0;
  try {
    const initial = initializeSharedField(FIELD, "Hallo Welt");
    await writer.post("initialize", {
      field: FIELD,
      value: "Hallo Welt",
      data: initial,
    });
    await writer.post("update", {
      data: appendTextUpdate(initial, "Hallo geprüfte Welt"),
    });
    session.state.beforeQuery = async (path) => {
      if (path === "zerotrust.documents.messages.read") {
        messageReads += 1;
      }
      if (messageReads > 0 && path === "zerotrust.keys.get" && fail) {
        throw new Error("Temporary key service outage");
      }
    };
    const peer = session.peer("Bearbeiterin");
    const failure = await failureOf(() => peer.connection.flush());
    const before = peer.sharedFields.value(FIELD) ?? null;
    fail = false;
    await peer.connection.flush();
    return {
      failure,
      before,
      text: peer.sharedFields.value(FIELD),
      rejected: peer.rejected(),
    };
  } finally {
    writer.close();
    session.close();
  }
}
async function invalidPageBoundary() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  const query = session.tenant.client.query;
  let corrupt = true;
  try {
    const initial = initializeSharedField(FIELD, "Hallo Welt");
    await writer.post("initialize", {
      field: FIELD,
      value: "Hallo Welt",
      data: initial,
    });
    await writer.post("update", {
      data: appendTextUpdate(initial, "Hallo geprüfte Welt"),
    });
    session.tenant.client.query = async (path, input, options) => {
      const result = await query(path, input, options);
      if (path === "zerotrust.documents.messages.read" && corrupt) {
        return [{ ...result[0], after: "999" }, null];
      }
      return result;
    };
    const peer = session.peer("Bearbeiterin");
    const failure = await failureOf(() => peer.connection.flush());
    const before = peer.sharedFields.value(FIELD) ?? null;
    corrupt = false;
    await peer.connection.flush();
    return {
      failure,
      before,
      text: peer.sharedFields.value(FIELD),
      rejected: peer.rejected(),
    };
  } finally {
    writer.close();
    session.close();
  }
}
async function closedBootstrap() {
  const session = await createGaebLiveFixture();
  let reads = 0;
  session.state.beforeQuery = async (path) => {
    if (path === "zerotrust.policy.get") {
      reads += 1;
      throw new Error("Offline");
    }
  };
  try {
    const peer = session.peer("Bearbeiter");
    const failure = await failureOf(() => peer.connection.flush());
    session.close();
    const stoppedAt = reads;
    announceDocumentMessage(session.tenant.client, session.room);
    await new Promise((resolve) => setTimeout(resolve, 650));
    return { failure, stoppedAt, reads };
  } finally {
    session.close();
  }
}
async function unavailableHistoricalPolicy() {
  const session = await createGaebLiveFixture();
  const query = session.tenant.client.query;
  session.tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.policy.get") {
      return [session.tenant.setup.policy, null];
    }
    return query(path, input, options);
  };
  const writer = await writerFor(session);
  session.tenant.client.query = query;
  let fail = true;
  let proofReads = 0;
  try {
    const initial = initializeSharedField(FIELD, "Hallo Welt");
    await writer.post("initialize", {
      field: FIELD,
      value: "Hallo Welt",
      data: initial,
    });
    session.state.beforeQuery = async (path) => {
      if (path === "zerotrust.policy.getVersion") {
        proofReads += 1;
        if (fail) {
          throw new Error("Historical policy unavailable");
        }
      }
    };
    const peer = session.peer("Bearbeiterin");
    const failure = await failureOf(() => peer.connection.flush());
    const before = peer.sharedFields.value(FIELD) ?? null;
    fail = false;
    await peer.connection.flush();
    return {
      failure,
      before,
      text: peer.sharedFields.value(FIELD),
      rejected: peer.rejected(),
      proofReads,
    };
  } finally {
    writer.close();
    session.close();
  }
}
async function lostUpdateReply() {
  const session = await createGaebLiveFixture();
  let lost = 0;
  try {
    const peer = session.peer("Bearbeiterin");
    await peer.connection.flush();
    session.state.afterPost = async (packet) => {
      if (packet.kind === "update" && lost < 3) {
        lost += 1;
        throw new Error("Lost live acknowledgement");
      }
    };
    peer.sharedFields.edit(FIELD, "Hallo Welt", "Hallo gespeicherte Welt");
    const failure = await failureOf(() => peer.connection.flush());
    await waitFor(() => peer.status() === "online");
    await peer.connection.flush();
    const late = session.peer("Später Beitritt");
    await late.connection.flush();
    const retries = session.requests
      .filter((packet) => packet.kind === "update")
      .slice(0, 3);
    return {
      failure,
      lost,
      text: peer.sharedFields.value(FIELD),
      late: late.sharedFields.value(FIELD),
      sameRetry:
        new Set(retries.map((packet) => packet.envelope.signature)).size === 1,
      rejected: peer.rejected(),
    };
  } finally {
    session.close();
  }
}
async function revokedDuringRead() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  let release;
  let entered = false;
  let held = true;
  let policy;
  const query = session.tenant.client.query;
  try {
    const peer = session.peer("Bearbeiterin");
    const initial = initializeSharedField(FIELD, "Hallo Welt");
    await writer.post("initialize", {
      field: FIELD,
      value: "Hallo Welt",
      data: initial,
    });
    await peer.connection.flush();
    session.state.beforeQuery = async (path) => {
      if (path === "zerotrust.documents.messages.read" && held) {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    };
    await writer.post("update", {
      data: appendTextUpdate(initial, "Nicht mehr freigegebener Text"),
    });
    await waitFor(() => entered);
    policy = await signPolicy(
      { tenant: "test", version: "3", rules: [] },
      session.tenant.authorityKey.privateKey,
    );
    session.tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.policy.get") {
        return [policy, null];
      }
      return query(path, input, options);
    };
    announceDataChanges(session.tenant.client, undefined, { control: true });
    held = false;
    release();
    const failure = await failureOf(() => peer.connection.flush());
    return {
      failure,
      text: peer.sharedFields.value(FIELD),
      rejected: peer.rejected(),
      status: peer.status(),
    };
  } finally {
    held = false;
    release?.();
    writer.close();
    session.close();
  }
}
async function revokedPresence() {
  const session = await createGaebLiveFixture();
  const current = await writerFor(session);
  const query = session.tenant.client.query;
  session.tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.policy.get") {
      return [session.tenant.setup.policy, null];
    }
    return query(path, input, options);
  };
  const historical = await writerFor(session);
  session.tenant.client.query = query;
  let release;
  let entered = false;
  let held = true;
  try {
    await current.post(
      "presence",
      { name: "Frühere Bearbeiterin", selection: { field: null }, left: false },
      "A".repeat(43),
    );
    await historical.post(
      "presence",
      { name: "Weiterer Bearbeiter", selection: { field: null }, left: false },
      "B".repeat(43),
    );
    session.state.beforeQuery = async (path) => {
      if (path === "zerotrust.policy.getVersion" && held) {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
    };
    const peer = session.peer("Bearbeiterin");
    await waitFor(() => entered);
    const policy = await signPolicy(
      { tenant: "test", version: "3", rules: [] },
      session.tenant.authorityKey.privateKey,
    );
    session.tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.policy.get") {
        return [policy, null];
      }
      return query(path, input, options);
    };
    announceDataChanges(session.tenant.client, undefined, { control: true });
    held = false;
    release();
    const failure = await failureOf(() => peer.connection.flush());
    return {
      failure,
      publishedNames: peer
        .peopleUpdates()
        .flatMap((people) => people.map((person) => person.name)),
      people: peer.people(),
    };
  } finally {
    held = false;
    release?.();
    current.close();
    historical.close();
    session.close();
  }
}
async function replacedAccount() {
  const session = await createGaebLiveFixture();
  let release;
  let entered = false;
  let held = true;
  let reads = 0;
  session.state.beforeQuery = async (path) => {
    reads += 1;
    if (path === "zerotrust.documents.messages.read" && held) {
      entered = true;
      await new Promise((resolve) => {
        release = resolve;
      });
    }
  };
  try {
    const peer = session.peer("Vorheriges Konto");
    await waitFor(() => entered);
    await protectedTenant(
      COMMERCIAL_FACETS.map((facet) => commercialCollection("4", facet)),
    );
    held = false;
    release();
    const failure = await failureOf(() => peer.connection.flush());
    const stoppedAt = reads;
    announceDocumentMessage(session.tenant.client, session.room);
    await new Promise((resolve) => setTimeout(resolve, 650));
    return {
      failure,
      stoppedAt,
      reads,
      text: peer.sharedFields.value(FIELD) ?? null,
      rejected: peer.rejected(),
    };
  } finally {
    held = false;
    release?.();
    session.close();
  }
}
async function staleBootstrapPolicy() {
  const session = await createGaebLiveFixture();
  const writer = await writerFor(session);
  const query = session.tenant.client.query;
  let held = true;
  let entered = false;
  let release;
  let newerPolicy;
  try {
    const initial = initializeSharedField(FIELD, "Vertraulicher Ausgangstext");
    await writer.post("initialize", {
      field: FIELD,
      value: "Vertraulicher Ausgangstext",
      data: initial,
    });
    session.tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.policy.get" && newerPolicy) {
        return [newerPolicy, null];
      }
      const result = await query(path, input, options);
      if (path === "zerotrust.policy.get" && held) {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return result;
    };
    const peer = session.peer("Bearbeiterin");
    await waitFor(() => entered);
    newerPolicy = await signPolicy(
      { tenant: "test", version: "3", rules: [] },
      session.tenant.authorityKey.privateKey,
    );
    announceDataChanges(session.tenant.client, undefined, { control: true });
    held = false;
    release();
    const failure = await failureOf(() => peer.connection.flush());
    return {
      failure,
      text: peer.sharedFields.value(FIELD) ?? null,
      rejected: peer.rejected(),
    };
  } finally {
    held = false;
    release?.();
    writer.close();
    session.close();
  }
}
const scenarios = {
  staleBootstrapPolicy,
  revokedPresence,
  replacedAccount,
  unavailableHistoricalPolicy,
  lostUpdateReply,
  revokedDuringRead,
  recoverBootstrap,
  poisonedInitializer,
  corruptPackets,
  unavailableProof,
  invalidPageBoundary,
  closedBootstrap,
};
export async function runLiveFaultScenario(name) {
  try {
    return await scenarios[name]();
  } finally {
    await lockCryptoSession();
  }
}
