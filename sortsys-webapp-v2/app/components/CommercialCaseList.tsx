import { useEffect, useState } from "react";
import { combineLatest, type Subscription } from "rxjs";
import type { QueryResult } from "@sortsys/v2-client";
import { useProtectedDataContext } from "~/hooks/useProtectedDataContext";
import { useMyModals } from "~/hooks/useMyModals";
import { showCommercialWorkspace } from "~/modals/commercial";
import {
  Button,
  Select,
  SelectItem,
  TextInput,
} from "@sortsys/react-components";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import {
  commercialError,
  kindLabel,
  money,
  statusLabel,
  type CommercialKind,
} from "~/lib/commercial";
import { MyTable } from "~/components/MyTable";
import { MyCallout } from "~/components/MyCallout";

type OverviewRow = QueryResult<"commercial.cases.overview">[number];

export function CommercialCaseList({
  projectId,
  kind,
  refresh = 0,
}: {
  projectId?: string;
  kind?: CommercialKind;
  refresh?: number;
}) {
  const modals = useMyModals();
  const context = useProtectedDataContext();
  const [revision, setRevision] = useState(0);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const filterKey = JSON.stringify([projectId, kind, search, status]);
  const [pagination, setPagination] = useState({ filter: filterKey, pages: 1 });
  const count = pagination.filter === filterKey ? pagination.pages : 1;
  const [state, setState] = useState<{ context: AbortSignal; filter: string; pages: number; rows: OverviewRow[]; more: boolean; error: string } | null>(null);
  const current = state?.context === context && state.filter === filterKey && !context.aborted ? state : null;
  const rows = current?.rows ?? [], more = current?.more ?? false, error = current?.error ?? "", busy = !current || current.pages !== count;
  useEffect(() => {
    let active = true, subscription: Subscription | undefined;
    const timer = setTimeout(() => {
      subscription = combineLatest(Array.from({ length: count }, (_, index) => client.streamQuery("commercial.cases.overview", {
        projectId: projectId ?? null, kind: kind === "offer" && !projectId ? "sales" : (kind ?? null),
        status: status || null, search: search.trim() || null, limit: 50n, offset: BigInt(index * 50),
      }))).subscribe(pages => {
        if (!active || context.aborted) return;
        const error = pages.find(([, error]) => error)?.[1];
        const seen = new Set<string>();
        const rows = error ? [] : pages.flatMap(([values]) => values ?? []).filter(row => {
          if (seen.has(row.id)) return false; seen.add(row.id); return true;
        });
        setState({ context, filter: filterKey, pages: count, rows, more: !error && pages.at(-1)?.[0]?.length === 50, error: error ? commercialError(error) : "" });
      });
    }, 150);
    return () => {
      active = false; clearTimeout(timer); subscription?.unsubscribe();
    };
  }, [context, filterKey, count, refresh, revision]);
  return (
    <div
      className="flex min-w-0 flex-col gap-4"
      role="region"
      aria-label={
        kind === "offer"
          ? uiText("Angebotsübersicht", "Offers list")
          : uiText("Vorgangsübersicht", "Workflows list")
      }
      aria-busy={busy}
    >
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-48 flex-1">
          <TextInput
            labelText={uiText("Suchen", "Search")}
            value={search}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setSearch(event.target.value)
            }
          />
        </div>
        <div className="w-52">
          <Select
            labelText={uiText("Status", "Status")}
            value={status}
            onChange={(event: { target: { value: string } }) =>
              setStatus(event.target.value)
            }
          >
            <SelectItem value="" text={uiText("Alle Status", "All statuses")} />
            {(kind === "offer"
              ? ["draft", "sent", "accepted", "rejected", "cancelled"]
              : [
                  "draft",
                  "sent",
                  "accepted",
                  "requested",
                  "awarded",
                  "confirmed",
                  "submitted",
                  "approved",
                  "partially_paid",
                  "paid",
                  "rejected",
                  "cancelled",
                ]
            ).map((value) => (
              <SelectItem key={value} value={value} text={statusLabel(value)} />
            ))}
          </Select>
        </div>
      </div>
      {error && (
        <MyCallout
          kind="error"
          title={uiText(
            "Vorgänge nicht geladen",
            "Workflows could not be loaded",
          )}
        >
          {error}
          <Button
            kind="ghost"
            onClick={() => setRevision(value => value + 1)}
          >
            {uiText("Erneut versuchen", "Try again")}
          </Button>
        </MyCallout>
      )}
      <MyTable
        rows={rows}
        loading={busy && !rows.length}
        emptyMessage={
          kind === "offer"
            ? uiText(
                "Noch keine Angebote. Beginne mit einer Leistungsanfrage oder einem eigenen Angebot.",
                "No offers yet. Start with a work inquiry or your own offer.",
              )
            : uiText(
                "Noch keine Vorgänge zu diesem Auftrag.",
                "No workflows for this contract yet.",
              )
        }
        onRowClick={(row) =>
          showCommercialWorkspace(modals, row.id, {
            onClosed: () => setRevision((value) => value + 1),
          })
        }
        columns={[
          {
            label: uiText("Vorgang", "Workflow"),
            render: (row) => (
              <div>
                <strong>{row.title}</strong>
                <p className="text-xs text-muted">
                  {row.reference} · {kindLabel(row.kind)}
                </p>
              </div>
            ),
            sortKey: (row) => row.title,
          },
          {
            label: uiText("Kunde / Partner", "Customer / partner"),
            render: (row) => row.customerName ?? row.counterpartyName ?? "—",
          },
          {
            label: uiText("Status", "Status"),
            render: (row) => (
              <span className="whitespace-nowrap text-sm">
                {statusLabel(row.status)}
              </span>
            ),
          },
          {
            label: uiText("Netto", "Net"),
            render: (row) => money(row.netAmount, row.currency),
            sortKey: (row) => Number(row.netAmount ?? 0),
          },
          ...(!projectId
            ? [
                {
                  label: uiText("Projekt", "Project"),
                  render: (row: OverviewRow) =>
                    row.projectId
                      ? uiText("Zugeordnet", "Linked")
                      : uiText("Vor Projektbeginn", "Before project start"),
                },
              ]
            : []),
        ]}
        autoConvertSmallViewport
      />
      {more && (
        <div className="flex justify-center">
          <Button
            kind="secondary"
            loading={busy}
            onClick={() => setPagination({ filter: filterKey, pages: count + 1 })}
          >
            {uiText("Mehr anzeigen", "Show more")}
          </Button>
        </div>
      )}
    </div>
  );
}
