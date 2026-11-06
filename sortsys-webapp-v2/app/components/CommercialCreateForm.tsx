import { useState } from "react";
import { Button } from "@sortsys/react-components";
import { createGaebXml, GaebDocument } from "@sortsys/gaeb";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useMyModals } from "~/hooks/useMyModals";
import { MyForm } from "~/components/MyForm";
import { customerName } from "~/lib/format";
import { SmallCustomerTile } from "~/lib/tiles";
import type { Customer } from "~/type-helpers";
import {
  commercialError,
  storeCommercialDocument,
  type CommercialKind,
} from "~/lib/commercial";
import { MyCallout } from "~/components/MyCallout";

export function CommercialCreateForm({
  kind = "offer",
  projectId,
  projectTitle,
  onCreated,
  hideHeading = false,
}: {
  kind?: CommercialKind;
  projectId?: string;
  projectTitle?: string;
  onCreated: (id: string) => void;
  hideHeading?: boolean;
}) {
  const session = useSessionInfo();
  const createAction = useCreateEntityAction(useMyModals());
  const [title, setTitle] = useState("");
  const [customerId, setCustomerId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [createdId, setCreatedId] = useState<string>();
  const create = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    let id = createdId;
    try {
      if (!session.canDo("manage:projects")) throw new Error("forbidden");
      if (!id) {
        const [value, error] = await client.mutate("commercial.cases.create", {
          kind,
          title: title.trim(),
          projectId: projectId ?? null,
          customerId: customerId || null,
          scopeItemIds: [],
        });
        if (error || !value) throw error ?? new Error("create-failed");
        id = value.id;
        setCreatedId(id);
      }
      const [existing, failure] = await client.query(
        "commercial.cases.get",
        { id },
        { strategy: "network-only" },
      );
      if (failure || !existing) throw failure ?? new Error("load-failed");
      if (!existing.documents.some((doc) => doc.purpose === "inquiry")) {
        let model = new GaebDocument(
          createGaebXml("83", title.trim()),
          "scope.x83",
        );
        model = new GaebDocument(model.setDocumentKind(kind), model.fileName);
        if (projectTitle)
          model = new GaebDocument(
            model.setProjectName(projectTitle),
            model.fileName,
          );
        await storeCommercialDocument({
          caseId: id,
          purpose: "inquiry",
          fileName: `${title.trim().replace(/[\\/]/g, "_")}.x83`,
          xml: model.source,
          readOnly: false,
        });
      }
      onCreated(id);
    } catch (error) {
      setError(commercialError(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <MyForm onSubmit={create} className="flex min-w-0 flex-col gap-5">
      {!hideHeading && (
        <h2 className="text-lg font-semibold">
          {kind === "variation"
            ? uiText("Nachtragsangebot erstellen", "Create a variation offer")
            : uiText("Angebot erstellen", "Create an offer")}
        </h2>
      )}
      {error && (
        <MyCallout
          kind="error"
          title={uiText(
            "Erstellen nicht abgeschlossen",
            "Creation did not complete",
          )}
        >
          {error}
        </MyCallout>
      )}
      <MyForm.Input
        name="title"
        labelText={uiText("Bezeichnung", "Title")}
        required
        maxLength={127}
        onValueChange={setTitle}
        disabled={busy || !!createdId}
      />
      <MyForm.MultiSelect<Customer>
        name="customer"
        labelText={uiText("Kunde", "Customer")}
        minSelectedItems={kind === "offer" ? 1 : 0}
        maxSelectedItems={1}
        disabled={busy || !!createdId}
        getOptions={async ({ query }) => {
          const [data, error] = await client.query("customers.list", {
            search: query,
          });
          if (error) throw error;
          return data ?? [];
        }}
        renderItem={({ item }) => customerName(item)}
        renderTile={(item) => <SmallCustomerTile data={item} noLink />}
        createAction={createAction.customer}
        onValueChange={(items) => setCustomerId(items[0]?.id ?? "")}
      />
      <div className="flex justify-end">
        <Button
          type="submit"
          loading={busy}
          disabled={!title.trim() || (kind === "offer" && !customerId)}
        >
          {createdId
            ? uiText("Erstellung fortsetzen", "Continue creation")
            : uiText("Angebot erstellen", "Create an offer")}
        </Button>
      </div>
    </MyForm>
  );
}
