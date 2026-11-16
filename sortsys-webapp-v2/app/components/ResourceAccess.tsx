import { useEffect, useRef, useState } from "react";
import { ComboBox, Loading } from "@sortsys/react-components";
import { useProtectedState } from "~/hooks/useProtectedState";
import { client, protectedContent } from "~/lib/client";
import { listenCryptoSession, unlockedAccount } from "~/lib/crypto/session";
import {
  accessChanged,
  accessDrafts,
  editAccessDraft,
  type AccessDraft,
  type AccessValue,
  type ManagedAction,
} from "~/lib/crypto/accessProfiles";
import {
  changeAreaActionAccesses,
  memberAreaAccesses,
} from "~/lib/crypto/permissions";
import type { Collection } from "~/lib/data/protectedObjects";
import { uiText } from "~/lib/i18n";
import { AccessLevelSelect } from "./AccessLevelSelect";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

export type ResourceAccessDefinition<Resource extends { id: string }> = {
  heading(): string;
  resourceLabel(): string;
  saveLabel(): string;
  reloadLabel(): string;
  errorLabel(): string;
  load(signal: AbortSignal): Promise<Resource[]>;
  describe(resource: Resource): string;
  fields: readonly {
    key: string;
    label(): string;
    area(resource: Resource): Collection;
    individual?: boolean;
    actions?: readonly ManagedAction[];
  }[];
};
export type ResourceAccessProps = {
  user: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};
type Selection<Resource> = { resource: Resource };
type LoadedAccess<Resource> = {
  selection: Selection<Resource>;
  context: AbortSignal;
  drafts: Record<string, AccessDraft>;
};

/** Resource labels belong to the decrypted content lifetime. Rights are read
 * together for one selected resource; only explicitly edited actions are saved. */
export function ResourceAccess<Resource extends { id: string }>(
  props: ResourceAccessProps & {
    definition: ResourceAccessDefinition<Resource>;
  },
) {
  return <ResourceAccessForm key={props.user} {...props} />;
}

function ResourceAccessForm<Resource extends { id: string }>({
  user,
  disabled = false,
  onBusyChange,
  definition,
}: ResourceAccessProps & { definition: ResourceAccessDefinition<Resource> }) {
  const [resources, setResources, context] = useProtectedState<
    Resource[] | null
  >(null);
  const [selection, setSelection] =
    useProtectedState<Selection<Resource> | null>(null);
  const [search, setSearch] = useProtectedState("");
  const [pickerLifetime, setPickerLifetime] = useState({ context, key: 0 });
  if (pickerLifetime.context !== context) {
    // The widget also retains its selected label internally. Replace that
    // state together with the decrypted data after an access-context change.
    setPickerLifetime({ context, key: pickerLifetime.key + 1 });
  }
  const [access, setAccess] = useState<LoadedAccess<Resource> | null>(null);
  const selected = selection?.resource ?? null;
  const current =
    access?.selection === selection && access?.context === context
      ? access
      : null;
  const drafts = current?.drafts ?? {};
  const [error, setError] = useState<"load" | "read" | "save" | null>(null);
  const loaded = current !== null;
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const [requested, setRequested] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const rememberedResource = useRef<string | null>(null);
  const fields = definition.fields;
  const keys = fields.map((field) => field.key);

  function loadDrafts(values: readonly AccessValue[]) {
    const byKey = new Map(
      fields.map((field, index) => [field.key, values[index]!]),
    );
    return accessDrafts(keys, (key) => byKey.get(key)!);
  }

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    setResources(null);
    setSelection(null);
    setError(null);
    if (!requested || !unlockedAccount() || operation.current) {
      return () => controller.abort();
    }
    void definition
      .load(signal)
      .then((rows) => {
        signal.throwIfAborted();
        setResources(rows);
        if (rememberedResource.current) {
          const resource = rows.find(
            (row) => row.id === rememberedResource.current,
          );
          setSelection(resource ? { resource } : null);
          setSearch(resource ? definition.describe(resource) : "");
        }
      })
      .catch(() => {
        if (!signal.aborted) setError("load");
      });
    return () => controller.abort();
  }, [user, definition, context, version, requested]);

  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([context, controller.signal]);
    setAccess(null);
    if (!selection) return () => controller.abort();
    setError(null);
    void memberAreaAccesses(
      client,
      user,
      fields.map((field) => field.area(selection.resource)),
      signal,
    )
      .then((values) => {
        signal.throwIfAborted();
        setAccess({ selection, context, drafts: loadDrafts(values) });
      })
      .catch(() => {
        if (!signal.aborted) setError("read");
      });
    return () => controller.abort();
  }, [user, selection, fields, context]);

  useEffect(() => {
    const account = unlockedAccount();
    function abortOperation() {
      if (operation.current) {
        operation.current.abort();
        operation.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
    const stopSession = listenCryptoSession(() => {
      if (unlockedAccount() !== account) abortOperation();
    });
    const stopAuth = client.listenAuthState(abortOperation);
    return () => {
      stopSession();
      stopAuth();
      abortOperation();
    };
  }, [user, onBusyChange]);

  const changed = fields.some(
    (field) => drafts[field.key] && accessChanged(drafts[field.key]!),
  );
  async function save() {
    if (
      !selected ||
      !selection ||
      !loaded ||
      !changed ||
      busy ||
      disabled ||
      operation.current ||
      context.aborted
    )
      return;
    const controller = new AbortController();
    // Publishing these rights invalidates the current content context itself.
    // Finish the verified policy and key change under the account lifetime;
    // labels and controls are reloaded separately in the new content context.
    const signal = controller.signal;
    operation.current = controller;
    setBusy(true);
    setError(null);
    onBusyChange?.(true);
    try {
      const changes = fields
        .filter((field) => accessChanged(drafts[field.key]!))
        .map((field) => ({
          area: field.area(selected),
          patch: drafts[field.key]!.patch,
        }));
      await changeAreaActionAccesses(client, user, changes, signal);
      const values = await memberAreaAccesses(
        client,
        user,
        fields.map((field) => field.area(selected)),
        signal,
      );
      signal.throwIfAborted();
      if (protectedContent.context() === context) {
        setAccess({ selection, context, drafts: loadDrafts(values) });
      } else {
        setVersion((previous) => previous + 1);
      }
    } catch {
      if (!signal.aborted) setError("save");
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <div className="flex min-h-7 items-center gap-3">
        <h3 className="text-lg font-semibold">{definition.heading()}</h3>
      </div>
      {error && <MyCallout color="red">{definition.errorLabel()}</MyCallout>}
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <ComboBox
          key={pickerLifetime.key}
          titleText={definition.resourceLabel()}
          items={resources ?? []}
          value={search}
          onInputChange={setSearch}
          selectedItem={selected}
          disabled={busy || disabled || !unlockedAccount()}
          loading={requested && !resources && !error}
          loadError={error === "load"}
          onFocus={() => setRequested(true)}
          itemToString={definition.describe}
          onChange={({ selectedItem }: { selectedItem: Resource | null }) => {
            if (!operation.current && !disabled) {
              rememberedResource.current = selectedItem?.id ?? null;
              setSelection(selectedItem ? { resource: selectedItem } : null);
              if (selectedItem) setSearch(definition.describe(selectedItem));
            }
          }}
        />
        {fields.map((field) => (
          <AccessLevelSelect
            key={`${user}:${selected?.id}:${field.key}`}
            label={field.label()}
            individual={field.individual}
            allowManagement
            actions={field.actions}
            value={drafts[field.key]?.value ?? "none"}
            disabled={busy || disabled || !selected || !loaded}
            onChange={(value, actions) => {
              if (!current || operation.current || disabled || context.aborted)
                return;
              setAccess((previous) => {
                if (
                  previous?.selection !== selection ||
                  previous?.context !== context
                )
                  return previous;
                return {
                  ...previous,
                  drafts: {
                    ...previous.drafts,
                    [field.key]: editAccessDraft(
                      previous.drafts[field.key]!,
                      value,
                      actions,
                    ),
                  },
                };
              });
            }}
          />
        ))}
      </div>
      {selected && !loaded && !error && (
        <Loading
          active
          description={uiText("Freigaben werden geladen …", "Loading access…")}
        />
      )}
      <div className="flex flex-wrap gap-2">
        <MyButton
          disabled={busy || disabled || !selected || !loaded || !changed}
          loading={busy}
          onClick={() => void save()}
        >
          {definition.saveLabel()}
        </MyButton>
        <MyButton
          kind="tertiary"
          disabled={busy || disabled}
          onClick={() => {
            setSearch("");
            setRequested(true);
            setVersion((value) => value + 1);
          }}
        >
          {definition.reloadLabel()}
        </MyButton>
      </div>
    </section>
  );
}
