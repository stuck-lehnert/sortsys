import type { QueryResult } from "@sortsys/v2-client";
import { uiText } from "~/lib/i18n";
import type { Route } from "./+types/tools.transferRequests";
import { useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyExpandable } from "~/components/MyExpandable";
import { MyTable, type MyTableColumn } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate, toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { MyLink } from "~/components/MyLink";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Umbuchungsanfragen", "Transfer requests") }];
}

type TransferRequest = QueryResult<"tools.trackings.transfers.list">[number];
type TransferAction = "accept" | "deny";

async function renderUser(id: string | null) {
  if (!id) return;

  const [user] = await client.query(
    "users.get",
    { id },
    { strategy: "cache-first" },
  );
  if (!user) return uiText("Unbekannt", "Unknown");

  return <MyLink to={`/users/${user.id}`}>{userFullName(user)}</MyLink>;
}

export default function ToolTransferRequestsPage() {
  const sessionInfo = useSessionInfo();
  const [requests, requestsError] = useClientStream(() =>
    client.streamQuery("tools.trackings.transfers.list", {}),
  );
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const groups = useMemo(() => {
    const rows: Record<TransferRequest["status"], TransferRequest[]> = {
      open: [],
      accepted: [],
      denied: [],
    };
    for (const request of requests ?? []) rows[request.status].push(request);
    return rows;
  }, [requests]);

  async function decide(action: TransferAction, id: string) {
    setPendingAction(`${action}:${id}`);
    setActionError(null);

    try {
      const [, error] = await client.mutate(`tools.trackings.transfers.${action}`, {
        id,
      });
      if (error) throw error;
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : uiText("Die Aktion ist fehlgeschlagen.", "The action failed."),
      );
    } finally {
      setPendingAction(null);
    }
  }

  const actions: MyTableColumn<TransferRequest> = {
    label: uiText("Aktionen"),
    render: (row) => {
      const enabled =
        sessionInfo.canDo("manage:toolTrackings") ||
        row.transferToUserId === sessionInfo.user.id;

      return (
        <div className="flex gap-1 flex-wrap">
          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Accept}
            loading={pendingAction === `accept:${row.id}`}
            onClick={() => decide("accept", row.id)}
            disabled={!enabled || !!pendingAction}
          >
            {uiText("Annehmen", "Accept")}
          </MyButton>
          <MyButton
            size="sm"
            kind="ghost"
            renderIcon={Icons.Deny}
            loading={pendingAction === `deny:${row.id}`}
            onClick={() => decide("deny", row.id)}
            disabled={!enabled || !!pendingAction}
          >
            {uiText("Ablehnen", "Deny")}
          </MyButton>
        </div>
      );
    },
  };
  const columns: MyTableColumn<TransferRequest>[] = [
    {
      label: uiText("Werkzeug"),
      render: async ({ toolId }) => {
        const [tool] = await client.query(
          "tools.get",
          { id: toolId },
          { strategy: "cache-first" },
        );
        if (!tool) return uiText("Unbekannt", "Unknown");

        return (
          <MyLink to={`/tools/${tool.id}`}>
            {tool.customId} {toolTitle(tool)}
          </MyLink>
        );
      },
    },
    {
      label: uiText("Verantwortlich"),
      render: ({ responsibleUserId }) => renderUser(responsibleUserId),
    },
    {
      label: uiText("Umbuchen auf"),
      render: ({ transferToUserId }) => renderUser(transferToUserId),
    },
    {
      label: uiText("Projekt", "Project"),
      render: async ({ projectId }) => {
        if (!projectId) return;

        const [project] = await client.query(
          "projects.get",
          { id: projectId },
          { strategy: "cache-first" },
        );
        if (!project) return uiText("Unbekannt", "Unknown");

        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      },
    },
    {
      label: uiText("Angefragt am"),
      render: (row) => formatDate(row.createdAt),
    },
  ];
  const sections = [
    { status: "open", title: uiText("Offen") },
    { status: "accepted", title: uiText("Genehmigt") },
    { status: "denied", title: uiText("Abgelehnt") },
  ] as const;

  return (
    <>
      <MyHeader title={uiText("Umbuchungsanfragen", "Transfer requests")} />

      {!!actionError && (
        <MyCallout
          kind="error"
          title={uiText(
            "Umbuchung konnte nicht verarbeitet werden",
            "Transfer request could not be processed",
          )}
          subtitle={actionError}
        />
      )}

      {sections.map(({ status, title }) => {
        const open = status === "open";
        const rows = groups[status];
        if (!open && !rows.length) return null;

        return (
          <MyExpandable key={status} title={title} initiallyExpanded={open}>
            <MyTable
              className="th-20rem"
              rows={rows}
              loading={open && !requests}
              error={open ? requestsError : undefined}
              columns={open ? [actions, ...columns] : columns}
              loadMore={{}}
            />
          </MyExpandable>
        );
      })}
    </>
  );
}
