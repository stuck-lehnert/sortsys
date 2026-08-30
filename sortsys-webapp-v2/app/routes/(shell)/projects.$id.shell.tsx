import { uiText } from "~/lib/i18n";
import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { MyHeader } from "~/components/MyHeader";
import { showRemarkFormModal } from "~/components/Remarks";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { formatAddress, formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { showExportWeeklyDailyProjectReportsModal } from "~/modals/dailyProjectReport";
import { showExportProjectDeliveryNotesTimespanModal, showExportProjectRegieReportsModal } from "~/modals/projectExports";
import { showCreateProjectInterruptionModal, showCreateProjectInvoiceModal, showCreateProjectOfferModal, showDeleteProjectModal, showModifyProjectModal } from "~/modals/projects";
import { NotFound } from "./_404";

export default function ProjectDetailShell() {
    const { id } = useParams();

    const sessionInfo = useSessionInfo();
    const modals = useMyModals();
    const supportsProjectFiles = sessionInfo.supportsProjectFiles();

    const path = useLocation().pathname;
    const navigate = useNavigate();

    const [project, err] = useClientStream(() => client.streamQuery('projects.get', { id: id! }), [id]);
    const [deliveryNotes] = useClientStream(() => client.streamQuery('deliveryNotes.list', { projectId: id! }), [id]);
    const [regieReports] = useClientStream(() => client.streamQuery('regieReports.list', { projectId: id! }), [id]);

    useShortcut('Control+e', e => {
        if (!project || !sessionInfo.canDo('manage:projects')) return;
        e.preventDefault();
        showModifyProjectModal(modals, project);
    });

    if (err) return <NotFound reason="resourceNotFound" />;
    if (!project) return;

    const tabs = [
        {
            path: `/projects/${id}`,
            label: uiText("Übersicht"),
            hideIf: !sessionInfo.canDo('view:tools'),
        },
        {
            path: `/projects/${id}/files`,
            label: uiText("Anhänge"),
            hideIf: !supportsProjectFiles,
        },
        {
            path: `/projects/${id}/costs`,
            label: uiText("Kosten"),
            hideIf: !sessionInfo.canDo('view:deliveryNotes') || !sessionInfo.canDo('view:dailyProjectReports'),
        },
        {
            path: `/projects/${id}/regieReports`,
            label: uiText("Regieberichte"),
            hideIf: !sessionInfo.canDo('view:regieReports'),
        },
        {
            path: `/projects/${id}/dailyReports`,
            label: uiText("Bautagesberichte"),
            hideIf: !sessionInfo.canDo('view:dailyProjectReports'),
        },
    ];


    const _tabs = tabs.filter(({hideIf}) => !hideIf);
    const selectedIndex = _tabs.findIndex(({ path: _path }) => path === _path);
    const archivedAt = (project as any).archivedAt ?? (project as any).archivedSince ?? null;
    const isOverviewTab = path === `/projects/${id}`;
    const isCostsTab = path.startsWith(`/projects/${id}/costs`);
    const isRegieReportsTab = path.startsWith(`/projects/${id}/regieReports`);
    const isDailyReportsTab = path.startsWith(`/projects/${id}/dailyReports`);
    const hasDeliveryNotes = (deliveryNotes?.length ?? 0) > 0;
    const hasRegieReports = (regieReports?.length ?? 0) > 0;

    return <>
        <MyHeader
            title={project.title}
            subtitle={!!project.address && formatAddress(project.address)}
            actions={<MyDropdown icon={Icons.DropdownMenu}
                items={[
                    {
                        label: uiText("Abschließen"),
                        renderIcon: Icons.Finish,
                        hideIf: !!project.finishedAt || !sessionInfo.canDo('manage:projects'),
                        onClick: async () => {
                            const [, actionErr] = await client.mutate('projects.finish', { id: project.id });
                            if (actionErr) throw actionErr;
                        },
                    },
                    {
                        label: uiText("Fortsetzen"),
                        renderIcon: Icons.Resume,
                        hideIf: !project.finishedAt || !sessionInfo.canDo('manage:projects'),
                        onClick: async () => {
                            const [, actionErr] = await client.mutate('projects.resume', { id: project.id });
                            if (actionErr) throw actionErr;
                        },
                    },
                    {
                        label: uiText("Bearbeiten"),
                        renderIcon: Icons.Edit,
                        hideIf: !sessionInfo.canDo('manage:projects'),
                        onClick: () => showModifyProjectModal(modals, project),
                    },
                    {
                        label: uiText("Unterbrechung eintragen"),
                        renderIcon: Icons.Disable,
                        hideIf: !sessionInfo.canDo('manage:projectDeployments'),
                        onClick: () => showCreateProjectInterruptionModal(modals, project),
                    },
                    {
                        label: uiText("Vermerk erstellen"),
                        renderIcon: Icons.Plus,
                        hideIf: !isOverviewTab || !sessionInfo.canDo('manage:projects'),
                        onClick: () => showRemarkFormModal({ modals, resourceType: 'project', resourceId: project.id }),
                    },
                    {
                        label: uiText("Angebotssumme"),
                        renderIcon: Icons.PriceRecord,
                        hideIf: !isCostsTab || !sessionInfo.canDo('manage:projects'),
                        onClick: () => showCreateProjectOfferModal(modals, project),
                    },
                    {
                        label: uiText("Rechnungssumme"),
                        renderIcon: Icons.DeliveryNote,
                        hideIf: !isCostsTab || !sessionInfo.canDo('manage:projects'),
                        onClick: () => showCreateProjectInvoiceModal(modals, project),
                    },
                    {
                        label: uiText("Lieferscheine Excel (Zeitraum)"),
                        renderIcon: Icons.Excel,
                        hideIf: !isCostsTab || !sessionInfo.canDo('view:deliveryNotes') || !hasDeliveryNotes,
                        onClick: () => showExportProjectDeliveryNotesTimespanModal(modals, project),
                    },
                    {
                        label: uiText("Regieberichte PDF"),
                        renderIcon: Icons.Download,
                        hideIf: !isRegieReportsTab || !sessionInfo.canDo('view:regieReports') || !hasRegieReports,
                        onClick: () => showExportProjectRegieReportsModal(modals, project, 'pdf'),
                    },
                    {
                        label: uiText("Regieberichte Excel"),
                        renderIcon: Icons.Excel,
                        hideIf: !isRegieReportsTab || !sessionInfo.canDo('view:regieReports') || !hasRegieReports,
                        onClick: () => showExportProjectRegieReportsModal(modals, project, 'excel'),
                    },
                    {
                        label: uiText("Bauwochenberichte PDF (alle)"),
                        renderIcon: Icons.Download,
                        hideIf: !isDailyReportsTab || !sessionInfo.canDo('view:dailyProjectReports'),
                        onClick: () => showExportWeeklyDailyProjectReportsModal(modals, project, 'pdf'),
                    },
                    {
                        label: uiText("Bauwochenberichte Excel (alle)"),
                        renderIcon: Icons.Excel,
                        hideIf: !isDailyReportsTab || !sessionInfo.canDo('view:dailyProjectReports'),
                        onClick: () => showExportWeeklyDailyProjectReportsModal(modals, project, 'excel'),
                    },
                    {
                        label: uiText("Löschen"),
                        renderIcon: Icons.Delete,
                        hideIf: !sessionInfo.canDo('delete:projects'),
                        onClick: () => showDeleteProjectModal(modals, project),
                    },
                ]}
            />}
        />

        {!!project.finishedAt && (
            <MyCallout icon={Icons.Finish} color="grey">
                {uiText(`Projekt ist seit ${formatDate(project.finishedAt)} abgeschlossen.`, `Project has been completed since ${formatDate(project.finishedAt)}.`)}
            </MyCallout>
        )}

        {!!archivedAt && (
            <MyCallout icon={Icons.Archive} color="grey">
                {uiText(`Projekt ist seit ${formatDate(archivedAt)} archiviert.`, `Project has been archived since ${formatDate(archivedAt)}.`)}
            </MyCallout>
        )}

        <Tabs
            selectedIndex={selectedIndex}
            onChange={({ selectedIndex }: any) => {
                const {path: _path} = _tabs[selectedIndex];
                if (_path === path) return;
                navigate(_path);
            }}
        >
            <TabList>
                {_tabs.map(({ path, label }) => <Tab key={path}>{label}</Tab>)}
            </TabList>
        </Tabs>

        <ScopedErrorBoundary scope="project.content" resetKey={path}>
            <Outlet context={{ project }} />
        </ScopedErrorBoundary>
    </>;
}
