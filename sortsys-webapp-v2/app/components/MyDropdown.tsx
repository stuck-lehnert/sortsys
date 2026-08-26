import { Button, Menu, MenuItem, MenuItemSelectable } from "@sortsys/react-components";
import type { ComponentProps } from "react";
import React, { useRef, useState } from "react";
import { useRefState } from "~/hooks/useRefState";
import { Icons } from "~/lib/icons";

type _MenuItemProps =
    & (Omit<ComponentProps<typeof MenuItem>, 'key' | 'defaultSelected' | 'hidden'> & {})
    | (Omit<ComponentProps<typeof MenuItemSelectable>, 'key' | 'defaultSelected' | 'hidden'> & {
        selectable: true;
    });

type MenuItemProps = _MenuItemProps & {
    hideIf?: boolean;
};

export function MyDropdown(_props: {
    icon?: React.ComponentType;
    // children?: React.ReactNode;

    items: MenuItemProps[];
    menuClassName?: string;
}) {
    let { icon: Icon, items, menuClassName, ...props } = _props;

    Icon ??= Icons.DropdownMenu;

    const triggerRef = useRef<HTMLDivElement | null>(null);
    const menuRef = useRef<HTMLUListElement | null>(null);

    const [open, setOpen] = useState(false);
    const [menuPosition, setMenuPosition] = useRefState({ x: 0, y: 0 });

    const filteredActions = items.map((item, i) => ({ ...item, index: i })).filter(({ hideIf }) => !hideIf);

    if (!filteredActions.length) return;

    return <>
        <div ref={triggerRef}>
            <Button kind="ghost" onClick={() => {
                if (triggerRef.current) {
                    const rect = triggerRef.current.getBoundingClientRect();
                    setMenuPosition({ x: rect.right, y: rect.bottom });
                }

                setOpen((value) => !value);
            }} >
                <Icon />
            </Button>
        </div>

        <Menu label="Dropdown"
            className={menuClassName}
            ref={menuRef}
            open={open}
            onClose={() => setOpen(false)}
            containerRef={triggerRef}
            {...menuPosition()}
        >
            {filteredActions.map(({ hideIf, index, ...action }) => {
                if ('selectable' in action && action.selectable) {
                    const { selectable, ...props } = action;
                    return <MenuItemSelectable key={index} {...props}   />
                }

                return <MenuItem key={index} {...(action as any)} />
            })}
        </Menu>
    </>;
}
