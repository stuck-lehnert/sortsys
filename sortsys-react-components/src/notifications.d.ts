import type { ComponentType, ReactNode } from "react";

export type NotificationKind = "info" | "success" | "warning" | "danger";
export type NotificationDismissReason = "action" | "close" | "programmatic" | "timeout";

export type NotificationIcon = ComponentType<{
  size?: number;
  className?: string;
  color?: string;
}>;

export interface NotificationAction {
  label: ReactNode;
  onClick: () => void;
  closeOnClick?: boolean;
}

export interface NotificationOptions {
  id?: string;
  kind?: NotificationKind;
  title?: ReactNode;
  content?: ReactNode;
  duration?: number | null;
  closable?: boolean;
  pauseOnHover?: boolean;
  actions?: NotificationAction[];
  renderIcon?: NotificationIcon;
  onDismiss?: (reason: NotificationDismissReason) => void;
}

export interface NotificationUpdate extends Partial<Omit<NotificationOptions, "id">> {}

export interface NotificationApi {
  push: (notification: NotificationOptions) => string;
  info: (notification: Omit<NotificationOptions, "kind">) => string;
  success: (notification: Omit<NotificationOptions, "kind">) => string;
  warning: (notification: Omit<NotificationOptions, "kind">) => string;
  danger: (notification: Omit<NotificationOptions, "kind">) => string;
  update: (id: string, notification: NotificationUpdate) => void;
  dismiss: (id: string) => void;
  clear: () => void;
}

export interface NotificationProviderProps {
  children: ReactNode;
  defaultDurations?: Partial<Record<NotificationKind, number | null>>;
  maxVisible?: number;
  closeLabel?: string;
  regionLabel?: string;
}

export function NotificationProvider(props: NotificationProviderProps): ReactNode;
export function useNotifications(): NotificationApi;
