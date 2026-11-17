import assert from "node:assert/strict";
import { type Client, createClient } from "@sortsys/v2-client";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import {
  acceptVaultWithKey,
  type UnlockedAccount,
  unlockedAccount,
} from "../app/lib/crypto/session";
import {
  approveMemberInvitation,
  createMemberInvitation,
  invitationMembers,
  joinMemberInvitation,
  signInMemberInvitation,
} from "../app/lib/crypto/invitations";
import {
  accessDraft,
  type AccessValue,
  editAccessDraft,
  profilePatch,
} from "../app/lib/crypto/accessProfiles";
import { invoiceNumberAccessChanges } from "../app/lib/crypto/invoiceAccess";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { createBusinessClient } from "../app/lib/data/businessClient";
import {
  COMMERCIAL_FACETS,
  commercialCollection,
} from "../app/lib/data/commercialAreas";
import {
  invoiceSealObject,
  invoiceSealRequest,
} from "../app/lib/data/commercialBillingData";
import type { DuckDriver } from "../app/lib/data/database";
import { NUMBERING_COLLECTION } from "../app/lib/data/organizationData";
import { financialCollection } from "../app/lib/data/projectFinancialData";
import { preparePrivateLlm } from "../app/lib/data/privateLlm";
import { acquireDataRuntime } from "../app/lib/data/runtime/session";
import { publicId } from "../app/lib/data/products";
import {
  type Collection,
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";
import { invoiceXml } from "./test-live-billing";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import { testPartialNativeDocument } from "./test-live-partial-document";
import {
  type FinancialTestAccounts,
  testFinancialDraftView,
  testQuantityWriter,
  testReferencedOfferView,
  testSignedOfferView,
  testUnfinishedOfferView,
} from "./test-live-financial-view";

type Business = ReturnType<typeof createBusinessClient>;

function invoiceAccess(facet: (typeof COMMERCIAL_FACETS)[number]): AccessValue {
  if (facet === "master-data" || facet === "billing") return "write";
  if (facet === "scope") return "read";
  return "none";
}

/** Ordinary certified accounts use content grants, never administrative or
 * legacy project roles, for issuing invoices and recording payments. */
export async function testBillingPermissions(
  ownerClient: Client,
  driver: () => Promise<DuckDriver>,
) {
  const signal = new AbortController().signal;
  const owner = unlockedAccount()!;
  const session = await required(
    ownerClient.query("auth.sessionInfo", undefined),
  );
  await preparePrivateLlm(ownerClient, `user:${session.user.id}`, signal);
  const member = (await invitationMembers(ownerClient, signal)).find(
    (value) => value.username === "worker.native",
  );
  assert.ok(member);
  assert.equal(member.enrolled, false);
  const invitation = await createMemberInvitation(
    ownerClient,
    member,
    {
      catalogue: "none",
      customers: "none",
      contacts: "none",
      vendors: "none",
      prices: "none",
      assistant: false,
    },
    signal,
  );
  const peer = createClient(
    process.env.SORTSYS_LLM_TEST_PEER!,
    "ordinary-billing-member",
  );
  await signInMemberInvitation(
    peer,
    invitation.link,
    "Native-Member-Billing-2026!",
    signal,
  );
  await joinMemberInvitation(peer, invitation.link, signal);
  const account = unlockedAccount()!;
  await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  // Invitation approval synchronizes absence grants through the shared local
  // runtime. Native tests use the blocking DuckDB driver, not a browser worker.
  const ownerRuntime = acquireDataRuntime(ownerClient, signal, driver);
  try {
    await approveMemberInvitation(
      ownerClient,
      invitation.link.invitation.id,
      signal,
    );
  } finally {
    ownerRuntime.close();
  }
  const memberSession = await required(
    peer.query("auth.sessionInfo", undefined),
  );
  assert.equal(memberSession.roles.includes(":admin"), false);
  assert.equal(memberSession.roles.includes("manage:projects"), false);
  const subject = `user:${memberSession.user.id}`;
  const requests: { path: string; input: unknown }[] = [];
  const observed: Client = {
    ...peer,
    query: ((path, input, options) => {
      requests.push({ path, input });
      return peer.query(path, input, options);
    }) as Client["query"],
    mutate: ((path, input, options) => {
      requests.push({ path, input });
      return peer.mutate(path, input, options);
    }) as Client["mutate"],
  };

  async function withBusiness<T>(
    identity: UnlockedAccount,
    transport: Client,
    work: (business: Business) => Promise<T>,
  ): Promise<T> {
    await acceptVaultWithKey(
      identity.dataKey,
      identity.vault,
      identity.username,
      false,
    );
    const business = createBusinessClient(transport, {
      productDriver: driver,
      gaebProcessor: gaebTestProcessor,
    });
    try {
      return await work(business);
    } finally {
      business.dispose();
    }
  }

  async function grant(changes: { area: Collection; access: AccessValue }[]) {
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
    await changeAreaActionAccesses(
      ownerClient,
      subject,
      changes.map((change) => ({
        area: change.area,
        patch: profilePatch(change.access),
      })),
      signal,
    );
  }

  let stage = "create an invoice draft as owner";
  try {
    const target = await withBusiness(owner, ownerClient, async (business) => {
      const project = await required(
        business.mutate("projects.create", {
          title: "Projekt Mitarbeiterabrechnung 326481",
        }),
      );
      const contract = await required(
        business.mutate("commercial.cases.adoptContract", {
          projectId: project.id,
          title: "Auftrag Mitarbeiterabrechnung",
          sourcePhase: "84",
          sourceFileName: "Auftrag.x84",
          sourceXml: createGaebXml(
            "84",
            "Auftrag Mitarbeiterabrechnung",
            "2026-11-12",
          ),
          offerXml: null,
          referenceXml: null,
          netAmount: "80.00",
        }),
      );
      const invoice = await required(
        business.mutate("commercial.cases.create", {
          kind: "invoice",
          projectId: project.id,
          parentCaseId: contract.id,
          title: "Private Mitarbeiterrechnung 728491",
          scopeItemIds: [],
          vatRate: "19.00",
        }),
      );
      const document = await required(
        business.mutate("commercial.documents.create", {
          caseId: invoice.id,
          purpose: "invoice",
          fileName: "Rechnung.x89",
          xml: invoiceXml("invoice", "80.00", "95.20").replace(
            "</Invoice>",
            "<!--Private estimator note 971846--></Invoice>",
          ),
          netAmount: "80.00",
          readOnly: false,
        }),
      );
      return {
        id: invoice.id,
        parentId: contract.id,
        projectId: project.id,
        documentId: document.id,
      };
    });

    stage = "master-data without financial access";
    await grant([
      { area: commercialCollection(target.id, "master-data"), access: "read" },
    ]);
    await withBusiness(account, observed, async (business) => {
      const headers = await required(
        business.query("commercial.cases.headers", {
          projectId: target.projectId,
        }),
      );
      assert.equal(headers.length, 1);
      assert.deepEqual(Object.keys(headers[0]!).sort(), [
        "id",
        "kind",
        "projectId",
        "reference",
        "status",
        "title",
      ]);
      assert.equal(headers[0]!.id, target.id);
      assert.equal(headers[0]!.kind, "invoice");
      assert.equal(headers[0]!.status, "draft");
      assert.deepEqual(
        await required(
          business.query("commercial.cases.headers", {
            projectId: target.projectId,
            kind: "offer",
          }),
        ),
        [],
      );
      const value = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(value.case.netAmount, null);
      assert.equal(value.invoice, null);
      assert.equal(value.canManage, false);
      const scope = `commercial:${target.id}`;
      const publicStore = await commercialDocumentStore(
        observed,
        scope,
        signal,
      );
      try {
        const head = await publicStore.head(target.documentId);
        assert.ok(
          head,
          "A header reader can verify every signer without financial keys",
        );
        const publicProof = await required(
          observed.query(
            "zerotrust.domains.proof",
            {
              domain: commercialCollection(target.id, "billing").domain,
              generation: "1",
            },
            { strategy: "network-only" },
          ),
        );
        assert.equal(Object.hasOwn(publicProof, "envelopes"), false);
        assert.ok(
          (
            await observed.query(
              "zerotrust.keys.get",
              {
                domain: commercialCollection(target.id, "billing").domain,
                generation: "1",
              },
              { strategy: "network-only" },
            )
          )[1],
          "A public proof must not grant a financial key",
        );
        assert.ok(
          (
            await observed.query(
              "zerotrust.domains.get",
              {
                domain: commercialCollection(target.id, "billing").domain,
                generation: "1",
              },
              { strategy: "network-only" },
            )
          )[1],
          "The complete user key packages remain inaccessible",
        );
        const history = await required(
          observed.query(
            "zerotrust.documents.history",
            {
              scope,
              id: target.documentId,
              before: String(BigInt(head.version) + 1n),
            },
            { strategy: "network-only" },
          ),
        );
        assert.equal(history.length, 1);
        assert.equal(history[0]!.id, target.documentId);
        assert.ok(
          (
            await observed.query(
              "zerotrust.documents.history",
              {
                scope: `commercial:${target.parentId}`,
                id: target.documentId,
                before: "2",
              },
              { strategy: "network-only" },
            )
          )[1],
        );
        assert.ok(
          (
            await observed.query(
              "zerotrust.domains.proof",
              {
                domain: commercialCollection(target.parentId, "billing").domain,
                generation: "1",
              },
              { strategy: "network-only" },
            )
          )[1],
        );
      } finally {
        publicStore.close();
      }
      assert.ok(
        (
          await business.query("commercial.cases.get", { id: publicId("7203") })
        )[1],
      );
    });

    stage = "native scope edits without private financial keys";
    await grant([
      { area: commercialCollection(target.id, "scope"), access: "write" },
    ]);
    const partialVersion = await testPartialNativeDocument(
      { client: ownerClient, account: owner },
      { client: observed, account },
      target.id,
      target.documentId,
      driver,
    );

    stage = "readable invoice without the parent accounting context";
    await grant([
      { area: commercialCollection(target.id, "scope"), access: "read" },
      { area: commercialCollection(target.id, "billing"), access: "write" },
    ]);
    await withBusiness(account, observed, async (business) => {
      const document = await business.documents.open(
        target.id,
        target.documentId,
      );
      assert.equal(document.contentView?.access.pricingSupported, true);
      assert.deepEqual(document.contentView?.access.writable, []);
      assert.equal(document.canEdit, false);
    });

    stage =
      "financial draft without opaque costs, scope writes or numbering rights";
    await grant([
      {
        area: commercialCollection(target.parentId, "master-data"),
        access: "read",
      },
      {
        area: commercialCollection(target.parentId, "billing"),
        access: "read",
      },
    ]);
    const financialVersion = await withBusiness(account, observed, (business) =>
      testFinancialDraftView(observed, business, target.id, target.documentId),
    );
    assert.equal(financialVersion, partialVersion + 2n);

    stage = "quotation pricing from separately granted X83 quantities";
    const financialAccounts: FinancialTestAccounts = {
      asOwner: (work) => withBusiness(owner, ownerClient, work),
      asMember: (work) => withBusiness(account, observed, work),
      memberClient: observed,
      grant,
    };
    await testReferencedOfferView(financialAccounts);

    stage = "unfinished quotation prices";
    await testUnfinishedOfferView(financialAccounts);

    stage = "read-only signed quotation printing";
    await testSignedOfferView(financialAccounts);

    stage = "quantity writes without price mutation rights";
    await testQuantityWriter(financialAccounts);

    stage =
      "required invoice facets without private extensions or numbering rights";
    await grant([
      ...COMMERCIAL_FACETS.map((facet) => ({
        area: commercialCollection(target.id, facet),
        access: invoiceAccess(facet),
      })),
      {
        area: commercialCollection(target.parentId, "master-data"),
        access: "read",
      },
      {
        area: commercialCollection(target.parentId, "billing"),
        access: "read",
      },
    ]);
    await withBusiness(account, observed, async (business) => {
      const document = await business.documents.open(
        target.id,
        target.documentId,
      );
      assert.equal(document.contentView?.access.complete, false);
      assert.equal(
        document.xml.includes("Private estimator note 971846"),
        false,
      );
      assert.equal(document.canEdit, true);
      assert.ok(
        (
          await business.mutate("commercial.invoices.issue", { id: target.id })
        )[1],
      );
    });

    stage =
      "numbering grant without configuration write or parent update rights";
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
    const numbering = editAccessDraft(accessDraft("none"), "write", ACTIONS);
    await changeAreaActionAccesses(
      ownerClient,
      subject,
      invoiceNumberAccessChanges(numbering),
      signal,
    );
    await withBusiness(account, observed, async (business) => {
      assert.ok(
        (
          await business.mutate("commercial.invoices.issue", { id: target.id })
        )[1],
      );
      assert.ok(
        (
          await business.mutate("settings.invoiceNumbering.set", {
            scheme: "sequential",
            startNumber: "1",
          })
        )[1],
      );
      const settings = await protectedCollection(
        observed,
        NUMBERING_COLLECTION,
        signal,
      );
      try {
        assert.equal(settings.can("read"), true);
        assert.equal(settings.can("update"), false);
      } finally {
        settings.close();
      }
    });

    stage = "parent billing rights without the project booking grant";
    await grant([
      {
        area: commercialCollection(target.parentId, "billing"),
        access: "write",
      },
    ]);
    await withBusiness(account, observed, async (business) => {
      assert.ok(
        (
          await business.mutate("commercial.invoices.issue", { id: target.id })
        )[1],
      );
      const draft = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(draft.case.status, "draft");
      assert.equal(draft.invoice?.invoiceNumber, null);
      assert.equal(draft.documents[0]!.version, financialVersion);
    });

    stage = "issue with exactly the additional project create permission";
    await grant([
      {
        area: financialCollection(target.projectId, "invoice", true),
        access: { actions: ["read", "create"] },
      },
    ]);
    await withBusiness(account, observed, async (business) => {
      await required(
        business.mutate("commercial.invoices.issue", { id: target.id }),
      );
      const issued = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(issued.case.status, "sent");
      assert.equal(issued.case.netAmount, "80.00");
      assert.ok(issued.invoice?.invoiceNumber);
      const document = await business.documents.open(
        target.id,
        target.documentId,
      );
      assert.equal(document.contentView?.access.complete, false);
      assert.equal(
        document.xml.includes("Private estimator note 971846"),
        false,
      );
      assert.equal(document.canEdit, false);
      const request = invoiceSealRequest(target.id);
      const sealed = await protectedCollection(observed, request.area, signal);
      try {
        assert.equal(
          (await sealed.get(invoiceSealObject(target.id))).envelope.author,
          subject,
        );
      } finally {
        sealed.close();
      }
    });

    await withBusiness(owner, ownerClient, async (business) => {
      const document = await required(
        business.query("commercial.documents.get", {
          caseId: target.id,
          id: target.documentId,
        }),
      );
      assert.ok(document.xml.includes("<!--Private estimator note 971846-->"));
      assert.equal(document.canEdit, false);
    });

    stage = "revocation across every explicit source of financial access";
    await grant([
      { area: commercialCollection(target.id, "billing"), access: "none" },
      {
        area: commercialCollection(target.parentId, "billing"),
        access: "none",
      },
      {
        area: financialCollection(target.projectId, "invoice", true),
        access: "none",
      },
    ]);
    await withBusiness(owner, ownerClient, async (business) => {
      await required(
        business.mutate("commercial.invoices.recordPayment", {
          id: target.id,
          amount: "15.20",
          paidOn: "2026-11-12",
          reference: "Zahlung nach Rechteentzug 982461",
          operationId: "qmem1",
        }),
      );
    });
    await withBusiness(account, observed, async (business) => {
      const denied = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(denied.case.netAmount, null);
      assert.equal(denied.invoice, null);
      assert.ok(
        (
          await business.query("commercial.documents.get", {
            caseId: target.id,
            id: target.documentId,
          })
        )[1],
      );
      assert.ok(
        (
          await business.mutate("commercial.invoices.recordPayment", {
            id: target.id,
            amount: "1.00",
            paidOn: "2026-11-12",
            reference: "Nicht berechtigt",
            operationId: "qmem2",
          })
        )[1],
      );
    });

    stage = "historical regrant without payment creation rights";
    await grant([
      { area: commercialCollection(target.id, "billing"), access: "read" },
    ]);
    await withBusiness(account, observed, async (business) => {
      const value = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(value.invoice?.paidAmount, "15.20");
      assert.equal(
        value.invoice?.payments[0]?.reference,
        "Zahlung nach Rechteentzug 982461",
      );
      assert.ok(
        (
          await business.mutate("commercial.invoices.recordPayment", {
            id: target.id,
            amount: "80.00",
            paidOn: "2026-11-12",
            reference: "Nur Leserechte",
            operationId: "qmem3",
          })
        )[1],
      );
    });

    stage =
      "payment creation without invoice amount edits or project booking updates";
    await grant([
      {
        area: commercialCollection(target.id, "billing"),
        access: { actions: ["read", "create"] },
      },
      {
        area: commercialCollection(target.parentId, "billing"),
        access: { actions: ["read", "update"] },
      },
    ]);
    await withBusiness(account, observed, async (business) => {
      const payment = {
        id: target.id,
        amount: "80.00",
        paidOn: "2026-11-12",
        reference: "Zahlung durch Mitarbeiter 629841",
        operationId: "qmem4",
      };
      await required(
        business.mutate("commercial.invoices.recordPayment", payment),
      );
      await required(
        business.mutate("commercial.invoices.recordPayment", payment),
      );
      const paid = await required(
        business.query("commercial.cases.get", { id: target.id }),
      );
      assert.equal(paid.case.status, "paid");
      assert.equal(paid.invoice?.paidAmount, "95.20");
      assert.equal(paid.invoice?.payments.length, 2);
    });
    for (const secret of [
      "Private Mitarbeiterrechnung",
      "Zahlung durch Mitarbeiter",
      "Zahlung nach Rechteentzug",
      "<Invoice",
    ]) {
      assert.equal(
        JSON.stringify(requests).includes(secret),
        false,
        `No member billing plaintext in requests: ${secret}`,
      );
    }
    console.log(
      "NATIVE_BILLING_PERMISSIONS_OK: ordinary invited member, independent invoice/parent/project/numbering grants, unchanged settings rights, atomic denial, immutable issuer, revocation, historical regrant and append-only payment creation verified.",
    );
    return target;
  } catch (cause) {
    throw new Error(`Billing permissions failed at ${stage}`, { cause });
  } finally {
    peer.setToken(null);
    await acceptVaultWithKey(owner.dataKey, owner.vault, owner.username, false);
  }
}
