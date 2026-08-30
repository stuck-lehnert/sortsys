import { uiText } from "~/lib/i18n";
import { useNavigate } from "react-router";
import { MyCallout } from "~/components/MyCallout";
import { MyLink } from "~/components/MyLink";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useIntUrlParam, useStringUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { formatCurrency, formatPercent, gainOrLossColor, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { useEffect, useMemo } from "react";
import { TableExportActions } from "~/components/TableExportActions";
import { EXCEL_CURRENCY_NUM_FMT, EXCEL_PERCENT_NUM_FMT } from "~/lib/xlsx";

type ProjectCostsOverviewRow = {
  projectId: string;
  title: string;
  costs: number;
  offersTotal: number;
  invoicesTotal: number;
  gainOrLoss: number | null;
  hasInvoices: boolean;
  finishedAt: Date | null;
  responsibleProjectLeaderUserId: string | null;
};

type ProjectCostStatusFilter = 'active' | 'finished' | 'all';

type ProjectCostsFilterOptions = {
  finishingYears: number[];
  projectLeaders: {
    id: string;
    firstName: string;
    lastName: string | null;
  }[];
};

const PROJECT_COST_STATUS_LABELS: Record<ProjectCostStatusFilter, string> = {
  active: 'Laufend',
  finished: 'Abgeschlossen',
  all: 'Alle',
};

function isProjectCostStatusFilter(value: string | null): value is ProjectCostStatusFilter {
  return value === 'active' || value === 'finished' || value === 'all';
}

export function meta() {
  return [
    { title: uiText("Kostenübersicht") },
  ];
}

function hasNumberData(value: number | null | undefined) {
  return Math.abs(Number(value ?? 0)) > 0.000001;
}

function formatGainOrLossPercentage(value: number, invoicesTotal: number) {
  if (!hasNumberData(invoicesTotal)) return null;
  return formatPercent((value / Math.abs(invoicesTotal)) * 100);
}

function formatGainOrLoss(value: number | null, invoicesTotal: number) {
  if (value == null) return '-';
  const percentage = formatGainOrLossPercentage(value, invoicesTotal);
  const amount = formatCurrency(value);
  return `${percentage ? `(${percentage}) ` : ''}${amount}`;
}

function renderGainOrLoss(value: number | null, invoicesTotal: number) {
  if (value == null) return '-';
  return <span style={{ color: gainOrLossColor(value), fontWeight: 700 }}>{formatGainOrLoss(value, invoicesTotal)}</span>;
}

export default function ProjectCostsOverviewPage() {
  const navigate = useNavigate();
  const [statusParam, setStatusParam] = useStringUrlParam('status');
  const [closingYear, setClosingYear] = useIntUrlParam('closingYear');
  const [projectLeaderUserId, setProjectLeaderUserId] = useStringUrlParam('projectLeaderUserId');
  const status = isProjectCostStatusFilter(statusParam) ? statusParam : 'active';
  const overviewInput = useMemo(() => ({
    status,
    closingYear: status !== 'active' && typeof closingYear === 'number' ? closingYear : undefined,
    responsibleProjectLeaderUserId: projectLeaderUserId ?? undefined,
  }), [status, closingYear, projectLeaderUserId]);

  const [filterOptions, filterOptionsErr] = useClientStream<ProjectCostsFilterOptions | null, any>(() => {
    return client.streamQuery('projects.costs.filterOptions', undefined);
  }, []);
  const [rows, err] = useClientStream<ProjectCostsOverviewRow[] | null, any>(() => {
    return client.streamQuery('projects.costs.overview', overviewInput);
  }, [overviewInput]);

  useEffect(() => {
    if (!filterOptions) return;

    if (statusParam && !isProjectCostStatusFilter(statusParam)) setStatusParam(null);
    if (status === 'active' && closingYear != null) setClosingYear(null);
    if (closingYear != null && !filterOptions.finishingYears.includes(closingYear)) setClosingYear(null);
    if (projectLeaderUserId && !filterOptions.projectLeaders.some(projectLeader => projectLeader.id === projectLeaderUserId)) {
      setProjectLeaderUserId(null);
    }
  }, [filterOptions, status, statusParam, setStatusParam, closingYear, setClosingYear, projectLeaderUserId, setProjectLeaderUserId]);

  const userById = useMemo(() => {
    return new Map((filterOptions?.projectLeaders ?? []).map(user => [user.id, user]));
  }, [filterOptions]);
  const tableRows = (rows ?? []).map(row => ({ ...row, id: row.projectId }));

  return <>
    {!!err && <MyCallout icon={Icons.Deny} color="red">{uiText("Kostenübersicht konnte nicht geladen werden:")} {err.message}
    </MyCallout>}
    {!!filterOptionsErr && <MyCallout icon={Icons.Deny} color="red">{uiText("Filteroptionen konnten nicht geladen werden:")} {filterOptionsErr.message}
    </MyCallout>}

    <div className="flex gap-2 w-full overlflow-x-auto">
      <TableExportActions
        title={uiText("Kostenübersicht")}
        fileName="Kostenuebersicht"
        rows={tableRows}
        disabled={!rows}
        columns={[
          { header: uiText("Projekt"), value: row => row.title, width: '2fr' },
          { header: uiText("Status"), value: row => row.finishedAt ? 'Abgeschlossen' : 'Laufend' },
          { header: uiText("Projektleiter"), value: row => {
            const user = row.responsibleProjectLeaderUserId ? userById.get(row.responsibleProjectLeaderUserId) : null;
            return user ? userFullName(user) : '-';
          }, width: '1.5fr' },
          {
            header: uiText("Kosten"),
            value: row => row.costs,
            format: value => formatCurrency(Number(value)),
            excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
            align: 'right',
          },
          {
            header: uiText("Gewinn/Verlust (absolut)"),
            value: row => row.gainOrLoss,
            format: value => value == null ? '-' : formatCurrency(Number(value)),
            excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
            align: 'right',
          },
          {
            header: uiText("Gewinn/Verlust (relativ)"),
            value: row => row.gainOrLoss == null || !hasNumberData(row.invoicesTotal)
              ? null
              : row.gainOrLoss / Math.abs(row.invoicesTotal),
            format: value => value == null ? '-' : formatPercent(Number(value) * 100),
            excelNumberFormat: EXCEL_PERCENT_NUM_FMT,
            align: 'right',
          },
          {
            header: uiText("Angebotssummen"),
            value: row => row.offersTotal,
            format: value => formatCurrency(Number(value)),
            excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
            align: 'right',
          },
          {
            header: uiText("Rechnungssummen"),
            value: row => row.invoicesTotal,
            format: value => formatCurrency(Number(value)),
            excelNumberFormat: EXCEL_CURRENCY_NUM_FMT,
            align: 'right',
          },
        ]}
      />
    </div>

    <div className="project-costs-filter-bar">
      <label>
        <span>{uiText("Status")}</span>
        <select value={status} onChange={event => {
          const nextStatus = event.target.value as ProjectCostStatusFilter;
          setStatusParam(nextStatus === 'active' ? null : nextStatus);
          if (nextStatus === 'active') setClosingYear(null);
        }}>
          <option value="active">{PROJECT_COST_STATUS_LABELS.active}</option>
          <option value="finished">{PROJECT_COST_STATUS_LABELS.finished}</option>
          <option value="all">{PROJECT_COST_STATUS_LABELS.all}</option>
        </select>
      </label>

      {status !== 'active' && <label>
        <span>{uiText("Abschlussjahr")}</span>
        <select
          value={closingYear?.toString() ?? ''}
          onChange={event => setClosingYear(event.target.value ? Number.parseInt(event.target.value, 10) : null)}
          disabled={!filterOptions?.finishingYears.length}
        >
          <option value="">{uiText("Alle")}</option>
          {(filterOptions?.finishingYears ?? []).map(year => <option key={year} value={year}>{year}</option>)}
        </select>
      </label>}

      <label>
        <span>{uiText("Projektleiter")}</span>
        <select value={projectLeaderUserId ?? ''} onChange={event => setProjectLeaderUserId(event.target.value || null)}>
          <option value="">{uiText("Alle")}</option>
          {(filterOptions?.projectLeaders ?? []).map(user => <option key={user.id} value={user.id}>{userFullName(user)}</option>)}
        </select>
      </label>
    </div>

    {!err && rows?.length === 0 && <MyCallout icon={Icons.Info} color="grey">{uiText("Keine Projekte für die aktuellen Filter.")}</MyCallout>}

    <MyTable
      topPagination
      persistentId="ProjectCostsOverview"
      rows={tableRows}
      onRowClick={row => navigate(`/projects/${row.projectId}/costs`)}
      columns={[
        {
          label: uiText("Projekt"),
          render: row => <MyLink to={`/projects/${row.projectId}/costs`}>{row.title}</MyLink>,
          sortKey: row => row.title.toLowerCase(),
        },
        {
          label: uiText("Status"),
          render: row => row.finishedAt ? 'Abgeschlossen' : 'Laufend',
          sortKey: row => row.finishedAt?.getTime() ?? Number.MAX_SAFE_INTEGER,
        },
        {
          label: uiText("Projektleiter"),
          render: row => {
            const user = row.responsibleProjectLeaderUserId ? userById.get(row.responsibleProjectLeaderUserId) : null;
            return user ? userFullName(user) : '-';
          },
          sortKey: row => {
            const user = row.responsibleProjectLeaderUserId ? userById.get(row.responsibleProjectLeaderUserId) : null;
            return user ? userFullName(user).toLowerCase() : '';
          },
        },
        {
          label: uiText("Kosten"),
          render: row => formatCurrency(row.costs),
          sortKey: row => row.costs,
        },
        {
          label: uiText("Gewinn/Verlust"),
          render: row => renderGainOrLoss(row.gainOrLoss, row.invoicesTotal),
          sortKey: row => row.gainOrLoss ?? Number.NEGATIVE_INFINITY,
        },
        {
          label: uiText("Angebotssummen"),
          render: row => formatCurrency(row.offersTotal),
          sortKey: row => row.offersTotal,
        },
        {
          label: uiText("Rechnungssummen"),
          render: row => formatCurrency(row.invoicesTotal),
          sortKey: row => row.invoicesTotal,
        },
      ]}
      pagination={{}}
      autoConvertSmallViewport
    />
  </>;
}
