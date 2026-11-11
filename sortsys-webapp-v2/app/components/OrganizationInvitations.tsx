import { useEffect, useRef, useState } from "react";
import { Checkbox, ComboBox, Loading, Select, SelectItem } from "@sortsys/react-components";
import { administratorInvitations, approveMemberInvitation, createMemberInvitation, invitationMembers, memberInvitationUrl, publishMemberInvitation, revokeMemberInvitation } from "~/lib/crypto/invitations";
import type { InvitationAccess, PendingInvitation } from "~/lib/crypto/invitations";
import { changeMemberAccess, finishAccessChanges, memberAccess } from "~/lib/crypto/permissions";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { ProjectAccess } from "./ProjectAccess";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type Member = Awaited<ReturnType<typeof invitationMembers>>[number];
export default function OrganizationInvitations() {
  const [members, setMembers] = useState<Member[] | null>(null), [selected, setSelected] = useState<Member | null>(null);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(false);
  const [editing, setEditing] = useState(false), [loadingAccess, setLoadingAccess] = useState(false);
  const [permissions, setPermissions] = useState<InvitationAccess>({ catalogue: "read", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true });
  const controller = useRef<AbortController | null>(null);
  async function refresh(signal: AbortSignal) {
    const [people, pending] = await Promise.all([invitationMembers(client, signal), administratorInvitations(client, signal)]);
    signal.throwIfAborted(); setMembers(people); setInvitations(pending);
    setSelected(previous => previous ? people.find(member => member.id === previous.id) ?? null : null);
    if (selected && people.some(member => member.id === selected.id && member.enrolled)) {
      const access = await memberAccess(client, `user:${selected.id}`, signal); signal.throwIfAborted();
      if (access) { setPermissions(access); setEditing(true); }
    }
  }
  useEffect(() => {
    const current = new AbortController(); controller.current = current;
    void finishAccessChanges(client, current.signal).then(() => refresh(current.signal)).catch(() => { if (!current.signal.aborted) setError(true); });
    return () => current.abort();
  }, []);
  useEffect(() => {
    const current = new AbortController(); setEditing(false);
    setPermissions({ catalogue: "read", customers: "none", contacts: "none", vendors: "none", prices: "none", assistant: true });
    if (!selected?.enrolled) { setLoadingAccess(false); return () => current.abort(); }
    setLoadingAccess(true);
    void memberAccess(client, `user:${selected.id}`, current.signal).then(access => {
      if (!current.signal.aborted && access) { setPermissions(access); setEditing(true); }
    }).catch(() => { if (!current.signal.aborted) setError(true); })
      .finally(() => { if (!current.signal.aborted) setLoadingAccess(false); });
    return () => current.abort();
  }, [selected?.id, selected?.enrolled]);
  async function act(operation: (signal: AbortSignal) => Promise<unknown>) {
    const signal = controller.current?.signal; if (!signal || signal.aborted || busy) return;
    setBusy(true); setError(false);
    try { await operation(signal); await refresh(signal); }
    catch { if (!signal.aborted) setError(true); }
    finally { if (!signal.aborted) setBusy(false); }
  }
  return <section className="mt-8 max-w-3xl space-y-4">
    <h2 className="text-xl font-semibold">{uiText("Benutzerzugang", "User access")}</h2>
    <p>{uiText("Neue Benutzer erhalten eine Einladung. Bestehende Zugriffe können hier angepasst werden.", "New users receive an invitation. Existing access can be adjusted here.")}</p>
    {error && <MyCallout color="red">{uiText("Die Einladung konnte nicht verarbeitet werden. Bitte den aktuellen Stand erneut laden.", "The invitation could not be processed. Please reload its current state.")}</MyCallout>}
    {!members && !error && <Loading active description={uiText("Benutzer werden geladen …", "Loading users…")} />}
    {members && <div className="grid gap-4 sm:grid-cols-2">
      <ComboBox titleText={uiText("Benutzerkonto", "User account")} items={members} itemToString={(member: Member) => member.username}
        disabled={busy} selectedItem={selected} onChange={({ selectedItem }: { selectedItem: Member | null }) => setSelected(selectedItem)} />
      {(["catalogue", "customers", "contacts", "vendors", "prices"] as const).map(key => <Select key={key} labelText={key === "catalogue" ? uiText("Produktkatalog", "Product catalogue") : key === "customers" ? uiText("Kunden", "Customers") : key === "contacts" ? uiText("Ansprechpartner", "Contacts") : key === "vendors" ? uiText("Lieferanten", "Suppliers") : uiText("Preisaufzeichnungen", "Price records")} disabled={busy || loadingAccess} value={permissions[key]}
        onChange={(event: { target: { value: string } }) => {
          const level = event.target.value; if (level === "none" || level === "read" || level === "write") setPermissions(value => ({ ...value, [key]: level }));
        }}>
        <SelectItem value="none" text={editing ? uiText("Kein Zugriff", "No access") : uiText("Kein zusätzlicher Zugriff", "No additional access")} />
        <SelectItem value="read" text={uiText("Lesen", "Read")} />
        <SelectItem value="write" text={uiText("Lesen und bearbeiten", "Read and edit")} />
      </Select>)}
      <Checkbox labelText={uiText("Persönlichen KI-Verlauf bereitstellen", "Enable personal AI history")} disabled={busy || loadingAccess} checked={permissions.assistant}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setPermissions(value => ({ ...value, assistant: event.target.checked }))} />
    </div>}
    <div className="flex flex-wrap gap-2">
      <MyButton disabled={!selected || busy || loadingAccess} loading={busy || loadingAccess} onClick={() => act(signal => editing
        ? changeMemberAccess(client, `user:${selected!.id}`, permissions, signal)
        : createMemberInvitation(client, selected!, permissions, signal))}>{editing ? uiText("Berechtigungen speichern", "Save permissions") : uiText("Einladung erstellen", "Create invitation")}</MyButton>
      <MyButton kind="secondary" disabled={busy} onClick={() => act(async signal => { await finishAccessChanges(client, signal); await refresh(signal); })}>{uiText("Aktualisieren", "Refresh")}</MyButton>
    </div>
    {editing && selected && !loadingAccess && <ProjectAccess key={selected.id} user={`user:${selected.id}`} disabled={busy} onBusyChange={setBusy} />}
    <div className="divide-y">
      {invitations.map(saved => {
        const expired = BigInt(saved.link.invitation.validUntil) <= BigInt(Math.floor(Date.now() / 1000));
        const status = expired ? uiText("Abgelaufen", "Expired") : saved.entry?.revoked ? uiText("Zurückgezogen", "Withdrawn")
          : saved.entry?.completed ? uiText("Zugang freigegeben", "Access approved") : saved.entry?.claim ? uiText("Freigabe ausstehend", "Awaiting approval") : uiText("Anmeldung ausstehend", "Awaiting sign-in");
        return <div key={saved.link.invitation.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div><div className="font-semibold">{saved.link.invitation.username}</div><div className="text-sm text-muted">{status}</div></div>
          <div className="flex flex-wrap gap-2">
            {!expired && !saved.entry?.revoked && !saved.entry?.completed && <MyButton kind="secondary" disabled={busy} onClick={() => act(async signal => {
              if (!saved.entry) await publishMemberInvitation(client, saved, signal);
              await navigator.clipboard.writeText(memberInvitationUrl(saved, window.location.origin));
            })}>{uiText("Einladungslink kopieren", "Copy invitation link")}</MyButton>}
            {!expired && saved.entry?.claim && !saved.entry.revoked && !saved.entry.completed && <MyButton disabled={busy} onClick={() => act(signal => approveMemberInvitation(client, saved.link.invitation.id, signal))}>{uiText("Zugang freigeben", "Approve access")}</MyButton>}
            {!expired && saved.entry && !saved.entry.accepted && !saved.entry.revoked && <MyButton kind="tertiary" disabled={busy} onClick={() => act(signal => revokeMemberInvitation(client, saved.link.invitation.id, signal))}>{uiText("Einladung zurückziehen", "Withdraw invitation")}</MyButton>}
          </div>
        </div>;
      })}
    </div>
  </section>;
}
