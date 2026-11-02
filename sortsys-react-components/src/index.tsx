export {
  Content,
  SkipToContent,
  Header,
  HeaderGlobalBar,
  HeaderGlobalAction,
  HeaderMenuButton,
  HeaderName,
  SideNav,
  SideNavItems,
  SideNavDivider,
  SideNavLink,
  SideNavItem,
  SideNavMenu,
  SideNavMenuItem,
} from "./hero-shell.js";
export type { FilterableMultiSelectProps } from "./control-types.js";
export { LoadMore } from "./hero-load-more.js";
export { Menu, MenuItem, MenuItemSelectable } from "./hero-menu.js";
import { Card } from "@heroui/react";
import { Button, TextInput } from "./hero-controls.js";
export {
  Button,
  Form,
  TextInput,
  PasswordInput,
  TextArea,
  Checkbox,
  Select,
  SelectItem,
  ComboBox,
  FilterableMultiSelect,
  MultiSelect,
  Tabs,
  TabList,
  Tab,
  Tag,
  OperationalTag,
  Callout,
  InlineNotification,
  Modal,
} from "./hero-controls.js";
import React, {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";
import { createPortal } from "react-dom";

type IconLike = React.ComponentType<{
  size?: number;
  className?: string;
  color?: string;
}>;

function cx(...tokens: Array<string | false | null | undefined>) {
  return tokens.filter(Boolean).join(" ");
}

function withClassName<T extends Record<string, any>>(
  props: T,
  className: string,
) {
  return {
    ...props,
    className: cx(className, props.className),
  };
}

function mapTagType(type?: string) {
  if (!type) return "neutral";
  return type.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function asDateInputValue(value: Date | Date[] | string | null | undefined) {
  if (Array.isArray(value)) {
    value = value[0];
  }

  if (!value) {
    return "";
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function asOptionText(item: any) {
  if (item == null) return "";
  if (typeof item === "string" || typeof item === "number") return `${item}`;

  const candidate =
    item.label ?? item.name ?? item.title ?? item.text ?? item.value ?? item.id;
  if (candidate == null) return "";
  if (typeof candidate === "string" || typeof candidate === "number")
    return `${candidate}`;
  return "";
}

function CloseIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M3 3L13 13M13 3L3 13"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MenuIcon({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M2.2 4.2H13.8M2.2 8H13.8M2.2 11.8H13.8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ensureDomAvailable() {
  return typeof document === "object";
}

export type OperationalTagType =
  | "green"
  | "red"
  | "cool-gray"
  | "purple"
  | "magenta"
  | "cyan"
  | "teal"
  | "blue"
  | "outline";

export interface OperationalTagBaseProps {
  type?: OperationalTagType;
}

export function Loading({
  active = true,
  withOverlay = false,
  small = false,
  description,
  className,
  ...props
}: any) {
  if (!active) {
    return null;
  }

  const node = (
    <div
      {...props}
      className={cx("ss-loading", className)}
      role="status"
      aria-live="polite"
    >
      <span className={cx("ss-spinner", small && "ss-spinner--small")} />
      {!!description && <span className="ss-loading__text">{description}</span>}
    </div>
  );

  if (!withOverlay) {
    return node;
  }

  return <div className="ss-loading-overlay">{node}</div>;
}

export function InlineLoading({ description, className, ...props }: any) {
  return (
    <div
      {...props}
      className={cx("ss-inline-loading", className)}
      role="status"
      aria-live="polite"
    >
      <span className="ss-spinner ss-spinner--small" />
      <span>{description || "Lädt..."}</span>
    </div>
  );
}

export function Heading({
  level = 2,
  as,
  noMargin = false,
  className,
  children,
  ...props
}: any) {
  const normalizedLevel = Math.min(6, Math.max(1, Number(level) || 2));
  const As = as || `h${normalizedLevel}`;
  const sizes = [
    "text-3xl sm:text-4xl",
    "text-2xl",
    "text-xl",
    "text-lg",
    "text-base",
    "text-sm",
  ];

  return (
    <As
      {...props}
      className={cx(
        "font-semibold tracking-tight text-foreground",
        sizes[normalizedLevel - 1],
        !noMargin && "mb-3 mt-6",
        className,
      )}
    >
      {children}
    </As>
  );
}

export function Tile({ className, ...props }: any) {
  return (
    <Card
      {...props}
      className={cx(
        "ss-tile min-w-0 border border-separator shadow-none",
        className,
      )}
    />
  );
}

type MultiSelectContextValue = {
  value: string;
  onValueChange: (next: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  invalidText?: string;
};

const DatePickerContext = createContext<MultiSelectContextValue | null>(null);

export function DatePicker({
  value,
  onChange,
  invalid,
  invalidText,
  className,
  children,
  disabled,
  datePickerType: _datePickerType,
  dateFormat: _dateFormat,
  allowInput: _allowInput,
  locale: _locale,
  ...props
}: any) {
  const inputValue = asDateInputValue(value);

  return (
    <DatePickerContext.Provider
      value={{
        value: inputValue,
        disabled,
        invalid,
        invalidText,
        onValueChange: (next) => {
          if (!next) {
            onChange?.(null);
            return;
          }

          onChange?.([new Date(`${next}T00:00:00`)]);
        },
      }}
    >
      <div
        {...props}
        className={cx("ss-date-picker min-w-0 w-full", className)}
        data-disabled={disabled ? "true" : "false"}
      >
        {children}
      </div>
    </DatePickerContext.Provider>
  );
}

export function DatePickerInput({
  invalid,
  invalidText,
  disabled,
  onChange,
  ...props
}: any) {
  const context = useContext(DatePickerContext);

  return (
    <TextInput
      {...props}
      type="date"
      disabled={disabled || context?.disabled}
      invalid={Boolean(invalid || context?.invalid)}
      invalidText={invalidText || context?.invalidText}
      value={context?.value ?? ""}
      onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
        context?.onValueChange(event.target.value);
        onChange?.(event);
      }}
    />
  );
}

export function TableContainer({ className, children, ...props }: any) {
  return (
    <section {...props} className={cx("ss-data-table-container", className)}>
      <div className="ss-data-table-content">{children}</div>
    </section>
  );
}

export function Table({ className, isSortable, ...props }: any) {
  return (
    <table
      {...props}
      className={cx("ss-data-table", isSortable && "is-sortable", className)}
    />
  );
}

export function TableHead({ className, ...props }: any) {
  return <thead {...props} className={cx("ss-table-head", className)} />;
}

export function TableBody({ className, ...props }: any) {
  return <tbody {...props} className={cx("ss-table-body", className)} />;
}

export function TableRow({ className, ...props }: any) {
  return <tr {...props} className={cx("ss-table-row", className)} />;
}

export function TableCell({ className, ...props }: any) {
  return <td {...props} className={cx("ss-table-cell", className)} />;
}

export function TableHeader({
  className,
  children,
  isSortable,
  isSortHeader,
  sortDirection = "NONE",
  ...props
}: any) {
  const sortIndicator =
    sortDirection === "ASC" ? "↑" : sortDirection === "DESC" ? "↓" : "";

  return (
    <th
      {...props}
      className={cx(
        "ss-table-header",
        isSortable && "is-sortable",
        isSortHeader && "is-sorted",
        className,
      )}
    >
      <span>{children}</span>
      {!!isSortable && !!sortIndicator && (
        <span
          className={cx(
            "ss-table-sort-indicator",
            sortDirection === "ASC" && "is-asc",
            sortDirection === "DESC" && "is-desc",
          )}
          aria-hidden="true"
        >
          {sortIndicator}
        </span>
      )}
    </th>
  );
}

export function DataTable({ children }: any) {
  return children ?? null;
}
