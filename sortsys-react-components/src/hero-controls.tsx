import { controlText } from "./hero-utils.js";
import type { FilterableMultiSelectProps } from "./control-types.js";
import { ComboBoxStateContext } from "react-aria-components/ComboBox";
import React, {
  Children,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  Alert,
  Button as HeroButton,
  Checkbox as HeroCheckbox,
  Chip,
  ComboBox as HeroComboBox,
  Description,
  FieldError,
  Form as HeroForm,
  Input,
  Label,
  ListBox,
  Modal as HeroModal,
  Select as HeroSelect,
  Tabs as HeroTabs,
  TextArea as HeroTextArea,
  TextField,
  Tag as HeroTag,
  TagGroup,
} from "@heroui/react";

const DialogFieldsContext = createContext(false);

function useFieldAutoFocus(autoFocus?: boolean) {
  const isDialogField = useContext(DialogFieldsContext);

  return Boolean(autoFocus) && !isDialogField;
}

// Keep DOM focus in the input so typing and screen-reader announcements retain
// the same active descendant as arrow navigation. Tab leaves at either end.
const AutocompleteInput = forwardRef<
  HTMLInputElement,
  React.ComponentProps<typeof Input>
>(function AutocompleteInput({ onKeyDownCapture, ...props }, ref) {
  const state = useContext(ComboBoxStateContext);
  return (
    <Input
      {...props}
      ref={ref}
      onKeyDownCapture={(event) => {
        onKeyDownCapture?.(event);
        if (
          event.defaultPrevented ||
          event.key !== "Tab" ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          event.nativeEvent.isComposing ||
          !state?.isOpen
        )
          return;
        const keys = [...state.collection.getKeys()].filter(
          (key) =>
            state.collection.getItem(key)?.type === "item" &&
            !state.selectionManager.isDisabled(key),
        );
        if (!keys.length) return;
        const current = keys.indexOf(state.selectionManager.focusedKey!);
        const next =
          current < 0
            ? event.shiftKey
              ? keys.length - 1
              : 0
            : current + (event.shiftKey ? -1 : 1);
        event.stopPropagation();
        if (next >= 0 && next < keys.length) {
          event.preventDefault();
          state.selectionManager.setFocusedKey(keys[next]!);
        } else {
          // React Aria normally commits the highlighted result on Tab. Leaving
          // the results must neither select a value nor invoke a create action.
          state.selectionManager.setFocusedKey(null);
          state.close();
        }
      }}
    />
  );
});

// These adapters preserve the existing form and route contracts. HeroUI owns
// keyboard interaction, focus management, validation semantics and overlays.
function classes(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}

function optionText(item: unknown): string {
  if (item == null) {
    return "";
  }

  if (typeof item === "string" || typeof item === "number") {
    return String(item);
  }

  if (typeof item === "object") {
    const fields = item as Record<string, unknown>;
    return optionText(
      fields.label ??
        fields.name ??
        fields.title ??
        fields.text ??
        fields.value ??
        fields.id,
    );
  }

  return "";
}

function itemKey(item: unknown, toText: (item: any) => string): string {
  if (item && typeof item === "object" && "id" in item && item.id != null) {
    return String(item.id);
  }

  return toText(item);
}

export const Button = forwardRef<HTMLButtonElement, any>(function Button(
  {
    kind = "primary",
    size = "md",
    renderIcon: Icon,
    loading,
    disabled,
    children,
    className,
    ...props
  },
  ref,
) {
  const variants = {
    primary: "primary",
    secondary: "secondary",
    tertiary: "outline",
    ghost: "ghost",
    danger: "danger",
    "danger--ghost": "danger-soft",
    "danger--tertiary": "danger-soft",
  } as const;
  const variant = variants[kind as keyof typeof variants] ?? "secondary";
  const contents = Children.toArray(children);
  const hasText = Boolean(controlText(children).trim());
  const isIconOnly = !hasText && (Boolean(Icon) || contents.length > 0);

  return (
    <HeroButton
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      variant={variant}
      size={size === "sm" || size === "lg" ? size : "md"}
      isDisabled={disabled || loading}
      isPending={Boolean(loading)}
      isIconOnly={isIconOnly}
      aria-busy={loading || undefined}
      className={classes("ss-btn", className)}
    >
      {loading && (
        <span className="ss-spinner ss-spinner--small" aria-hidden="true" />
      )}
      {!loading && Icon && <Icon size={18} aria-hidden="true" />}
      {children}
    </HeroButton>
  );
});

export const Form = forwardRef<HTMLFormElement, any>(function Form(props, ref) {
  return (
    <HeroForm
      {...props}
      ref={ref}
      className={classes("ss-form", props.className)}
    />
  );
});

export const TextInput = forwardRef<HTMLInputElement, any>(function TextInput(
  {
    labelText,
    helperText,
    invalid,
    invalidText,
    suffix,
    className,
    inputClassName,
    id,
    disabled,
    required,
    value,
    defaultValue,
    "aria-label": ariaLabel,
    ...props
  },
  ref,
) {
  const fieldAutoFocus = useFieldAutoFocus(props.autoFocus);
  const generatedId = useId();

  return (
    <TextField
      variant="secondary"
      id={id ?? generatedId}
      value={value}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      isInvalid={Boolean(invalid)}
      isDisabled={disabled}
      isRequired={required}
      className={classes(
        "ss-field min-w-0 w-full",
        invalid && "is-invalid",
        className,
      )}
    >
      {labelText && <Label>{labelText}</Label>}
      <div className="flex min-w-0 w-full items-center gap-2">
        <Input
          {...props}
          autoFocus={fieldAutoFocus}
          ref={ref}
          className={classes("min-w-0 w-full flex-1", inputClassName)}
        />
        {suffix && <span className="shrink-0">{suffix}</span>}
      </div>
      {helperText && <Description>{helperText}</Description>}
      {invalid && invalidText && (
        <FieldError className="ss-field__error">{invalidText}</FieldError>
      )}
    </TextField>
  );
});

export const PasswordInput = forwardRef<HTMLInputElement, any>(
  function PasswordInput(props, ref) {
    return <TextInput {...props} ref={ref} type="password" />;
  },
);

export const TextArea = forwardRef<HTMLTextAreaElement, any>(function TextArea(
  {
    labelText,
    helperText,
    invalid,
    invalidText,
    className,
    inputClassName,
    id,
    disabled,
    required,
    value,
    defaultValue,
    "aria-label": ariaLabel,
    rows = 4,
    ...props
  },
  ref,
) {
  const fieldAutoFocus = useFieldAutoFocus(props.autoFocus);
  const generatedId = useId();

  return (
    <TextField
      variant="secondary"
      id={id ?? generatedId}
      value={value}
      defaultValue={defaultValue}
      aria-label={ariaLabel}
      isInvalid={Boolean(invalid)}
      isDisabled={disabled}
      isRequired={required}
      className={classes(
        "ss-field min-w-0 w-full",
        invalid && "is-invalid",
        className,
      )}
    >
      {labelText && <Label>{labelText}</Label>}
      <HeroTextArea
        {...props}
        autoFocus={fieldAutoFocus}
        ref={ref}
        rows={rows}
        className={inputClassName}
      />
      {helperText && <Description>{helperText}</Description>}
      {invalid && invalidText && (
        <FieldError className="ss-field__error">{invalidText}</FieldError>
      )}
    </TextField>
  );
});

export const Checkbox = forwardRef<HTMLInputElement, any>(function Checkbox(
  {
    labelText,
    invalid,
    invalidText,
    className,
    children,
    checked,
    defaultChecked,
    disabled,
    required,
    onChange,
    ...props
  },
  ref,
) {
  const fieldAutoFocus = useFieldAutoFocus(props.autoFocus);
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <HeroCheckbox
      variant="secondary"
      {...props}
      autoFocus={fieldAutoFocus}
      inputRef={(input) => {
        inputRef.current = input;
        if (typeof ref === "function") {
          ref(input);
        } else if (ref) {
          ref.current = input;
        }
      }}
      isSelected={checked}
      defaultSelected={defaultChecked}
      isDisabled={disabled}
      isRequired={required}
      isInvalid={Boolean(invalid)}
      className={classes("ss-checkbox", className)}
      onChange={(next) => {
        const input = inputRef.current;
        if (input) {
          input.checked = next;
          onChange?.({ target: input, currentTarget: input });
        }
      }}
    >
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        <Label>{labelText ?? children}</Label>
      </HeroCheckbox.Content>
      {invalid && invalidText && (
        <FieldError className="ss-field__error">{invalidText}</FieldError>
      )}
    </HeroCheckbox>
  );
});

export function SelectItem({ text, children, ...props }: any) {
  return <option {...props}>{text ?? children}</option>;
}

export const Select = forwardRef<HTMLButtonElement, any>(function Select(
  {
    labelText,
    hideLabel = false,
    triggerClassName,
    helperText,
    invalid,
    invalidText,
    suffix,
    className,
    id,
    children,
    value,
    defaultValue,
    disabled,
    required,
    onChange,
    ...props
  },
  ref,
) {
  const fieldAutoFocus = useFieldAutoFocus(props.autoFocus);
  const generatedId = useId();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const options = Children.toArray(children)
    .filter(isValidElement)
    .map((child) => {
      const option = child.props as {
        value?: string | number;
        text?: string;
        children?: React.ReactNode;
        disabled?: boolean;
      };
      const text = option.text ?? option.children;
      return {
        id: String(option.value ?? text ?? ""),
        text,
        disabled: option.disabled,
      };
    });
  const selected =
    value === undefined ? (internalValue ?? options[0]?.id) : value;

  return (
    <HeroSelect
      variant="secondary"
      {...props}
      autoFocus={fieldAutoFocus}
      id={id ?? generatedId}
      value={selected == null ? null : String(selected)}
      onChange={(key) => {
        const next = key == null ? "" : String(key);
        setInternalValue(next);
        onChange?.({ target: { value: next }, currentTarget: { value: next } });
      }}
      isDisabled={disabled}
      isRequired={required}
      isInvalid={Boolean(invalid)}
      className={classes(
        "ss-field min-w-0 w-full",
        invalid && "is-invalid",
        className,
      )}
    >
      {labelText && (
        <Label className={hideLabel ? "sr-only" : undefined}>{labelText}</Label>
      )}
      <div className="flex min-w-0 w-full items-center gap-2">
        <HeroSelect.Trigger
          ref={ref}
          className={classes("min-w-0 flex-1", triggerClassName)}
        >
          <HeroSelect.Value />
          <HeroSelect.Indicator />
        </HeroSelect.Trigger>
        {suffix && <span className="shrink-0">{suffix}</span>}
      </div>
      <HeroSelect.Popover>
        <ListBox
          aria-label={typeof labelText === "string" ? labelText : undefined}
        >
          {options.map((option) => (
            <ListBox.Item
              className="pe-8"
              key={option.id}
              id={option.id}
              textValue={
                typeof option.text === "string" ? option.text : option.id
              }
              isDisabled={option.disabled}
            >
              <div className="min-w-0 flex-1 break-words">{option.text}</div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroSelect.Popover>
      {helperText && <Description>{helperText}</Description>}
      {invalid && invalidText && (
        <FieldError className="ss-field__error">{invalidText}</FieldError>
      )}
    </HeroSelect>
  );
});

function autocompleteText(german: string, english: string) {
  return typeof document === "object" && document.documentElement.lang === "en"
    ? english
    : german;
}

function AutocompleteLoading({ clearable = false }: { clearable?: boolean }) {
  return (
    <span
      role="status"
      aria-label={autocompleteText(
        "Vorschläge werden geladen …",
        "Loading suggestions …",
      )}
      className={classes(
        "pointer-events-none absolute top-1/2 flex size-8 -translate-y-1/2",
        "items-center justify-center",
        clearable ? "end-16" : "end-8",
      )}
    >
      <span className="ss-spinner ss-spinner--small" aria-hidden="true" />
    </span>
  );
}

function AutocompleteEmpty({
  loading,
  failed,
  query,
}: {
  loading?: boolean;
  failed?: boolean;
  query: string;
}) {
  const message = loading
    ? autocompleteText("Vorschläge werden geladen …", "Loading suggestions …")
    : failed
      ? autocompleteText(
          "Vorschläge konnten nicht geladen werden.",
          "Suggestions could not be loaded.",
        )
      : query
        ? autocompleteText("Keine Treffer.", "No results.")
        : autocompleteText("Suchbegriff eingeben.", "Type to search.");

  return (
    <p
      role={loading ? "status" : undefined}
      aria-label={loading ? message : undefined}
      className="px-3 py-2 text-sm text-muted"
    >
      {message}
    </p>
  );
}

export const ComboBox = forwardRef<HTMLInputElement, any>(function ComboBox(
  {
    titleText,
    helperText,
    items = [],
    itemToString = optionText,
    itemToElement,
    onInputChange,
    onChange,
    value,
    className,
    id,
    invalid,
    invalidText,
    disabled,
    placeholder,
    autoFocus,
    allowCustomValue,
    selectedItem,
    loading = false,
    loadError = false,
    ...props
  },
  ref,
) {
  const fieldAutoFocus = useFieldAutoFocus(autoFocus);
  const [internalValue, setInternalValue] = useState("");
  const singleOptions = items.filter(
    (item: unknown, index: number, values: unknown[]) =>
      values.findIndex(
        (candidate) =>
          itemKey(candidate, itemToString) === itemKey(item, itemToString),
      ) === index,
  );

  return (
    <HeroComboBox
      variant="secondary"
      {...props}
      id={id}
      allowsCustomValue
      allowsEmptyCollection
      aria-busy={loading}
      menuTrigger="focus"
      inputValue={value === undefined ? internalValue : String(value ?? "")}
      onInputChange={(next) => {
        setInternalValue(next);
        onInputChange?.(next);
      }}
      onChange={(key) => {
        const selectedItem = singleOptions.find(
          (item: unknown) => itemKey(item, itemToString) === String(key),
        );
        onChange?.({ selectedItem: selectedItem ?? null });
      }}
      isDisabled={disabled}
      isInvalid={Boolean(invalid)}
      className={classes(
        "ss-field ss-combobox min-w-0 w-full",
        invalid && "is-invalid",
        className,
      )}
    >
      {titleText && <Label>{titleText}</Label>}
      <HeroComboBox.InputGroup>
        <AutocompleteInput
          ref={ref}
          placeholder={placeholder}
          autoFocus={fieldAutoFocus}
          className={loading ? "pe-18" : "pe-10"}
        />
        {loading && <AutocompleteLoading />}
        <HeroComboBox.Trigger className="w-8 pe-0" />
      </HeroComboBox.InputGroup>
      <HeroComboBox.Popover>
        <ListBox
          aria-busy={loading}
          renderEmptyState={() => (
            <AutocompleteEmpty
              loading={loading}
              failed={loadError}
              query={value === undefined ? internalValue : String(value ?? "")}
            />
          )}
        >
          {singleOptions.map((item: unknown) => (
            <ListBox.Item
              className="pe-8"
              key={itemKey(item, itemToString)}
              id={itemKey(item, itemToString)}
              textValue={itemToString(item)}
            >
              <div className="min-w-0 flex-1 break-words">
                {itemToElement ? itemToElement(item) : itemToString(item)}
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </HeroComboBox.Popover>
      {helperText && <Description>{helperText}</Description>}
      {invalid && invalidText && (
        <FieldError className="ss-field__error">{invalidText}</FieldError>
      )}
    </HeroComboBox>
  );
});

export function FilterableMultiSelect<T = unknown>({
  titleText,
  items = [],
  selectedItems = [],
  onChange,
  onInputValueChange,
  itemToElement,
  itemToString = optionText,
  createActionLabel,
  onCreateAction,
  invalid,
  invalidText,
  disabled,
  autoFocus,
  className,
  id,
  name,
  required,
  readOnly,
  helperText,
  clearSelectionText,
  clearSelectionDescription: _clearDescription,
  selectionFeedback: _selectionFeedback,
  loading = false,
  loadError = false,
  sortItems,
  filterItems,
  ref,
  ...inputProps
}: FilterableMultiSelectProps<T>) {
  const fieldAutoFocus = useFieldAutoFocus(autoFocus);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generatedId = useId();
  const createId = `__sortsys_create_${generatedId}`;
  const createLabel =
    typeof createActionLabel === "function"
      ? createActionLabel({ query })
      : createActionLabel;
  const selectedOptions = selectedItems.filter(
    (item, index, values) =>
      values.findIndex(
        (candidate) =>
          itemKey(candidate, itemToString) === itemKey(item, itemToString),
      ) === index,
  );
  const allItems = [...selectedOptions, ...items].filter(
    (item, index, collection) =>
      collection.findIndex(
        (candidate) =>
          itemKey(candidate, itemToString) === itemKey(item, itemToString),
      ) === index,
  );

  const filteredItems = filterItems ? filterItems([...allItems]) : allItems;
  const visibleItems = sortItems
    ? sortItems([...filteredItems])
    : filteredItems;

  const clearable = selectedOptions.length > 0 && Boolean(clearSelectionText);
  const inputPadding =
    clearable && loading ? "pe-26" : clearable || loading ? "pe-18" : "pe-10";

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <HeroComboBox<object, "multiple">
        variant="secondary"
        ref={ref}
        id={id}
        name={name}
        isRequired={required}
        isReadOnly={readOnly}
        selectionMode="multiple"
        // getOptions/filterItems may match descriptions or other fields that
        // are absent from the label. Do not filter those results a second time.
        defaultFilter={filterItems ? () => true : undefined}
        allowsCustomValue
        allowsEmptyCollection
        aria-busy={loading}
        menuTrigger="focus"
        inputValue={query}
        onInputChange={(next) => {
          setQuery(next);
          onInputValueChange?.(next);
        }}
        value={selectedOptions.map((item: unknown) =>
          itemKey(item, itemToString),
        )}
        onChange={(keys) => {
          if (keys.includes(createId)) {
            onCreateAction?.(query);
            return;
          }

          onChange?.({
            selectedItems: allItems.filter((item) =>
              keys.includes(itemKey(item, itemToString)),
            ),
          });
        }}
        isDisabled={disabled}
        isInvalid={Boolean(invalid)}
        className={classes(
          "ss-field ss-multi-select min-w-0 w-full",
          invalid && "is-invalid",
          className,
        )}
      >
        {titleText && <Label>{titleText}</Label>}
        <HeroComboBox.InputGroup>
          <AutocompleteInput
            {...inputProps}
            ref={inputRef}
            autoFocus={fieldAutoFocus}
            className={inputPadding}
            onFocus={(event) => {
              inputProps.onFocus?.(event);
            }}
          />
          {selectedOptions.length > 0 && clearSelectionText && (
            <HeroButton
              type="button"
              slot={null}
              variant="ghost"
              size="sm"
              isIconOnly
              aria-label={clearSelectionText}
              className={[
                "absolute end-8 top-1/2 m-0 size-8 min-w-0 -translate-y-1/2",
                "rounded-full p-0",
              ].join(" ")}
              isDisabled={disabled || readOnly}
              onPress={() => {
                onChange?.({ selectedItems: [] });
                setQuery("");
                onInputValueChange?.("");
                inputRef.current?.focus();
              }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="m4 4 8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </HeroButton>
          )}
          {loading && <AutocompleteLoading clearable={clearable} />}
          <HeroComboBox.Trigger className="w-8 pe-0" />
        </HeroComboBox.InputGroup>
        {helperText && <Description>{helperText}</Description>}
        <HeroComboBox.Popover>
          <ListBox
            aria-busy={loading}
            renderEmptyState={() => (
              <AutocompleteEmpty
                loading={loading}
                failed={loadError}
                query={query}
              />
            )}
          >
            {visibleItems.map((item) => (
              <ListBox.Item
                className="pe-8"
                key={itemKey(item, itemToString)}
                id={itemKey(item, itemToString)}
                textValue={itemToString(item)}
              >
                <div className="min-w-0 flex-1 break-words">
                  {itemToElement ? itemToElement(item) : itemToString(item)}
                </div>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
            {onCreateAction && (
              <ListBox.Item
                id={createId}
                textValue={controlText(createLabel)}
                className="bg-accent-soft font-medium text-accent-soft-foreground"
                data-create-option
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 16 16"
                  fill="none"
                  className="shrink-0"
                  aria-hidden="true"
                >
                  <path
                    d="M8 3v10M3 8h10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
                {createLabel}
              </ListBox.Item>
            )}
          </ListBox>
        </HeroComboBox.Popover>
        {invalid && invalidText && (
          <FieldError className="ss-field__error">{invalidText}</FieldError>
        )}
      </HeroComboBox>
      {selectedOptions.length > 0 && (
        <TagGroup
          aria-label={
            controlText(titleText) || autocompleteText("Auswahl", "Selection")
          }
          size="sm"
          variant="surface"
          onRemove={
            disabled || readOnly
              ? undefined
              : (keys) => {
                  onChange?.({
                    selectedItems: selectedOptions.filter(
                      (item) => !keys.has(itemKey(item, itemToString)),
                    ),
                  });
                }
          }
        >
          <TagGroup.List className="flex max-w-full flex-wrap gap-1.5">
            {selectedOptions.map((item) => (
              <HeroTag
                key={itemKey(item, itemToString)}
                id={itemKey(item, itemToString)}
                textValue={itemToString(item)}
                className="max-w-full rounded-full"
              >
                <span className="min-w-0 truncate">{itemToString(item)}</span>
                <HeroTag.RemoveButton
                  aria-label={autocompleteText("Entfernen", "Remove")}
                />
              </HeroTag>
            ))}
          </TagGroup.List>
        </TagGroup>
      )}
    </div>
  );
}

export const MultiSelect = FilterableMultiSelect;

export function Tabs({
  selectedIndex,
  onChange,
  selectedKey,
  onSelectionChange,
  className,
  children,
  ...props
}: any) {
  return (
    <HeroTabs
      {...props}
      selectedKey={
        selectedIndex === undefined ? selectedKey : String(selectedIndex)
      }
      onSelectionChange={(key) => {
        onSelectionChange?.(key);
        onChange?.({ selectedIndex: Number(key) });
      }}
      className={classes("ss-tabs w-full min-w-0", className)}
    >
      {children}
    </HeroTabs>
  );
}

export function TabList({ children, className, ...props }: any) {
  return (
    <HeroTabs.ListContainer className="max-w-full">
      <HeroTabs.List
        {...props}
        className={classes("ss-tab-list max-w-full overflow-x-auto", className)}
      >
        {Children.map(children, (child, index) => {
          if (!isValidElement<Record<string, unknown>>(child)) {
            return child;
          }

          return <Tab {...child.props} id={child.props.id ?? String(index)} />;
        })}
      </HeroTabs.List>
    </HeroTabs.ListContainer>
  );
}

export function Tab({ children, className, ...props }: any) {
  return (
    <HeroTabs.Tab
      {...props}
      className={classes(
        "w-auto shrink-0 text-foreground data-[hovered=true]:text-foreground",
        className,
      )}
    >
      {children}
      <HeroTabs.Indicator />
    </HeroTabs.Tab>
  );
}

export function Tag({
  type = "neutral",
  size = "md",
  children,
  className,
  ...props
}: any) {
  const colors = {
    red: "danger",
    green: "success",
    yellow: "warning",
    orange: "warning",
    blue: "accent",
    purple: "accent",
    magenta: "accent",
    cyan: "accent",
    teal: "accent",
  } as const;
  const color = colors[type as keyof typeof colors] ?? "default";

  return (
    <Chip
      {...props}
      color={color}
      size={size === "sm" ? "sm" : "md"}
      variant="soft"
      className={className}
    >
      <Chip.Label>{children}</Chip.Label>
    </Chip>
  );
}

export function OperationalTag({
  renderIcon: Icon,
  text,
  onClick,
  ...props
}: any) {
  if (onClick) {
    return (
      <Button kind="ghost" size="sm" onClick={onClick} {...props}>
        {Icon && <Icon size={16} aria-hidden="true" />}
        {text}
      </Button>
    );
  }

  return (
    <Tag {...props}>
      <span className="inline-flex items-center gap-1 whitespace-nowrap">
        {Icon && <Icon size={16} aria-hidden="true" />}
        {text}
      </span>
    </Tag>
  );
}

export function Callout({
  kind = "info",
  title,
  subtitle,
  className,
  renderIcon: Icon,
  children,
  ...props
}: any) {
  const status =
    kind === "error" || kind === "danger"
      ? "danger"
      : kind === "warning"
        ? "warning"
        : kind === "success"
          ? "success"
          : "accent";

  return (
    <Alert
      {...props}
      status={status}
      role={props.role ?? (status === "danger" ? "alert" : "status")}
      className={classes("ss-notice", className)}
      data-kind={status}
    >
      <Alert.Indicator>
        {Icon && <Icon size={18} aria-hidden="true" />}
      </Alert.Indicator>
      <Alert.Content>
        {title && <Alert.Title>{title}</Alert.Title>}
        {(subtitle || children) && (
          <Alert.Description>
            {subtitle}
            {children}
          </Alert.Description>
        )}
      </Alert.Content>
    </Alert>
  );
}

export const InlineNotification = Callout;

function ModalFocusRestoration() {
  const [returnFocusTo] = useState(() =>
    typeof document === "undefined" ? null : document.activeElement,
  );

  useEffect(() => {
    if (!(returnFocusTo instanceof HTMLElement)) {
      return;
    }

    const ownerDocument = returnFocusTo.ownerDocument;

    return () => {
      // Wait for the overlay's passive cleanup to release inert. React Aria's
      // restore frame can run before that cleanup and silently lose focus.
      queueMicrotask(() => {
        if (
          ownerDocument.activeElement === ownerDocument.body &&
          returnFocusTo.isConnected &&
          !returnFocusTo.closest("[inert]")
        ) {
          returnFocusTo.focus({ preventScroll: true });
        }
      });
    };
  }, [returnFocusTo]);

  return null;
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
  primaryButtonLoading,
  secondaryButtonDisabled,
  closeButtonLabel = "Schließen",
  shouldSubmitOnEnter = true,
  passiveModal,
  edgeToEdge = false,
  size = "lg",
  placement = "auto",
  danger,
  children,
  className,
  "data-fullheight": fullHeight,
  "data-fullwidth": fullWidth,
  ...props
}: any) {
  const headingId = useId();
  const isFullHeight = fullHeight === true || fullHeight === "true";
  const isFullWidth = fullWidth === true || fullWidth === "true";
  const isFullScreen = Boolean(edgeToEdge) && isFullHeight && isFullWidth;
  const hasPrimaryAction = typeof onRequestSubmit === "function";
  const closeTrigger = (
    <HeroModal.CloseTrigger
      aria-label={closeButtonLabel}
      className={
        isFullScreen
          ? "static order-3 m-0 min-h-0 min-w-0 self-center justify-self-end " +
            "rounded-full p-0 outline-offset-[-2px]"
          : undefined
      }
    />
  );

  return (
    <DialogFieldsContext.Provider value={true}>
      <HeroModal.Backdrop
        {...props}
        isOpen={Boolean(open)}
        onOpenChange={(next) => {
          if (!next) {
            onRequestClose?.();
          }
        }}
        data-fullheight={isFullHeight || undefined}
        data-fullwidth={isFullWidth || undefined}
        data-editor-fullscreen={isFullScreen || undefined}
        className={classes("ss-modal", className)}
      >
        <HeroModal.Container
          placement={isFullScreen ? "center" : placement}
          size={
            isFullScreen ? "full" : isFullHeight && isFullWidth ? "cover" : size
          }
          scroll="inside"
          className={classes(
            "ss-modal-container",
            isFullWidth && "w-full sm:w-full",
            isFullScreen ? "p-0" : isFullHeight && "p-2 sm:p-4",
          )}
        >
          <HeroModal.Dialog
            className={classes(
              isFullHeight && "h-full",
              isFullWidth && "max-w-none",
              isFullScreen && "gap-0 rounded-none p-0 shadow-none",
            )}
            aria-labelledby={modalHeading ? headingId : undefined}
            aria-label={!modalHeading ? modalLabel || "Dialog" : undefined}
          >
            <ModalFocusRestoration />
            <div
              className="contents"
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.defaultPrevented ||
                  event.nativeEvent.isComposing ||
                  event.repeat ||
                  !shouldSubmitOnEnter ||
                  !hasPrimaryAction ||
                  primaryButtonDisabled ||
                  primaryButtonLoading
                ) {
                  return;
                }

                const target = event.target;
                if (!(
                  target instanceof HTMLInputElement ||
                  target instanceof HTMLSelectElement
                )) {
                  return;
                }

                if (
                  target instanceof HTMLInputElement &&
                  [
                    "button",
                    "checkbox",
                    "file",
                    "radio",
                    "range",
                    "reset",
                    "submit",
                  ].includes(target.type)
                ) {
                  return;
                }

                // Enter accepts an open autocomplete option; it must not also save.
                if (target.getAttribute("aria-expanded") === "true") {
                  return;
                }

                const dialogs = document.querySelectorAll(
                  "[data-slot='modal-dialog']",
                );
                const dialog = event.currentTarget.closest(
                  "[data-slot='modal-dialog']",
                );
                if (dialogs[dialogs.length - 1] !== dialog) {
                  return;
                }

                event.preventDefault();
                onRequestSubmit();
              }}
            >
              <HeroModal.Header
                className={classes(
                  "ss-modal-header min-w-0 gap-1 pr-8",
                  isFullScreen &&
                    "relative grid h-11 shrink-0 " +
                      "grid-cols-[minmax(0,1fr)_minmax(0,3fr)_minmax(0,1fr)] " +
                      "items-center gap-2 px-1 py-0",
                )}
              >
                {(modalLabel || isFullScreen) && (
                  <p
                    className={classes(
                      "ss-modal-label m-0 text-xs leading-snug text-muted",
                      isFullScreen ? "truncate" : "break-words",
                    )}
                  >
                    {modalLabel}
                  </p>
                )}
                {modalHeading && (
                  <HeroModal.Heading
                    id={headingId}
                    title={
                      typeof modalHeading === "string"
                        ? modalHeading
                        : undefined
                    }
                    className={classes(
                      "ss-modal-heading m-0 text-lg leading-snug",
                      isFullScreen
                        ? "min-w-0 truncate text-center"
                        : "break-words",
                    )}
                  >
                    {modalHeading}
                  </HeroModal.Heading>
                )}
                {isFullScreen && closeTrigger}
              </HeroModal.Header>
              <HeroModal.Body
                className={classes(
                  "ss-modal-content min-h-0",
                  isFullHeight && "flex-1",
                  isFullScreen &&
                    "m-0 flex w-full flex-col overflow-hidden p-0",
                )}
              >
                {children}
              </HeroModal.Body>
              {!passiveModal && (
                <HeroModal.Footer>
                  <Button
                    kind="secondary"
                    disabled={secondaryButtonDisabled}
                    onClick={() => onRequestClose?.()}
                  >
                    {secondaryButtonText}
                  </Button>
                  {hasPrimaryAction && (
                    <Button
                      kind={danger ? "danger" : "primary"}
                      disabled={primaryButtonDisabled}
                      loading={primaryButtonLoading}
                      onClick={onRequestSubmit}
                    >
                      {primaryButtonText}
                    </Button>
                  )}
                </HeroModal.Footer>
              )}
              {!isFullScreen && closeTrigger}
            </div>
          </HeroModal.Dialog>
        </HeroModal.Container>
      </HeroModal.Backdrop>
    </DialogFieldsContext.Provider>
  );
}
