import { useRef, useState } from "react";
import { Button, TextInput } from "@sortsys/react-components";
import { GaebDocument } from "@sortsys/gaeb";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import {
  commercialError,
  deriveChecked,
  documentAmount,
  readGaebFile,
} from "~/lib/commercial";
import { MyCallout } from "./MyCallout";

/** Give a legacy project a native contract without recreating its bookkeeping. */
export function CommercialAdoptForm({
  projectId,
  title: initialTitle,
  onCreated,
}: {
  projectId: string;
  title: string;
  onCreated: (id: string) => void;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [source, setSource] = useState<{
    xml: string;
    name: string;
    phase: "84" | "85" | "86" | "87";
    referenceXml?: string;
    referenceName?: string;
  }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const referenceInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!source || busy) return;
        setBusy(true);
        setError("");
        void (async () => {
          const offerXml = source.phase === "84"
            ? undefined
            : await deriveChecked(source.xml, "84", { title });
          let amountXml = source.xml;
          if (source.phase === "84" && source.referenceXml) {
            const prices = new GaebDocument(source.xml, source.name);
            const scope = new GaebDocument(source.referenceXml, "scope.x83");
            const positions = new Set(scope.items.map((item) => item.oz));
            if (prices.items.length !== scope.items.length || prices.items.some((item) => !positions.has(item.oz)))
              throw new Error("contract-reference-mismatch");
            try {
              amountXml = await deriveChecked(source.xml, "86", { referenceXml: source.referenceXml });
            } catch (failure) {
              if (failure instanceof Error && ["workflow-missing-prices", "workflow-quantity-difference"].includes(failure.message))
                throw new Error("contract-reference-mismatch");
              throw failure;
            }
          }
          const netAmount = documentAmount(amountXml);
          if (netAmount === null)
            throw new Error(source.phase === "84" ? "workflow-reference-required" : "workflow-pricing-rules");
          const [value, failure] = await client.mutate(
            "commercial.cases.adoptContract",
            {
              projectId,
              title,
              sourceXml: source.xml,
              sourcePhase: source.phase,
              sourceFileName: source.name,
              referenceXml: source.referenceXml ?? null,
              offerXml: offerXml ?? null,
              netAmount,
            },
          );
          if (failure || !value) throw failure ?? new Error("adoption-failed");
          onCreated(value.id);
        })()
          .catch((failure) => setError(commercialError(failure)))
          .finally(() => setBusy(false));
      }}
    >
      <p className="text-sm text-muted">
        {uiText(
          "Ein vorhandenes Angebot, Nebenangebot oder Auftragsdokument als Grundlage für Aufmaße, Weitervergaben und Abrechnung übernehmen. Bereits erfasste Angebotssummen bleiben erhalten.",
          "Adopt an existing offer, alternative offer or order document as the basis for measurements, subcontracting and billing. Existing offer totals are retained.",
        )}
      </p>
      {error && (
        <MyCallout
          kind="error"
          title={uiText(
            "Übernahme nicht abgeschlossen",
            "Adoption did not complete",
          )}
        >
          {error}
        </MyCallout>
      )}
      <TextInput
        labelText={uiText("Auftragsbezeichnung", "Contract title")}
        required
        maxLength={127}
        value={title}
        disabled={busy}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setTitle(event.target.value)
        }
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          kind="secondary"
          disabled={busy}
          onClick={() => fileInput.current?.click()}
        >
          {uiText("GAEB-Datei wählen", "Choose GAEB file")}
        </Button>
        <span className="min-w-0 break-all text-sm text-muted">
          {source?.name ??
            uiText(
              "X84–X87, D84–D87 oder P84–P87",
              "X84–X87, D84–D87 or P84–P87",
            )}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".x84,.x85,.x86,.x87,.d84,.d85,.d86,.d87,.p84,.p85,.p86,.p87,.xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          setSource(undefined);
          void readGaebFile(file)
            .then(({ xml, model, fileName, referenceXml }) => {
              const phase = model.phase;
              if (phase !== "84" && phase !== "85" && phase !== "86" && phase !== "87")
                throw new Error("Expected X84, X85, X86 or X87");
              const name = new RegExp(`\\.x${phase}$`, "i").test(fileName)
                ? fileName
                : `${fileName.replace(/\.[^./]+$/, "")}.x${phase}`;
              setSource({ xml, name, phase, referenceXml });
            })
            .catch((failure) => setError(commercialError(failure)))
            .finally(() => setBusy(false));
        }}
      />
      {source?.phase === "84" && (
        <div className="flex flex-wrap items-center gap-3">
          <Button kind="secondary" disabled={busy} onClick={() => referenceInput.current?.click()}>
            {uiText("Leistungsverzeichnis ergänzen", "Add bill of quantities")}
          </Button>
          {source.referenceName && <span className="text-sm break-all">{source.referenceName}</span>}
        </div>
      )}
      <input
        ref={referenceInput}
        type="file"
        accept=".x83,.d83,.p83,.xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          void readGaebFile(file, "83")
            .then(({ xml, fileName }) => setSource((current) => current && {
              ...current, referenceXml: xml, referenceName: fileName,
            }))
            .catch((failure) => setError(commercialError(failure)))
            .finally(() => setBusy(false));
        }}
      />
      <Button type="submit" disabled={busy || !source}>
        {busy
          ? uiText("Wird übernommen …", "Adopting …")
          : uiText("Bestandsauftrag übernehmen", "Adopt existing contract")}
      </Button>
    </form>
  );
}
