import { useEffect, useState } from "react";
import { Modal } from "@sortsys/react-components";
import { EditorIconButton } from "@sortsys/gaeb";
import DocumentSigned from "@carbon/icons-react/es/DocumentSigned";
import {
  publicOtsBlockSource,
  sized,
  verifyOtsBitcoin,
} from "@sortsys/zerotrust/sortsys";
import { client } from "~/lib/client";
import { checkTimestampEvidence } from "~/lib/crypto/timestampEvidence";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { downloadBlob } from "~/lib/utils";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type Entry = { scope: string; object: string; revision: string; title: string };
type Checked = Awaited<ReturnType<typeof checkTimestampEvidence>>;
type Result = {
  entry: Entry;
  checked: Checked | null;
  artifact?: unknown;
  status: "waiting" | "pending" | "unverified" | "verified";
  time?: number;
};

function timestampStatusText(result: Result): string {
  switch (result.status) {
    case "verified": {
      const timestamp = new Date(result.time! * 1000).toLocaleString(
        currentLocaleTag(),
      );
      return uiText(
        `Bitcoin-Zeitnachweis vom ${timestamp}.`,
        `Bitcoin timestamp dated ${timestamp}.`,
      );
    }
    case "pending":
      return uiText(
        "Beim Kalender eingereicht; Bitcoin-Bestätigung steht aus.",
        "Submitted to a calendar; Bitcoin confirmation is pending.",
      );
    case "unverified":
      return uiText(
        "Beleg vorhanden; Bitcoin-Nachweis derzeit nicht bestätigt.",
        "Proof available; Bitcoin evidence is currently unconfirmed.",
      );
    case "waiting":
      return uiText(
        "Für diesen Stand liegt noch kein externer Beleg vor.",
        "No external proof is available for this revision yet.",
      );
  }
}
export function TimestampEvidenceButton({
  entries,
  ribbon = false,
}: {
  entries: Entry[];
  ribbon?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Result[] | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const identity = JSON.stringify(entries);
  useEffect(() => {
    if (!open) return;
    const cancellation = new AbortController();
    setResults(null);
    setError(false);
    void (async () => {
      const source = publicOtsBlockSource();
      const next: Result[] = [];
      for (const entry of entries) {
        const [value, failure] = await client.query(
          "zerotrust.timestamps.get",
          {
            scope: entry.scope,
            object: entry.object,
            revision: entry.revision,
          },
          { strategy: "network-only" },
        );
        cancellation.signal.throwIfAborted();
        if (failure) throw failure;
        if (!value) {
          next.push({ entry, checked: null, status: "waiting" });
          continue;
        }
        const checked = await checkTimestampEvidence(
          client,
          value,
          entry,
          cancellation.signal,
        );
        const verification = checked.proof
          ? await verifyOtsBitcoin(
              checked.proof,
              sized(checked.target.digest, 32),
              source,
              cancellation.signal,
            )
          : null;
        next.push({
          entry,
          checked,
          artifact: value.artifact,
          status: verification?.status ?? "waiting",
          ...(verification?.status === "verified"
            ? { time: verification.unixTime }
            : {}),
        });
      }
      cancellation.signal.throwIfAborted();
      setResults(next);
    })().catch(() => {
      if (!cancellation.signal.aborted) setError(true);
    });
    return () => cancellation.abort();
  }, [open, identity]);
  async function download() {
    setBusy(true);
    try {
      const { default: JSZip } = await import("jszip");
      const zip = new JSZip();
      for (const [index, result] of (results ?? []).entries())
        if (result.checked) {
          const folder = zip.folder(String(index + 1))!;
          folder.file("signed-packet.bin", result.checked.packet);
          folder.file(
            "target.json",
            JSON.stringify(result.checked.target, null, 2),
          );
          folder.file(
            "artifact.json",
            JSON.stringify(result.artifact, null, 2),
          );
          if (result.checked.proof)
            folder.file("signed-packet.bin.ots", result.checked.proof);
        }
      downloadBlob(
        await zip.generateAsync({ type: "blob" }),
        "Zeitnachweise.zip",
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const label = uiText("Zeitnachweis", "Timestamp evidence");
  return (
    <>
      {ribbon ? (
        <EditorIconButton
          showLabel
          icon={DocumentSigned}
          label={label}
          onClick={() => setOpen(true)}
        />
      ) : (
        <MyButton
          kind="ghost"
          size="sm"
          renderIcon={DocumentSigned}
          onClick={() => setOpen(true)}
        >
          {label}
        </MyButton>
      )}
      <Modal
        open={open}
        passiveModal
        modalHeading={label}
        onRequestClose={() => setOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {error && (
          <MyCallout kind="error">
            {uiText(
              "Der Nachweis konnte nicht geprüft werden. Der gespeicherte Dokumentstand bleibt unverändert.",
              "The evidence could not be checked. The saved document remains unchanged.",
            )}
          </MyCallout>
        )}
        {!results && !error && (
          <p role="status">
            {uiText("Nachweise werden geprüft …", "Checking evidence…")}
          </p>
        )}
        <ul className="space-y-3">
          {results?.map((result, index) => (
            <li key={index}>
              <strong>{result.entry.title}</strong>
              <p>{timestampStatusText(result)}</p>
            </li>
          ))}
        </ul>
        {results?.some((result) => result.status === "verified") && (
          <p className="my-3 text-sm">
            {uiText(
              "Der Block wurde mit Blockstream und mempool.space abgeglichen. Die Prüfung ist von deren Blockauskunft abhängig.",
              "The block was checked against Blockstream and mempool.space. Verification depends on their block information.",
            )}
          </p>
        )}
        <p className="my-3 text-sm">
          {uiText(
            "Der Zeitnachweis belegt das Vorliegen des signierten, verschlüsselten Standes spätestens zum Bitcoin-Blockzeitpunkt. Die Bearbeitungssperre gilt unabhängig vom Beleg.",
            "The timestamp proves the existence of the signed, encrypted revision by the Bitcoin block time. Its edit lock applies independently of the proof.",
          )}
        </p>
        <MyButton
          disabled={!results?.some((result) => result.checked)}
          loading={busy}
          onClick={download}
        >
          {uiText("Nachweise herunterladen", "Download evidence")}
        </MyButton>
      </Modal>
    </>
  );
}
