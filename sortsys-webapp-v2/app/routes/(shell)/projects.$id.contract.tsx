import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { showCommercialWorkspace } from "~/modals/commercial";
import { useMyModals } from "~/hooks/useMyModals";
import { useEffect, useState } from "react";
import { useOutletContext, useSearchParams } from "react-router";
import { Button, Modal } from "@sortsys/react-components";
import { CommercialAdoptForm } from "~/components/CommercialAdoptForm";
import { client } from "~/lib/client";
import { CommercialCaseList } from "~/components/CommercialCaseList";
import { CommercialCreateForm } from "~/components/CommercialCreateForm";
import { CommercialBillingForm } from "~/components/CommercialBillingForm";
import { CommercialProjectForm } from "~/components/CommercialProjectForm";
import { MyHeader } from "~/components/MyHeader";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { uiText } from "~/lib/i18n";
import type { Project } from "~/type-helpers";
export default function ProjectContractPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const session = useSessionInfo();
  const modals = useMyModals();
  const [refresh, setRefresh] = useState(0);
  const [params] = useSearchParams();
  const [action, setAction] = useState(params.get("new") ?? "");
  const [hasContract, setHasContract] = useState<boolean>();
  useEffect(() => {
    let current = true;
    void client
      .query(
        "commercial.cases.list",
        { projectId: project.id, kind: "offer", limit: 1n },
        { strategy: "network-only" },
      )
      .then(([rows, error]) => {
        if (current && !error && rows) setHasContract(rows.length > 0);
      });
    return () => {
      current = false;
    };
  }, [project.id, refresh]);
  const close = () => {
    setAction("");
  };
  const created = (id: string) => {
    close();
    showCommercialWorkspace(modals, id, {
      onClosed: () => setRefresh((value) => value + 1),
    });
  };
  return (
    <>
      <MyHeader
        title={uiText("Auftrag & Leistungen", "Contract & work")}
        actions={
          session.canDo("manage:projects") &&
          !project.finishedAt && (
            <MyDropdown
              icon={Icons.Plus}
              kind="primary"
              size="sm"
              label={uiText("Neu", "New")}
              ariaLabel={uiText("Vorgang erstellen", "Create document")}
              items={[
                {
                  label: uiText("Rechnung", "Invoice"),
                  renderIcon: Icons.PriceRecord,
                  showIcon: true,
                  disabled: !hasContract,
                  onClick: () => setAction("billing"),
                },
                {
                  label: uiText("Nachtragsangebot", "Variation offer"),
                  renderIcon: Icons.DocumentAdd,
                  showIcon: true,
                  onClick: () => setAction("variation"),
                },
                {
                  label: uiText("Aufmaß", "Measurement"),
                  renderIcon: Icons.Excel,
                  showIcon: true,
                  disabled: !hasContract,
                  onClick: () => setAction("measurement"),
                },
                {
                  label: uiText("Weitervergabe", "Subcontract"),
                  renderIcon: Icons.Transfer,
                  showIcon: true,
                  disabled: !hasContract,
                  onClick: () => setAction("subcontract"),
                },
                {
                  label: uiText("Preisanfrage", "Price inquiry"),
                  renderIcon: Icons.Product,
                  showIcon: true,
                  disabled: !hasContract,
                  onClick: () => setAction("procurement"),
                },
                {
                  label: uiText("Kalkulation", "Cost calculation"),
                  renderIcon: Icons.PriceRecord,
                  showIcon: true,
                  disabled: !hasContract,
                  onClick: () => setAction("calculation"),
                },
              ]}
            />
          )
        }
      />
      {hasContract === false &&
        session.canDo("manage:projects") &&
        !project.finishedAt && (
          <div className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-default p-4">
            <p className="min-w-0 flex-1 text-sm">
              {uiText(
                "Für dieses Projekt ist noch keine Vertragsgrundlage hinterlegt. Ein vorhandenes Angebot oder Auftragsdokument stellt die Positionen für Aufmaße und Weitervergaben bereit.",
                "This project has no contract basis yet. An existing offer or order document provides the items for measurements and subcontracting.",
              )}
            </p>
            <Button kind="secondary" onClick={() => setAction("adopt")}>
              {uiText("Bestandsauftrag übernehmen", "Adopt existing contract")}
            </Button>
          </div>
        )}
      <CommercialCaseList projectId={project.id} refresh={refresh} />
      <Modal
        open={!!action}
        passiveModal
        modalHeading={
          action === "billing"
            ? uiText("Rechnung erstellen", "Create invoice")
            : action === "procurement"
              ? uiText("Preisanfrage", "Price inquiry")
              : action === "calculation"
                ? uiText("Kalkulation", "Cost calculation")
                : action === "adopt"
                  ? uiText(
                      "Bestandsauftrag übernehmen",
                      "Adopt existing contract",
                    )
                  : action === "variation"
                    ? uiText("Nachtragsangebot", "Variation offer")
                    : action === "measurement"
                      ? uiText("Aufmaß beginnen", "Start measurement")
                      : uiText("Leistungen weitervergeben", "Subcontract work")
        }
        onRequestClose={close}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {action === "billing" ? (
          <CommercialBillingForm projectId={project.id} onCreated={created} />
        ) : action === "adopt" ? (
          <CommercialAdoptForm
            projectId={project.id}
            title={project.title}
            onCreated={created}
          />
        ) : action === "variation" ? (
          <CommercialCreateForm
            kind="variation"
            hideHeading
            projectId={project.id}
            projectTitle={project.title}
            onCreated={created}
          />
        ) : [
            "measurement",
            "subcontract",
            "procurement",
            "calculation",
          ].includes(action) ? (
          <CommercialProjectForm
            key={action}
            kind={
              action as
                "measurement" | "subcontract" | "procurement" | "calculation"
            }
            projectId={project.id}
            projectTitle={project.title}
            onCreated={created}
          />
        ) : null}
      </Modal>
    </>
  );
}
