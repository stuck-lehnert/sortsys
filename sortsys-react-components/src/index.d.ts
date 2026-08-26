import * as React from "react";

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

export const Loading: React.ComponentType<any>;
export const InlineLoading: React.ComponentType<any>;
export const Heading: React.ComponentType<any>;

export const Button: React.ForwardRefExoticComponent<any>;
export const Tile: React.ComponentType<any>;
export const Content: React.ComponentType<any>;
export const SkipToContent: React.ComponentType<any>;

export const Header: React.ComponentType<any>;
export const HeaderGlobalBar: React.ComponentType<any>;
export const HeaderGlobalAction: React.ComponentType<any>;
export const HeaderMenuButton: React.ComponentType<any>;
export const HeaderName: React.ComponentType<any>;

export const SideNav: React.ComponentType<any>;
export const SideNavItems: React.ComponentType<any>;
export const SideNavDivider: React.ComponentType<any>;
export const SideNavLink: React.ForwardRefExoticComponent<any>;
export const SideNavItem: React.ForwardRefExoticComponent<any>;
export const SideNavMenu: React.ComponentType<any>;
export const SideNavMenuItem: React.ComponentType<any>;

export const Tag: React.ComponentType<any>;
export const OperationalTag: React.ComponentType<any>;

export const Tabs: React.ComponentType<any>;
export const TabList: React.ComponentType<any>;
export const Tab: React.ComponentType<any>;

export const Form: React.ComponentType<any>;
export const TextInput: React.ForwardRefExoticComponent<any>;
export const PasswordInput: React.ForwardRefExoticComponent<any>;
export const TextArea: React.ForwardRefExoticComponent<any>;
export const Checkbox: React.ForwardRefExoticComponent<any>;
export const Select: React.ForwardRefExoticComponent<any>;
export const SelectItem: React.ComponentType<any>;
export const ComboBox: React.ForwardRefExoticComponent<any>;
export const DatePicker: React.ComponentType<any>;
export const DatePickerInput: React.ComponentType<any>;
export const FilterableMultiSelect: React.ForwardRefExoticComponent<any>;
export const MultiSelect: React.ForwardRefExoticComponent<any>;

export const Menu: React.ForwardRefExoticComponent<any>;
export const MenuItem: React.ComponentType<any>;
export const MenuItemSelectable: React.ComponentType<any>;
export const Modal: React.ComponentType<any>;

export const Callout: React.ComponentType<any>;
export const InlineNotification: React.ComponentType<any>;

export const TableContainer: React.ComponentType<any>;
export const Table: React.ComponentType<any>;
export const TableHead: React.ComponentType<any>;
export const TableBody: React.ComponentType<any>;
export const TableRow: React.ComponentType<any>;
export const TableCell: React.ComponentType<any>;
export const TableHeader: React.ComponentType<any>;
export const DataTable: React.ComponentType<any>;
export const Pagination: React.ComponentType<any>;
