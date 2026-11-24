import { OperationalTag } from "@sortsys/react-components";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

export function ListFilterActions({
  active,
  onEdit,
  onClear,
}: {
  active: boolean;
  onEdit: () => void;
  onClear: () => void;
}) {
  return (
    <>
      <OperationalTag
        renderIcon={active ? Icons.FilterEdit : Icons.Filter}
        text={active ? uiText("Filter ändern") : uiText("Filter")}
        onClick={onEdit}
      />
      {active && (
        <OperationalTag
          renderIcon={Icons.FilterRemove}
          text={uiText("Filter aus")}
          onClick={onClear}
        />
      )}
    </>
  );
}
