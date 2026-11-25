import { openCryptPad } from "../../app/lib/cryptpadBridge";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../app/lib/i18n";
import { Observable } from "rxjs";
import { ProtectedOfficeEditor } from "../../app/components/ProtectedOfficeEditor";
import { client, gaebDocuments, projectFiles } from "../../app/lib/client";
import { prepareExcelExport } from "../../app/lib/officeExports";
import { createTableWorkbook } from "../../app/lib/xlsx";
import type { MyModalsInterface } from "../../app/hooks/useMyModals";
import {
  browserGaebXml,
  createGaebXml,
  DEFAULT_GAEB_VIEW,
} from "@sortsys/gaeb";
import GaebFileModal from "../../app/components/GaebFileModal";
import { required } from "../../app/lib/data/protectedObjects";

function mockCommercialDocumentReader() {
  gaebDocuments.open = (caseId, id) =>
    required(client.query("commercial.documents.get", { caseId, id }));
}

const iframe = document.createElement("iframe");
iframe.id = "private-office";
document.body.append(iframe);
let bridge: ReturnType<typeof openCryptPad> | undefined;
let releasePublish: (() => void) | undefined;
const state = {
  ready: 0,
  errors: 0,
  published: 0,
  saved: [] as string[],
  recovered: [] as { text: string; epoch: string; version: string }[],
};

Object.assign(window, {
  privateEditorFixture: {
    state,
    async gaebPublication() {
      iframe.remove();
      const { mountPublicationModal } =
        await import("./gaeb-publication.fixture.jsx");
      mountPublicationModal();
    },
    async gaebPartialPublication(options?: { description?: string }) {
      iframe.remove();
      const { mountPartialPublicationModal } =
        await import("./gaeb-publication.fixture.jsx");
      await mountPartialPublicationModal(options);
    },
    async gaebSignedPublication() {
      iframe.remove();
      const { mountSignedPublicationModal } =
        await import("./gaeb-publication.fixture.jsx");
      await mountSignedPublicationModal();
    },
    async gaebFinancialPublication(options?: {
      referenced?: boolean;
      image?: "missing" | "readable";
      unfinished?: boolean;
      quantityWriter?: boolean;
    }) {
      iframe.remove();
      const { mountFinancialPublicationModal } =
        await import("./gaeb-publication.fixture.jsx");
      await mountFinancialPublicationModal(options);
    },
    async contractAdoption() {
      iframe.remove();
      const { CommercialAdoptForm } =
        await import("../../app/components/CommercialAdoptForm");
      const result: { id: string | null; input: unknown; count: number } = {
        id: null,
        input: null,
        count: 0,
      };
      client.mutate = (async (path, input) => {
        if (path !== "commercial.cases.adoptContract") {
          throw new Error("Unexpected adoption mutation");
        }
        result.input = input;
        result.count++;
        return [{ id: "123" }, null];
      }) as typeof client.mutate;
      Object.assign(window, {
        contractAdoptionFixture: {
          snapshot: () => result,
          xml(phase: "84" | "85" | "86" | "87") {
            const description =
              "<Description><CompleteText><DetailTxt><Text><p><span>Untergrund vorbereiten.</span></p></Text></DetailTxt><OutlineText><OutlTxt><TextOutlTxt><p><span>Fensterlaibung</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>";
            return createGaebXml(
              phase,
              "Fenstersanierung",
              "2026-11-10",
            ).replace(
              "<BoQBody/>",
              `<BoQBody><Itemlist><Item ID="position-1" RNoPart="0001"><Qty>3.000</Qty>${
                phase === "84" ? "" : "<QU>m²</QU>"
              }<UP>592.000</UP><IT>1776.00</IT>${
                phase === "84" ? "" : description
              }</Item></Itemlist></BoQBody>`,
            );
          },
        },
      });
      const host = document.createElement("div");
      document.body.append(host);
      createRoot(host).render(
        createElement(
          I18nProvider,
          null,
          createElement(CommercialAdoptForm, {
            projectId: "4",
            title: "Bestandsauftrag Altbau",
            onCreated: (id) => {
              result.id = id;
            },
          }),
        ),
      );
    },
    async commercialDownload(kind: "offer" | "subcontract" = "offer") {
      iframe.remove();
      const [
        { default: CommercialWorkspace },
        { SessionInfoProvider },
        { MyModalsProvider },
        { MemoryRouter },
      ] = await Promise.all([
        import("../../app/components/CommercialWorkspace"),
        import("../../app/hooks/useSessionInfo"),
        import("../../app/hooks/useMyModals"),
        import("react-router"),
      ]);
      const xml = createGaebXml("84", "Vertrauliches Angebot"),
        stamp = new Date().toISOString(),
        paths: string[] = [];
      let held = false,
        denied = false,
        reads = 0;
      const pending: (() => void)[] = [];
      const detail = {
        case: {
          id: "1",
          title: "Vertrauliches Angebot",
          reference: "ANG-TEST",
          kind,
          status: "draft",
          currency: "EUR",
          netAmount: "0.00",
          notes: null,
          scopeItemIds: [],
          projectId: null,
          projectTitle: null,
          parentCaseId: null,
          customerId: null,
          customerName: null,
          counterpartyName: null,
          validUntil: null,
          existingContract: false,
          selectedOfferDocumentId: null,
          acceptedAt: null,
          createdAt: stamp,
          modifiedAt: stamp,
        },
        documents: [
          {
            id: "2",
            caseId: "1",
            purpose: "offer",
            phase: "84",
            fileName: "Vertrauliches Angebot.x84",
            version: 1n,
            readOnly: true,
            sourceDocumentId: null,
            sourceVersion: null,
            sourceCurrentVersion: null,
            partnerName: null,
            netAmount: "0.00",
            createdAt: stamp,
            modifiedAt: stamp,
          },
        ],
        events: [
          {
            id: "3",
            action: "document_created",
            status: "draft",
            actor: "Ada Muster",
            createdAt: stamp,
          },
        ],
        invoice: null,
        canManage: true,
      };
      client.loggedIn = () => true;
      client.query = (async (path) => {
        paths.push(path);
        if (path === "commercial.cases.get") return [detail, null];
        if (path === "personalization.gaebView.get") {
          return [DEFAULT_GAEB_VIEW, null];
        }
        if (path === "commercial.documents.get") {
          return denied
            ? [null, new Error("Revoked")]
            : [
                {
                  xml,
                  referenceXml: null,
                  fileName: detail.documents[0]!.fileName,
                  version: 1n,
                  canEdit: false,
                  liveTicket: "",
                  livePath: "",
                  recoveryScope: "",
                },
                null,
              ];
        }
        return [null, new Error("Unexpected fixture query")];
      }) as typeof client.query;
      client.streamQuery = ((path: string) =>
        new Observable<[unknown, null]>((subscriber) =>
          subscriber.next([
            path === "auth.sessionInfo"
              ? {
                  user: { id: "1", username: "owner", locale: "de" },
                  roles: [":admin"],
                  tenant: { objectStorageEnabled: true },
                }
              : detail,
            null,
          ]),
        )) as typeof client.streamQuery;
      mockCommercialDocumentReader();
      gaebDocuments.download = async () => {
        reads++;
        if (held) {
          await new Promise<void>((resolve) => pending.push(resolve));
        }
        return {
          blob: new Blob([xml], { type: "application/xml" }),
          fileName: detail.documents[0]!.fileName,
        };
      };
      Object.assign(window, {
        privateGaebDownload: {
          snapshot: () => ({ paths, reads, xml }),
          pause: () => {
            held = true;
          },
          release: () => {
            held = false;
            for (const resolve of pending.splice(0)) resolve();
          },
          revoke: async () => {
            denied = true;
            await client.clearCache();
          },
        },
      });
      const host = document.createElement("div");
      host.style.height = "100vh";
      document.body.append(host);
      createRoot(host).render(
        createElement(
          I18nProvider,
          null,
          createElement(
            MemoryRouter,
            null,
            createElement(
              MyModalsProvider,
              null,
              createElement(
                SessionInfoProvider,
                null,
                createElement(CommercialWorkspace, {
                  caseId: "1",
                  onClose() {},
                }),
              ),
            ),
          ),
        ),
      );
    },
    gaeb() {
      iframe.remove();
      let denied = false;
      mockCommercialDocumentReader();
      const content = {
        xml: createGaebXml("84", "Vertrauliche Fassade"),
        referenceXml: null,
        fileName: "Privat.x84",
        version: 1n,
        canEdit: false,
        liveTicket: "",
        livePath: "",
        recoveryScope: "",
      };
      client.query = (async (path) => {
        if (path === "personalization.gaebView.get") {
          return [DEFAULT_GAEB_VIEW, null];
        }
        if (path === "commercial.documents.get") {
          return denied ? [null, new Error("Revoked")] : [content, null];
        }
        return [null, new Error("Unexpected fixture query")];
      }) as typeof client.query;
      client.streamQuery = (() =>
        new Observable((subscriber) => {
          subscriber.next([null, null]);
        })) as typeof client.streamQuery;
      Object.assign(window, {
        revokePrivateGaeb: async () => {
          denied = true;
          await client.clearCache();
        },
      });
      const host = document.createElement("div");
      document.body.append(host);
      createRoot(host).render(
        createElement(
          I18nProvider,
          null,
          createElement(GaebFileModal, {
            caseId: "1",
            documentId: "2",
            fileName: "Privat.x84",
          }),
        ),
      );
    },
    async gaebPartition() {
      const signal = new AbortController().signal;
      const xml = createGaebXml("84", "Verschlüsselte Fassade").replace(
        "<BoQBody/>",
        '<BoQBody><Itemlist><Item ID="window-1" RNoPart="1"><Qty>2.500</Qty><QU>m²</QU><UP>592.00</UP><PrivateCost>9876.54</PrivateCost></Item></Itemlist></BoQBody>',
      );
      const split = await browserGaebXml.partition(xml, "offer", signal),
        parts = new Map();
      for (const fragment of split.fragments) {
        const values = parts.get(fragment.facet) ?? [];
        values.push(fragment);
        parts.set(fragment.facet, values);
      }
      const complete = await browserGaebXml.render(split.layout, parts, signal);
      parts.delete("offer-prices");
      parts.delete("opaque");
      const partial = await browserGaebXml.render(split.layout, parts, signal);
      const valid = await browserGaebXml.validate(
        createGaebXml("84", "Vertrauliches Angebot"),
        split.layout.identity,
        signal,
      );
      const invalid = await browserGaebXml.validate(
        xml,
        split.layout.identity,
        signal,
      );
      return {
        exact: complete.xml === xml,
        complete: complete.complete,
        scope: JSON.stringify(split.layout),
        partial,
        validation: { valid: valid.valid, invalid: invalid.valid },
      };
    },
    open(
      editorOrigin: string,
      canEdit = true,
      accessKey?: string,
      application: Parameters<typeof openCryptPad>[0]["application"] = "doc",
    ) {
      bridge?.close();
      state.ready = state.errors = state.published = 0;
      state.saved = [];
      bridge = openCryptPad({
        iframe,
        editorOrigin,
        canEdit,
        accessKey,
        application,
        locale: "de",
        fileName: application === "diagram" ? "Private.drawio" : "Private.docx",
        document: new Blob(["private browser document"]),
        publishSession: async (_previous, proposed) => {
          state.published++;
          await new Promise<void>((resolve) => {
            releasePublish = resolve;
          });
          return proposed;
        },
        save: async (document) => {
          state.saved.push(await document.text());
        },
        onReady: () => {
          state.ready++;
        },
        onError: () => {
          state.errors++;
        },
      });
    },
    publish: () => releasePublish?.(),
    close: () => bridge?.close(),
    export: (format: Parameters<NonNullable<typeof bridge>["export"]>[0]) =>
      bridge!.export(format),
    async exportExcel(editorOrigin: string, resetDuringWrite = false) {
      bridge?.close();
      iframe.remove();
      const queries: string[] = [];
      client.query = (async (path) => {
        queries.push(path);
        if (path !== "zerotrust.editors.config") {
          throw new Error("Unexpected export request");
        }
        return [{ officeOrigin: editorOrigin }, null];
      }) as typeof client.query;
      const host = document.createElement("div");
      document.body.append(host);
      const root = createRoot(host);
      const modals: MyModalsInterface = {
        show(render) {
          let visible = true;
          const hide = () => {
            visible = false;
            draw();
          };
          const draw = () =>
            root.render(
              createElement(
                I18nProvider,
                null,
                render({
                  id: "export",
                  visible,
                  hide,
                  replace: () => {},
                  setLocation: () => {},
                }),
              ),
            );
          draw();
        },
        showDefault: () => {
          throw new Error("Export unexpectedly failed");
        },
        showForm: () => {},
        trackLocation: () => ({ close() {}, detach() {}, update() {} }),
      };
      Object.assign(window, {
        exportQueries: queries,
        resetExportContext: () => client.clearCache(),
      });
      const openExcel = prepareExcelExport(modals);
      const workbook = await createTableWorkbook({
        sheetName: "Projekt",
        columns: ["Position"],
        rows: [["private generated workbook"]],
      });
      if (resetDuringWrite) {
        const write = workbook.xlsx.writeBuffer.bind(workbook.xlsx);
        workbook.xlsx.writeBuffer = async () => {
          const bytes = await write();
          client.clearCache();
          return bytes;
        };
      }

      await openExcel(workbook, "Projekt.xlsx");
    },
    protected(
      editorOrigin: string,
      recoverDraft = false,
      options: {
        fileName?: string;
        holdFirstLoad?: boolean;
        readOnly?: boolean;
      } = {},
    ) {
      bridge?.close();
      iframe.remove();
      state.ready = state.errors = state.published = 0;
      state.saved = [];
      state.recovered = [];
      let canEdit = !options.readOnly;
      let allowed = true;
      let fileId = "5";
      let epoch: string | null = null;
      let contentVersion = "1";
      let replacement: string | undefined;
      let releaseLoad: (() => void) | undefined;
      const loads: string[] = [];
      let previousSession = recoverDraft
        ? { epoch: "old-office-room", viewKey: "view-capability", version: "1" }
        : null;
      const subscribers = new Set<() => void>();
      const current = () => {
        const original =
          fileId === "5" ? "private browser document" : `Private document ${fileId}`;
        return {
          editorOrigin,
          document: new Blob([replacement ?? original]),
          fileName: options.fileName ?? "Private.docx",
          canEdit,
          epoch,
          contentVersion,
          policyVersion: "1",
          keyGeneration: "1",
          previousSession,
          viewKey: epoch ? "view-capability" : undefined,
          accessKey: epoch
            ? canEdit
              ? "new-edit-capability"
              : "view-capability"
            : undefined,
        };
      };
      projectFiles.office = async (_project, requestedFile) => {
        state.ready++;
        if (!allowed) throw new Error("Document access denied");
        const value = current();
        loads.push(requestedFile);
        if (options.holdFirstLoad && loads.length === 1) {
          await new Promise<void>((resolve) => {
            releaseLoad = resolve;
          });
        }
        return value;
      };
      projectFiles.officeStatus = async () => {
        if (!allowed) throw new Error("Document access denied");
        return current();
      };
      projectFiles.publishOfficeSession = async (
        _project,
        _file,
        _previous,
        proposed,
        recovered,
      ) => {
        if (previousSession) {
          if (
            !recovered ||
            recovered.epoch !== previousSession.epoch ||
            recovered.version !== previousSession.version
          ) {
            throw new Error(
              "A pending draft must be transferred before replacing its room",
            );
          }
          state.recovered.push({
            text: await recovered.document.text(),
            epoch: recovered.epoch,
            version: recovered.version,
          });
          previousSession = null;
        }
        state.published++;
        epoch = "shared-office-room";
        return { ...proposed, epoch };
      };
      projectFiles.saveOffice = async (_project, _file, _epoch, version, blob) => {
        if (version !== 1n) throw new Error("Unexpected Office file version");
        state.saved.push(await blob.text());
        return { version: 2n, savedAt: new Date() };
      };
      const changes = new Observable<[unknown, null]>((subscriber) => {
        const update = () => subscriber.next([[], null]);
        subscribers.add(update);
        update();
        return () => subscribers.delete(update);
      });
      client.streamQuery = (() => changes) as typeof client.streamQuery;
      Object.assign(window, {
        downgradePrivateOffice: async () => {
          canEdit = false;
          epoch = "new-read-only-room";
          await client.clearCache();
        },
        replacePrivateOfficeRoom: () => {
          epoch = "new-shared-room";
          for (const subscriber of subscribers) subscriber();
        },
        replaceConfirmedPrivateOfficeFile: (text: string) => {
          replacement = text;
          contentVersion = "2";
          for (const subscriber of subscribers) subscriber();
        },
      });
      const host = document.createElement("div");
      host.style.height = "100vh";
      document.body.append(host);
      const root = createRoot(host);
      const render = () =>
        root.render(
          createElement(
            I18nProvider,
            null,
            createElement(ProtectedOfficeEditor, { projectId: "4", fileId }),
          ),
        );
      Object.assign(window, {
        privateOfficeLoads: loads,
        releasePrivateOfficeLoad: () => releaseLoad?.(),
        switchPrivateOfficeFile: (next: string) => {
          fileId = next;
          render();
        },
        denyPrivateOffice: async () => {
          allowed = false;
          await client.clearCache();
        },
      });
      render();
    },
  },
});
