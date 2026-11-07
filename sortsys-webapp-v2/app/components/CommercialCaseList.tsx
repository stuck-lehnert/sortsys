import { useEffect, useRef, useState } from "react";
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
  type CommercialCase,
  type CommercialKind,
} from "~/lib/commercial";
import { MyTable } from "~/components/MyTable";
import { MyCallout } from "~/components/MyCallout";

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
  const [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<CommercialCase[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const previousFilter = useRef<string | undefined>(undefined);
  const filterKey = JSON.stringify([projectId, kind, search, status]);
  const load = async (offset: number, epoch: number, count = 50) => {
    setBusy(true);
    setError("");
    const pages = await Promise.all(
      Array.from({ length: Math.ceil(count / 50) }, (_, index) =>
        client.query(
          "commercial.cases.list",
          {
            projectId: projectId ?? null,
            kind: kind === "offer" && !projectId ? "sales" : (kind ?? null),
            status: status || null,
            search: search.trim() || null,
            limit: 50n,
            offset: BigInt(offset + index * 50),
          },
          { strategy: "network-only" },
        ),
      ),
    );
    if (epoch !== generation.current) return;
    const error = pages.find(([, error]) => error)?.[1];
    if (error) setError(commercialError(error));
    else {
      const values = pages.flatMap(([values]) => values ?? []);
      setRows((previous) => (offset ? [...previous, ...values] : values));
      setMore(pages.at(-1)?.[0]?.length === 50);
    }
    setBusy(false);
  };
  useEffect(() => {
    const epoch = ++generation.current;
    setBusy(true);
    const sameFilter = previousFilter.current === filterKey;
    previousFilter.current = filterKey;
    if (!sameFilter) setRows([]);
    const timer = setTimeout(
      () => void load(0, epoch, sameFilter ? Math.max(50, rows.length) : 50),
      150,
    );
    return () => {
      clearTimeout(timer);
      generation.current++;
    };
  }, [projectId, kind, search, status, refresh, revision]);
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
            onClick={() => void load(rows.length, generation.current)}
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
                  render: (row: CommercialCase) =>
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
            onClick={() => void load(rows.length, generation.current)}
          >
            {uiText("Mehr anzeigen", "Show more")}
          </Button>
        </div>
      )}
    </div>
  );
}
