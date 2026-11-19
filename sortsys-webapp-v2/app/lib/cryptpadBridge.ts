/** Browser-only subset of CryptPad's integration protocol. Source reference:
 * cryptpad/cryptpad@86dc5ae80daa47f3b46487da9b33aeeb38846899/www/integration/main.js
 * No source URL, server callback or document key is placed in an HTTP request.
 */
export type OfficeSession = { editKey: string; viewKey: string };
type Options = {
  iframe: HTMLIFrameElement;
  editorOrigin: string;
  document: Blob;
  fileName: string;
  application: "doc" | "sheet" | "presentation" | "diagram";
  locale: "de" | "en";
  canEdit: boolean;
  /** Project rooms must survive service restarts; unsaved exports are temporary. */
  persistentSession?: boolean;
  accessKey?: string;
  viewKey?: string;
  /** A recovery must not silently replace a missing shared room with the
   * last confirmed file. The caller can offer that as an explicit choice. */
  requireExistingSession?: boolean;
  /** Persist both capabilities encrypted under the file's appropriate rights.
   * Resolve only after commit; return the winner if another editor initialized it. */
  publishSession: (
    previous: string | undefined,
    proposed: OfficeSession,
  ) => Promise<OfficeSession>;
  save: (document: Blob) => Promise<void>;
  onReady: () => void;
  onError: () => void;
  onSaveError?: (error: unknown) => void;
  onDirty?: (dirty: boolean) => void;
  onSession?: (shared: boolean) => void;
};
const MAX_DOCUMENT = 512 * 1024 * 1024;
const MAX_MESSAGES = 32;
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 8192 &&
    !value.includes("\0")
  );
}

export function openCryptPad(options: Options): {
  close(): void;
  saveCurrent(): void;
  export(
    format:
      | "docx"
      | "xlsx"
      | "pptx"
      | "pdf"
      | "odt"
      | "ods"
      | "odp"
      | "csv"
      | "txt"
      | "drawio",
  ): Promise<Blob>;
} {
  const origin = new URL(options.editorOrigin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (
    origin.origin === window.location.origin ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password ||
    (origin.protocol !== "https:" && !(local && origin.protocol === "http:")) ||
    options.document.size > MAX_DOCUMENT
  ) {
    throw new Error("Invalid private editor configuration");
  }
  const iframe = options.iframe;
  const editor = iframe.contentWindow;
  if (!editor) throw new Error("Editor frame is unavailable");
  let closed = false,
    booting = false,
    started = false,
    ready = false,
    exportFailed = false,
    saves = 0;
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: () => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const received = new Set<string>();
  let saveQueue = Promise.resolve();
  let exporting:
    | {
        resolve: (document: Blob) => void;
        reject: () => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  const failExport = () => {
    // Upstream export replies carry no request identifier. After an incomplete
    // export, a new request could otherwise consume the previous late reply.
    exportFailed = true;
    const operation = exporting;
    exporting = undefined;
    if (operation) {
      clearTimeout(operation.timer);
      operation.reject();
    }
  };
  const post = (message: unknown) => {
    if (!closed) editor.postMessage(message, origin.origin);
  };
  const reply = (txid: string, args?: unknown) => post({ ack: txid, args });
  const request = (q: string, data?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (closed || pending.size >= MAX_MESSAGES) {
        reject(new Error("Editor is unavailable"));
        return;
      }
      const txid = crypto.randomUUID();
      pending.set(txid, {
        resolve,
        reject: () => reject(new Error("Editor communication failed")),
        timer: setTimeout(() => {
          pending.delete(txid);
          reject(new Error("Editor response timed out"));
        }, 60000),
      });
      post({ msg: { q, data }, txid });
    });
  const start = async (key: string | undefined, attempt = 0): Promise<void> => {
    if (closed || attempt > 2) throw new Error("Editor session changed");
    // A reader without a shared room opens an unshared, read-only copy. Its
    // fresh capability is never published and cannot write the project file.
    const standalone = !options.canEdit && key === undefined;
    const session = await request("GET_SESSION", {
      key,
      view: !options.canEdit && !standalone,
      keepOld: false,
    });
    if (closed) return;
    if (
      !options.canEdit &&
      key &&
      object(session) &&
      session.error === "ENOENT"
    ) {
      if (options.requireExistingSession)
        throw new Error("Shared editor session is unavailable");
      return start(undefined, attempt + 1);
    }
    if (
      !object(session) ||
      session.error ||
      !identifier(session.key) ||
      !identifier(session.viewKey)
    ) {
      throw new Error("Editor session is unavailable");
    }
    if (
      key === session.key &&
      options.viewKey &&
      options.viewKey !== session.viewKey
    )
      throw new Error("Editor session changed");
    if (session.key !== key && !standalone) {
      if (!options.canEdit) throw new Error("Read-only session is unavailable");
      const committed = await options.publishSession(key, {
        editKey: session.key,
        viewKey: session.viewKey,
      });
      if (closed) return;
      if (!identifier(committed.editKey) || !identifier(committed.viewKey))
        throw new Error("Invalid session");
      if (committed.editKey !== session.key)
        return start(committed.editKey, attempt + 1);
    }
    options.onSession?.(!standalone);
    started = true;
    const result = await request("START", {
      key: session.key,
      application: options.application,
      name: options.fileName,
      document: options.document,
      ext: options.fileName.split(".").pop()?.toLowerCase(),
      autosave: options.canEdit ? 10 : false,
      readOnly: !options.canEdit,
      editorConfig: { lang: options.locale },
      _config: {
        sortsysPersistentRoom:
          !standalone && options.persistentSession !== false,
        editorConfig: { lang: options.locale },
        document: {
          title: options.fileName,
          permissions: { edit: options.canEdit },
        },
      },
    });
    if (object(result) && result.error)
      throw new Error("Editor could not be started");
  };
  const receive = (event: MessageEvent<unknown>) => {
    if (
      closed ||
      event.source !== editor ||
      event.origin !== origin.origin ||
      !object(event.data)
    )
      return;
    const packet = event.data;
    if (packet.q === "INTEGRATION_READY") {
      if (booting) return;
      booting = true;
      void start(options.accessKey).catch(() => {
        if (!closed) options.onError();
      });
      return;
    }
    if (typeof packet.ack === "string") {
      const operation = pending.get(packet.ack);
      if (operation) {
        pending.delete(packet.ack);
        clearTimeout(operation.timer);
        operation.resolve(packet.args);
      }
      return;
    }
    if (
      !started ||
      !identifier(packet.txid) ||
      !object(packet.msg) ||
      typeof packet.msg.q !== "string"
    )
      return;
    const txid = packet.txid,
      command = packet.msg;
    if (received.has(txid)) return;
    received.add(txid);
    if (received.size > 256) received.delete(received.values().next().value!);
    switch (command.q) {
      case "SAVE": {
        const document = command.data;
        if (
          !options.canEdit ||
          !(document instanceof Blob) ||
          document.size > MAX_DOCUMENT ||
          saves >= 2
        ) {
          reply(txid, { error: "SAVE_REJECTED" });
          return;
        }
        saves++;
        saveQueue = saveQueue
          .then(async () => {
            if (closed) return;
            try {
              await options.save(document);
              if (!closed) {
                reply(txid);
                options.onDirty?.(false);
              }
            } catch (error) {
              if (!closed) {
                reply(txid, { error: "SAVE_FAILED" });
                if (options.onSaveError) options.onSaveError(error);
                else options.onError();
              }
            }
          })
          .finally(() => {
            saves--;
          });
        return;
      }
      case "DOCUMENT_READY":
        ready = true;
        options.onReady();
        break;
      case "DOCUMENT_ERROR":
        failExport();
        options.onError();
        break;
      case "ON_DOWNLOADAS": {
        const operation = exporting;
        exporting = undefined;
        if (!operation) {
          reply(txid, { error: "EXPORT_NOT_REQUESTED" });
          return;
        }
        clearTimeout(operation.timer);
        if (
          !(command.data instanceof Blob) ||
          command.data.size > MAX_DOCUMENT
        ) {
          exportFailed = true;
          operation.reject();
          reply(txid, { error: "EXPORT_REJECTED" });
          return;
        }
        operation.resolve(command.data);
        break;
      }
      case "USERLIST_CHANGE":
        break;
      case "HAS_UNSAVED_CHANGES":
        if (typeof command.data === "boolean") options.onDirty?.(command.data);
        break;
      default:
        reply(txid, { error: "UNSUPPORTED_COMMAND" });
        return;
    }
    reply(txid);
  };
  window.addEventListener("message", receive);
  iframe.referrerPolicy = "no-referrer";
  iframe.src = `${origin.origin}/integration/`;
  return {
    saveCurrent() {
      if (!ready || closed || !options.canEdit) return;
      post({ msg: { q: "MANUAL_SAVE" }, txid: crypto.randomUUID() });
    },
    export(format) {
      if (
        closed ||
        !ready ||
        exportFailed ||
        exporting ||
        ![
          "docx",
          "xlsx",
          "pptx",
          "pdf",
          "odt",
          "ods",
          "odp",
          "csv",
          "txt",
          "drawio",
        ].includes(format)
      )
        return Promise.reject(new Error("Editor export is unavailable"));
      return new Promise<Blob>((resolve, reject) => {
        const fail = () => reject(new Error("Editor export failed"));
        exporting = {
          resolve,
          reject: fail,
          timer: setTimeout(failExport, 60000),
        };
        post({
          msg: { q: "DOWNLOAD_AS", data: format },
          txid: crypto.randomUUID(),
        });
      });
    },
    close() {
      if (closed) return;
      closed = true;
      window.removeEventListener("message", receive);
      for (const operation of pending.values()) {
        clearTimeout(operation.timer);
        operation.reject();
      }
      pending.clear();
      received.clear();
      if (exporting) {
        clearTimeout(exporting.timer);
        exporting.reject();
        exporting = undefined;
      }
      iframe.src = "about:blank";
    },
  };
}
