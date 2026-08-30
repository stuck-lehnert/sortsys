import { uiText } from "~/lib/i18n";
import { Loading } from "@sortsys/react-components";
import { useParams } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { NotFound } from "./_404";
import { MyHeader } from "~/components/MyHeader";
import { formatCurrency, formatDate, userContractName, userFullName } from "~/lib/format";
import { MyDivider } from "~/components/MyDivider";
import { AttrList } from "~/components/AttrList";
import { MyLink } from "~/components/MyLink";
import { useTitle } from "~/hooks/useTitle";
import { useShortcut } from "~/hooks/useShortcut";
import { useEffect, useMemo, useState } from "react";
import { TrackingTable } from "~/components/TrackingTable";
import { MyExpandable } from "~/components/MyExpandable";
import { MyDropdown } from "~/components/MyDropdown";
import { Icons } from "~/lib/icons";
import { showDeactivateUserModal, showDeleteUserModal, showModifyUserModal, showSetUserPasswordModal, showSetUserRolesModal, showSetUserSupervisorModal } from "~/modals/users";
import { useMyModals } from "~/hooks/useMyModals";
import { MyCallout } from "~/components/MyCallout";
import type { User } from "~/type-helpers";

export default function UserDetailPage() {
    const { id } = useParams();

    const modals = useMyModals();

    const sessionInfo = useSessionInfo();

    const [user, err] = useClientStream(() => client.streamQuery('users.get', { id: id! }), [id]);
    const [trackings, trackingsError] = useClientStream(() => client.streamQuery('tools.trackings.list', { responsibleUserId: id!, finished: false }), [id]);
    const [supervisor, setSupervisor] = useState<User | null>(null);

    useTitle(() => user ? userFullName(user) : null, [user]);

    useEffect(() => {
        let cancelled = false;
        const supervisorUserId = (user as any)?.supervisorUserId;
        setSupervisor(null);
        if (!supervisorUserId) return;

        client.query('users.get', { id: supervisorUserId }, { strategy: 'cache-first' }).then(([data]) => {
            if (cancelled) return;
            setSupervisor(data ?? null);
        });

        return () => {
            cancelled = true;
        };
    }, [(user as any)?.supervisorUserId]);
        
    const sortedTrackings = useMemo(() => {
        if (!trackings) return null;
        return [...trackings].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    }, [trackings]);

    useShortcut('Control+e', e => {
        if (!user || !sessionInfo.canDo('manage:users')) return;
        e.preventDefault();
        showModifyUserModal(modals, user);
    });

    if (err) return <NotFound reason="resourceNotFound" />;
    if (!user) return <Loading withOverlay />;

    return <>
        <MyHeader
            title={userFullName(user)}
            actions={<>
                <MyDropdown items={[
                    {
                        label: uiText("Archivieren", "Archive"),
                        renderIcon: Icons.Archive,
                        hideIf: !!user.archivedAt || !user.deactivatedAt || !sessionInfo.canDo('manage:users'),
                        onClick: () => client.mutate('users.archive', { id: user.id }),
                    },
                    {
                        label: uiText("Aus Archiv holen"),
                        renderIcon: Icons.UndoArchive,
                        hideIf: !user.archivedAt || !sessionInfo.canDo('manage:users'),
                        onClick: () => client.mutate('users.unarchive', { id: user.id }),
                    },
                    {
                        label: uiText("Rollen setzen"),
                        renderIcon: Icons.EditRole,
                        hideIf: !sessionInfo.isAdmin(),
                        onClick: () => showSetUserRolesModal(modals, user),
                    },
                    {
                        label: uiText("Aktivieren"),
                        renderIcon: Icons.Unlock,
                        hideIf: !user.deactivatedAt || !sessionInfo.isAdmin(),
                        onClick: () => client.mutate('users.activate', { id: user.id }),
                    },
                    {
                        label: uiText("Deaktivieren"),
                        renderIcon: Icons.Lock,
                        hideIf: !!user.deactivatedAt || !sessionInfo.isAdmin(),
                        onClick: () => showDeactivateUserModal(modals, user),
                    },
                    {
                        label: uiText("Passwort setzen"),
                        renderIcon: Icons.SetPassword,
                        hideIf: !sessionInfo.isAdmin() && sessionInfo.user.id !== user.id,
                        onClick: () => showSetUserPasswordModal(modals, user),
                    },
                    {
                        label: uiText("Bearbeiten"),
                        renderIcon: Icons.Edit,
                        hideIf: !sessionInfo.canDo('manage:users'),
                        onClick: () => showModifyUserModal(modals, user),
                    },
                    {
                        label: uiText("Vorgesetzten setzen"),
                        renderIcon: Icons.User,
                        hideIf: !sessionInfo.canDo('manage:users'),
                        onClick: () => showSetUserSupervisorModal(modals, user, supervisor),
                    },
                    {
                        label: uiText("Vorgesetzten entfernen"),
                        renderIcon: Icons.Reset,
                        hideIf: !sessionInfo.canDo('manage:users') || !(user as any).supervisorUserId,
                        onClick: () => client.mutate('users.update', { id: user.id, data: { supervisorUserId: null } as any }),
                    },
                    {
                        label: uiText("Löschen"),
                        renderIcon: Icons.Delete,
                        hideIf: !sessionInfo.canDo('delete:users'),
                        onClick: () => showDeleteUserModal(modals, user),
                    },
                ]} />
            </>}
        />

        {!!user.deactivatedAt && <MyCallout icon={Icons.Lock} color="amber">
            {user.deactivatedAt.getTime() > Date.now()
                ? uiText(`Benutzer wird am ${formatDate(user.deactivatedAt)} deaktiviert.`, `User will be deactivated on ${formatDate(user.deactivatedAt)}.`)
                : uiText(`Benutzer ist seit ${formatDate(user.deactivatedAt)} deaktiviert.`, `User has been deactivated since ${formatDate(user.deactivatedAt)}.`)}
        </MyCallout>}

        {!!user.archivedAt && <MyCallout icon={Icons.Archive} color="grey">
            {uiText(`Benutzer ist seit ${formatDate(user.archivedAt)} archiviert.`, `User has been archived since ${formatDate(user.archivedAt)}.`)}
        </MyCallout>}

        <MyDivider />

        <AttrList>
            <AttrList.Attr name={uiText("Vorname", "First name")} value={user.firstName} />
            {!!user.lastName && <AttrList.Attr name={uiText("Nachname", "Last name")} value={user.lastName} />}
            <AttrList.Attr name={uiText("Anmeldename", "Username")} value={<code>{user.username}</code>} />
            {!!user.email && <AttrList.Attr name={uiText("E-Mail")} value={<MyLink to={`mailto:${user.email}`}>{user.email}</MyLink>} />}
            {!!user.phone && <AttrList.Attr name={uiText("Telefon", "Phone")} value={<MyLink to={`tel:${user.phone}`}>{user.phone}</MyLink>} />}
            <AttrList.Attr name={uiText("Vertrag", "Contract")} value={userContractName(user)} />
            {!!supervisor && <AttrList.Attr name={uiText("Vorgesetzter")} value={<MyLink to={`/users/${supervisor.id}`}>{userFullName(supervisor)}</MyLink>} />}
            {!!user.costPerHour &&  <AttrList.Attr name={uiText("Kosten pro Std")} value={formatCurrency(user.costPerHour)} />}
        </AttrList>

        <MyDivider />
        
        <MyExpandable title={uiText(`Gebuchte Werkzeuge (${sortedTrackings?.length ?? 0})`, `Booked tools (${sortedTrackings?.length ?? 0})`)}>
            <TrackingTable trackings={sortedTrackings ?? []} loading={!trackings} error={trackingsError} omit={['responsible']} />
        </MyExpandable>
    </>;
}
