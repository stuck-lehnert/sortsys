import { createClient } from "@sortsys/v2-client";
import { Observable } from "rxjs";
import { base64, createAccountVault, createIdentity } from "@sortsys/zerotrust";
import { acceptVault } from "../../app/lib/crypto/session";
import { ramCache } from "../../app/lib/data/ramCache";
import { errorHttpStatus } from "../../app/lib/errorTelemetry";
import {
  API_ENDPOINT,
  client,
  dashboardPreferences,
  gaebDocuments,
  organizationSettings,
  templateAssets,
  reportClientError,
} from "../../app/lib/client";

/** Presentation and interaction tests inject the typed business boundary.
 * Their HTTP responses are synthetic; they do not exercise encryption or the
 * browser database. crypto.browser.mjs and native E2E cover those real paths. */
export async function installPresentationClient() {
  // Hold delivery at the business boundary: encrypted streams can finish
  // decrypting independently even when their HTTP requests share a batch.
  const heldStream = new URLSearchParams(window.location.search).get(
    "holdStream",
  );
  let releaseStream;
  const streamReleased = new Promise((resolve) => {
    releaseStream = resolve;
  });
  window.__sortsysReleasePresentationStream = () => releaseStream();
  const transport = createClient(API_ENDPOINT, "presentation-fixture", {
    cache: ramCache(),
  });
  transport.setToken("sortsys-ui-synthetic-session");
  const [session, sessionError] = await transport.query(
    "auth.sessionInfo",
    undefined,
  );
  if (sessionError) throw sessionError;
  if (!session) throw new Error("The presentation fixture needs a session");
  const identity = await createIdentity();
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(
    exportKey,
    await createAccountVault(
      exportKey,
      "fixture-tenant",
      `user:${session.user.id}`,
      identity,
    ),
    session.user.username,
    false,
  );
  const report = (source, error) => {
    if (error)
      void reportClientError({ source, status: errorHttpStatus(error) });
  };
  client.query = async (...args) => {
    const reply = await transport.query(...args);
    report("client.query", reply[1]);
    return reply;
  };
  client.queryDynamic = async (...args) => {
    const reply = await transport.queryDynamic(...args);
    report("client.queryDynamic", reply[1]);
    return reply;
  };
  client.streamQuery = (...args) =>
    new Observable((subscriber) =>
      transport.streamQuery(...args).subscribe({
        next(reply) {
          report("client.streamQuery", reply[1]);
          if (args[0] === heldStream) {
            void streamReleased.then(() => {
              if (!subscriber.closed) subscriber.next(reply);
            });
          } else {
            subscriber.next(reply);
          }
        },
        error: (error) => subscriber.error(error),
        complete: () => subscriber.complete(),
      }),
    );
  client.mutate = transport.mutate;
  client.mutateDynamic = transport.mutateDynamic;
  client.invalidate = transport.invalidate;
  client.invalidateCascading = transport.invalidateCascading;
  window.__sortsysRefreshPresentation = (path) => transport.invalidate(path);

  const signal = new AbortController().signal;
  const access = {
    context: () => signal,
    subscribe: () => () => {},
    refresh() {},
    async read() {
      const [session, error] = await transport.query(
        "auth.sessionInfo",
        undefined,
      );
      if (error) throw error;
      const roles = session.roles;
      const administrator = roles.includes(":admin");
      const role = (name) =>
        administrator ||
        roles.includes(name) ||
        (name.startsWith("view:") && roles.includes(`manage:${name.slice(5)}`));
      return {
        subject: `user:${session.user.id}`,
        role,
        can: () => administrator,
        canCreate: () => administrator,
        canAny: () => administrator,
        canManagePermissions: () => administrator,
        canSeeOffers: () => administrator,
        canBookTool: () => administrator,
      };
    },
  };
  const listeners = new Set();
  async function changePin(path, input) {
    const [, error] = await transport.mutate(path, input);
    if (error) throw error;
    for (const listener of listeners) listener();
  }
  Object.assign(dashboardPreferences, {
    async get() {
      const [rows, error] = await transport.query(
        "personalization.dashboard.pins.get",
        undefined,
      );
      if (error) throw error;
      return rows;
    },
    listen(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    pin: (value) => changePin("personalization.dashboard.pins.pin", value),
    unpin: (path) =>
      changePin("personalization.dashboard.pins.unpin", { path }),
    move: (value) => changePin("personalization.dashboard.pins.move", value),
    importLocal: (entries) =>
      changePin("personalization.dashboard.pins.import", { entries }),
  });
  async function editSettings(query, mutation) {
    const [value, error] = await transport.query(query, undefined);
    if (error) throw error;
    return {
      value,
      async save(next) {
        const [, error] = await transport.mutate(mutation, next);
        if (error) throw error;
      },
    };
  }
  Object.assign(organizationSettings, {
    profile: () =>
      editSettings("settings.organization.get", "settings.organization.set"),
    numbering: () =>
      editSettings(
        "settings.invoiceNumbering.get",
        "settings.invoiceNumbering.set",
      ),
  });
  gaebDocuments.open = async (caseId, id) => {
    const [session, error] = await transport.query(
      "commercial.documents.get",
      { caseId, id },
      { strategy: "network-only" },
    );
    if (error) throw error;
    return session;
  };
  // These cases test layout and ordinary editing. Native protocol tests own
  // the encrypted live transport; dedicated live cases supply their own room.
  gaebDocuments.live = async (options) => {
    options.onParticipants([]);
    options.onStatus("online");
    return {
      field() {},
      selection() {},
      saved() {},
      async flush() {},
      close() {},
    };
  };
  const uploadedAssets = new Map();
  templateAssets.blob = async (id, version, signal) => {
    signal?.throwIfAborted();
    const asset = uploadedAssets.get(id);
    if (version !== "legacy") {
      throw new Error("Unknown synthetic template asset");
    }
    if (asset) return asset;
    // Reloaded print previews read the same synthetic fixture bytes again.
    const response = await fetch(`/template-test/${encodeURIComponent(id)}`, {
      signal,
    });
    if (!response.ok) throw new Error("Synthetic asset read failed");
    return response.blob();
  };
  templateAssets.upload = async (file) => {
    const [upload, createError] = await transport.mutateDynamic(
      "fixture.documentTemplate.assets.createUpload",
      { fileName: file.name, mimeType: file.type, sizeBytes: file.size },
    );
    if (createError) throw createError;
    const response = await fetch(upload.uploadUrl, {
      method: upload.uploadMethod,
      headers: upload.uploadHeaders,
      body: file,
    });
    if (!response.ok) throw new Error("Synthetic asset upload failed");
    const [, completeError] = await transport.mutateDynamic(
      "fixture.documentTemplate.assets.completeUpload",
      { id: upload.id },
    );
    if (completeError) throw completeError;
    uploadedAssets.set(upload.id, file);
  };
  return access;
}
