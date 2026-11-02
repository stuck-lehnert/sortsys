import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
} from "react";
import { Button, Toast } from "@heroui/react";

export type NotificationKind = "info" | "success" | "warning" | "danger";
export type NotificationDismissReason =
  | "action"
  | "close"
  | "programmatic"
  | "timeout";

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

export interface NotificationUpdate
  extends Partial<Omit<NotificationOptions, "id">> {}

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

type NotificationValue = Omit<
  NotificationOptions,
  "id" | "kind" | "duration"
> & {
  id: string;
  kind: NotificationKind;
  duration: number | null;
  revision: number;
};

type ActiveNotification = {
  key: string;
  value: NotificationValue;
  reason?: NotificationDismissReason;
  closing: boolean;
};

const DEFAULT_DURATIONS: Record<NotificationKind, number | null> = {
  info: 6_000,
  success: 4_500,
  warning: 8_000,
  danger: null,
};

const NotificationContext = createContext<NotificationApi | null>(null);
let fallbackNotificationId = 0;

function createNotificationId() {
  if (typeof crypto === "object" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  fallbackNotificationId += 1;
  return `notification-${Date.now().toString(36)}-${fallbackNotificationId.toString(36)}`;
}

function normalizeKind(kind: NotificationOptions["kind"]): NotificationKind {
  if (kind === "success" || kind === "warning" || kind === "danger") {
    return kind;
  }

  return "info";
}

function normalizeDuration(
  duration: number | null | undefined,
  fallback: number | null,
) {
  if (duration === null || duration === 0) {
    return null;
  }

  if (duration === undefined || !Number.isFinite(duration) || duration < 0) {
    return fallback;
  }

  return duration;
}

function UnpausedTimeout({
  notification,
  onDismiss,
}: {
  notification: NotificationValue;
  onDismiss: (id: string, reason: NotificationDismissReason) => void;
}) {
  const { id, duration, revision, pauseOnHover } = notification;

  useEffect(() => {
    if (pauseOnHover !== false || duration === null) {
      return;
    }

    // An explicit opt-out keeps running even while the toast region is paused.
    const timer = window.setTimeout(() => onDismiss(id, "timeout"), duration);
    return () => window.clearTimeout(timer);
  }, [id, duration, revision, pauseOnHover, onDismiss]);

  return null;
}

export function NotificationProvider({
  children,
  defaultDurations,
  maxVisible = 5,
  closeLabel = "Close notification",
  regionLabel = "Notifications",
}: NotificationProviderProps) {
  const durations = useMemo(
    () => ({
      ...DEFAULT_DURATIONS,
      ...defaultDurations,
    }),
    [defaultDurations],
  );
  const [queue] = useState(
    () =>
      new Toast.Queue<NotificationValue>({
        maxVisibleToasts: Math.max(1, maxVisible),
        exitDuration: 180,
      }),
  );
  const activeRef = useRef(new Map<string, ActiveNotification>());

  const finishDismissal = useCallback((id: string, key: string) => {
    const active = activeRef.current.get(id);
    if (!active || active.key !== key) {
      return;
    }

    activeRef.current.delete(id);
    active.value.onDismiss?.(active.reason ?? "timeout");
  }, []);

  const dismissWithReason = useCallback(
    (id: string, reason: NotificationDismissReason) => {
      const active = activeRef.current.get(id);
      if (!active || active.closing) {
        return;
      }

      active.reason = reason;
      active.closing = true;
      queue.close(active.key);
    },
    [queue],
  );

  const store = useCallback(
    (value: NotificationValue) => {
      const previous = activeRef.current.get(value.id);
      const timeout = value.pauseOnHover === false ? 0 : (value.duration ?? 0);
      if (previous) {
        previous.value = value;
        previous.reason = undefined;
        previous.closing = false;
        if (
          queue.update(previous.key, value, {
            timeout,
            onClose: () => finishDismissal(value.id, previous.key),
          })
        ) {
          return value.id;
        }
      }

      const key = queue.add(value, {
        timeout,
        onClose: () => finishDismissal(value.id, key),
      });
      activeRef.current.set(value.id, { key, value, closing: false });
      return value.id;
    },
    [queue, finishDismissal],
  );

  const push = useCallback(
    (options: NotificationOptions) => {
      const id = options.id || createNotificationId();
      const kind = normalizeKind(options.kind);
      return store({
        ...options,
        id,
        kind,
        duration: normalizeDuration(options.duration, durations[kind]),
        revision: (activeRef.current.get(id)?.value.revision ?? 0) + 1,
      });
    },
    [durations, store],
  );

  const update = useCallback(
    (id: string, patch: NotificationUpdate) => {
      const previous = activeRef.current.get(id)?.value;
      if (!previous) {
        return;
      }

      const kind = normalizeKind(patch.kind ?? previous.kind);
      store({
        ...previous,
        ...patch,
        id,
        kind,
        duration: Object.hasOwn(patch, "duration")
          ? normalizeDuration(patch.duration, durations[kind])
          : previous.duration,
        revision: previous.revision + 1,
      });
    },
    [durations, store],
  );

  const dismiss = useCallback(
    (id: string) => {
      dismissWithReason(id, "programmatic");
    },
    [dismissWithReason],
  );

  const clear = useCallback(() => {
    for (const id of activeRef.current.keys()) {
      dismissWithReason(id, "programmatic");
    }
  }, [dismissWithReason]);

  useEffect(
    () => () => {
      activeRef.current.clear();
      queue.destroy();
    },
    [queue],
  );

  const api = useMemo<NotificationApi>(
    () => ({
      push,
      info: (notification) => push({ ...notification, kind: "info" }),
      success: (notification) => push({ ...notification, kind: "success" }),
      warning: (notification) => push({ ...notification, kind: "warning" }),
      danger: (notification) => push({ ...notification, kind: "danger" }),
      update,
      dismiss,
      clear,
    }),
    [push, update, dismiss, clear],
  );

  return (
    <NotificationContext.Provider value={api}>
      {children}
      <Toast.Provider
        queue={queue}
        placement="bottom end"
        maxVisibleToasts={Math.max(1, maxVisible)}
        aria-label={regionLabel}
        width="min(28rem, calc(100vw - 2rem))"
      >
        {({ toast }) => {
          const notification = toast.content;
          const Icon = notification.renderIcon;
          const variant =
            notification.kind === "info" ? "accent" : notification.kind;

          return (
            <Toast toast={toast} variant={variant}>
              <UnpausedTimeout
                notification={notification}
                onDismiss={dismissWithReason}
              />
              <Toast.Indicator>{Icon && <Icon size={19} />}</Toast.Indicator>
              <Toast.Content>
                <Toast.Title>
                  {notification.title ?? notification.content}
                </Toast.Title>
                {notification.title && notification.content && (
                  <Toast.Description>{notification.content}</Toast.Description>
                )}
                {Boolean(notification.actions?.length) && (
                  <div className="flex flex-wrap gap-2 pt-2">
                    {notification.actions?.map((action, index) => (
                      <Button
                        key={index}
                        size="sm"
                        variant="secondary"
                        onPress={() => {
                          action.onClick();
                          if (action.closeOnClick !== false) {
                            dismissWithReason(notification.id, "action");
                          }
                        }}
                      >
                        {action.label}
                      </Button>
                    ))}
                  </div>
                )}
              </Toast.Content>
              {notification.closable !== false && (
                <Button
                  isIconOnly
                  size="sm"
                  variant="ghost"
                  aria-label={closeLabel}
                  onPress={() => dismissWithReason(notification.id, "close")}
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    aria-hidden="true"
                  >
                    <path
                      d="m4 4 8 8M12 4l-8 8"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                  </svg>
                </Button>
              )}
            </Toast>
          );
        }}
      </Toast.Provider>
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationApi {
  const notifications = useContext(NotificationContext);
  if (!notifications) {
    throw new Error(
      "useNotifications must be used inside NotificationProvider",
    );
  }

  return notifications;
}
