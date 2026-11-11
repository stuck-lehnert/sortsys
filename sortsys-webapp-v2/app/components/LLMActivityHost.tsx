import { useEffect, useSyncExternalStore } from "react";
import { Loading, Modal } from "@sortsys/react-components";
import { bindLLMPageLifetime, llmActivity } from "~/lib/llmActivity";
import type { LLMActivities } from "~/lib/llmActivity";
import { uiText } from "~/lib/i18n";

export function LLMActivityHost({ activity = llmActivity }: { activity?: LLMActivities }) {
  const current = useSyncExternalStore(activity.subscribe, activity.snapshot, activity.snapshot);
  useEffect(() => {
    if (activity !== llmActivity) return bindLLMPageLifetime(activity, window);
  }, [activity]);
  const imports = current.filter(task => task.kind === "document-import");
  if (!imports.length) return null;
  return <Modal open preventClose passiveModal modalHeading={uiText("Dokumente werden eingelesen", "Reading documents")} size="sm">
    <div className="flex flex-col gap-4" aria-live="polite">
      <Loading active description={imports[0]?.stage ?? uiText("Verarbeitung läuft …", "Processing…")} />
      <p>{uiText("Die Verarbeitung läuft in diesem Browser-Tab. Neuladen oder Schließen des Tabs unterbricht sie.",
        "Processing runs in this browser tab. Reloading or closing the tab interrupts it.")}</p>
    </div>
  </Modal>;
}
