import {
  Checkbox,
  ComboBox,
  DatePicker,
  DatePickerInput,
  FilterableMultiSelect,
  Form,
  Select,
  SelectItem,
  TextArea,
  TextInput,
} from "./index.js";
import {
  createContext,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
  type ReactNode,
} from "react";
import { SSButton } from "./my-button.js";

type PromiseOr<T> = Promise<T> | T;

type MyRule<T> = (value: T) => string | null;

interface MyFormField<T = any> {
  getValue: () => T;
  setValue: (value: T) => void;

  validate: () => PromiseOr<void>;
  hasError: () => boolean;
}

interface MyFormContext {
  loading: () => boolean;
  process: (action: (context: MyFormContext) => PromiseOr<void>) => Promise<void>;

  field<T = any>(name: string): MyFormField<T> | null;

  setValues: (values: Record<string, any>) => void;
  getValues: () => Record<string, any>;

  validate: () => Promise<void>;
  hasError: () => boolean;

  submit: () => void;

  setField: (name: string, field: MyFormField) => void;
  delField: (name: string) => void;
}

export type MyPublicFormContext = Omit<MyFormContext, "setField" | "delField">;

const MyFormContext = createContext(null as unknown as MyFormContext);

function useRefState<T>(initialValue: T): [() => T, (value: T, rerender?: boolean) => void] {
  const ref = useRef(initialValue);
  const [, setTick] = useState(0);

  return [
    () => ref.current,
    (value, rerender) => {
      ref.current = value;
      if (rerender) {
        setTick((tick) => tick + 1);
      }
    },
  ];
}

function useLoading(): [() => boolean, (action: () => Promise<void> | void) => Promise<void>] {
  const [loading, setLoading] = useRefState(false);

  return [
    loading,
    async (action) => {
      if (loading()) return;
      setLoading(true, !loading());

      try {
        await action();
      } finally {
        setLoading(false, loading());
      }
    },
  ];
}

function NotifyLoaded({ onLoad }: { onLoad: () => PromiseOr<void> | void }) {
  const onLoadRef = useRef(onLoad);
  onLoadRef.current = onLoad;

  useEffect(() => {
    onLoadRef.current();
  }, []);

  return null;
}

function formatNumber(value: number): string {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

function normalizeNumberForField(value: number, inputType?: string) {
  if (!Number.isFinite(value)) return "";

  if (inputType === "number") {
    return `${value}`;
  }

  let text = formatNumber(value).replace(/\./g, "");
  while (text.endsWith("0")) {
    text = text.substring(0, text.length - 1);
  }
  if (text.endsWith(",")) {
    text = text.substring(0, text.length - 1);
  }

  return text;
}

function focusFirstInvalidField(root: HTMLFormElement | null) {
  const invalid = root?.querySelector<HTMLElement>(".is-invalid, .ss-field__error");
  if (!invalid) return;

  const target = invalid.matches("input, textarea, select, button, [tabindex]")
    ? invalid
    : invalid.closest(".ss-field, .ss-checkbox")?.querySelector<HTMLElement>("input, textarea, select, button, [tabindex]:not([tabindex='-1'])");

  target?.focus();
  target?.scrollIntoView({ block: "center", inline: "nearest" });
}

function formErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;

  return typeof document === "object" && document.documentElement.lang === "en"
    ? "The action could not be completed."
    : "Die Aktion konnte nicht ausgeführt werden.";
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

function toTextValue(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return `${node}`;
  if (Array.isArray(node)) return node.map(toTextValue).filter(Boolean).join(" ").trim();
  if (!isValidElement(node)) return "";
  return toTextValue((node as any).props?.children);
}

const MyForm: any = function forwardRef(_props: Omit<ComponentProps<typeof Form>, "onSubmit"> & {
  formRef?: RefObject<MyPublicFormContext>;
  onSubmit?: (context: MyPublicFormContext) => Promise<void> | void;
  notifyLoaded?: (context: MyPublicFormContext) => Promise<void> | void;
}) {
  const { children, formRef, onSubmit, notifyLoaded, ...props } = _props;

  const fieldsRef = useRef<Record<string, MyFormField>>({});
  const formElementRef = useRef<HTMLFormElement | null>(null);
  const [loading, process] = useLoading();
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const submissionErrorRef = useRef<HTMLDivElement | null>(null);

  const formContext: MyFormContext = {
    loading,
    process: (action) => process(() => action(formContext)),

    field: (name) => fieldsRef.current[name] ?? null,

    setValues: (values) => {
      Object.entries(values).forEach(([name, value]) => fieldsRef.current[name]?.setValue(value));
    },
    getValues: () => Object.fromEntries(Object.entries(fieldsRef.current).map(([name, field]) => [name, field.getValue()])),

    validate: () => Promise.all(Object.values(fieldsRef.current).map((field) => field.validate())).then(),
    hasError: () => Object.values(fieldsRef.current).some((field) => field.hasError()),

    submit: () => {
      process(async () => {
        setSubmissionError(null);

        try {
          await formContext.validate();
          if (formContext.hasError()) {
            requestAnimationFrame(() => focusFirstInvalidField(formElementRef.current));
            return;
          }
          await onSubmit?.(formContext);
        } catch (error) {
          setSubmissionError(formErrorMessage(error));
          requestAnimationFrame(() => submissionErrorRef.current?.focus());
        }
      });
    },

    setField: (name, field) => {
      fieldsRef.current[name] = field;
    },
    delField: (name) => {
      delete fieldsRef.current[name];
    },
  };

  if (formRef) {
    formRef.current = formContext;
  }

  return (
    <Form
      {...props}
      ref={formElementRef}
      style={{
        ...props.style,
        marginInline: "auto",
      }}
      className={`ss-smart-form ${props.className ?? ""}`}
      onKeyDown={(event: any) => {
        props.onKeyDown?.(event);
        if (event.defaultPrevented) return;
        if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
        event.preventDefault();
        formContext.submit();
      }}
      onSubmit={(event: any) => {
        event.preventDefault();
        formContext.submit();
      }}
    >
      <MyFormContext.Provider value={formContext}>
        {!!submissionError && <div ref={submissionErrorRef} className="ss-form-submit-error" role="alert" tabIndex={-1}>
          <span className="ss-form-submit-error__mark" aria-hidden="true">!</span>
          <span>{submissionError}</span>
        </div>}

        {children}
      </MyFormContext.Provider>

      {!!notifyLoaded && (
        <NotifyLoaded
          onLoad={() => {
            if (!notifyLoaded) return;
            process(() => notifyLoaded(formContext));
          }}
        />
      )}
    </Form>
  );
};

MyForm.useContextRef = function useContextRef() {
  return useRef<MyPublicFormContext>(null as any);
};

MyForm.$useContext = function $useContext() {
  return useContext(MyFormContext);
};

type Suggestions<ItemT = Record<string, any> & { id: string | number }, PrepT = any> = {
  prepare?: () => PromiseOr<PrepT>;
  getItems: (props: { query: string; init: Awaited<PrepT> }) => PromiseOr<ItemT[]>;
  renderItem?: (props: { item: ItemT; init: Awaited<PrepT> }) => ReactNode;
  stringify: (props: { item: ItemT; init: Awaited<PrepT> }) => string;
};

const MyInput = function<ItemT = any, PrepT = any>(_props: any) {
  const {
    id: _id,
    rules,
    onValueChange,
    notifyLoaded,
    required,
    suggestions,
    labelText: _labelText,
    suffix,
    type,
    textArea,
    ...props
  } = _props;
  const context = useContext(MyFormContext);

  const generatedId = useId();
  const id = _id || generatedId;

  let labelText = `${_labelText ?? ""}`.trim();
  if (required) {
    labelText += " *";
  }

  const [loading, process] = useLoading();
  const [value, setValue] = useRefState("");
  const [error, setError] = useRefState<string | null>(null);

  const field: MyFormField = {
    getValue: () => {
      const trimmed = value().trim();
      if (!trimmed) return null;
      return trimmed;
    },
    setValue: (newValue) => {
      if (typeof newValue === "number") {
        const text = normalizeNumberForField(newValue, type);
        setValue(text, value() !== text);
        return;
      }

      const mapped = `${newValue ?? ""}`;
      setValue(mapped, value() !== mapped);
    },

    validate: () => {
      let newError: string | null = null;

      const activeRules = [...(rules ?? [])];
      if (required) {
        activeRules.unshift(MyInput.rules.required);
      }

      for (const rule of activeRules) {
        newError = rule(value());
        if (newError) break;
      }

      setError(newError, error() !== newError);
    },
    hasError: () => !!error(),
  };

  useEffect(() => {
    const name = props.name;
    if (!name || !context) return;

    context.setField(name, field);
    return () => context.delField(name);
  }, [props.name]);

  const preparedRef = useRef({
    finished: false,
    data: null as any,
    version: 0,
  });

  const [suggItems, setSuggItems] = useState<any[]>([]);

  useEffect(() => {
    if (!suggestions) {
      preparedRef.current.finished = true;
      preparedRef.current.data = null;
      setSuggItems([]);
      return;
    }

    preparedRef.current.finished = false;
    preparedRef.current.data = null;
    preparedRef.current.version += 1;
    const version = preparedRef.current.version;

    (async () => suggestions.prepare?.())()
      .then((data) => {
        if (preparedRef.current.version !== version) return;
        preparedRef.current.data = data;
      })
      .finally(() => {
        if (preparedRef.current.version !== version) return;
        preparedRef.current.finished = true;
      });
  }, [suggestions]);

  const query = value().trim().toLowerCase();
  useEffect(() => {
    setSuggItems([]);
    if (!suggestions || !query || !preparedRef.current.finished) return;

    const timeout = setTimeout(async () => {
      const items = await suggestions.getItems({ query, init: preparedRef.current.data });
      setSuggItems(items);
    }, 250);

    return () => clearTimeout(timeout);
  }, [query, suggestions]);

  const suggInit = preparedRef.current.data;

  const InputComponent = textArea ? TextArea : TextInput;

  return (
    <>
      {!suggestions ? (
        <InputComponent
          id={id}
          {...props}
          labelText={labelText}
          suffix={suffix}
          value={value()}
          onChange={(event: any) => {
            const newValue = event.target.value;
            setValue(newValue, value() !== newValue);
            onValueChange?.(newValue);
          }}
          invalidText={props.invalidText || error()}
          invalid={props.invalid || !!error()}
          disabled={props.disabled || context?.loading() || loading()}
          autoComplete={props.autoComplete ?? "off"}
          type={type}
        />
      ) : (
        <ComboBox
          id={id}
          {...props}
          titleText={labelText}
          allowCustomValue
          value={value()}
          invalidText={props.invalidText || error()}
          invalid={props.invalid || !!error()}
          disabled={props.disabled || context?.loading() || loading()}
          autoComplete={props.autoComplete ?? "off"}
          items={suggItems}
          onInputChange={(newValue: any) => {
            setValue(newValue, value() !== newValue);
            onValueChange?.(newValue);
          }}
          itemToString={(item: any) => (item ? suggestions.stringify({ init: suggInit, item }) : "")}
          itemToElement={(item: any) => {
            if (suggestions.renderItem) {
              return suggestions.renderItem({ init: suggInit, item });
            }

            return suggestions.stringify({ init: suggInit, item });
          }}
        />
      )}

      {!!notifyLoaded && (
        <NotifyLoaded
          onLoad={() => {
            if (!notifyLoaded) return;
            process(() => notifyLoaded(field));
          }}
        />
      )}
    </>
  );
};

MyInput.rules = {
  required: (value: string) => (value.trim() ? null : "Pflichtfeld"),
  pattern: (pattern: RegExp) => (value: string) =>
    value.trim() && !pattern.test(value) ? "Eingabe entspricht nicht dem erwarteten Muster" : null,
  min: (min: number) => (value: string) => (value.length >= min ? null : `Mindestens ${min} Zeichen`),
  max: (max: number) => (value: string) => (value.length <= max ? null : `Maximal ${max} Zeichen`),
  posint: (value: string) =>
    value.trim() && !/^[0-9]+$/.test(value.trim()) ? "Eingabe muss eine Ganzzahl >= 0 sein" : null,
  posnum: (value: string) =>
    value.trim() && !/^[0-9]+([\,\.][0-9]+)?$/.test(value.trim()) ? "Eingabe muss eine Zahl >= 0 sein" : null,
  int: (value: string) => value.trim() && !/^\-?[0-9]+$/.test(value.trim()) ? "Eingabe muss eine Ganzzahl sein" : null,
  num: (value: string) =>
    value.trim() && !/^\-?[0-9]+([\,\.][0-9]+)?$/.test(value.trim()) ? "Eingabe muss eine Zahl sein" : null,
};

const MySubmitButton = (props: any) => {
  const context = useContext(MyFormContext);

  return (
    <SSButton
      {...props}
      type="submit"
      loading={context.loading() || props.loading}
      disabled={context.loading() || props.disabled}
    />
  );
};

const MyCheckbox = function(_props: any) {
  const { rules, required, onValueChange, ...props } = _props;
  const context = useContext(MyFormContext);

  const id = useId();

  const [value, setValue] = useRefState(false);
  const [error, setError] = useRefState<string | null>(null);

  const field: MyFormField = {
    getValue: () => value(),
    setValue: (newValue) => setValue(!!newValue, value() !== !!newValue),
    validate: () => {
      let newError: string | null = null;

      const activeRules = [...(rules ?? [])];
      if (required) {
        activeRules.unshift(MyCheckbox.rules.required);
      }

      for (const rule of activeRules) {
        newError = rule(value());
        if (newError) break;
      }

      setError(newError, error() !== newError);
    },
    hasError: () => !!error(),
  };

  useEffect(() => {
    const name = props.name;
    if (!name || !context) return;

    context.setField(name, field);
    return () => context.delField(name);
  }, [props.name]);

  return (
    <Checkbox
      id={id}
      {...props}
      checked={value()}
      onChange={(event: any) => {
        const newValue = event.target.checked;
        setValue(newValue, value() !== newValue);
        onValueChange?.(newValue);
      }}
      invalid={props.invalid || !!error()}
      invalidText={props.invalidText || error()}
      disabled={props.disabled || context.loading()}
    />
  );
};

MyCheckbox.rules = {
  required: (value: boolean) => (value ? null : "Pflichtfeld"),
};

const MySelect = function(_props: any) {
  const {
    getOptions,
    getOptionsDeps,
    buildOption,
    rules,
    onValueChange,
    ...props
  } = _props;
  const context = useContext(MyFormContext);

  const id = useId();

  const [options, setOptions] = useRefState<any[] | null>(null);
  const [value, setValue] = useRefState<string | null>(null);
  const [error, setError] = useRefState<string | null>(null);

  useEffect(() => {
    const result = getOptions();

    const handleResult = (newOptions: any[]) => {
      setOptions(newOptions, true);

      if (!newOptions.length) {
        setValue(null, true);
        return;
      }

      const built = newOptions.map(buildOption);
      const newValues = built
        .map(({ value: optionValue }: any) => optionValue)
        .filter((entry: any) => typeof entry === "string" || typeof entry === "number")
        .map((entry: any) => `${entry}`);

      const currentValue = value();
      if (currentValue !== null && newValues.includes(currentValue)) return;

      setValue(newValues[0] ?? null, true);
    };

    if (("then" in result && typeof result.then === "function") || result instanceof Promise) {
      result.then(handleResult);
    } else {
      handleResult(result);
    }
  }, getOptionsDeps ?? []);

  const field: MyFormField = {
    getValue: () => value(),
    setValue: (newValue) => setValue(newValue, value() !== newValue),
    validate: () => {
      let newError: string | null = null;

      const activeRules = [...(rules ?? [])];

      for (const rule of activeRules) {
        newError = rule(value());
        if (newError) break;
      }

      setError(newError, error() !== newError);
    },
    hasError: () => !!error(),
  };

  useEffect(() => {
    const name = props.name;
    if (!name || !context) return;

    context.setField(name, field);
    return () => context.delField(name);
  }, [props.name]);

  return (
    <Select
      id={id}
      {...props}
      value={value() ?? undefined}
      onChange={(event: any) => {
        const newValue = event.target.value;
        setValue(newValue, value() !== newValue);
        onValueChange?.(newValue);
      }}
      invalid={props.invalid || !!error()}
      invalidText={props.invalidText || error()}
      disabled={props.disabled || context.loading()}
    >
      {options()?.map((option) => (
        <SelectItem key={option.id} {...buildOption(option)} />
      ))}
    </Select>
  );
};

MySelect.rules = {
  required: (value: any) => (value ? null : "Pflichtfeld"),
};

const MyMultiSelect = function(_props: any) {
  const {
    name: _name,
    labelText: _labelText,
    prepare,
    getOptions,
    renderItem,
    minSelectedItems,
    maxSelectedItems,
    rules,
    renderTile,
    renderTileDisallowUndo,
    stringifyItem: stringifyItemCustom,
    createAction,
    onValueChange,
    ...props
  } = _props;
  const context = useContext(MyFormContext);

  const id = useId();

  let labelText = `${_labelText ?? ""}`.trim();
  if (minSelectedItems) {
    labelText += " *";
  }

  const [options, setOptions] = useState<any[]>([]);
  const [value, setValue] = useRefState<any[]>([]);
  const [error, setError] = useRefState<string | null>(null);
  const [query, setQuery] = useRefState("");

  const preparedRef = useRef({
    finished: false,
    data: null as any,
    version: 0,
  });

  useEffect(() => {
    preparedRef.current.finished = false;
    preparedRef.current.data = null;
    preparedRef.current.version += 1;
    const version = preparedRef.current.version;

    (async () => prepare?.())()
      .then((data) => {
        if (preparedRef.current.version !== version) return;
        preparedRef.current.data = data;
      })
      .finally(() => {
        if (preparedRef.current.version !== version) return;
        preparedRef.current.finished = true;
      });
  }, [prepare]);

  const normalizedQuery = query().trim().toLowerCase();

  const isSelectableAutocompleteItem = (item: any) => {
    if (!item || typeof item !== "object") return true;

    if (
      item.archivedAt != null
      || item.archived_at != null
      || item.archivedSince != null
      || item.archived_since != null
    ) {
      return false;
    }

    if (item.finishedAt != null || item.finished_at != null) {
      return false;
    }

    return true;
  };

  useEffect(() => {
    setOptions(!normalizedQuery ? value() : []);
    if (!normalizedQuery || !preparedRef.current.finished) return;

    const timeout = setTimeout(async () => {
      const items = await getOptions({ query: normalizedQuery, init: preparedRef.current.data });
      setOptions((items ?? []).filter(isSelectableAutocompleteItem).slice(0, 20));
    }, 250);

    return () => clearTimeout(timeout);
  }, [normalizedQuery]);

  useEffect(() => {
    if (!normalizedQuery) {
      setOptions(value());
    }
  }, [value()]);

  const field: MyFormField = {
    getValue: () => value(),
    setValue: (newValue) => setValue(newValue, value() !== newValue),
    validate: () => {
      let newError: string | null = null;

      const activeRules = [...(rules ?? [])];
      if (minSelectedItems) {
        activeRules.unshift(MyMultiSelect.rules.min(minSelectedItems));
      }
      if (maxSelectedItems) {
        activeRules.unshift(MyMultiSelect.rules.max(maxSelectedItems));
      }

      for (const rule of activeRules) {
        newError = rule(value());
        if (newError) break;
      }

      setError(newError, error() !== newError);
    },
    hasError: () => !!error(),
  };

  useEffect(() => {
    const name = _name;
    if (!name || !context) return;

    context.setField(name, field);
    return () => context.delField(name);
  }, [_name]);

  const init = preparedRef.current.data;

  const stringifyItem = (item: any) => {
    if (item == null) return "";

    const custom = stringifyItemCustom?.({ item, init });
    if (typeof custom === "string" || typeof custom === "number") {
      return `${custom}`;
    }

    if (typeof item === "string" || typeof item === "number") return `${item}`;

    const direct = item.label ?? item.name ?? item.title ?? item.text ?? item.value;
    if (typeof direct === "string" || typeof direct === "number") return `${direct}`;

    const fromRendered = toTextValue(renderItem({ item, init })).trim();
    if (fromRendered) return fromRendered;

    if (item.id != null) return `${item.id}`;
    return "";
  };

  const hasExactOption = !!normalizedQuery && options.some(item => stringifyItem(item).trim().toLowerCase() === normalizedQuery);
  const visibleCreateAction = !!normalizedQuery && !hasExactOption && typeof createAction?.onCreate === "function"
    ? createAction
    : null;

  const selectCreatedItem = (item: any) => {
    if (!item) return;

    const current = value();
    const nextBase = current.filter((entry: any) => {
      if (entry?.id != null || item?.id != null) return entry?.id !== item?.id;
      return stringifyItem(entry) !== stringifyItem(item);
    });
    const next = maxSelectedItems === 1 ? [item] : [...nextBase, item];

    setValue(next, true);
    onValueChange?.(next);
    setQuery("", query() !== "");
    setOptions(next);
  };

  if (maxSelectedItems === 1 && value().length && renderTile) {
    return (
      <div>
        <span className="ss-label">{labelText}</span>

        <div className="ss-single-select-preview">
          <div className="ss-single-select-preview__item">{renderTile(value()[0])}</div>

          {!renderTileDisallowUndo && (
            <SSButton
              kind="ghost"
              size="sm"
              renderIcon={CloseIcon}
              aria-label="Auswahl entfernen"
              title="Auswahl entfernen"
              onClick={() => {
                setValue([], true);
                onValueChange?.([]);
              }}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <FilterableMultiSelect
      id={id}
      {...props}
      titleText={labelText}
      selectedItems={value()}
      onInputValueChange={(newValue: any) => {
        const normalized = (typeof newValue === "string"
          ? newValue
          : (newValue?.inputValue ?? "")
        ).trim().toLowerCase();

        setQuery(normalized, normalized !== query());
      }}
      onChange={({ selectedItems }: any) => {
        const next = selectedItems ?? [];
        setValue(next, true);
        onValueChange?.(next);
      }}
      items={options}
      createActionLabel={visibleCreateAction
        ? (typeof visibleCreateAction.label === "function"
          ? ({ query: rawQuery }: any) => visibleCreateAction.label({ query: `${rawQuery ?? ""}`.trim() })
          : visibleCreateAction.label ?? `Neu erstellen: ${query()}`)
        : undefined}
      onCreateAction={visibleCreateAction
        ? (rawQuery: string) => visibleCreateAction.onCreate({
          query: `${rawQuery ?? ""}`.trim(),
          select: selectCreatedItem,
        })
        : undefined}
      disabled={props.disabled || context.loading()}
      invalid={props.invalid || !!error()}
      invalidText={props.invalidText || error()}
      itemToString={stringifyItem}
      itemToElement={(item: any) => renderItem({ item, init })}
      sortItems={(items: any) => items as any}
      filterItems={(items: any) => items as any}
      clearSelectionText={props.clearSelectionText || "Auswahl zurücksetzen"}
      clearSelectionDescription={props.clearSelectionDescription || "Auswahl zurücksetzen"}
      selectionFeedback={props.selectionFeedback ?? "top-after-reopen"}
    />
  );
};

MyMultiSelect.rules = {
  min: (min: number) => (items: any[]) =>
    items.length < min
      ? `Mindestens ${min !== 1 ? `${min} Elemente müssen` : `ein Element muss`} ausgewählt werden`
      : null,
  max: (max: number) => (items: any[]) =>
    items.length > max
      ? `Maximal ${max !== 1 ? `${max} Elemente dürfen` : `ein Element darf`} ausgewählt werden`
      : null,
};

function SingleDatePickerField({
  id,
  labelText,
  value,
  disabled,
  invalid,
  invalidText,
  allowInput,
  suffix,
  onValueChange,
  children,
  ...props
}: any) {
  return (
    <DatePicker
      {...props}
      locale="de"
      datePickerType="single"
      value={value ?? undefined}
      onChange={(date: any) => {
        const next = Array.isArray(date) ? (date.length ? date[0] : null) : (date ?? null);
        onValueChange?.(next);
      }}
      dateFormat="d.m.Y"
      invalid={invalid}
      invalidText={invalidText}
      allowInput={allowInput ?? false}
    >
      <DatePickerInput
        id={id}
        labelText={labelText}
        suffix={suffix}
        pattern=""
        disabled={disabled}
        invalid={invalid}
        invalidText={invalidText}
      />

      {children}
    </DatePicker>
  );
}

const MyDateInput = function(_props: any) {
  const {
    id: _id,
    labelText: _labelText,
    rules,
    required,
    suffix,
    disabled,
    ...props
  } = _props;
  const context = useContext(MyFormContext);

  const generatedId = useId();
  const id = _id || generatedId;

  let labelText = `${_labelText ?? ""}`.trim();
  if (required) {
    labelText += " *";
  }

  const [value, setValue] = useRefState<Date | null>(null);
  const [error, setError] = useRefState<string | null>(null);

  const field: MyFormField = {
    getValue: () => value(),
    setValue: (newValue) => {
      if (!newValue) {
        setValue(null, value() !== null);
      } else if (newValue instanceof Date) {
        setValue(newValue, true);
      } else if (typeof newValue === "number" || typeof newValue === "string") {
        setValue(new Date(newValue), true);
      }
    },

    validate: () => {
      let newError: string | null = null;

      const activeRules = [...(rules ?? [])];
      if (required) {
        activeRules.unshift(MyDateInput.rules.required);
      }

      for (const rule of activeRules) {
        newError = rule(value());
        if (newError) break;
      }

      setError(newError, error() !== newError);
    },
    hasError: () => !!error(),
  };

  useEffect(() => {
    const name = props.name;
    if (!name || !context) return;

    context.setField(name, field);
    return () => context.delField(name);
  }, [props.name]);

  return (
    <SingleDatePickerField
      {...props}
      id={id}
      labelText={labelText}
      value={value()}
      disabled={disabled}
      invalid={props.invalid || !!error()}
      invalidText={props.invalidText || error()}
      allowInput={props.allowInput ?? false}
      suffix={suffix ?? (!required ? (
        <SSButton
          kind="ghost"
          size="sm"
          className="ss-date-input-clear"
          title="Datum leeren"
          aria-label="Datum leeren"
          disabled={disabled}
          onClick={() => setValue(null, value() !== null)}
        >
          <CloseIcon size={11} />
        </SSButton>
      ) : null)}
      onValueChange={(next: Date | null) => {
        setValue(next, true);
        props.onValueChange?.(next);
      }}
    />
  );
};

MyDateInput.rules = {
  required: (date: Date | null) => (!date ? "Pflichtfeld" : null),
};

MyForm.Input = MyInput;
MyForm.Checkbox = MyCheckbox;
MyForm.Select = MySelect;
MyForm.MultiSelect = MyMultiSelect;
MyForm.DateInput = MyDateInput;
MyForm.SubmitButton = MySubmitButton;

export const SSForm = MyForm;
export type SSPublicFormContext = MyPublicFormContext;
export { MyForm };
