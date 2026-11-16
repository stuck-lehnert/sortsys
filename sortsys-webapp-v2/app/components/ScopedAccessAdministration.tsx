import { useEffect, useRef, useState } from "react";
import { ComboBox, Loading } from "@sortsys/react-components";
import { client } from "~/lib/client";
import { useProtectedState } from "~/hooks/useProtectedState";
import {
  runAccountCommand,
  waitForAccountCommands,
} from "~/lib/crypto/accountCommands";
import {
  readScopedManagement,
  readScopedMemberPermissions,
  type ManagedPermission,
} from "~/lib/crypto/scopedManagement";
import { changeAreaActionAccesses } from "~/lib/crypto/permissions";
import { finishDelegatedAccessChanges } from "~/lib/crypto/delegatedAccess";
import {
  accessChanged,
  accessDraft,
  editAccessDraft,
  type AccessDraft,
} from "~/lib/crypto/accessProfiles";
import { managedAreaLabel } from "~/lib/accessManagementLabels";
import { uiText } from "~/lib/i18n";
import {
  permissionSelection,
  rememberPermissionSelection,
} from "~/lib/crypto/permissionSelection";
import { AccessLevelSelect } from "./AccessLevelSelect";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type Workspace = Awaited<ReturnType<typeof readScopedManagement>>;
type Member = Workspace["members"][number];
type Editing = {
  subject: string;
  permissions: ManagedPermission[];
  drafts: Record<string, AccessDraft>;
};

function memberLabel(member: Member): string {
  const name = [member.firstName, member.lastName].filter(Boolean).join(" ");
  if (name && member.username) return `${name} (${member.username})`;
  return (
    name || member.username || `${uiText("Benutzer", "User")} ${member.id}`
  );
}

export default function ScopedAccessAdministration() {
  const [workspace, setWorkspace, context] =
    useProtectedState<Workspace | null>(null);
  const [member, setMember] = useProtectedState<Member | null>(null);
  const [editing, setEditing] = useProtectedState<Editing | null>(null);
  const [memberQuery, setMemberQuery] = useProtectedState("");
  const [areaQuery, setAreaQuery] = useProtectedState("");
  const [areaId, setAreaId] = useState("");
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [picker, setPicker] = useState({ context, key: 0 });
  if (picker.context !== context) setPicker({ context, key: picker.key + 1 });
  const operation = useRef(false);
  const rememberedMember = useRef(permissionSelection().member);
  const rememberedArea = useRef(permissionSelection().area);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    if (operation.current) return () => controller.abort();
    setWorkspace(null);
    setEditing(null);
    setMember(null);
    void waitForAccountCommands(client, signal)
      .then(() => readScopedManagement(client, signal))
      .then((value) => {
        signal.throwIfAborted();
        setWorkspace(value);
        const selected =
          value.members.find(
            (person) => person.id === rememberedMember.current,
          ) ?? null;
        setMember(selected);
        setMemberQuery(selected ? memberLabel(selected) : "");
      })
      .catch(() => {
        if (!signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [context, version]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    setEditing(null);
    setAreaQuery("");
    if (!member || operation.current) return () => controller.abort();
    const subject = `user:${member.id}`;
    void readScopedMemberPermissions(client, subject, signal)
      .then((permissions) => {
        signal.throwIfAborted();
        setEditing({
          subject,
          permissions,
          drafts: Object.fromEntries(
            permissions.map(({ area, value }) => [
              area.domain,
              accessDraft(value),
            ]),
          ),
        });
        const selected =
          permissions.find(
            ({ area }) => area.domain === rememberedArea.current,
          ) ??
          permissions[0] ??
          null;
        setAreaId(selected?.area.domain ?? "");
        setAreaQuery(selected ? managedAreaLabel(selected) : "");
      })
      .catch(() => {
        if (!signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [context, member, version]);

  const current = editing?.subject === `user:${member?.id}` ? editing : null;
  const selected =
    current?.permissions.find(({ area }) => area.domain === areaId) ?? null;
  const changed =
    current?.permissions.some(({ area }) =>
      accessChanged(current.drafts[area.domain]!),
    ) ?? false;
  async function save() {
    if (!current || !changed || busy || operation.current || context.aborted)
      return;
    operation.current = true;
    setBusy(true);
    setError(false);
    try {
      const changes = current.permissions
        .filter(
          ({ area, editable }) =>
            editable && accessChanged(current.drafts[area.domain]!),
        )
        .map(({ area }) => ({
          area,
          patch: current.drafts[area.domain]!.patch,
        }));
      await runAccountCommand(client, (signal) =>
        changeAreaActionAccesses(client, current.subject, changes, signal),
      );
      setVersion((previous) => previous + 1);
    } catch {
      setError(true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  async function refresh() {
    if (busy || operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(false);
    try {
      if (workspace?.areas.length)
        await runAccountCommand(client, (signal) =>
          finishDelegatedAccessChanges(
            client,
            workspace.areas.map(({ area }) => area),
            signal,
          ),
        );
      setVersion((previous) => previous + 1);
    } catch {
      setError(true);
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }
  return (
    <section
      className="max-w-3xl space-y-5"
      aria-label={uiText("Datenfreigaben", "Data access")}
    >
      <h2 className="text-xl font-semibold">
        {uiText("Datenfreigaben", "Data access")}
      </h2>
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Freigaben konnten nicht vollständig aktualisiert werden. Der aktuelle Stand kann erneut geladen werden.",
            "Access could not be fully updated. Reload the current state to retry.",
          )}
        </MyCallout>
      )}
      {!workspace && !error && (
        <Loading
          active
          description={uiText("Freigaben werden geladen …", "Loading access…")}
        />
      )}
      {workspace && (
        <div key={picker.key} className="space-y-5">
          <ComboBox
            titleText={uiText("Benutzer", "User")}
            items={workspace.members}
            itemToString={memberLabel}
            value={memberQuery}
            onInputChange={setMemberQuery}
            selectedItem={member}
            disabled={busy}
            onChange={({ selectedItem }: { selectedItem: Member | null }) => {
              if (busy || context.aborted) return;
              rememberedMember.current = selectedItem?.id ?? null;
              rememberPermissionSelection({ member: rememberedMember.current });
              setMember(selectedItem);
              if (selectedItem) setMemberQuery(memberLabel(selectedItem));
              setError(false);
            }}
          />
          {member && !current && !error && (
            <Loading
              active
              description={uiText(
                "Berechtigungen werden geladen …",
                "Loading permissions…",
              )}
            />
          )}
          {current && (
            <>
              <ComboBox
                titleText={uiText("Bereich", "Area")}
                items={current.permissions}
                itemToString={managedAreaLabel}
                value={areaQuery}
                onInputChange={setAreaQuery}
                selectedItem={selected}
                disabled={busy}
                onChange={({
                  selectedItem,
                }: {
                  selectedItem: ManagedPermission | null;
                }) => {
                  if (!busy && !context.aborted) {
                    rememberedArea.current = selectedItem?.area.domain ?? null;
                    rememberPermissionSelection({
                      area: rememberedArea.current,
                    });
                    setAreaId(selectedItem?.area.domain ?? "");
                    if (selectedItem)
                      setAreaQuery(managedAreaLabel(selectedItem));
                  }
                }}
              />
              {selected && (
                <AccessLevelSelect
                  key={`${current.subject}:${areaId}`}
                  label={managedAreaLabel(selected)}
                  individual
                  actions={selected.actions}
                  value={current.drafts[areaId]!.value}
                  disabled={busy || !selected.editable}
                  onChange={(value, actions) => {
                    if (busy || !selected.editable || context.aborted) return;
                    setEditing(
                      (previous) =>
                        previous && {
                          ...previous,
                          drafts: {
                            ...previous.drafts,
                            [areaId]: editAccessDraft(
                              previous.drafts[areaId]!,
                              value,
                              actions,
                            ),
                          },
                        },
                    );
                  }}
                />
              )}
              {selected && !selected.editable && (
                <p className="text-sm text-muted">
                  {uiText(
                    "Diese Freigabe kann nur die Hauptadministration ändern.",
                    "Only the primary administrator can change this access.",
                  )}
                </p>
              )}
            </>
          )}
          {!workspace.members.length && (
            <p>
              {uiText(
                "Keine bestätigten Empfänger vorhanden.",
                "No confirmed recipients available.",
              )}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <MyButton
          disabled={!changed || busy}
          loading={busy}
          onClick={() => void save()}
        >
          {uiText("Berechtigungen speichern", "Save permissions")}
        </MyButton>
        <MyButton
          kind="secondary"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {uiText("Aktualisieren", "Refresh")}
        </MyButton>
      </div>
    </section>
  );
}
