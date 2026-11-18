import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import { InlineLoading, Modal } from "@sortsys/react-components";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import {
  activatePreparedContent,
  approvePreparedContent,
  inspectPreparedContent,
} from "~/lib/backups/contentRestore";
import { client } from "~/lib/client";
import { unlockedAccount } from "~/lib/crypto/session";
import { required } from "~/lib/data/protectedObjects";
import { currentLocaleTag, uiText } from "~/lib/i18n";

type Backup = QueryResult<"zerotrust.content.snapshots">["rows"][number];
type Verification = Awaited<ReturnType<typeof inspectPreparedContent>>;
type CheckedBackup = {
  backup: Backup;
  input: MutateInput<"zerotrust.content.activate">;
  report: Verification;
};
type Review =
  | { status: "checking" | "failed"; backup: Backup; operation: string }
  | { status: "checked"; checked: CheckedBackup };
type Publication =
  | { status: "restoring" | "failed"; checked: CheckedBackup }
  | { status: "restored" | "conflict"; backup: Backup };

// A confirmed change reloads the data session, which can briefly unmount this
// screen. Preserve the result and exact retry in memory for this account only.
const publications = new WeakMap<object, Publication>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function publish(account: object, value: Publication | null) {
  if (value) publications.set(account, value);
  else publications.delete(account);
  for (const listener of listeners) listener();
}

function backupDate(backup: Backup) {
  return new Intl.DateTimeFormat(currentLocaleTag(), {
    dateStyle: "medium",
    timeStyle: "medium",
  }).format(backup.createdAt);
}

function RestoreCounts({ report }: { report: Verification }) {
  const count = new Intl.NumberFormat(currentLocaleTag());
  const entries = [
    { label: uiText("Projekte", "Projects"), value: report.projects },
    { label: uiText("Kunden", "Customers"), value: report.customers },
    { label: uiText("Kontakte", "Contacts"), value: report.contacts },
  ];
  return (
    <>
      <dl className="grid grid-cols-3 gap-4 rounded-md border border-border p-3">
        {entries.map(({ label, value }) => (
          <div key={label}>
            <dt className="text-sm text-muted">{label}</dt>
            <dd className="mt-1 text-lg font-semibold">
              {value === null
                ? uiText("Keine Lesefreigabe", "No read access")
                : count.format(value)}
            </dd>
          </div>
        ))}
      </dl>
      {report.missingReferences > 0 && (
        <MyCallout color="yellow">
          {uiText(
            "Einige zugeordnete Kunden oder Kontakte fehlen in dieser Sicherung.",
            "Some linked customers or contacts are missing from this backup.",
          )}{" "}
          {count.format(report.missingReferences)}
        </MyCallout>
      )}
      {report.uncheckedReferences > 0 && (
        <p className="text-sm text-muted">
          {uiText(
            "Für einige verknüpfte Adressdaten fehlt die Lesefreigabe zur Prüfung.",
            "Some linked address data could not be checked with the current read access.",
          )}
        </p>
      )}
      <p className="text-sm text-muted">
        {uiText(
          "Der Browser hat die lesbaren Projekte und Adressdaten geprüft.",
          "The browser checked projects and address data available to this account.",
        )}
      </p>
    </>
  );
}

export default function OrganizationBackups() {
  const account = unlockedAccount();
  const publication = useSyncExternalStore(
    subscribe,
    () => (account ? publications.get(account) : undefined),
    () => undefined,
  );
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [page, loadError] = useClientStream(
    () =>
      client.streamQuery(
        "zerotrust.content.snapshots",
        { after: cursor },
        {
          strategy: "network-only",
        },
      ),
    [cursor],
  );
  const [review, setReview] = useState<Review | null>(null);
  const checking = useRef<AbortController | null>(null);
  useEffect(() => () => checking.current?.abort(), []);

  function closeReview() {
    checking.current?.abort();
    checking.current = null;
    setReview(null);
    if (account && publications.get(account)?.status === "failed")
      publish(account, null);
  }

  async function checkBackup(
    backup: Backup,
    operation: string = crypto.randomUUID(),
  ) {
    if (
      !account ||
      checking.current ||
      publications.get(account)?.status === "restoring"
    )
      return;
    const controller = new AbortController();
    checking.current = controller;
    publish(account, null);
    setReview({ status: "checking", backup, operation });
    try {
      const prepared = await required(
        client.mutate(
          "zerotrust.content.prepare",
          {
            operation,
            snapshotOperation: backup.id,
          },
          { signal: controller.signal },
        ),
      );
      controller.signal.throwIfAborted();
      if (
        prepared.operation !== operation ||
        prepared.snapshotOperation !== backup.id ||
        prepared.bytes !== backup.bytes
      ) {
        throw new Error("Unexpected backup preparation");
      }
      const input = await approvePreparedContent(
        client,
        prepared,
        controller.signal,
      );
      const report = await inspectPreparedContent(
        client,
        input,
        controller.signal,
      );
      setReview({ status: "checked", checked: { backup, input, report } });
    } catch (error) {
      if (!controller.signal.aborted) {
        const conflict =
          error instanceof RpcClientError && error.code === "CONFLICT";
        setReview({
          status: "failed",
          backup,
          operation: conflict ? crypto.randomUUID() : operation,
        });
      }
    } finally {
      if (checking.current === controller) checking.current = null;
    }
  }

  async function restore(checked: CheckedBackup) {
    if (
      !account ||
      unlockedAccount() !== account ||
      publications.get(account)?.status === "restoring"
    )
      return;
    publish(account, { status: "restoring", checked });
    setReview(null);
    try {
      await activatePreparedContent(
        client,
        checked.input,
        new AbortController().signal,
      );
      publish(account, { status: "restored", backup: checked.backup });
    } catch (error) {
      if (error instanceof RpcClientError && error.code === "CONFLICT")
        publish(account, { status: "conflict", backup: checked.backup });
      else publish(account, { status: "failed", checked });
    }
  }

  const restoring = publication?.status === "restoring";
  let checked: CheckedBackup | null = null;
  if (review?.status === "checked") checked = review.checked;
  if (publication && "checked" in publication) checked = publication.checked;
  let selected = checked?.backup ?? null;
  if (review && "backup" in review) selected = review.backup;
  const failedReview = review?.status === "failed" ? review : null;
  const rows = [...(page?.rows ?? [])].sort(
    (left, right) => right.createdAt.getTime() - left.createdAt.getTime(),
  );
  const megabytes = new Intl.NumberFormat(currentLocaleTag(), {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  });
  return (
    <section
      aria-label={uiText("Sicherungen", "Backups")}
      className="space-y-4"
    >
      {publication?.status === "restored" && (
        <MyCallout color="green">
          {uiText("Wiederhergestellter Stand", "Restored backup")}{" "}
          {backupDate(publication.backup)}
        </MyCallout>
      )}
      {publication?.status === "conflict" && (
        <MyCallout color="yellow">
          {uiText(
            "Der Datenstand oder die Freigaben haben sich seit der Prüfung geändert. Bitte die Sicherung erneut prüfen.",
            "Data or permissions changed after the check. Check the backup again.",
          )}
        </MyCallout>
      )}
      {loadError && (
        <MyCallout color="red">
          {uiText(
            "Sicherungen konnten nicht geladen werden.",
            "Could not load backups.",
          )}
          <MyButton
            kind="ghost"
            onClick={() =>
              void client.invalidate("zerotrust.content.snapshots")
            }
          >
            {uiText("Neu laden", "Reload")}
          </MyButton>
        </MyCallout>
      )}
      {!page && !loadError && (
        <InlineLoading
          description={uiText("Sicherungen laden", "Loading backups")}
        />
      )}
      {page && rows.length === 0 && (
        <p className="text-muted">
          {uiText("Keine Sicherungen verfügbar.", "No backups available.")}
        </p>
      )}
      {rows.length > 0 && (
        <MyTable
          rows={rows}
          columns={[
            {
              label: uiText("Erstellt", "Created"),
              render: (row: Backup) => (
                <time
                  id={`backup-date-${row.id}`}
                  dateTime={row.createdAt.toISOString()}
                >
                  {backupDate(row)}
                </time>
              ),
            },
            {
              label: uiText("Größe", "Size"),
              render: (row: Backup) =>
                megabytes.format(Number(row.bytes) / 1_000_000),
            },
            {
              label: uiText("Aktionen", "Actions"),
              render: (row: Backup) => (
                <MyButton
                  kind="secondary"
                  aria-describedby={`backup-date-${row.id}`}
                  onClick={() => void checkBackup(row)}
                >
                  {uiText("Sicherung prüfen", "Check backup")}
                </MyButton>
              ),
            },
          ]}
          autoConvertSmallViewport
        />
      )}
      {(cursors.length > 0 || page?.after) && (
        <div className="flex gap-2">
          {cursors.length > 0 && (
            <MyButton
              kind="secondary"
              onClick={() => setCursors(cursors.slice(0, -1))}
            >
              {uiText("Zurück", "Previous")}
            </MyButton>
          )}
          {!!page?.after && (
            <MyButton
              kind="secondary"
              onClick={() => setCursors([...cursors, page.after!])}
            >
              {uiText("Weitere Sicherungen", "More backups")}
            </MyButton>
          )}
        </div>
      )}
      {selected && (
        <Modal
          open
          modalHeading={uiText("Sicherung wiederherstellen", "Restore backup")}
          modalLabel={backupDate(selected)}
          onRequestClose={closeReview}
          onRequestSubmit={checked ? () => void restore(checked) : undefined}
          primaryButtonText={uiText(
            "Fachdaten wiederherstellen",
            "Restore business data",
          )}
          primaryButtonLoading={restoring}
          primaryButtonDisabled={restoring}
          secondaryButtonText={uiText("Abbrechen", "Cancel")}
          closeButtonLabel={uiText("Schließen", "Close")}
          shouldSubmitOnEnter={false}
          preventClose={restoring}
          danger
        >
          <div className="space-y-4">
            {review?.status === "checking" && (
              <InlineLoading
                description={uiText(
                  "Sicherung wird geprüft …",
                  "Checking backup…",
                )}
              />
            )}
            {failedReview && (
              <MyCallout color="red">
                {uiText(
                  "Die Sicherung konnte nicht geprüft werden.",
                  "The backup could not be checked.",
                )}
                <MyButton
                  kind="ghost"
                  onClick={() =>
                    void checkBackup(
                      failedReview.backup,
                      failedReview.operation,
                    )
                  }
                >
                  {uiText("Prüfung wiederholen", "Check again")}
                </MyButton>
              </MyCallout>
            )}
            {publication?.status === "failed" && (
              <MyCallout color="red">
                {uiText(
                  "Die Wiederherstellung wurde noch nicht bestätigt. Die Aktion kann erneut ausgeführt werden.",
                  "The restore could not be confirmed. You can retry the same action.",
                )}
              </MyCallout>
            )}
            {checked && (
              <>
                <RestoreCounts report={checked.report} />
                <p>
                  {uiText(
                    "Die Sicherung ersetzt den aktiven Stand der Fachdaten. Konten und Berechtigungen bleiben erhalten.",
                    "The backup replaces the current business data. Accounts and permissions remain in place.",
                  )}
                </p>
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
