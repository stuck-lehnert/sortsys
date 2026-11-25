import { MyButton } from "~/components/MyButton";
import type { CursorHistoryState } from "@sortsys/zerotrust";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

export const COLLAPSED_ACTIVITY_COUNT = 6;

export function ActivityHistoryControls({
  history,
  expanded,
  listId,
  onToggle,
  onLoadOlder,
}: {
  history: CursorHistoryState<unknown>;
  expanded: boolean;
  listId: string;
  onToggle: () => void;
  onLoadOlder: () => void;
}) {
  if (history.items.length <= COLLAPSED_ACTIVITY_COUNT) return null;

  return (
    <>
      <div className="entity-activity-actions flex flex-wrap items-center gap-2 border-t border-separator pt-3">
        {expanded && !history.complete && (
          <MyButton
            kind="secondary"
            size="sm"
            renderIcon={Icons.Plus}
            loading={history.loading}
            onClick={onLoadOlder}
          >
            {uiText("Ältere Aktivitäten laden", "Load older activities")}
          </MyButton>
        )}
        <MyButton
          kind="ghost"
          size="sm"
          renderIcon={Icons.AccordionExpanded}
          className={
            expanded ? "entity-activity-collapse [&_svg]:rotate-180" : undefined
          }
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={onToggle}
        >
          {expanded
            ? uiText("Weniger anzeigen", "Show less")
            : uiText("Mehr anzeigen", "Show more")}
        </MyButton>
      </div>
      {expanded && history.error && (
        <div className="entity-activity-error text-sm text-danger" role="alert">
          {uiText(
            "Ältere Aktivitäten konnten nicht geladen werden.",
            "Older activities could not be loaded.",
          )}
        </div>
      )}
    </>
  );
}
