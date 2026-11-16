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
  memberAccess,
} from "~/lib/crypto/permissions";
import { client } from "~/lib/client";
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
  accessDrafts,
  editAccessDraft,
  MASTER_DATA_FIELDS,
} from "~/lib/crypto/accessProfiles";

type Member = Awaited<ReturnType<typeof invitationMembers>>[number];
const initialAccess = (): InvitationAccess => ({
  catalogue: "read",
  customers: "none",
  contacts: "none",
  vendors: "none",
  prices: "none",
  assistant: true,
});
function accessLabel(key: (typeof MASTER_DATA_FIELDS)[number]): string {
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
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loadingAccess, setLoadingAccess] = useState(false);
  const [permissions, setPermissions] = useState(initialAccess);
  const [originalAssistant, setOriginalAssistant] = useState(true);
  const [drafts, setDrafts] = useState(() =>
    accessDrafts(MASTER_DATA_FIELDS, (key) => initialAccess()[key]),
  );
  function loadAccess(access: InvitationAccess) {
    setPermissions(access);
    setOriginalAssistant(access.assistant);
    setDrafts(accessDrafts(MASTER_DATA_FIELDS, (key) => access[key]));
  }
  const controller = useRef<AbortController | null>(null);
  async function refresh(signal: AbortSignal) {
    const [people, pending] = await Promise.all([
      invitationMembers(client, signal),
      administratorInvitations(client, signal),
    ]);
    signal.throwIfAborted();
    setMembers(people);
    setInvitations(pending);
    setSelected(
      (previous) =>
        people.find((member) => member.id === (memberId ?? previous?.id)) ??
        null,
    );
    if (
      selected &&
      people.some((member) => member.id === selected.id && member.enrolled)
    ) {
      const access = await memberAccess(client, `user:${selected.id}`, signal);
      signal.throwIfAborted();
      if (access) {
        loadAccess(access);
        setEditing(true);
      } else setEditing(false);
    }
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
    if (!selected?.enrolled) {
      setLoadingAccess(false);
      return () => current.abort();
    }
    setLoadingAccess(true);
    void memberAccess(client, `user:${selected.id}`, current.signal)
      .then((access) => {
        if (!current.signal.aborted && access) {
          loadAccess(access);
          setEditing(true);
        }
      })
      .catch(() => {
        if (!current.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!current.signal.aborted) setLoadingAccess(false);
      });
    return () => current.abort();
  }, [selected?.id, selected?.enrolled]);
  async function act(operation: (signal: AbortSignal) => Promise<unknown>) {
    const signal = controller.current?.signal;
    if (!signal || signal.aborted || busy) return;
    setBusy(true);
    setError(false);
    try {
      await operation(signal);
      await refresh(signal);
    } catch {
      if (!signal.aborted) setError(true);
    } finally {
      if (!signal.aborted) setBusy(false);
    }
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
              onChange={({ selectedItem }: { selectedItem: Member | null }) =>
                setSelected(selectedItem)
              }
            />
          )}
          {MASTER_DATA_FIELDS.map((key) => (
            <AccessLevelSelect
              key={`${selected?.id}:${key}`}
              label={accessLabel(key)}
              disabled={busy || loadingAccess}
              value={drafts[key].value}
              noneLabel={
                editing
                  ? uiText("Kein Zugriff", "No access")
                  : uiText("Kein zusätzlicher Zugriff", "No additional access")
              }
              onChange={(value, actions) =>
                setDrafts((previous) => ({
                  ...previous,
                  [key]: editAccessDraft(previous[key], value, actions),
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
                  setSelected({
                    id: user.id,
                    username: user.username,
                    enrolled: false,
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
            (editing &&
              !MASTER_DATA_FIELDS.some((key) => accessChanged(drafts[key])) &&
              permissions.assistant === originalAssistant)
          }
          loading={busy || loadingAccess}
          onClick={() =>
            act((signal) => {
              const intended: InvitationAccess = {
                ...permissions,
                ...Object.fromEntries(
                  MASTER_DATA_FIELDS.map((key) => [key, drafts[key].value]),
                ),
              };
              return editing
                ? changeMemberAccess(
                    client,
                    `user:${selected!.id}`,
                    intended,
                    signal,
                    {
                      actions: Object.fromEntries(
                        MASTER_DATA_FIELDS.filter((key) =>
                          accessChanged(drafts[key]),
                        ).map((key) => [key, drafts[key].patch]),
                      ),
                      ...(permissions.assistant !== originalAssistant
                        ? { assistant: permissions.assistant }
                        : {}),
                    },
                  )
                : createMemberInvitation(client, selected!, intended, signal);
            })
          }
        >
          {editing
            ? uiText("Berechtigungen speichern", "Save permissions")
            : uiText("Einladung erstellen", "Create invitation")}
        </MyButton>
        <MyButton
          kind="secondary"
          disabled={busy}
          onClick={() =>
            act(async (signal) => {
              await finishAccessChanges(client, signal);
              await refresh(signal);
            })
          }
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
