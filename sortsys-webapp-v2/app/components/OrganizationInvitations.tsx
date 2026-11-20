import { useEffect, useRef, useState } from "react";
import { Checkbox, ComboBox, Loading } from "@sortsys/react-components";
import {
  administratorInvitations,
  approveMemberInvitation,
  createMemberInvitation,
  invitationMembers,
  memberInvitationUrl,
  publishMemberInvitation,
  revokeMemberInvitation,
} from "~/lib/crypto/invitations";
import type {
  InvitationAccess,
  PendingInvitation,
} from "~/lib/crypto/invitations";
import {
  changeMemberAccess,
  finishAccessChanges,
  memberAccessState,
  type MemberAccessEdits,
} from "~/lib/crypto/permissions";
import type { OrganizationRole } from "@sortsys/zerotrust/sortsys";
import {
  emptyOrganizationRoles,
  organizationRoles,
  type OrganizationRolePatch,
  type OrganizationRoleState,
} from "~/lib/crypto/organizationRoleAccess";
import { client } from "~/lib/client";
import {
  permissionSelection,
  rememberPermissionSelection,
} from "~/lib/crypto/permissionSelection";
import { uiText } from "~/lib/i18n";
import { ProjectAccess } from "./ProjectAccess";
import { CreationAccess } from "./CreationAccess";
import { PersonnelAccess } from "./PersonnelAccess";
import { CommercialAccess } from "./CommercialAccess";
import { ToolAccess } from "./ToolAccess";
import { OrganizationAccess } from "./OrganizationAccess";
import { AccessLevelSelect } from "./AccessLevelSelect";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { useMyModals } from "~/hooks/useMyModals";
import { showCreateUserModal } from "~/modals/users";
import {
  accessChanged,
  accessDraft,
  accessDrafts,
  DATA_ACTIONS,
  editAccessDraft,
  MASTER_DATA_FIELDS,
  type AccessDraft,
  type MasterDataField,
} from "~/lib/crypto/accessProfiles";

type Member = Awaited<ReturnType<typeof invitationMembers>>[number];
type MasterDataDraft = AccessDraft & { useRoleAccess?: boolean };
const initialAccess = (): InvitationAccess => ({
  catalogue: "read",
  customers: "none",
  contacts: "none",
  vendors: "none",
  prices: "none",
  assistant: true,
});
const roleLabels: Record<OrganizationRole, () => string> = {
  "organization-office": () =>
    uiText(
      "Büro (Kunden und Kontakte pflegen, Produkte lesen)",
      "Office (edit customers and contacts, read products)",
    ),
  "organization-procurement": () =>
    uiText(
      "Einkauf (Produkte, Lieferanten und Preise pflegen)",
      "Purchasing (edit products, suppliers, and prices)",
    ),
};
function accessLabel(key: MasterDataField): string {
  switch (key) {
    case "catalogue":
      return uiText("Produktkatalog", "Product catalogue");
    case "customers":
      return uiText("Kunden", "Customers");
    case "contacts":
      return uiText("Ansprechpartner", "Contacts");
    case "vendors":
      return uiText("Lieferanten", "Suppliers");
    case "prices":
      return uiText("Preisaufzeichnungen", "Price records");
  }
}

function invitationStatus(saved: PendingInvitation, expired: boolean): string {
  if (saved.entry?.revoked) return uiText("Zurückgezogen", "Withdrawn");
  if (saved.entry?.completed)
    return uiText("Zugang freigegeben", "Access approved");
  if (expired) return uiText("Abgelaufen", "Expired");
  if (saved.entry?.claim)
    return uiText("Freigabe ausstehend", "Awaiting approval");
  return uiText("Anmeldung ausstehend", "Awaiting sign-in");
}

export default function OrganizationInvitations({
  memberId,
}: { memberId?: string } = {}) {
  const modals = useMyModals();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [selected, setSelected] = useState<Member | null>(null);
  const [memberSearch, setMemberSearch] = useState("");
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [permissions, setPermissions] = useState(initialAccess);
  const [originalAssistant, setOriginalAssistant] = useState(true);
  const [drafts, setDrafts] = useState<Record<MasterDataField, MasterDataDraft>>(
    () => accessDrafts(MASTER_DATA_FIELDS, (key) => initialAccess()[key]),
  );
  const [roleDraft, setRoleDraft] = useState<{
    original: OrganizationRoleState;
    value: OrganizationRoleState;
  }>(() => {
    const roles = emptyOrganizationRoles();
    return { original: roles, value: roles };
  });
  const roleEdits: OrganizationRolePatch = {};
  for (const role of organizationRoles) {
    if (roleDraft.value[role] !== roleDraft.original[role])
      roleEdits[role] = roleDraft.value[role];
  }
  const rolesChanged = Object.keys(roleEdits).length > 0;

  function loadAccess(access: InvitationAccess, roles = emptyOrganizationRoles()) {
    setPermissions(access);
    setOriginalAssistant(access.assistant);
    setDrafts(accessDrafts(MASTER_DATA_FIELDS, (key) => access[key]));
    setRoleDraft({ original: roles, value: roles });
  }
  const controller = useRef<AbortController | null>(null);
  async function refreshMemberAccess(member: Member, signal: AbortSignal) {
    const state = await memberAccessState(client, `user:${member.id}`, signal);
    signal.throwIfAborted();
    if (state) loadAccess(state.access, state.roles);
    setEditing(state !== null);
  }

  async function refresh(signal: AbortSignal) {
    const [people, pending] = await Promise.all([
      invitationMembers(client, signal),
      administratorInvitations(client, signal),
    ]);
    signal.throwIfAborted();
    setMembers(people);
    setInvitations(pending);
    const selectedId = memberId ?? selected?.id ?? permissionSelection().member;
    const nextMember =
      people.find((member) => member.id === selectedId) ?? null;
    setSelected(nextMember);
    setMemberSearch(nextMember?.username ?? "");
    if (nextMember?.certified && nextMember.id === selected?.id)
      await refreshMemberAccess(nextMember, signal);
  }
  useEffect(() => {
    const current = new AbortController();
    controller.current = current;
    void finishAccessChanges(client, current.signal)
      .then(() => refresh(current.signal))
      .catch(() => {
        if (!current.signal.aborted) setError(true);
      });
    return () => current.abort();
  }, [memberId]);
  useEffect(() => {
    const current = new AbortController();
    setEditing(false);
    loadAccess(initialAccess());
    if (!selected?.certified) {
      setLoadingAccess(false);
      return () => current.abort();
    }
    setLoadingAccess(true);
    void refreshMemberAccess(selected, current.signal)
      .catch(() => {
        if (!current.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!current.signal.aborted) setLoadingAccess(false);
      });
    return () => current.abort();
  }, [selected?.id, selected?.certified]);
  async function act(
    operation: (signal: AbortSignal) => Promise<unknown>,
    update: (signal: AbortSignal) => Promise<void> = refresh,
  ) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError(false);
    try {
      await operation(signal);
      await update(signal);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
  }

  function saveAccess() {
    if (!selected || (selected.certified && !editing)) return;
    const member = selected;
    const access: InvitationAccess = {
      ...permissions,
      ...Object.fromEntries(
        MASTER_DATA_FIELDS.map((key) => [key, drafts[key].value]),
      ),
    };
    if (!editing) {
      const roles = organizationRoles.filter((role) => roleDraft.value[role]);
      return act((signal) =>
        createMemberInvitation(client, member, { ...access, roles }, signal),
      );
    }
    const actions: MemberAccessEdits["actions"] = {};
    for (const key of MASTER_DATA_FIELDS) {
      if (drafts[key].useRoleAccess) {
        actions[key] = Object.fromEntries(
          DATA_ACTIONS.map((action) => [action, null]),
        );
      } else if (accessChanged(drafts[key])) {
        actions[key] = drafts[key].patch;
      }
    }
    return act(
      (signal) =>
        changeMemberAccess(client, `user:${member.id}`, access, signal, {
          actions,
          ...(permissions.assistant !== originalAssistant
            ? { assistant: permissions.assistant }
            : {}),
          ...(rolesChanged ? { roles: roleEdits } : {}),
        }),
      (signal) => refreshMemberAccess(member, signal),
    );
  }
  return (
    <section className="mt-8 max-w-3xl space-y-4">
      <h2 className="text-xl font-semibold">
        {uiText("Benutzerzugang", "User access")}
      </h2>
      <p>
        {uiText(
          "Neue Benutzer erhalten eine Einladung. Bestehende Zugriffe können hier angepasst werden.",
          "New users receive an invitation. Existing access can be adjusted here.",
        )}
      </p>
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Aktion konnte nicht abgeschlossen werden. Bitte den aktuellen Stand erneut laden.",
            "The action could not be completed. Please reload the current state.",
          )}
        </MyCallout>
      )}
      {!members && !error && (
        <Loading
          active
          description={uiText("Benutzer werden geladen …", "Loading users…")}
        />
      )}
      {members && (
        <div className="grid gap-4 sm:grid-cols-2">
          {!memberId && (
            <ComboBox
              titleText={uiText("Benutzerkonto", "User account")}
              items={members}
              itemToString={(member: Member) => member.username}
              disabled={busy}
              selectedItem={selected}
              value={memberSearch}
              onInputChange={setMemberSearch}
              onChange={({ selectedItem }: { selectedItem: Member | null }) => {
                rememberPermissionSelection({
                  member: selectedItem?.id ?? null,
                });
                setSelected(selectedItem);
                if (selectedItem) setMemberSearch(selectedItem.username);
              }}
            />
          )}
          {MASTER_DATA_FIELDS.map((key) => (
            <AccessLevelSelect
              key={`${selected?.id}:${key}`}
              label={accessLabel(key)}
              allowManagement={editing}
              disabled={busy || loadingAccess}
              value={drafts[key].value}
              noneLabel={
                editing
                  ? uiText("Kein Zugriff", "No access")
                  : uiText("Kein zusätzlicher Zugriff", "No additional access")
              }
              roleAccess={
                editing
                  ? {
                      pending: drafts[key].useRoleAccess === true,
                      select: () =>
                        setDrafts((previous) => ({
                          ...previous,
                          [key]: {
                            ...accessDraft(previous[key].original),
                            useRoleAccess: true,
                          },
                        })),
                    }
                  : undefined
              }
              onChange={(value, actions) =>
                setDrafts((previous) => ({
                  ...previous,
                  [key]: {
                    ...editAccessDraft(previous[key], value, actions),
                    useRoleAccess: false,
                  },
                }))
              }
            />
          ))}
          <Checkbox
            labelText={uiText(
              "KI-Assistent und persönlicher Verlauf",
              "AI assistant and personal history",
            )}
            disabled={busy || loadingAccess}
            checked={permissions.assistant}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              setPermissions((value) => ({
                ...value,
                assistant: event.target.checked,
              }))
            }
          />
        </div>
      )}
      {selected && (!selected.certified || editing) && (
        <fieldset className="space-y-2">
          <legend className="font-medium">
            {uiText("Fachrollen", "Business roles")}
          </legend>
          {editing && (
            <p className="text-sm text-muted">
              {uiText(
                "Ausdrückliche Sperren in den Einzelfreigaben gelten auch mit Fachrolle.",
                "Explicit denials in individual permissions also apply to role members.",
              )}
            </p>
          )}
          {organizationRoles.map((role) => (
            <Checkbox
              key={role}
              labelText={roleLabels[role]()}
              checked={roleDraft.value[role]}
              disabled={busy || loadingAccess}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                const checked = event.target.checked;
                setRoleDraft((current) => ({
                  ...current,
                  value: { ...current.value, [role]: checked },
                }));
              }}
            />
          ))}
        </fieldset>
      )}
      <div className="flex flex-wrap gap-2">
        {!memberId && (
          <MyButton
            kind="secondary"
            disabled={busy}
            onClick={() =>
              showCreateUserModal(modals, {
                onCreated: async (user) => {
                  const signal = controller.current?.signal;
                  if (!signal) return;
                  await refresh(signal);
                  signal.throwIfAborted();
                  rememberPermissionSelection({ member: user.id });
                  setMemberSearch(user.username);
                  setSelected({
                    id: user.id,
                    username: user.username,
                    enrolled: false,
                    certified: false,
                    roles: [],
                  });
                },
              })
            }
          >
            {uiText("Benutzer anlegen", "Create user")}
          </MyButton>
        )}
        <MyButton
          disabled={
            !selected ||
            busy ||
            loadingAccess ||
            (selected.certified && !editing) ||
            (editing &&
              !rolesChanged &&
              !MASTER_DATA_FIELDS.some(
                (key) => drafts[key].useRoleAccess || accessChanged(drafts[key]),
              ) &&
              permissions.assistant === originalAssistant)
          }
          loading={busy || loadingAccess}
          onClick={saveAccess}
        >
          {selected?.certified
            ? uiText("Berechtigungen speichern", "Save permissions")
            : uiText("Einladung erstellen", "Create invitation")}
        </MyButton>
        <MyButton
          kind="secondary"
          disabled={busy}
          onClick={() => act((signal) => finishAccessChanges(client, signal))}
        >
          {uiText("Aktualisieren", "Refresh")}
        </MyButton>
      </div>
      {editing && selected && !loadingAccess && (
        <CreationAccess
          key={`creation:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      {editing && selected && !loadingAccess && (
        <ProjectAccess
          key={`projects:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      {editing && selected && !loadingAccess && (
        <CommercialAccess
          key={`documents:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      {editing && selected && !loadingAccess && (
        <PersonnelAccess
          key={`personnel:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      {editing && selected && !loadingAccess && (
        <ToolAccess
          key={`tools:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      {editing && selected && !loadingAccess && (
        <OrganizationAccess
          key={`organization:${selected.id}`}
          user={`user:${selected.id}`}
          disabled={busy}
          onBusyChange={setBusy}
        />
      )}
      <div className="divide-y">
        {invitations.map((saved) => {
          const expired =
            BigInt(saved.link.invitation.validUntil) <=
            BigInt(Math.floor(Date.now() / 1000));
          const status = invitationStatus(saved, expired);
          return (
            <div
              key={saved.link.invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div>
                <div className="font-semibold">
                  {saved.link.invitation.username}
                </div>
                <div className="text-sm text-muted">{status}</div>
                {!expired &&
                  !saved.entry?.revoked &&
                  !saved.entry?.completed &&
                  saved.access.roles?.map((role) => (
                    <div key={role} className="text-sm">
                      {roleLabels[role]()}
                    </div>
                  ))}
              </div>
              <div className="flex flex-wrap gap-2">
                {!expired &&
                  !saved.entry?.revoked &&
                  !saved.entry?.completed && (
                    <MyButton
                      kind="secondary"
                      disabled={busy}
                      onClick={() =>
                        act(async (signal) => {
                          if (!saved.entry)
                            await publishMemberInvitation(
                              client,
                              saved,
                              signal,
                            );
                          await navigator.clipboard.writeText(
                            memberInvitationUrl(saved, window.location.origin),
                          );
                        })
                      }
                    >
                      {uiText(
                        "Einladungslink kopieren",
                        "Copy invitation link",
                      )}
                    </MyButton>
                  )}
                {!expired &&
                  saved.entry?.claim &&
                  !saved.entry.revoked &&
                  !saved.entry.completed && (
                    <MyButton
                      disabled={busy}
                      onClick={() =>
                        act((signal) =>
                          approveMemberInvitation(
                            client,
                            saved.link.invitation.id,
                            signal,
                          ),
                        )
                      }
                    >
                      {uiText("Zugang freigeben", "Approve access")}
                    </MyButton>
                  )}
                {!expired &&
                  saved.entry &&
                  !saved.entry.accepted &&
                  !saved.entry.revoked && (
                    <MyButton
                      kind="tertiary"
                      disabled={busy}
                      onClick={() =>
                        act((signal) =>
                          revokeMemberInvitation(
                            client,
                            saved.link.invitation.id,
                            signal,
                          ),
                        )
                      }
                    >
                      {uiText("Einladung zurückziehen", "Withdraw invitation")}
                    </MyButton>
                  )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
