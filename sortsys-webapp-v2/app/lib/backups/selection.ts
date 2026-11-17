import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "../data/database";
import { readBusinessRows, publicId } from "../data/products";
import { memberCreationFrame } from "../crypto/members";
import { uiText } from "../i18n";
import {
  listenCryptoSession,
  unlockedAccount,
  type UnlockedAccount,
} from "../crypto/session";
import { openPostgresBackup } from "./business";
import { backupObjects, localBackupFiles } from "./files";
import {
  checkImportHistoryUsers,
  selectImportHistory,
  type ImportHistorySelection,
} from "./importHistory";

export type BackupSelection = {
  sql: File;
  files: File[];
  ownerId: string;
  username: string;
  history?: ImportHistorySelection;
};
export type BackupOwner = { id: string; username: string; name: string };
let pending: {
  context: string;
  account: UnlockedAccount;
  value: BackupSelection;
} | null = null;
listenCryptoSession(() => {
  if (pending && unlockedAccount() !== pending.account) pending = null;
});

export function pendingBackup(context: string): BackupSelection | null {
  return pending?.context === context && pending.account === unlockedAccount()
    ? pending.value
    : null;
}
export function rememberPendingBackup(
  context: string,
  value: BackupSelection | null,
) {
  if (!value) {
    pending = null;
    return;
  }
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  pending = { context, account, value };
}

export async function inspectBackup(
  sql: Blob,
  signal: AbortSignal,
  driver?: DuckDriver,
): Promise<BackupOwner[]> {
  const opened = await openPostgresBackup(sql, signal, driver);
  try {
    const users = await readBusinessRows(opened.database, "users");
    const owners: BackupOwner[] = [];
    for (const { values } of users) {
      const id = publicId(values.id);
      if (typeof values.username !== "string") throw new InvalidProtectedData();
      // Detect unsupported technical names before consuming a setup link.
      memberCreationFrame({
        tenant: "backup",
        generation: "1",
        author: "user:1",
        id,
        username: values.username,
      });
      if (values.archived_at !== null || values.deactivated_at !== null)
        continue;
      const name = [values.first_name, values.last_name]
        .filter((value) => typeof value === "string" && value.trim())
        .join(" ");
      owners.push({
        id,
        username: values.username,
        name: name || values.username,
      });
    }
    if (owners.length === 0)
      throw new Error(
        uiText(
          "Die Sicherung enthält keinen aktiven Benutzer, der die Organisation einrichten kann.",
          "The backup contains no active user who can set up the organization.",
        ),
      );
    return owners;
  } finally {
    await opened.database.close();
  }
}

export async function validateBackupSelection(
  selection: BackupSelection,
  signal: AbortSignal,
  driver?: DuckDriver,
) {
  const opened = await openPostgresBackup(selection.sql, signal, driver);
  try {
    const users = await readBusinessRows(opened.database, "users");
    const owner = users.find(
      (row) => publicId(row.values.id) === selection.ownerId,
    );
    if (
      !owner ||
      owner.values.username !== selection.username ||
      owner.values.archived_at !== null ||
      owner.values.deactivated_at !== null
    )
      throw new InvalidProtectedData();
    const files = localBackupFiles(selection.files);
    for (const object of await backupObjects(opened.database))
      await files.read(object, signal);
    if (selection.history) {
      const history = await selectImportHistory(
        selection.history.file,
        selection.history.tenant,
        signal,
      );
      await checkImportHistoryUsers(history, opened.database);
    }
  } finally {
    await opened.database.close();
  }
}
