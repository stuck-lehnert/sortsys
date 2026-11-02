import { controlText } from "./hero-utils.js";
import { Menu as HeroMenu, Popover } from "@heroui/react";
import { forwardRef, useId, useRef, useState } from "react";

function classes(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}

export const Menu = forwardRef<HTMLDivElement, any>(function Menu(
  { open, onClose, x = 0, y = 0, className, children, containerRef, ...props },
  ref,
) {
  const positionRef = useRef<HTMLSpanElement | null>(null);
  const label =
    typeof document === "object" && document.documentElement.lang === "en"
      ? "Actions"
      : "Aktionen";

  return (
    <>
      <span
        ref={positionRef}
        aria-hidden="true"
        className="pointer-events-none fixed size-0"
        style={{ left: x, top: y }}
      />
      <Popover.Content
        isOpen={Boolean(open)}
        onOpenChange={(next) => {
          if (!next) {
            onClose?.();
          }
        }}
        triggerRef={positionRef}
        placement="bottom end"
        offset={4}
        className="min-w-48 p-1"
      >
        <HeroMenu
          {...props}
          ref={ref}
          aria-label={props["aria-label"] ?? label}
          autoFocus="first"
          onClose={onClose}
          className={classes("ss-menu", className)}
        >
          {children}
        </HeroMenu>
      </Popover.Content>
    </>
  );
});

export function MenuItem({
  label,
  renderIcon: Icon,
  showIcon = false,
  title,
  className,
  onClick,
  disabled,
  children,
  ...props
}: any) {
  const content = label ?? children;

  return (
    <HeroMenu.Item
      {...props}
      isDisabled={disabled}
      textValue={controlText(content) || props["aria-label"]}
      onAction={onClick}
      className={className}
    >
      {Icon && (showIcon || content == null) && (
        <Icon size={18} className="ss-menu__icon shrink-0" aria-hidden="true" />
      )}
      {content != null && <span title={title}>{content}</span>}
    </HeroMenu.Item>
  );
}

export function MenuItemSelectable({
  selected,
  defaultSelected,
  onClick,
  className,
  label,
  title,
  children,
  disabled,
  ...props
}: any) {
  const id = useId();
  const [internalSelected, setInternalSelected] = useState(
    Boolean(defaultSelected),
  );
  const isSelected = selected ?? internalSelected;
  const content = label ?? children;

  return (
    <HeroMenu.Section
      selectionMode="multiple"
      selectedKeys={isSelected ? [id] : []}
      onSelectionChange={(keys) => {
        if (selected === undefined) {
          setInternalSelected(keys === "all" || keys.has(id));
        }
      }}
      shouldCloseOnSelect
    >
      <HeroMenu.Item
        {...props}
        id={id}
        isDisabled={disabled}
        textValue={controlText(content) || props["aria-label"]}
        onAction={onClick}
        className={className}
      >
        <HeroMenu.ItemIndicator />
        <span title={title}>{content}</span>
      </HeroMenu.Item>
    </HeroMenu.Section>
  );
}
