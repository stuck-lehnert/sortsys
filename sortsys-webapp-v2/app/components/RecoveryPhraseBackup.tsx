import { useState } from "react";
import { uiText } from "~/lib/i18n";
import { MyForm } from "./MyForm";
import { MyButton } from "./MyButton";

/** The phrase stays in component memory and is never included in an API input. */
export function RecoveryPhraseBackup({ phrase, onConfirmed, onCancel }: {
  phrase: string; onConfirmed: () => Promise<void>; onCancel: () => void;
}) {
  const words = phrase.split(" ");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [positions] = useState(() => {
    const chosen = new Set<number>();
    while (chosen.size < 3) {
      const value = crypto.getRandomValues(new Uint8Array(1))[0]!;
      if (value < 240) chosen.add(value % 24);
    }
    return [...chosen].sort((a, b) => a - b);
  });
  return <div className="space-y-5">
    <p>{uiText(
      "Diese 24 Wörter ermöglichen die Wiederherstellung des gesamten Mandanten. Sie werden ausschließlich hier im Browser erzeugt. Ohne diese Wörter kann auch der Betreiber den Zugang nicht wiederherstellen.",
      "These 24 words recover the entire tenant. They are generated only in this browser. Without them, the provider cannot restore access either.",
    )}</p>
    {!checking ? <>
      <ol className="grid gap-x-6 gap-y-2" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(9rem,1fr))" }} aria-label={uiText("Neue Wiederherstellungsphrase", "New recovery phrase")}>
        {words.map((word, index) => <li key={index} className="flex gap-2 border border-default px-3 py-2 font-mono"><span className="text-muted">{index + 1}.</span><span>{word}</span></li>)}
      </ol>
      <p>{uiText("Die Wörter in dieser Reihenfolge außerhalb von sortsys sicher aufbewahren. Wer sie kennt, kann den Mandanten übernehmen.", "Store the words in this order securely outside sortsys. Anyone who knows them can take control of the tenant.")}</p>
      <MyButton onClick={() => setChecking(true)}>{uiText("Sicherung prüfen", "Check backup")}</MyButton>
    </> : <MyForm className="max-w-none" onSubmit={async context => {
      const values = context.getValues();
      if (positions.some(position => String(values[`word-${position}`] ?? "").trim().toLowerCase() !== words[position])) {
        throw new Error(uiText("Die Wörter stimmen nicht mit der neuen Phrase überein.", "The words do not match the new phrase."));
      }
      setBusy(true);
      try { await onConfirmed(); } finally { setBusy(false); }
    }}>
      <div className="grid gap-4 sm:grid-cols-3">
        {positions.map(position => <MyForm.Input key={position} name={`word-${position}`} labelText={`${uiText("Wort", "Word")} ${position + 1}`} autoComplete="off" spellCheck={false} required />)}
      </div>
      <MyForm.Checkbox name="backed-up" required labelText={uiText("Die vollständige Phrase ist außerhalb von sortsys gesichert.", "The complete phrase is backed up outside sortsys.")} />
      <div className="flex flex-wrap gap-2">
        <MyForm.SubmitButton>{uiText("Mit gesicherter Phrase fortfahren", "Continue with backed-up phrase")}</MyForm.SubmitButton>
        <MyButton kind="tertiary" disabled={busy} onClick={() => setChecking(false)}>{uiText("Wörter erneut anzeigen", "Show words again")}</MyButton>
      </div>
    </MyForm>}
    <MyButton kind="tertiary" disabled={busy} onClick={onCancel}>{uiText("Abbrechen", "Cancel")}</MyButton>
  </div>;
}
