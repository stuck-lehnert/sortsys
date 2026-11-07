import { useRef, useState } from "react";
import { Button, TextInput } from "@sortsys/react-components";
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
  const [source, setSource] = useState<{ xml: string; name: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!source || busy) return;
        setBusy(true);
        setError("");
        void (async () => {
          const offerXml = await deriveChecked(source.xml, "84", { title });
          const netAmount = documentAmount(offerXml);
          if (netAmount === null) throw new Error("workflow-pricing-rules");
          const [value, failure] = await client.mutate(
            "commercial.cases.adoptContract",
            {
              projectId,
              title,
              orderXml: source.xml,
              offerXml,
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
          "Übernimm den vorhandenen Auftrag als Grundlage für Aufmaße und Weitervergaben. Die originale Auftragsdatei bleibt erhalten. Bereits erfasste Angebotssummen bleiben bestehen und werden nicht erneut gebucht.",
          "Use the existing contract as the basis for measurements and subcontracting. The original order file is retained. Existing offer totals are preserved without posting them again.",
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
          {uiText("Auftragsdatei wählen", "Choose order file")}
        </Button>
        <span className="min-w-0 break-all text-sm text-muted">
          {source?.name ??
            uiText(
              "Auftragserteilung des Kunden (X86)",
              "Customer order (X86)",
            )}
        </span>
      </div>
      <input
        ref={fileInput}
        type="file"
        accept=".x86,.xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          setBusy(true);
          setError("");
          void readGaebFile(file, "86")
            .then(({ xml }) => setSource({ xml, name: file.name }))
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
