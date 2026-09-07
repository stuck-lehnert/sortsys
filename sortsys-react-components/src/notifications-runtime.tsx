import React, {
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
import { createPortal } from "react-dom";

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

type StoredNotification = Omit<NotificationOptions, "id" | "kind" | "duration"> & {
  id: string;
  kind: NotificationKind;
  duration: number | null;
  revision: number;
  state: "visible" | "leaving";
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
  if (kind === "success" || kind === "warning" || kind === "danger") return kind;
  return "info";
}

function normalizeDuration(duration: number | null | undefined, fallback: number | null) {
  if (duration === null || duration === 0) return null;
  if (duration === undefined) return fallback;
  if (!Number.isFinite(duration) || duration < 0) return fallback;
  return duration;
}

function NotificationSymbol({ kind }: { kind: NotificationKind }) {
  if (kind === "success") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 10.3 3.6 3.6L16 5.8" /></svg>;
  }

  if (kind === "warning") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 2.5 18 17H2L10 2.5Z" /><path d="M10 7v4.5M10 14.2v.2" /></svg>;
  }

  if (kind === "danger") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 5.8v5.5M10 14.2v.2" /></svg>;
  }

  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 5.8v.2" /></svg>;
}

function NotificationCloseIcon() {
  return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3 13 13M13 3 3 13" /></svg>;
}

function NotificationToast({
  notification,
  closeLabel,
  onDismiss,
}: {
  notification: StoredNotification;
  closeLabel: string;
  onDismiss: (id: string, reason: NotificationDismissReason) => void;
}) {
  const timeoutRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const remainingRef = useRef(notification.duration ?? 0);
  const [paused, setPaused] = useState(false);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current === null) return;

    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = null;
  }, []);

  const startTimer = useCallback(() => {
    if (notification.duration === null || remainingRef.current <= 0) return;

    clearTimer();
    startedAtRef.current = Date.now();
    timeoutRef.current = window.setTimeout(() => {
      timeoutRef.current = null;
      onDismiss(notification.id, "timeout");
    }, remainingRef.current);
  }, [clearTimer, notification.duration, notification.id, onDismiss]);

  useEffect(() => {
    remainingRef.current = notification.duration ?? 0;
    setPaused(false);

    if (notification.duration !== null) startTimer();
    return clearTimer;
  }, [clearTimer, notification.duration, notification.revision, startTimer]);

  const pauseTimer = () => {
    if (notification.duration === null || timeoutRef.current === null) return;

    remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
    clearTimer();
    setPaused(true);
  };

  const resumeTimer = () => {
    if (notification.duration === null || !paused) return;

    setPaused(false);
    startTimer();
  };

  const Icon = notification.renderIcon;
  const role = notification.kind === "danger" ? "alert" : "status";

  return (
    <section
      className={`ss-notification ss-notification--${notification.kind}`}
      data-state={notification.state}
      data-paused={paused || undefined}
      role={role}
      aria-live={role === "alert" ? "assertive" : "polite"}
      aria-atomic="true"
      onMouseEnter={notification.pauseOnHover === false ? undefined : pauseTimer}
      onMouseLeave={notification.pauseOnHover === false ? undefined : resumeTimer}
      onFocusCapture={notification.pauseOnHover === false ? undefined : pauseTimer}
      onBlurCapture={(event) => {
        if (notification.pauseOnHover === false) return;
        if (event.currentTarget.contains(event.relatedTarget)) return;
        resumeTimer();
      }}
    >
      <div className="ss-notification__accent" aria-hidden="true" />

      <span className="ss-notification__icon" aria-hidden="true">
        {Icon ? <Icon size={19} /> : <NotificationSymbol kind={notification.kind} />}
      </span>

      <div className="ss-notification__body">
        {!!notification.title && <div className="ss-notification__title">{notification.title}</div>}
        {!!notification.content && <div className="ss-notification__content">{notification.content}</div>}

        {!!notification.actions?.length && (
          <div className="ss-notification__actions">
            {notification.actions.map((action, index) => (
              <button
                key={index}
                type="button"
                onClick={() => {
                  action.onClick();
                  if (action.closeOnClick !== false) onDismiss(notification.id, "action");
                }}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {notification.closable !== false && (
        <button
          type="button"
          className="ss-notification__close"
          aria-label={closeLabel}
          onClick={() => onDismiss(notification.id, "close")}
        >
          <NotificationCloseIcon />
        </button>
      )}

      {notification.duration !== null && (
        <span
          key={notification.revision}
          className="ss-notification__timer"
          aria-hidden="true"
          style={{ animationDuration: `${notification.duration}ms` }}
        />
      )}
    </section>
  );
}

export function NotificationProvider({
  children,
  defaultDurations,
  maxVisible = 5,
  closeLabel = "Close notification",
  regionLabel = "Notifications",
}: NotificationProviderProps) {
  const durations = useMemo(() => ({
    ...DEFAULT_DURATIONS,
    ...defaultDurations,
  }), [defaultDurations]);
  const [notifications, setNotifications] = useState<StoredNotification[]>([]);
  const notificationsRef = useRef<StoredNotification[]>([]);
  const dismissTimersRef = useRef(new Map<string, number>());
  const dismissCallbacksRef = useRef(new Map<string, NotificationOptions["onDismiss"]>());

  notificationsRef.current = notifications;

  const finishDismissal = useCallback((id: string, reason: NotificationDismissReason) => {
    setNotifications(current => current.filter(notification => notification.id !== id));

    const callback = dismissCallbacksRef.current.get(id);
    dismissCallbacksRef.current.delete(id);
    dismissTimersRef.current.delete(id);
    callback?.(reason);
  }, []);

  const dismissWithReason = useCallback((id: string, reason: NotificationDismissReason) => {
    const found = notificationsRef.current.some(notification => (
      notification.id === id && notification.state !== "leaving"
    ));

    if (!found || dismissTimersRef.current.has(id)) return;

    setNotifications(current => current.map(notification => {
      if (notification.id !== id || notification.state === "leaving") return notification;

      return { ...notification, state: "leaving" };
    }));

    const timer = window.setTimeout(() => finishDismissal(id, reason), 180);
    dismissTimersRef.current.set(id, timer);
  }, [finishDismissal]);

  const push = useCallback((options: NotificationOptions) => {
    const id = options.id || createNotificationId();
    const kind = normalizeKind(options.kind);

    const pendingDismissal = dismissTimersRef.current.get(id);
    if (pendingDismissal !== undefined) {
      window.clearTimeout(pendingDismissal);
      dismissTimersRef.current.delete(id);
    }

    dismissCallbacksRef.current.set(id, options.onDismiss);
    setNotifications(current => {
      const existing = current.find(notification => notification.id === id);
      const next: StoredNotification = {
        ...options,
        id,
        kind,
        duration: normalizeDuration(options.duration, durations[kind]),
        revision: (existing?.revision ?? 0) + 1,
        state: "visible",
      };

      if (!existing) return [...current, next];
      return current.map(notification => notification.id === id ? next : notification);
    });

    return id;
  }, [durations]);

  const update = useCallback((id: string, patch: NotificationUpdate) => {
    const pendingDismissal = dismissTimersRef.current.get(id);
    if (pendingDismissal !== undefined) {
      window.clearTimeout(pendingDismissal);
      dismissTimersRef.current.delete(id);
    }

    setNotifications(current => current.map(notification => {
      if (notification.id !== id) return notification;

      const kind = normalizeKind(patch.kind ?? notification.kind);
      const duration = Object.hasOwn(patch, "duration")
        ? normalizeDuration(patch.duration, durations[kind])
        : notification.duration;

      if (Object.hasOwn(patch, "onDismiss")) {
        dismissCallbacksRef.current.set(id, patch.onDismiss);
      }

      return {
        ...notification,
        ...patch,
        id,
        kind,
        duration,
        revision: notification.revision + 1,
        state: "visible",
      };
    }));
  }, [durations]);

  const dismiss = useCallback((id: string) => {
    dismissWithReason(id, "programmatic");
  }, [dismissWithReason]);

  const clear = useCallback(() => {
    for (const notification of notificationsRef.current) {
      dismissWithReason(notification.id, "programmatic");
    }
  }, [dismissWithReason]);

  useEffect(() => () => {
    for (const timer of dismissTimersRef.current.values()) window.clearTimeout(timer);
    dismissTimersRef.current.clear();
    dismissCallbacksRef.current.clear();
  }, []);

  const api = useMemo<NotificationApi>(() => ({
    push,
    info: notification => push({ ...notification, kind: "info" }),
    success: notification => push({ ...notification, kind: "success" }),
    warning: notification => push({ ...notification, kind: "warning" }),
    danger: notification => push({ ...notification, kind: "danger" }),
    update,
    dismiss,
    clear,
  }), [clear, dismiss, push, update]);

  const visibleNotifications = notifications
    .slice(-Math.max(1, maxVisible))
    .reverse();
  const notificationRegion = visibleNotifications.length > 0 && typeof document === "object"
    ? createPortal(
      <div className="ss-notification-region" aria-label={regionLabel}>
        {visibleNotifications.map(notification => (
          <NotificationToast
            key={notification.id}
            notification={notification}
            closeLabel={closeLabel}
            onDismiss={dismissWithReason}
          />
        ))}
      </div>,
      document.body,
    )
    : null;

  return (
    <NotificationContext.Provider value={api}>
      {children}
      {notificationRegion}
    </NotificationContext.Provider>
  );
}

export function useNotifications(): NotificationApi {
  const notifications = useContext(NotificationContext);
  if (!notifications) throw new Error("useNotifications must be used inside NotificationProvider");

  return notifications;
}
