import React, { StrictMode, useState } from "react";
import { BackupPicker } from "../../app/components/BackupPicker";
import { row, sourceSql } from "../../app/lib/data/testing/businessRow.mjs";
import {
  oldScan,
  scanSourceSql,
} from "../../app/lib/data/testing/importHistory.mjs";
import { I18nProvider } from "../../app/lib/i18n";

export function showBackupSelection(root) {
  function View() {
    const [selection, setSelection] = useState(null);
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1>Organisation aus Sicherung einrichten</h1>
        <BackupPicker onChange={setSelection} />
        <button disabled={!selection}>Übernahme starten</button>
        <output aria-label="Ausgewählte Sicherung">
          {JSON.stringify(
            selection
              ? {
                  ownerId: selection.ownerId,
                  username: selection.username,
                  historyTenant: selection.history?.tenant ?? null,
                }
              : null,
          )}
        </output>
      </main>
    );
  }
  window.cryptoFixture.backupSelectionFiles = () => ({
    sql: sourceSql([
      row("users", {
        id: "87",
        username: "owner",
        first_name: "Anna",
        contract_type: "internal",
        ui_locale: "de",
      }),
    ]),
    history: scanSourceSql([
      oldScan(),
      oldScan({ tenant_name: "other-tenant" }),
    ]),
  });
  root.render(
    <StrictMode>
      <I18nProvider>
        <View />
      </I18nProvider>
    </StrictMode>,
  );
}
