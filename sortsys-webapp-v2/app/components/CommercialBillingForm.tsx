import { useEffect, useState } from "react";
import {
  Button,
  Select,
  SelectItem,
  TextInput,
} from "@sortsys/react-components";
import {
  createInvoiceXml,
  GaebDocument,
  validateGaebInBrowser,
} from "@sortsys/gaeb";
import type { QueryResult } from "@sortsys/v2-client";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import {
  commercialError,
  documentAmount,
  kindLabel,
  loadCommercialDocument,
  storeCommercialDocument,
  type CommercialCase,
} from "~/lib/commercial";
import { MyCallout } from "./MyCallout";

type Kind = "invoice" | "progress_invoice" | "final_invoice";
export function CommercialBillingForm({
  projectId,
  onCreated,
}: {
  projectId: string;
  onCreated: (id: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [contracts, setContracts] = useState<CommercialCase[]>([]);
  const [parentId, setParentId] = useState("");
  const [context, setContext] =
    useState<QueryResult<"commercial.invoices.context">>();
  const [kind, setKind] = useState<Kind>("invoice");
  const [basis, setBasis] = useState("work");
  const [title, setTitle] = useState("");
  const [lumpSum, setLumpSum] = useState("");
  const [vat, setVat] = useState("19.00");
  const [tax, setTax] = useState("");
  const [date, setDate] = useState(today);
  const [start, setStart] = useState(today);
  const [end, setEnd] = useState(today);
  const [measurements, setMeasurements] = useState<CommercialCase[]>([]);
  const [measurement, setMeasurement] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState<string>();
  useEffect(() => {
    let active = true;
    void client
      .query(
        "commercial.cases.list",
        { projectId, limit: 200n },
        { strategy: "network-only" },
      )
      .then(([rows, error]) => {
        if (!active) return;
        if (error) {
          setError(commercialError(error));
          return;
        }
        const contracts = (rows ?? []).filter(
          (c) =>
            ["offer", "variation", "alternative"].includes(c.kind) &&
            c.status === "accepted",
        );
        setContracts(contracts);
        setParentId(contracts[0]?.id ?? "");
        setMeasurements(
          (rows ?? []).filter(
            (c) => c.kind === "measurement" && c.status === "approved",
          ),
        );
      });
    return () => {
      active = false;
    };
  }, [projectId]);
  useEffect(() => {
    if (!parentId) return;
    let active = true;
    setContext(undefined);
    setError("");
    setMeasurement("");
    void client
      .query(
        "commercial.invoices.context",
        { contractCaseId: parentId },
        { strategy: "network-only" },
      )
      .then(([value, error]) => {
        if (!active) return;
        if (error || !value) {
          setError(commercialError(error));
          return;
        }
        setContext(value);
        setKind(value.progressInvoices.length ? "final_invoice" : "invoice");
        if (value.vatRate) setVat(value.vatRate);
      });
    return () => {
      active = false;
    };
  }, [parentId]);
  const blocked = context?.hasInvoice || context?.hasFinalInvoice;
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!context || blocked || busy) return;
    setBusy(true);
    setError("");
    try {
      const [parent, failure] = await client.query(
        "commercial.cases.get",
        { id: parentId },
        { strategy: "network-only" },
      );
      if (failure || !parent) throw failure ?? new Error("load-failed");
      const doc =
        parent.documents.find((d) => d.purpose === "order") ??
        parent.documents.find((d) => d.purpose === "offer");
      if (!doc) throw new Error("workflow-reference-required");
      const loaded = await loadCommercialDocument(parentId, doc.id);
      const [org, orgError] = await client.query(
        "settings.organization.get",
        undefined,
        { strategy: "network-first" },
      );
      if (orgError || !org) throw orgError ?? new Error("load-failed");
      const [customer, customerError] = parent.case.customerId
        ? await client.query("customers.get", { id: parent.case.customerId })
        : [undefined, undefined];
      if (customerError) throw customerError;
      let measured: string | undefined;
      if (measurement && basis === "work") {
        const [detail, err] = await client.query("commercial.cases.get", {
          id: measurement,
        });
        const file = detail?.documents.find((d) => d.purpose === "measurement");
        if (err || !file) throw err ?? new Error("load-failed");
        measured = (await loadCommercialDocument(measurement, file.id)).xml;
      }
      const xml = createInvoiceXml(loaded.xml, {
        kind,
        title: title.trim() || `${kindLabel(kind)} · ${parent.case.title}`,
        referenceXml: loaded.referenceXml ?? undefined,
        measurementXml: measured,
        lumpSum:
          kind === "progress_invoice" && basis === "lump_sum"
            ? lumpSum.replace(",", ".")
            : undefined,
        vatRate: vat.replace(",", "."),
        invoiceDate: date,
        serviceStart: start,
        serviceEnd: end,
        ownCompany: org.companyName ?? "",
        ownAddress: org.address,
        customerName: customer?.name ?? parent.case.customerName ?? "",
        customerAddress: customer?.address,
        taxNumber: tax,
        previousInvoices: context.progressInvoices,
      });
      const model = new GaebDocument(xml, "Rechnung.x89");
      const check = await validateGaebInBrowser(xml, model.identity);
      if (!check.valid) throw new Error(`schema: ${check.issues[0]?.message}`);
      let id = createdId;
      if (!id) {
        const [value, err] = await client.mutate("commercial.cases.create", {
          kind,
          scopeItemIds: [],
          title: title.trim() || `${kindLabel(kind)} · ${parent.case.title}`,
          projectId,
          parentCaseId: parentId,
          billingBasis: kind === "progress_invoice" ? basis : "work",
          vatRate: vat.replace(",", "."),
        });
        if (err || !value) throw err ?? new Error("create-failed");
        id = value.id;
        setCreatedId(id);
      }
      await storeCommercialDocument({
        caseId: id,
        purpose: "invoice",
        fileName: `${kindLabel(kind)}.x89`,
        xml,
        readOnly: false,
        netAmount: documentAmount(xml),
        sourceDocumentId: doc.id,
        sourceVersion: loaded.version,
      });
      onCreated(id);
    } catch (err) {
      setError(commercialError(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      onSubmit={(event) => void create(event)}
      className="flex flex-col gap-4"
    >
      {error && (
        <MyCallout
          kind="error"
          title={uiText("Rechnung nicht erstellt", "Invoice not created")}
        >
          {error}
        </MyCallout>
      )}
      <Select
        labelText={uiText("Auftrag / Nachtrag", "Contract / variation")}
        value={parentId}
        disabled={busy || !!createdId}
        onChange={(e: { target: { value: string } }) =>
          setParentId(e.target.value)
        }
      >
        {contracts.map((c) => (
          <SelectItem
            key={c.id}
            value={c.id}
            text={`${c.reference} · ${c.title}`}
          />
        ))}
      </Select>
      {blocked ? (
        <p>
          {uiText(
            "Für diesen Auftrag besteht bereits eine Rechnung oder Schlussrechnung.",
            "This contract already has an invoice or final invoice.",
          )}
        </p>
      ) : (
        <>
          <Select
            labelText={uiText("Rechnungsart", "Invoice type")}
            value={kind}
            disabled={!context || busy || !!createdId}
            onChange={(e: { target: { value: string } }) =>
              setKind(e.target.value as Kind)
            }
          >
            {!context?.progressInvoices.length && (
              <SelectItem
                value="invoice"
                text={uiText(
                  "Rechnung ohne vorherige Abschläge",
                  "Invoice without prior progress invoices",
                )}
              />
            )}
            <SelectItem
              value="progress_invoice"
              text={uiText("Abschlagsrechnung", "Progress invoice")}
            />
            {!!context?.progressInvoices.length && (
              <SelectItem
                value="final_invoice"
                text={uiText(
                  "Schlussrechnung mit Abzug aller Abschläge",
                  "Final invoice deducting all progress invoices",
                )}
              />
            )}
          </Select>
          {kind === "final_invoice" && (
            <p className="text-sm text-muted">
              {uiText(
                `${context?.progressInvoices.length ?? 0} gestellte Abschlagsrechnungen werden abgezogen. Zahlungseingänge werden separat geführt.`,
                `${context?.progressInvoices.length ?? 0} issued progress invoices will be deducted. Receipts are tracked separately.`,
              )}
            </p>
          )}
          <TextInput
            labelText={uiText("Bezeichnung (optional)", "Title (optional)")}
            maxLength={127}
            value={title}
            disabled={busy || !!createdId}
            onChange={(e: { target: { value: string } }) =>
              setTitle(e.target.value)
            }
          />
          {kind === "progress_invoice" && (
            <Select
              labelText={uiText("Abrechnung nach", "Billing basis")}
              value={basis}
              disabled={busy || !!createdId}
              onChange={(e: { target: { value: string } }) =>
                setBasis(e.target.value)
              }
            >
              <SelectItem
                value="work"
                text={uiText(
                  "Erbrachter Leistung / Aufmaß",
                  "Completed work / measurement",
                )}
              />
              <SelectItem
                value="lump_sum"
                text={uiText("Pauschalem Betrag", "Lump sum")}
              />
            </Select>
          )}
          {kind === "progress_invoice" && basis === "lump_sum" ? (
            <TextInput
              labelText={uiText(
                "Abschlag netto (€)",
                "Net progress amount (€)",
              )}
              required
              inputMode="decimal"
              value={lumpSum}
              onChange={(e: { target: { value: string } }) =>
                setLumpSum(e.target.value)
              }
            />
          ) : (
            <Select
              labelText={uiText("Mengenbasis", "Quantity basis")}
              value={measurement}
              onChange={(e: { target: { value: string } }) =>
                setMeasurement(e.target.value)
              }
            >
              <SelectItem
                value=""
                text={uiText(
                  "Vertragsmengen – im Dokument anpassbar",
                  "Contract quantities – editable in the document",
                )}
              />
              {measurements
                .filter((m) => m.parentCaseId === parentId)
                .map((m) => (
                  <SelectItem key={m.id} value={m.id} text={m.title} />
                ))}
            </Select>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <TextInput
              type="date"
              labelText={uiText("Rechnungsdatum", "Invoice date")}
              required
              value={date}
              onChange={(e: { target: { value: string } }) =>
                setDate(e.target.value)
              }
            />
            <TextInput
              type="date"
              labelText={uiText("Leistung von", "Service from")}
              required
              value={start}
              onChange={(e: { target: { value: string } }) =>
                setStart(e.target.value)
              }
            />
            <TextInput
              type="date"
              labelText={uiText("Leistung bis", "Service until")}
              required
              min={start}
              value={end}
              onChange={(e: { target: { value: string } }) =>
                setEnd(e.target.value)
              }
            />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <TextInput
              labelText={uiText("Umsatzsteuer (%)", "VAT (%)")}
              inputMode="decimal"
              required
              value={vat}
              disabled={!!context?.vatRate || busy}
              onChange={(e: { target: { value: string } }) =>
                setVat(e.target.value)
              }
            />
            <TextInput
              labelText={uiText(
                "Eigene Steuernummer / USt-ID",
                "Your tax number / VAT ID",
              )}
              required
              maxLength={40}
              value={tax}
              onChange={(e: { target: { value: string } }) =>
                setTax(e.target.value)
              }
            />
          </div>
          <Button
            type="submit"
            loading={busy}
            disabled={!context || !parentId || !tax.trim()}
          >
            {uiText("Rechnung bearbeiten", "Edit invoice")}
          </Button>
        </>
      )}
    </form>
  );
}
