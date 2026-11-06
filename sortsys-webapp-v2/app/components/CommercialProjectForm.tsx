import { useEffect, useState } from "react";
import {
  Button,
  Checkbox,
  Select,
  SelectItem,
  TextInput,
} from "@sortsys/react-components";
import { GaebDocument } from "@sortsys/gaeb";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import {
  commercialError,
  deriveChecked,
  loadCommercialDocument,
  storeCommercialDocument,
  type CommercialCase,
  type CommercialDocument,
} from "~/lib/commercial";
import { MyCallout } from "~/components/MyCallout";

export function CommercialProjectForm({
  projectId,
  projectTitle,
  kind,
  onCreated,
}: {
  projectId: string;
  projectTitle?: string;
  kind: "subcontract" | "measurement" | "procurement" | "calculation";
  onCreated: (id: string) => void;
}) {
  const session = useSessionInfo();
  const [title, setTitle] = useState("");
  const [contracts, setContracts] = useState<CommercialCase[]>([]);
  const [parentId, setParentId] = useState("");
  const [source, setSource] = useState<{
    doc: CommercialDocument;
    xml: string;
    referenceXml?: string;
    scope: GaebDocument;
  } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [occupied, setOccupied] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  useEffect(() => {
    let active = true;
    void client
      .query(
        "commercial.cases.list",
        { projectId, limit: 200n },
        { strategy: "network-only" },
      )
      .then(([values, error]) => {
        if (!active) return;
        if (error) {
          setError(commercialError(error));
          return;
        }
        const contracts = (values ?? []).filter(
          (item) =>
            ["offer", "variation", "alternative"].includes(item.kind) &&
            item.status === "accepted",
        );
        setContracts(contracts);
        setParentId(contracts[0]?.id ?? "");
        setOccupied(
          new Set(
            (values ?? [])
              .filter(
                (item) =>
                  item.kind === "subcontract" &&
                  ["awarded", "confirmed"].includes(item.status),
              )
              .flatMap((item) =>
                Array.isArray(item.scopeItemIds)
                  ? item.scopeItemIds
                      .filter((id): id is string => typeof id === "string")
                      .map((id) => `${item.parentCaseId}:${id}`)
                  : [],
              ),
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
    setBusy(true);
    setSource(null);
    setError("");
    void (async () => {
      const [value, error] = await client.query(
        "commercial.cases.get",
        { id: parentId },
        { strategy: "network-only" },
      );
      if (error || !value) throw error ?? new Error("load-failed");
      const doc =
        value.documents.find((doc) => doc.purpose === "order") ??
        value.documents.find((doc) => doc.purpose === "offer");
      if (!doc) throw new Error("workflow-reference-required");
      const loaded = await loadCommercialDocument(parentId, doc.id);
      const model = new GaebDocument(loaded.xml, doc.fileName);
      const scope =
        model.phase === "84" && loaded.referenceXml
          ? new GaebDocument(loaded.referenceXml, "reference.xml")
          : model;
      if (active) {
        setSource({
          doc,
          xml: loaded.xml,
          referenceXml: loaded.referenceXml ?? undefined,
          scope,
        });
        setSelected(
          kind !== "subcontract"
            ? scope.items.map((item) => item.element.getAttribute("ID")!)
            : [],
        );
      }
    })()
      .catch((error) => {
        if (active) setError(commercialError(error));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [parentId, kind]);
  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!source) return;
    setBusy(true);
    setError("");
    try {
      const phase =
        kind === "measurement"
          ? "31"
          : kind === "procurement"
            ? "93"
            : kind === "calculation"
              ? "52"
              : "83";
      const xml = await deriveChecked(source.xml, phase, {
        referenceXml: source.referenceXml,
        selectedItemIds: selected,
        ownCompany: session.tenant.companyName ?? undefined,
        title,
        projectTitle,
      });
      let id = createdId;
      if (!id) {
        const [value, error] = await client.mutate("commercial.cases.create", {
          kind,
          title,
          projectId,
          parentCaseId: parentId,
          scopeItemIds: selected,
        });
        if (error || !value) throw error ?? new Error("create-failed");
        id = value.id;
        setCreatedId(id);
      }
      await storeCommercialDocument({
        caseId: id,
        purpose:
          kind === "measurement"
            ? "measurement"
            : kind === "procurement"
              ? "price_inquiry"
              : kind === "calculation"
                ? "calculation"
                : "inquiry",
        fileName: `${title.replace(/[\\/]/g, "_")}.x${phase}`,
        xml,
        readOnly: false,
        sourceDocumentId: source.doc.id,
        sourceVersion: source.doc.version,
      });
      onCreated(id);
    } catch (error) {
      setError(commercialError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => void create(event)}
    >
      {kind === "subcontract" && (
        <p className="text-sm text-muted">
          {uiText(
            "Wähle einen beauftragten Leistungsumfang und die Positionen für das Paket. Eigene Verkaufspreise werden nicht in die Anfrage übernommen.",
            "Choose an accepted scope and the items for this package. Your own selling prices are excluded from the inquiry.",
          )}
        </p>
      )}
      {error && (
        <MyCallout
          kind="error"
          title={uiText(
            "Vorgang nicht abgeschlossen",
            "Action did not complete",
          )}
        >
          {error}
        </MyCallout>
      )}
      <TextInput
        labelText={uiText("Bezeichnung", "Title")}
        value={title}
        required
        maxLength={127}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
          setTitle(event.target.value)
        }
        disabled={busy || !!createdId}
      />
      <Select
        labelText={uiText(
          "Zugehöriger Auftrag / Nachtrag",
          "Related contract / variation",
        )}
        value={parentId}
        disabled={busy || !!createdId}
        onChange={(event: { target: { value: string } }) =>
          setParentId(event.target.value)
        }
      >
        {contracts.map((item) => (
          <SelectItem
            key={item.id}
            value={item.id}
            text={`${item.reference} · ${item.title}`}
          />
        ))}
      </Select>
      {!contracts.length && !busy && (
        <p className="text-sm">
          {uiText(
            "Es wird zuerst ein angenommenes Angebot oder ein angenommener Nachtrag in diesem Projekt benötigt.",
            "An accepted offer or variation in this project is required first.",
          )}
        </p>
      )}
      {source && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm">
              {uiText(
                `${selected.length} Positionen ausgewählt`,
                `${selected.length} items selected`,
              )}
            </span>
            <Button
              kind="ghost"
              size="sm"
              disabled={busy || !!createdId}
              onClick={() =>
                setSelected(
                  source.scope.items
                    .map((item) => item.element.getAttribute("ID")!)
                    .filter(
                      (id) =>
                        kind === "measurement" ||
                        !occupied.has(`${parentId}:${id}`),
                    ),
                )
              }
            >
              {uiText("Alle verfügbaren auswählen", "Select all available")}
            </Button>
          </div>
          <div
            className="max-h-72 overflow-auto rounded border border-border p-3"
            role="group"
            aria-label={uiText(
              "Positionen im Leistungspaket",
              "Items in the work package",
            )}
          >
            {source.scope.items.map((item) => {
              const id = item.element.getAttribute("ID")!;
              const assigned =
                kind === "subcontract" && occupied.has(`${parentId}:${id}`);
              return (
                <Checkbox
                  key={id}
                  id={`scope-${id}`}
                  className="w-full [&_[data-slot=checkbox-content]]:w-full"
                  labelText={`${item.oz} · ${item.title || uiText("Position", "Item")}${assigned ? ` · ${uiText("bereits weitervergeben", "already subcontracted")}` : ""}`}
                  checked={selected.includes(id)}
                  disabled={busy || assigned || !!createdId}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    const checked = event.target.checked;
                    setSelected((values) =>
                      checked
                        ? [...values, id]
                        : values.filter((value) => value !== id),
                    );
                  }}
                />
              );
            })}
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button
          type="submit"
          loading={busy}
          disabled={!title.trim() || !source || !selected.length}
        >
          {kind === "subcontract"
            ? uiText("Leistungspaket anlegen", "Create work package")
            : kind === "procurement"
              ? uiText("Preisanfrage erstellen", "Create price inquiry")
              : kind === "calculation"
                ? uiText("Kalkulation erstellen", "Create calculation")
                : uiText("Aufmaß beginnen", "Start measurement")}
        </Button>
      </div>
    </form>
  );
}
