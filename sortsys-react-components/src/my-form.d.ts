import * as React from "react";

type PromiseOr<T> = Promise<T> | T;

export type MyRule<T> = (value: T) => string | null;

export interface MyFormField<T = any> {
  getValue: () => T;
  setValue: (value: T) => void;
  validate: () => PromiseOr<void>;
  hasError: () => boolean;
}

export interface MyPublicFormContext {
  loading: () => boolean;
  process: (action: (context: MyPublicFormContext) => PromiseOr<void>) => Promise<void>;
  field<T = any>(name: string): MyFormField<T> | null;
  setValues: (values: Record<string, any>) => void;
  getValues: () => Record<string, any>;
  validate: () => Promise<void>;
  hasError: () => boolean;
  submit: () => void;
}

export interface MyFormProps extends Omit<React.FormHTMLAttributes<HTMLFormElement>, "onSubmit"> {
  formRef?: React.RefObject<MyPublicFormContext>;
  onSubmit?: (context: MyPublicFormContext) => PromiseOr<void>;
  notifyLoaded?: (context: MyPublicFormContext) => PromiseOr<void>;
}

export interface MySuggestions<ItemT = any, PrepT = any> {
  prepare?: () => PromiseOr<PrepT>;
  getItems: (props: { query: string; init: Awaited<PrepT> }) => PromiseOr<ItemT[]>;
  renderItem?: (props: { item: ItemT; init: Awaited<PrepT> }) => React.ReactNode;
  stringify: (props: { item: ItemT; init: Awaited<PrepT> }) => string;
}

export interface MyInputProps<ItemT = any, PrepT = any> extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  id?: string;
  labelText: string;
  suffix?: React.ReactNode;
  textArea?: boolean;
  rules?: MyRule<string>[];
  required?: boolean;
  invalid?: boolean;
  invalidText?: React.ReactNode;
  onValueChange?: (value: string) => PromiseOr<void>;
  notifyLoaded?: (field: MyFormField<string>) => PromiseOr<void>;
  suggestions?: MySuggestions<ItemT, PrepT>;
}

export interface MyCheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  rules?: MyRule<boolean>[];
  required?: boolean;
  invalid?: boolean;
  invalidText?: React.ReactNode;
  onValueChange?: (value: boolean) => PromiseOr<void>;
}

export type MySelectItemLike = {
  id: string | number;
  [key: string]: any;
};

export interface MySelectProps<T extends MySelectItemLike = MySelectItemLike> extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "children"> {
  labelText: string;
  getOptions: () => PromiseOr<T[]>;
  getOptionsDeps?: any[];
  buildOption: (item: T) => {
    value?: string | number;
    text?: React.ReactNode;
    children?: React.ReactNode;
    [key: string]: any;
  };
  rules?: MyRule<string | null>[];
  invalid?: boolean;
  invalidText?: React.ReactNode;
  onValueChange?: (value: string) => PromiseOr<void>;
}

export type MyMultiSelectItemLike = {
  id: string | number;
  [key: string]: any;
};

export interface MyMultiSelectProps<T extends MyMultiSelectItemLike = MyMultiSelectItemLike, PrepT = any> extends React.HTMLAttributes<HTMLDivElement> {
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
  createAction?: {
    label?: React.ReactNode | ((props: { query: string }) => React.ReactNode);
    onCreate: (props: { query: string; select: (item: T) => void }) => PromiseOr<void>;
  };
  onValueChange?: (value: T[]) => void;
  invalid?: boolean;
  invalidText?: React.ReactNode;
  clearSelectionText?: string;
  clearSelectionDescription?: string;
  selectionFeedback?: string;
  disabled?: boolean;
}

export interface MyDateInputProps extends React.HTMLAttributes<HTMLDivElement> {
  id?: string;
  labelText: string;
  suffix?: React.ReactNode;
  required?: boolean;
  name?: string;
  rules?: MyRule<Date | null>[];
  disabled?: boolean;
  invalid?: boolean;
  invalidText?: React.ReactNode;
  allowInput?: boolean;
  onValueChange?: (value: Date | null) => PromiseOr<void>;
}

export interface MyInputRules {
  required: MyRule<string>;
  pattern: (pattern: RegExp) => MyRule<string>;
  min: (min: number) => MyRule<string>;
  max: (max: number) => MyRule<string>;
  posint: MyRule<string>;
  posnum: MyRule<string>;
  int: MyRule<string>;
  num: MyRule<string>;
}

export interface MyCheckboxRules {
  required: MyRule<boolean>;
}

export interface MySelectRules {
  required: MyRule<any>;
}

export interface MyMultiSelectRules {
  min: (min: number) => MyRule<any[]>;
  max: (max: number) => MyRule<any[]>;
}

export interface MyDateInputRules {
  required: MyRule<Date | null>;
}

export type MyInputComponent = React.ComponentType<MyInputProps<any, any>> & {
  rules: MyInputRules;
};

export type MyCheckboxComponent = React.ComponentType<MyCheckboxProps> & {
  rules: MyCheckboxRules;
};

export type MySelectComponent = React.ComponentType<MySelectProps<any>> & {
  rules: MySelectRules;
};

export type MyMultiSelectComponent = React.ComponentType<MyMultiSelectProps<any, any>> & {
  rules: MyMultiSelectRules;
};

export type MyDateInputComponent = React.ComponentType<MyDateInputProps> & {
  rules: MyDateInputRules;
};

export type MySubmitButtonComponent = (props: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  loading?: boolean;
  kind?: string;
  size?: string;
  renderIcon?: React.ComponentType<any>;
}) => React.ReactElement | null;

export type MyFormType = ((props: MyFormProps) => React.ReactElement | null) & {
  useContextRef: () => React.MutableRefObject<MyPublicFormContext>;
  $useContext: () => MyPublicFormContext;
  Input: MyInputComponent;
  Checkbox: MyCheckboxComponent;
  Select: MySelectComponent;
  MultiSelect: MyMultiSelectComponent;
  DateInput: MyDateInputComponent;
  SubmitButton: MySubmitButtonComponent;
};

export type SSPublicFormContext = MyPublicFormContext;
export type SSFormType = MyFormType;
export const SSForm: SSFormType;
export const MyForm: MyFormType;
