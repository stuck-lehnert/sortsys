import { uiText } from "~/lib/i18n";
import { Button } from "@heroui/react";
import { useState } from "react";
import type { ToolTracking } from "~/type-helpers";
import { MyTable, type MyTableColumn } from "./MyTable";
import { client } from "~/lib/client";
import { MyLink } from "./MyLink";
import { formatDate, userFullNameComma } from "~/lib/format";
import { TrackingTile } from "~/lib/tiles";
import { TrackingToolReference } from "./trackingToolReference";

function ReturnBookingButton({ trackingId }: { trackingId: string }) {
  const [running, setRunning] = useState(false);
  const [failed, setFailed] = useState(false);
  async function submit() {
    setRunning(true);
    setFailed(false);
    try {
      const [, error] = await client.mutate("tools.trackings.return", { trackingId });
      if (error) throw error;
    } catch {
      setFailed(true);
    } finally {
      setRunning(false);
    }
  }
  return (
    <div>
      <Button size="sm" isDisabled={running} onPress={submit}>
        {uiText("Zurückbuchen")}
      </Button>
      {failed && (
        <p role="alert">
          {uiText(
            "Das Werkzeug konnte nicht zurückgebucht werden.",
            "The tool could not be returned.",
          )}
        </p>
      )}
    </div>
  );
}

export function TrackingTable(props: {
  trackings: ToolTracking[];
  omit?: ("tool" | "project" | "author" | "responsible" | "timestamps")[];
  className?: string;
  loading?: boolean;
  error?: unknown;
}) {
  const columns: MyTableColumn<ToolTracking>[] = [];

  if (!props.omit?.includes("tool")) {
    columns.push({
      label: uiText("Werkzeug"),
      render: (tracking) => <TrackingToolReference tracking={tracking} />,
    });
  }

  if (!props.omit?.includes("project")) {
    columns.push({
      label: uiText("Projekt"),
      render: async (tracking) => {
        if (!tracking.projectId) return;

        const [project] = await client.query(
          "projects.get",
          { id: tracking.projectId },
          { strategy: "cache-first" },
        );
        if (!project) return "Unbekannt";
        return <MyLink to={`/projects/${project.id}`}>{project.title}</MyLink>;
      },
    });
  }

  if (!props.omit?.includes("responsible")) {
    columns.push({
      label: uiText("Verantwortlicher"),
      render: async (tracking) => {
        if (!tracking.responsibleUserId) return;

        const [user] = await client.query(
          "users.get",
          { id: tracking.responsibleUserId },
          { strategy: "cache-first" },
        );
        if (!user) return "Unbekannt";
        return (
          <MyLink to={`/users/${user.id}`}>{userFullNameComma(user)}</MyLink>
        );
      },
    });
  }

  if (!props.omit?.includes("author")) {
    columns.push({
      label: uiText("Herausgeber"),
      render: async (tracking) => {
        if (!tracking.startedByUserId) return;

        const [user] = await client.query(
          "users.get",
          { id: tracking.startedByUserId },
          { strategy: "cache-first" },
        );
        if (!user) return "Unbekannt";
        return (
          <MyLink to={`/users/${user.id}`}>{userFullNameComma(user)}</MyLink>
        );
      },
    });
  }

  if (!props.omit?.includes("timestamps")) {
    columns.push({
      label: uiText("Von"),
      render: (tracking) => formatDate(tracking.startedAt),
      sortKey: (tracking) => tracking.startedAt.getTime(),
    });

    columns.push({
      label: uiText("Bis"),
      render: (tracking) =>
        tracking.endedAt ? formatDate(tracking.endedAt) : "offen",
      sortKey: (tracking) =>
        tracking.endedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
    });
  }

  function returnAction(tracking: ToolTracking) {
    return tracking.canReturnOwn ? <ReturnBookingButton trackingId={tracking.id} /> : null;
  }
  if (props.trackings.some((tracking) => tracking.canReturnOwn)) {
    columns.push({ label: uiText("Aktionen"), render: returnAction });
  }

  return (
    <MyTable
      loading={props.loading}
      error={props.error}
      rows={props.trackings}
      columns={columns}
      loadMore={{}}
      className={props.className ?? "th-20rem"}
      renderSmallViewport={(tracking) =>
        tracking.canReturnOwn ? (
          <div className="grid gap-2">
            <TrackingTile tracking={tracking} omit={props.omit} />
            {returnAction(tracking)}
          </div>
        ) : (
          <TrackingTile tracking={tracking} omit={props.omit} />
        )
      }
      viewportBreakpoint={1400}
    />
  );
}
