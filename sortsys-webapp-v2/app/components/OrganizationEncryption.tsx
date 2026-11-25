import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import OrganizationInvitations from "./OrganizationInvitations";
import { SigningRequestApproval } from "./SigningRenewal";

function CommercialRelationshipReview() {
  const active = useRef<AbortController | null>(null);
  const [progress, setProgress] = useState<{
    status: "running" | "complete" | "failed";
    reviewed: number;
  }>();

  useEffect(() => () => {
    active.current?.abort();
    active.current = null;
  }, []);

  async function review() {
    if (active.current) return;

    const controller = new AbortController();
    active.current = controller;
    let reviewed = 0;
    setProgress({ status: "running", reviewed });

    try {
      const { reviewReadableCommercialRelationships } = await import(
        "~/lib/data/commercialReview"
      );
      await reviewReadableCommercialRelationships(client, controller.signal, (count) => {
        reviewed = count;
        setProgress({ status: "running", reviewed });
      });
      if (!controller.signal.aborted) setProgress({ status: "complete", reviewed });
    } catch {
      if (!controller.signal.aborted) setProgress({ status: "failed", reviewed });
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  return (
    <details className="space-y-4 rounded-md border border-border p-4">
      <summary className="cursor-pointer font-semibold">
        {uiText("Beziehungen in älteren Angeboten prüfen", "Review relationships in older offers")}
      </summary>
      <p className="text-sm">
        {uiText(
          "Die Prüfung ergänzt technische Nachweise für lesbare Vorgänge und Projektfinanzen. Sie ändert keine Angebote, Dokumente oder früheren Fassungen. Nicht freigegebene Bereiche bleiben ungeprüft.",
          "The review records relationship proofs for cases and project finances you can read. It does not change offers, documents or earlier revisions. Areas you cannot read are not reviewed.",
        )}
      </p>
      <MyButton
        type="button"
        kind="secondary"
        loading={progress?.status === "running"}
        onClick={review}
      >
        {uiText("Beziehungen prüfen", "Review relationships")}
      </MyButton>
      {progress && (
        <p role="status">
          {progress.status === "complete"
            ? uiText("Prüflauf beendet. Geprüfte Datensätze:", "Review finished. Records reviewed:")
            : uiText("Geprüfte Datensätze:", "Records reviewed:")}{" "}
          {progress.reviewed}
        </p>
      )}
      {progress?.status === "failed" && (
        <MyCallout color="red">
          {uiText(
            "Die Prüfung wurde nicht abgeschlossen. Bereits gespeicherte Nachweise bleiben erhalten. Die Prüfung kann erneut gestartet werden.",
            "The review did not finish. Proofs already recorded are kept. The review can be run again.",
          )}
        </MyCallout>
      )}
    </details>
  );
}

export default function OrganizationEncryption() {
  return (
    <div className="max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">
        {uiText("Wiederherstellung", "Recovery")}
      </h2>
      <p>
        {uiText(
          "Der Notfallzugang wurde bei der Einrichtung gesichert. Für die normale Anmeldung wird nur das Anmeldepasswort benötigt.",
          "Emergency access was backed up during setup. Normal sign-in only requires the account password.",
        )}
      </p>
      <Link to="/auth/recovery">
        {uiText(
          "Organisation mit Wiederherstellungsphrase wiederherstellen",
          "Recover organization using the recovery phrase",
        )}
      </Link>
      <SigningRequestApproval />
      <OrganizationInvitations />
      <CommercialRelationshipReview />
    </div>
  );
}
