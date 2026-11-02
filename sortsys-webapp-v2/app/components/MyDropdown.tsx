import { Dropdown } from "@heroui/react";
import {
  Button,
  MenuItem,
  MenuItemSelectable,
} from "@sortsys/react-components";
import { useState, type ComponentProps, type ReactNode } from "react";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

type MenuAction =
  | Omit<ComponentProps<typeof MenuItem>, "key" | "defaultSelected" | "hidden">
  | (Omit<
      ComponentProps<typeof MenuItemSelectable>,
      "key" | "defaultSelected" | "hidden"
    > & { selectable: true });

type MenuItemProps = MenuAction & { hideIf?: boolean };

export function MyDropdown({
  icon: Icon = Icons.DropdownMenu,
  label,
  ariaLabel,
  items,
  menuClassName,
  size = "md",
}: {
  icon?: React.ComponentType;
  label?: ReactNode;
  ariaLabel?: string;
  items: MenuItemProps[];
  menuClassName?: string;
  size?: "sm" | "md";
}) {
  const [open, setOpen] = useState(false);
  const actions = items
    .map((item, index) => ({ ...item, index }))
    .filter(({ hideIf }) => !hideIf);

  if (!actions.length) {
    return null;
  }

  const accessibleLabel = ariaLabel ?? (
    typeof label === "string" ? label : uiText("Aktionen", "Actions")
  );

  return (
    <Dropdown isOpen={open} onOpenChange={setOpen}>
      <Button
        type="button"
        kind="ghost"
        size={size}
        renderIcon={Icon}
        aria-label={accessibleLabel}
      >
        {label}
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={accessibleLabel} className={menuClassName}>
          {actions.map(({ hideIf: _hidden, index, ...action }) => {
            if ("selectable" in action && action.selectable) {
              const { selectable: _selectable, ...props } = action;
              return <MenuItemSelectable key={index} {...props} />;
            }

            return <MenuItem key={index} {...action} />;
          })}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}
