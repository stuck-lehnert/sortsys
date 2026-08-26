import { Checkbox, ComboBox, DatePicker, FilterableMultiSelect, Form, Select, TextArea, TextInput } from "@sortsys/react-components";
import { SSForm as RuntimeSSForm } from "@sortsys/react-components/my-form";
import type { ComponentProps } from "react";
import { MyButton } from "./MyButton";
import type { BidirectionalMerge, PromiseOr } from "~/type-helpers";

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
}

export type MyPublicFormContext = MyFormContext;

type Suggestions<ItemT = Record<string, any> & { id: string | number }, PrepT = any> = {
  prepare?: () => PromiseOr<PrepT>;
  getItems: (props: { query: string; init: Awaited<PrepT> }) => PromiseOr<ItemT[]>;
  renderItem?: (props: { item: ItemT; init: Awaited<PrepT> }) => React.ReactNode;
  stringify: (props: { item: ItemT; init: Awaited<PrepT> }) => string;
};

type MyInputProps<ItemT = any, PrepT = any> = Omit<
  BidirectionalMerge<
    ComponentProps<typeof TextInput>,
    BidirectionalMerge<ComponentProps<typeof ComboBox>, ComponentProps<typeof TextArea>>
  >,
  "value" | "id"
> & {
  rules?: MyRule<string>[];
  onValueChange?: (value: string) => PromiseOr<void>;
  notifyLoaded?: (field: MyFormField<string>) => PromiseOr<void>;
  labelText: string;
  type?: string;
  id?: string;
} & ({
  suggestions?: Suggestions<ItemT, PrepT>;
  textArea?: false | null;
} | {
  suggestions?: undefined;
  textArea: true;
});

type MyCheckboxProps = Omit<ComponentProps<typeof Checkbox>, "id"> & {
  rules?: MyRule<boolean>[];
  onValueChange?: (value: boolean) => PromiseOr<void>;
};

type MySelectProps<T extends Record<string, any> & { id: string | number }> = Omit<
  ComponentProps<typeof Select>,
  "id" | "children" | "onChange" | "required"
> & {
  getOptions: () => Promise<T[]> | T[];
  getOptionsDeps?: any[];
  buildOption: (item: T) => Record<string, any>;
  labelText: string;
  rules?: MyRule<string | null>[];
  onValueChange?: (value: string) => PromiseOr<void>;
};

type MyMultiSelectProps<T extends Record<string, any> & { id: string | number }, PrepT = any> = Omit<
  ComponentProps<typeof FilterableMultiSelect<T>>,
  "id" | "titleText" | "items" | "itemToString" | "itemToElement" | "selectedItems" | "onChange" | "onInputValueChange" | "ref"
> & {
  name?: string;
  labelText: string;

  renderTile?: (item: T) => React.ReactNode;
  renderTileDisallowUndo?: boolean;

  minSelectedItems?: number;
  maxSelectedItems?: number;
  rules?: MyRule<T[]>[];

  prepare?: () => PromiseOr<PrepT>;
  getOptions: (props: { query: string; init: PrepT }) => PromiseOr<T[]>;
  renderItem: (props: { item: T; init: PrepT }) => React.ReactNode;
  stringifyItem?: (props: { item: T; init: PrepT }) => string;
  createAction?: MyMultiSelectCreateAction<T>;

  onValueChange?: (value: T[]) => void;
};

export type MyMultiSelectCreateAction<T> = {
    label?: React.ReactNode | ((props: { query: string }) => React.ReactNode);
    onCreate: (props: { query: string; select: (item: T) => void }) => PromiseOr<void>;
};

type MyDateInputProps = Omit<
  ComponentProps<typeof DatePicker>,
  "locale" | "datePickerType" | "value" | "onChange" | "dateFormat" | "children"
> & {
  id?: string;
  labelText: string;
  suffix?: React.ReactNode;
  required?: boolean;
  name?: string;

  rules?: MyRule<Date | null>[];
  disabled?: boolean;
  onValueChange?: (value: Date | null) => PromiseOr<void>;
};

type MySubmitButtonProps = Omit<ComponentProps<typeof MyButton>, "type">;

type MyInputComponent = (<ItemT = any, PrepT = any>(props: MyInputProps<ItemT, PrepT>) => React.ReactNode) & {
  rules: {
    required: MyRule<string>;
    pattern: (pattern: RegExp) => MyRule<string>;
    min: (min: number) => MyRule<string>;
    max: (max: number) => MyRule<string>;
    posint: MyRule<string>;
    posnum: MyRule<string>;
    int: MyRule<string>;
    num: MyRule<string>;
  };
};

type MyCheckboxComponent = ((props: MyCheckboxProps) => React.ReactNode) & {
  rules: {
    required: MyRule<boolean>;
  };
};

type MySelectComponent = (<T extends Record<string, any> & { id: string | number }>(props: MySelectProps<T>) => React.ReactNode) & {
  rules: {
    required: MyRule<any>;
  };
};

type MyMultiSelectComponent = (<T extends Record<string, any> & { id: string | number }, PrepT = any>(props: MyMultiSelectProps<T, PrepT>) => React.ReactNode) & {
  rules: {
    min: (min: number) => MyRule<any[]>;
    max: (max: number) => MyRule<any[]>;
  };
};

type MyDateInputComponent = ((props: MyDateInputProps) => React.ReactNode) & {
  rules: {
    required: MyRule<Date | null>;
  };
};

type MyFormComponent = ((props: Omit<ComponentProps<typeof Form>, "onSubmit"> & {
  formRef?: React.RefObject<MyPublicFormContext>;
  onSubmit?: (context: MyPublicFormContext) => Promise<void> | void;
  notifyLoaded?: (context: MyPublicFormContext) => Promise<void> | void;
}) => React.ReactNode) & {
  useContextRef: () => React.MutableRefObject<MyPublicFormContext>;
  $useContext: () => MyFormContext;
  Input: MyInputComponent;
  Checkbox: MyCheckboxComponent;
  Select: MySelectComponent;
  MultiSelect: MyMultiSelectComponent;
  DateInput: MyDateInputComponent;
  SubmitButton: (props: MySubmitButtonProps) => React.ReactNode;
};

export const MyForm = RuntimeSSForm as unknown as MyFormComponent;
