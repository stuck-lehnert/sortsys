import type { InputHTMLAttributes, ReactNode, RefAttributes } from "react";

export interface FilterableMultiSelectProps<T>
  extends Omit<
      InputHTMLAttributes<HTMLInputElement>,
      "onChange" | "value" | "defaultValue" | "size"
    >,
    RefAttributes<HTMLDivElement> {
  titleText?: ReactNode;
  helperText?: ReactNode;
  items?: T[];
  selectedItems?: T[];
  onChange?: (selection: { selectedItems: T[] }) => void;
  onInputValueChange?: (query: string) => void;
  itemToString?: (item: T) => string;
  itemToElement?: (item: T) => ReactNode;
  createActionLabel?: ReactNode | ((input: { query: string }) => ReactNode);
  onCreateAction?: (query: string) => void | Promise<void>;
  invalid?: boolean;
  invalidText?: ReactNode;
  clearSelectionText?: string;
  clearSelectionDescription?: string;
  selectionFeedback?: string;
  loading?: boolean;
  loadError?: boolean;
  sortItems?: (items: T[]) => T[];
  filterItems?: (items: T[]) => T[];
}
