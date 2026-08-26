import React, {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
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

function withClassName<T extends Record<string, any>>(props: T, className: string) {
  return {
    ...props,
    className: cx(className, props.className),
  };
}

function mapTagType(type?: string) {
  if (!type) return "neutral";
  return type.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

function asDateInputValue(value: Date | string | null | undefined) {
  if (!value) return "";

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

  const candidate = item.label ?? item.name ?? item.title ?? item.text ?? item.value ?? item.id;
  if (candidate == null) return "";
  if (typeof candidate === "string" || typeof candidate === "number") return `${candidate}`;
  return "";
}

function CloseIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M3 3L13 13M13 3L3 13" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function MenuIcon({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 16 16"
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2.2 4.2H13.8M2.2 8H13.8M2.2 11.8H13.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
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
  description,
  className,
  ...props
}: any) {
  if (!active) return null;

  const node = (
    <div {...props} className={cx("ss-loading", className)} role="status" aria-live="polite">
      <span className="ss-spinner" />
      {!!description && <span className="ss-loading__text">{description}</span>}
    </div>
  );

  if (!withOverlay) return node;

  return <div className="ss-loading-overlay">{node}</div>;
}

export function InlineLoading({ description, className, ...props }: any) {
  return (
    <div {...props} className={cx("ss-inline-loading", className)} role="status" aria-live="polite">
      <span className="ss-spinner ss-spinner--small" />
      <span>{description || "Lädt..."}</span>
    </div>
  );
}

export function Heading({ level = 2, as, noMargin = false, className, children, ...props }: any) {
  const normalizedLevel = Math.min(6, Math.max(1, Number(level) || 2));
  const As = as || `h${normalizedLevel}`;

  return (
    <As
      {...props}
      className={cx("ss-heading", `ss-heading--h${normalizedLevel}`, noMargin && "ss-heading--nomargin", className)}
    >
      {children}
    </As>
  );
}

export const Button = forwardRef<HTMLButtonElement, any>(function Button(props, ref) {
  const {
    kind = "primary",
    size = "md",
    renderIcon: Icon,
    loading,
    disabled,
    children,
    className,
    ...rest
  } = props;

  const visibleChildren = Children
    .toArray(children)
    .filter((child) => child !== null && child !== false && child !== "");
  const hasTextChild = visibleChildren.some((child) => {
    if (typeof child === "number") return true;
    if (typeof child === "string") return child.trim().length > 0;
    return false;
  });
  const iconOnly = !hasTextChild && (!!Icon || !!visibleChildren.length);

  return (
    <button
      ref={ref}
      {...rest}
      type={rest.type || "button"}
      disabled={disabled || loading}
      className={cx(
        "ss-btn",
        `ss-btn--${mapTagType(kind)}`,
        `ss-btn--${mapTagType(size)}`,
        iconOnly && "ss-btn--icon-only",
        loading && "is-loading",
        className,
      )}
    >
      {!!Icon && <Icon size={16} className="ss-btn__icon" />}
      {!!visibleChildren.length && (
        iconOnly
          ? <span className="ss-btn__icon-only-child">{children}</span>
          : <span className="ss-btn__text">{children}</span>
      )}
    </button>
  );
});

export function Tile({ className, ...props }: any) {
  return <div {...props} className={cx("ss-tile", className)} />;
}

export function Content({ className, ...props }: any) {
  return <main {...props} id={props.id || "main-content"} className={cx("ss-content", className)} />;
}

export function SkipToContent({ href = "#main-content", children = "Zum Inhalt", className, ...props }: any) {
  return (
    <a {...props} href={href} className={cx("ss-skip-to-content", className)}>
      {children}
    </a>
  );
}

export function Header({ className, ...props }: any) {
  return <header {...props} className={cx("ss-header", className)} />;
}

export function HeaderGlobalBar({ className, ...props }: any) {
  return <div {...props} className={cx("ss-header-global-bar", className)} />;
}

export function HeaderGlobalAction({ className, children, ...props }: any) {
  return (
    <button {...props} type={props.type || "button"} className={cx("ss-header-global-action", "ss-icon-button", className)}>
      {children}
    </button>
  );
}

export function HeaderMenuButton({ className, isActive, children, ...props }: any) {
  return (
    <button
      {...props}
      type={props.type || "button"}
      className={cx("ss-header__menu-toggle", "ss-header-menu-button", "ss-icon-button", isActive && "is-active", className)}
    >
      {children || <MenuIcon className="ss-header-menu-button__icon" />}
    </button>
  );
}

export function HeaderName({ as: As = "a", prefix, className, children, ...props }: any) {
  return (
    <As {...props} className={cx("ss-header-name", className)}>
      {!!prefix && <span className="ss-header-name__prefix">{prefix}</span>}
      <span className="ss-header-name__text">{children}</span>
    </As>
  );
}

export function SideNav({ expanded = false, onOverlayClick, className, children, ...props }: any) {
  return (
    <>
      <div
        className={cx("ss-side-nav-overlay", expanded && "is-visible")}
        onClick={onOverlayClick}
        aria-hidden="true"
      />
      <aside
        {...props}
        className={cx(
          "ss-side-nav",
          "ss-side-nav--ux",
          expanded && "ss-side-nav--expanded",
          className,
        )}
      >
        {children}
      </aside>
    </>
  );
}

export function SideNavItems({ className, ...props }: any) {
  return <nav {...props} className={cx("ss-side-nav-items", className)} />;
}

export function SideNavDivider({ className, ...props }: any) {
  return <hr {...props} className={cx("ss-side-nav-divider", className)} />;
}

export const SideNavLink = forwardRef<any, any>(function SideNavLink(props, ref) {
  const {
    as: As,
    className,
    renderIcon: Icon,
    children,
    isActive,
    ...rest
  } = props;

  const linkProps = withClassName(rest, "ss-side-nav__link");
  const childNode = (
    <>
      {!!Icon && <Icon size={16} className="ss-side-nav__icon" />}
      <span className="ss-side-nav__label">{children}</span>
    </>
  );

  const control = As
    ? <As ref={ref} {...linkProps}>{childNode}</As>
    : <button ref={ref} type={rest.type || "button"} {...linkProps}>{childNode}</button>;

  return (
    <div className={cx("ss-side-nav__item", "ss-side-nav__item--icon", isActive && "is-active", className)}>
      {control}
    </div>
  );
});

export const SideNavItem = SideNavLink;

export function SideNavMenu({ title, renderIcon: Icon, children, className, defaultExpanded = false, ...props }: any) {
  const [open, setOpen] = useState(!!defaultExpanded);

  return (
    <div {...props} className={cx("ss-side-nav-menu", className)}>
      <button
        type="button"
        className="ss-side-nav-menu__trigger"
        onClick={() => setOpen((value) => !value)}
      >
        {!!Icon && <Icon size={16} className="ss-side-nav__icon" />}
        <span>{title}</span>
        <span className="ss-side-nav-menu__caret" aria-hidden="true">{open ? "-" : "+"}</span>
      </button>

      {open && <div className="ss-side-nav-menu__items">{children}</div>}
    </div>
  );
}

export function SideNavMenuItem(props: any) {
  return <SideNavLink {...props} className={cx("ss-side-nav-menu-item", props.className)} />;
}

export function Tag({ type = "neutral", size = "md", children, className, ...props }: any) {
  return (
    <span
      {...props}
      className={cx("ss-tag", `ss-tag--${mapTagType(type)}`, `ss-tag--${mapTagType(size)}`, className)}
    >
      {children}
    </span>
  );
}

export function OperationalTag({
  renderIcon: Icon,
  text,
  type = "blue",
  className,
  onClick,
  ...props
}: any) {
  const Comp = onClick ? "button" : "span";

  return (
    <Comp
      {...props}
      {...(onClick ? { type: "button", onClick } : {})}
      className={cx("ss-operational-tag", `ss-operational-tag--${mapTagType(type)}`, className)}
    >
      {!!Icon && <Icon size={14} className="ss-operational-tag__icon" />}
      <span>{text}</span>
    </Comp>
  );
}

type TabsContextValue = {
  selectedIndex: number;
  setSelectedIndex: (value: number) => void;
};

const TabsContext = createContext<TabsContextValue | null>(null);

export function Tabs({ selectedIndex, onChange, className, children, ...props }: any) {
  const controlled = typeof selectedIndex === "number";
  const [internalIndex, setInternalIndex] = useState(controlled ? selectedIndex : 0);

  useEffect(() => {
    if (!controlled) return;
    setInternalIndex(selectedIndex);
  }, [controlled, selectedIndex]);

  const setSelectedIndex = (next: number) => {
    if (!controlled) {
      setInternalIndex(next);
    }
    onChange?.({ selectedIndex: next });
  };

  return (
    <TabsContext.Provider value={{ selectedIndex: internalIndex, setSelectedIndex }}>
      <div {...props} className={cx("ss-tabs", className)}>
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabList({ children, className, ...props }: any) {
  return (
    <div {...props} role="tablist" className={cx("ss-tab-list", className)}>
      {Children.map(children, (child, index) => {
        if (!isValidElement(child)) return child;
        return cloneElement(child, { __tabIndex: index });
      })}
    </div>
  );
}

export function Tab({ __tabIndex, children, className, ...props }: any) {
  const context = useContext(TabsContext);
  const selected = context?.selectedIndex === __tabIndex;

  return (
    <button
      {...props}
      type="button"
      role="tab"
      aria-selected={selected}
      className={cx("ss-tab", selected && "is-active", className)}
      onClick={(event) => {
        props.onClick?.(event);
        context?.setSelectedIndex?.(__tabIndex || 0);
      }}
    >
      {children}
    </button>
  );
}

export const Form = forwardRef<HTMLFormElement, any>(function Form({ className, ...props }, ref) {
  return <form ref={ref} {...props} className={cx("ss-form", className)} />;
});

export const TextInput = forwardRef<HTMLInputElement, any>(function TextInput(props, ref) {
  const {
    labelText,
    helperText,
    invalid,
    invalidText,
    suffix,
    className,
    id,
    type = "text",
    ...rest
  } = props;

  return (
    <div className={cx("ss-field", className)}>
      {!!labelText && <label className="ss-label" htmlFor={id}>{labelText}</label>}

      <div className={cx("ss-field__input-row", !!suffix && "has-suffix")}>
        <input ref={ref} id={id} {...rest} type={type} className={cx("ss-input", invalid && "is-invalid", rest.inputClassName)} />
        {!!suffix && <div className="ss-field__suffix">{suffix}</div>}
      </div>

      {!!helperText && <div className="ss-field__hint">{helperText}</div>}
      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

export const PasswordInput = forwardRef<HTMLInputElement, any>(function PasswordInput(props, ref) {
  return <TextInput ref={ref} {...props} type="password" />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, any>(function TextArea(props, ref) {
  const {
    labelText,
    helperText,
    invalid,
    invalidText,
    className,
    id,
    rows = 4,
    ...rest
  } = props;

  return (
    <div className={cx("ss-field", className)}>
      {!!labelText && <label className="ss-label" htmlFor={id}>{labelText}</label>}
      <textarea ref={ref} id={id} rows={rows} {...rest} className={cx("ss-input ss-textarea", invalid && "is-invalid", rest.inputClassName)} />
      {!!helperText && <div className="ss-field__hint">{helperText}</div>}
      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

export const Checkbox = forwardRef<HTMLInputElement, any>(function Checkbox(props, ref) {
  const {
    labelText,
    invalid,
    invalidText,
    className,
    id,
    children,
    ...rest
  } = props;

  return (
    <div className={cx("ss-checkbox", className)}>
      <label htmlFor={id} className="ss-checkbox__label">
        <input ref={ref} id={id} {...rest} type="checkbox" className="ss-checkbox__input" />
        <span className="ss-checkbox__text">{labelText || children}</span>
      </label>
      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

export const Select = forwardRef<HTMLSelectElement, any>(function Select(props, ref) {
  const {
    labelText,
    helperText,
    invalid,
    invalidText,
    suffix,
    className,
    id,
    children,
    ...rest
  } = props;

  return (
    <div className={cx("ss-field", className)}>
      {!!labelText && <label className="ss-label" htmlFor={id}>{labelText}</label>}

      <div className={cx("ss-field__input-row", !!suffix && "has-suffix")}>
        <select ref={ref} id={id} {...rest} className={cx("ss-input ss-select", invalid && "is-invalid")}>
          {children}
        </select>

        {!!suffix && <div className="ss-field__suffix">{suffix}</div>}
      </div>

      {!!helperText && <div className="ss-field__hint">{helperText}</div>}
      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

export function SelectItem({ text, children, ...props }: any) {
  return <option {...props}>{text ?? children}</option>;
}

export const ComboBox = forwardRef<HTMLInputElement, any>(function ComboBox(props, ref) {
  const {
    titleText,
    items = [],
    itemToString = (item: any) => asOptionText(item),
    itemToElement,
    onInputChange,
    value,
    className,
    invalid,
    invalidText,
    disabled,
    ...rest
  } = props;

  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(`${value ?? ""}`);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setInternalValue(`${value ?? ""}`);
  }, [value]);

  useEffect(() => {
    if (!open) return;

    const listener = (event: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [open]);

  return (
    <div ref={wrapperRef} className={cx("ss-field ss-combobox", className)}>
      {!!titleText && <label className="ss-label">{titleText}</label>}

      <input
        ref={ref}
        {...rest}
        value={internalValue}
        disabled={disabled}
        className={cx("ss-input", invalid && "is-invalid")}
        onFocus={(event) => {
          setOpen(true);
          rest.onFocus?.(event);
        }}
        onChange={(event) => {
          const next = event.target.value;
          setInternalValue(next);
          onInputChange?.(next);
          rest.onChange?.(event);
          setOpen(true);
        }}
      />

      {open && !!items.length && (
        <ul className="ss-combobox__list" role="listbox">
          {items.map((item: any, index: number) => {
            const key = item?.id ?? `${itemToString(item)}-${index}`;
            return (
              <li key={key} className="ss-combobox__item" role="option">
                <button
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    const next = itemToString(item);
                    setInternalValue(next);
                    onInputChange?.(next);
                    setOpen(false);
                  }}
                >
                  {itemToElement ? itemToElement(item) : itemToString(item)}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

type MultiSelectContextValue = {
  value: string;
  onValueChange: (next: string) => void;
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
  ...props
}: any) {
  const inputValue = asDateInputValue(value);

  return (
    <DatePickerContext.Provider
      value={{
        value: inputValue,
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
      <div {...props} className={cx("ss-date-picker", className)} data-disabled={disabled ? "true" : "false"}>
        {children}
      </div>
    </DatePickerContext.Provider>
  );
}

export function DatePickerInput({
  id,
  labelText,
  invalid,
  invalidText,
  suffix,
  className,
  disabled,
  onChange,
  ...props
}: any) {
  const context = useContext(DatePickerContext);
  const mergedInvalid = !!(invalid || context?.invalid);

  return (
    <div className={cx("ss-field", className)}>
      {!!labelText && <label className="ss-label" htmlFor={id}>{labelText}</label>}

      <div className={cx("ss-field__input-row", !!suffix && "has-suffix")}>
        <input
          id={id}
          {...props}
          type="date"
          disabled={disabled}
          className={cx("ss-input", mergedInvalid && "is-invalid")}
          value={context?.value ?? ""}
          onChange={(event) => {
            context?.onValueChange(event.target.value);
            onChange?.(event);
          }}
        />

        {!!suffix && <div className="ss-field__suffix">{suffix}</div>}
      </div>

      {mergedInvalid && <div className="ss-field__error">{invalidText || context?.invalidText}</div>}
    </div>
  );
}

export const FilterableMultiSelect = forwardRef<HTMLDivElement, any>(function FilterableMultiSelect(props, ref) {
  const {
    titleText,
    items = [],
    selectedItems = [],
    onChange,
    onInputValueChange,
    itemToElement,
    itemToString = (item: any) => asOptionText(item),
    createActionLabel,
    onCreateAction,
    invalid,
    invalidText,
    disabled,
    autoFocus,
    className,
  } = props;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const localRef = useRef<HTMLDivElement | null>(null);
  const createActionHandledRef = useRef(false);

  useEffect(() => {
    if (!open) return;

    const listener = (event: MouseEvent) => {
      if (!localRef.current) return;
      if (localRef.current.contains(event.target as Node)) return;
      setOpen(false);
    };

    window.addEventListener("mousedown", listener);
    return () => window.removeEventListener("mousedown", listener);
  }, [open]);

  const isSameItem = (left: any, right: any) => {
    if (left === right) return true;

    const leftId = left?.id;
    const rightId = right?.id;
    if (leftId != null || rightId != null) {
      return leftId === rightId;
    }

    return itemToString(left) === itemToString(right);
  };

  const attachRef = (node: HTMLDivElement | null) => {
    localRef.current = node;
    if (typeof ref === "function") {
      ref(node);
    } else if (ref) {
      (ref as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }
  };

  const runCreateAction = () => {
    if (createActionHandledRef.current) return;
    createActionHandledRef.current = true;
    window.setTimeout(() => {
      createActionHandledRef.current = false;
    }, 0);

    setOpen(false);
    onCreateAction?.(query);
  };

  return (
    <div ref={attachRef} className={cx("ss-field ss-multi-select", className)}>
      {!!titleText && <label className="ss-label">{titleText}</label>}

      <div className="ss-multi-select__control">
        <input
          type="text"
          value={query}
          autoFocus={autoFocus}
          disabled={disabled}
          className={cx("ss-input", invalid && "is-invalid")}
          onFocus={() => setOpen(true)}
          onChange={(event) => {
            const next = event.target.value;
            setQuery(next);
            onInputValueChange?.(next);
          }}
        />

        {open && (!!items.length || !!onCreateAction) && (
          <ul className="ss-multi-select__list" role="listbox">
            {items.map((item: any, index: number) => {
              const key = `${item?.id ?? itemToString(item)}-${index}`;
              const selected = selectedItems.some((entry: any) => isSameItem(entry, item));

              return (
                <li key={key} className={cx("ss-multi-select__item", selected && "is-selected")}
                >
                  <button
                    type="button"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      let next: any[];
                      if (selected) {
                        next = selectedItems.filter((entry: any) => !isSameItem(entry, item));
                      } else {
                        next = [...selectedItems, item];
                      }

                      onChange?.({ selectedItems: next });
                    }}
                  >
                    <span className={cx("ss-multi-select__check", selected && "is-checked")} aria-hidden="true">{selected ? "✓" : ""}</span>
                    <span className="ss-multi-select__item-content">{itemToElement ? itemToElement(item) : itemToString(item)}</span>
                  </button>
                </li>
              );
            })}

            {!!onCreateAction && (
              <li className="ss-multi-select__create-action">
                <button
                  type="button"
                  onPointerDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    runCreateAction();
                  }}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    runCreateAction();
                  }}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.detail === 0) runCreateAction();
                  }}
                >
                  {typeof createActionLabel === "function" ? createActionLabel({ query }) : createActionLabel}
                </button>
              </li>
            )}
          </ul>
        )}
      </div>

      {!!selectedItems.length && (
        <div className="ss-multi-select__chips">
          {selectedItems.map((item: any, index: number) => (
            <span className="ss-multi-select__chip" key={`${item?.id ?? index}-${index}`}>
              {itemToString(item)}
            </span>
          ))}
        </div>
      )}

      {!!invalid && !!invalidText && <div className="ss-field__error">{invalidText}</div>}
    </div>
  );
});

export const MultiSelect = FilterableMultiSelect;

type MenuContextValue = {
  close: () => void;
};

const MenuContext = createContext<MenuContextValue | null>(null);

export const Menu = forwardRef<HTMLUListElement, any>(function Menu(props, ref) {
  const {
    open,
    onClose,
    x = 0,
    y = 0,
    className,
    children,
    containerRef,
  } = props;

  const localRef = useRef<HTMLUListElement | null>(null);

  const attachRef = (node: HTMLUListElement | null) => {
    localRef.current = node;

    if (typeof ref === "function") {
      ref(node);
    } else if (ref) {
      (ref as React.MutableRefObject<HTMLUListElement | null>).current = node;
    }
  };

  useEffect(() => {
    if (!open) return;

    const keyListener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    const clickListener = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;

      if (localRef.current && localRef.current.contains(target)) return;
      if (containerRef?.current && containerRef.current.contains(target)) return;

      onClose?.();
    };

    window.addEventListener("keydown", keyListener);
    window.addEventListener("mousedown", clickListener);
    return () => {
      window.removeEventListener("keydown", keyListener);
      window.removeEventListener("mousedown", clickListener);
    };
  }, [open, onClose, containerRef]);

  if (!open) return null;

  let menuX = x;
  let menuY = y;

  if (ensureDomAvailable()) {
    const menuWidth = localRef.current?.offsetWidth ?? 220;
    const menuHeight = localRef.current?.offsetHeight ?? 240;
    const margin = 8;

    menuX = Math.min(Math.max(x, menuWidth + margin), window.innerWidth - margin);
    menuY = Math.min(Math.max(y, margin), Math.max(margin, window.innerHeight - menuHeight - margin));
  }

  const node = (
    <MenuContext.Provider value={{ close: () => onClose?.() }}>
      <ul
        ref={attachRef}
        className={cx("ss-menu", className)}
        style={{ top: menuY, left: menuX, transform: "translateX(-100%)" }}
      >
        {children}
      </ul>
    </MenuContext.Provider>
  );

  if (!ensureDomAvailable()) return node;
  return createPortal(node, document.body);
});

export function MenuItem({ label, renderIcon: Icon, className, onClick, ...props }: any) {
  const context = useContext(MenuContext);

  return (
    <li className={cx("ss-menu__item", className)}>
      <button
        {...props}
        type="button"
        onClick={(event) => {
          onClick?.(event);
          context?.close();
        }}
      >
        {!!Icon && <Icon size={14} className="ss-menu__icon" />}
        <span>{label ?? props.children}</span>
      </button>
    </li>
  );
}

export function MenuItemSelectable({
  selected,
  defaultSelected,
  onClick,
  className,
  ...props
}: any) {
  const context = useContext(MenuContext);
  const [_selected, setSelected] = useState(!!(selected ?? defaultSelected));

  useEffect(() => {
    if (typeof selected === "boolean") {
      setSelected(selected);
    }
  }, [selected]);

  return (
    <li className={cx("ss-menu__item", className)}>
      <button
        {...props}
        type="button"
        onClick={(event) => {
          if (typeof selected !== "boolean") {
            setSelected((value) => !value);
          }
          onClick?.(event);
          context?.close();
        }}
      >
        <span className="ss-menu__select-indicator">{_selected ? "x" : ""}</span>
        <span>{props.label ?? props.children}</span>
      </button>
    </li>
  );
}

export function Modal({
  open,
  onRequestClose,
  onRequestSubmit,
  modalHeading,
  modalLabel,
  primaryButtonText = "Speichern",
  secondaryButtonText = "Abbrechen",
  primaryButtonDisabled,
  secondaryButtonDisabled,
  closeButtonLabel,
  shouldSubmitOnEnter,
  passiveModal,
  children,
  className,
  ...props
}: any) {
  const hasPrimaryAction = typeof onRequestSubmit === "function";

  useEffect(() => {
    if (!open) return;

    const listener = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onRequestClose?.();
      }

      if (event.key === "Enter" && hasPrimaryAction && shouldSubmitOnEnter && !primaryButtonDisabled) {
        onRequestSubmit?.();
      }
    };

    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [open, onRequestClose, onRequestSubmit, shouldSubmitOnEnter, primaryButtonDisabled, hasPrimaryAction]);

  useEffect(() => {
    if (!open || !ensureDomAvailable()) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;

  const node = (
    <div
      {...props}
      className={cx("ss-modal", "is-visible", className)}
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return;
        onRequestClose?.();
      }}
    >
      <div className="ss-modal-container" role="dialog" aria-modal="true">
        <header className="ss-modal-header">
          <div className="ss-modal-header__text">
            {!!modalLabel && <div className="ss-modal-label">{modalLabel}</div>}
            {!!modalHeading && <h3 className="ss-modal-heading">{modalHeading}</h3>}
          </div>

          <button
            type="button"
            className="ss-modal-close"
            aria-label={closeButtonLabel || "Schließen"}
            onClick={() => onRequestClose?.()}
          >
            <CloseIcon className="ss-modal-close__icon" />
          </button>
        </header>

        <div className="ss-modal-content">{children}</div>

        {!passiveModal && (
          <footer className="ss-modal-footer">
            <Button
              kind="secondary"
              disabled={secondaryButtonDisabled}
              onClick={() => onRequestClose?.()}
            >
              {secondaryButtonText}
            </Button>

            {hasPrimaryAction && (
              <Button
                kind="primary"
                disabled={primaryButtonDisabled}
                onClick={() => onRequestSubmit?.()}
              >
                {primaryButtonText}
              </Button>
            )}
          </footer>
        )}
      </div>
    </div>
  );

  if (!ensureDomAvailable()) return node;
  return createPortal(node, document.body);
}

export function Callout({ kind = "info", title, subtitle, className, renderIcon: Icon, children, ...props }: any) {

  return (
    <div
      {...props}
      className={cx("ss-inline-notification", `ss-inline-notification--${mapTagType(kind)}`, className)}
    >
      {!!Icon && (
        <span className="ss-inline-notification__icon" aria-hidden="true">
          <Icon size={15} />
        </span>
      )}

      <div className="ss-inline-notification__body">
        {!!title && <strong>{title}</strong>}
        {!!subtitle && <div>{subtitle}</div>}
        {children}
      </div>
    </div>
  );
}

export function InlineNotification({ kind = "info", title, subtitle, className, renderIcon: Icon, children, ...props }: any) {

  return (
    <div
      {...props}
      className={cx("ss-inline-notification", `ss-inline-notification--${mapTagType(kind)}`, className)}
    >
      {!!Icon && (
        <span className="ss-inline-notification__icon" aria-hidden="true">
          <Icon size={15} />
        </span>
      )}

      <div className="ss-inline-notification__body">
        {!!title && <strong>{title}</strong>}
        {!!subtitle && <div>{subtitle}</div>}
        {children}
      </div>
    </div>
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
  return <table {...props} className={cx("ss-data-table", isSortable && "is-sortable", className)} />;
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
  const sortIndicator = sortDirection === "ASC"
    ? "↑"
    : sortDirection === "DESC"
      ? "↓"
      : "";

  return (
    <th
      {...props}
      className={cx("ss-table-header", isSortable && "is-sortable", isSortHeader && "is-sorted", className)}
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

export function Pagination({
  totalItems = 0,
  page = 1,
  pageSize = 25,
  pageSizes = [25, 50, 100],
  onChange,
  backwardText = "Zurück",
  forwardText = "Weiter",
  itemsPerPageText = "Elemente pro Seite",
  itemRangeText,
  pageRangeText,
  className,
  ...props
}: any) {
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(page, 1), totalPages);
  const from = totalItems ? (safePage - 1) * pageSize + 1 : 0;
  const to = Math.min(totalItems, safePage * pageSize);

  const setPage = (nextPage: number) => {
    const bounded = Math.min(Math.max(nextPage, 1), totalPages);
    onChange?.({ page: bounded, pageSize });
  };

  return (
    <div {...props} className={cx("ss-pagination", "ss-pagination--md", className)}>
      <div className="ss-pagination__summary">
        {typeof itemRangeText === "function"
          ? itemRangeText(from, to, totalItems)
          : `${from}-${to} / ${totalItems}`}
      </div>

      <div className="ss-pagination__controls">
        <label className="ss-pagination__sizes">
          <span>{itemsPerPageText}</span>
          <select
            value={pageSize}
            onChange={(event) => {
              const nextSize = Number(event.target.value);
              onChange?.({ page: 1, pageSize: nextSize });
            }}
          >
            {pageSizes.map((size: number) => (
              <option key={size} value={size}>{size}</option>
            ))}
          </select>
        </label>

        <button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage <= 1}>
          {backwardText}
        </button>

        <span>
          {typeof pageRangeText === "function"
            ? pageRangeText(safePage, totalPages)
            : `${safePage} / ${totalPages}`}
        </span>

        <button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage >= totalPages}>
          {forwardText}
        </button>
      </div>
    </div>
  );
}
