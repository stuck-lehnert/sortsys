import { uiText } from "~/lib/i18n";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type RefObject,
} from "react";
import { useForceUpdate } from "./useForceUpdate";
import { generateId } from "~/lib/utils";
import { Modal } from "@sortsys/react-components";
import { useFormFieldCount } from "@sortsys/react-components/my-form";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import type { PromiseOr } from "~/type-helpers";
import {
  useLocation,
  useNavigate,
  type NavigateFunction,
  type NavigateOptions,
  type To,
} from "react-router";
import { useLoading } from "./useLoading";
import { MyCallout } from "~/components/MyCallout";
import { client, dataSession } from "~/lib/client";
import { unlockedAccount, type UnlockedAccount } from "~/lib/crypto/session";

type ModalContext = AbortSignal | UnlockedAccount;

type MyModal = {
  id: string;
  context: ModalContext;
  render: (props: {
    id: string;
    hide: () => void;
    replace: (callback: () => void) => void;
    visible: boolean;
    setLocation: (location: { url: string; backgroundUrl: string }) => void;
  }) => React.ReactNode;
  options?: {
    onRequestClose?: () => void;
    location?: { url: string; backgroundUrl: string };
  };
  location?: { url: string; backgroundUrl: string };
  visible: boolean;
};

const MyModalsContext = createContext<MyModalsInterface>(null as any);

function actionErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim()
    ? error.message
    : uiText(
        "Die Aktion konnte nicht ausgeführt werden.",
        "The action could not be completed.",
      );
}

function ModalActionError({ message }: { message: string | null }) {
  const element = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (message) element.current?.focus();
  }, [message]);
  return message ? (
    <div ref={element} role="alert" tabIndex={-1}>
      <MyCallout
        kind="error"
        title={uiText("Aktion fehlgeschlagen", "Action failed")}
        subtitle={message}
      />
    </div>
  ) : null;
}

export function useMyModals(): MyModalsInterface {
  const modals = useContext(MyModalsContext);
  const context = useDataContext();
  return useMemo(() => {
    if (!modals) return modals;
    // A handle retained by an asynchronous action cannot open a dialog in a
    // replacement account or after the action's data access was revoked.
    return {
      show: (...args) => {
        if (currentDataContext(context)) modals.show(...args);
      },
      showDefault: (...args) => {
        if (currentDataContext(context)) modals.showDefault(...args);
      },
      showForm: (...args) => {
        if (currentDataContext(context)) modals.showForm(...args);
      },
      trackLocation: (...args) => {
        if (currentDataContext(context)) return modals.trackLocation(...args);
        return { close() {}, detach() {}, update() {} };
      },
    } satisfies MyModalsInterface;
  }, [context, modals]);
}

function useDataContext() {
  return useSyncExternalStore(
    dataSession.listenContext,
    dataSession.context,
    dataSession.context,
  );
}

function currentDataContext(context: AbortSignal): boolean {
  return !context.aborted && dataSession.context() === context;
}

function currentModalContext(context: ModalContext): boolean {
  if (context instanceof AbortSignal) return currentDataContext(context);
  return client.loggedIn() && unlockedAccount() === context;
}

function contextNavigation(
  navigate: NavigateFunction,
  context: ModalContext,
): NavigateFunction {
  return (to: To | number, options?: NavigateOptions) => {
    if (!currentModalContext(context)) return;
    if (typeof to === "number") return navigate(to);
    return navigate(to, options);
  };
}

export function MyModalsProvider({ children }: { children: React.ReactNode }) {
  const interfaceRef = useRef<MyModalsInterface>(null as any);

  return (
    <MyModalsContext.Provider
      value={{
        show: (...args) => interfaceRef.current.show(...args),
        trackLocation: (...args) => interfaceRef.current.trackLocation(...args),
        showDefault: (...args) => interfaceRef.current.showDefault(...args),
        showForm: (...args) => interfaceRef.current.showForm(...args),
      }}
    >
      {children}
      <_Modals interfaceRef={interfaceRef} />
    </MyModalsContext.Provider>
  );
}

export interface MyModalsInterface {
  show: (render: MyModal["render"], options?: MyModal["options"]) => void;
  /** Share modal history with a dialog whose content is already rendered by its page. */
  trackLocation: (
    location: { url: string; backgroundUrl: string },
    onRequestClose: () => void,
  ) => {
    close: () => void;
    detach: () => void;
    update: (location: { url: string; backgroundUrl: string }) => void;
  };

  showDefault: (
    props: {
      content: (props: {
        hide: () => void;
        replace: (callback: () => void) => void;
      }) => React.ReactNode;
      modalProps: (props: { hide: () => void }) => Omit<
        React.ComponentProps<typeof Modal>,
        "id" | "key" | "open" | "onRequestClose" | "isFullWidth"
      > & {
        useFullscreen?: boolean;
        noFullscreen?: boolean;
      };
      onPrimaryAction?: (props: {
        hide: () => void;
        navigate: ReturnType<typeof useNavigate>;
        pathname: string;
      }) => PromiseOr<void>;
    },
    options?: NonNullable<MyModal["options"]> & { lifetime?: "session" },
  ) => void;

  showForm: (
    props: {
      content: (props: {
        hide: () => void;
        context: MyPublicFormContext;
      }) => React.ReactNode;

      modalProps?: (props: {
        hide: () => void;
        context: MyPublicFormContext;
      }) => Omit<
        React.ComponentProps<typeof Modal>,
        | "id"
        | "key"
        | "open"
        | "onRequestClose"
        | "isFullWidth"
        | "secondaryButtonText"
        | "secondaryButtonDisabled"
      > & {
        noFullscreen?: boolean;
        useFullscreen?: boolean;
      };

      onSubmit: (props: {
        hide: () => void;
        context: MyPublicFormContext;
        navigate: ReturnType<typeof useNavigate>;
        pathname: string;
      }) => PromiseOr<void>;
    },
    options?: MyModal["options"],
  ) => void;
}

function _Modals(props: { interfaceRef: RefObject<MyModalsInterface> }) {
  const dataContext = useDataContext();
  const forceUpdate = useForceUpdate();
  const modalsRef = useRef<MyModal[]>([]);
  const restoringBack = useRef(false);
  const closingHistory = useRef(false);
  const closeAfterRestore = useRef(false);
  const modals = () => modalsRef.current;
  const setLocation = (
    modal: MyModal,
    location: { url: string; backgroundUrl: string },
  ) => {
    if (!modal.visible || !currentModalContext(modal.context)) return;
    const target = new URL(location.url, window.location.href).href;
    if (modal.location) {
      if (window.location.href === modal.location.url)
        history.replaceState(history.state, "", target);
      modal.location.url = target;
      return;
    }
    const backgroundUrl = new URL(location.backgroundUrl, window.location.href)
      .href;
    // A directly opened link gets its own background entry as well. Closing it
    // therefore returns to this page, including after a reload.
    if (
      window.location.href === target &&
      history.state?.sortsysModal === true
    ) {
      modal.location = { url: target, backgroundUrl };
      return;
    }
    if (window.location.href === target)
      history.replaceState(history.state, "", backgroundUrl);
    const state = history.state ?? {};
    history.pushState(
      {
        ...state,
        idx: (state.idx ?? 0) + 1,
        key: generateId(),
        sortsysModal: true,
      },
      "",
      target,
    );
    modal.location = { url: target, backgroundUrl };
  };

  const hideModal = (modal: MyModal) => {
    if (!modal.visible) return;
    modal.visible = false;
    if (modal.location && window.location.href === modal.location.url) {
      if (restoringBack.current) closeAfterRestore.current = true;
      else if (!closingHistory.current) {
        closingHistory.current = true;
        history.back();
      }
    } else if (modal.location && restoringBack.current) {
      closeAfterRestore.current = true;
    }
    forceUpdate();
    setTimeout(() => {
      modalsRef.current = modals().filter((m) => m.id !== modal.id);
      forceUpdate();
    }, 2000);
  };
  const registerModal = (
    render: MyModal["render"],
    options?: MyModal["options"],
    context: ModalContext = dataContext,
  ) => {
    if (!currentDataContext(dataContext)) return null;
    const modal: MyModal = {
      id: generateId(),
      context,
      visible: true,
      render,
      options,
    };
    modals().push(modal);
    if (options?.location) setLocation(modal, options.location);
    forceUpdate();
    return modal;
  };
  const _interface: MyModalsInterface = {
    show: (render, options) => {
      registerModal(render, options);
    },
    trackLocation: (location, onRequestClose) => {
      const modal = registerModal(() => null, { location, onRequestClose });
      if (!modal) return { close() {}, detach() {}, update() {} };
      return {
        close: () => hideModal(modal),
        detach: () => {
          modal.visible = false;
          modalsRef.current = modals().filter((entry) => entry !== modal);
          forceUpdate();
        },
        update: (next) => setLocation(modal, next),
      };
    },

    showDefault: (props, options) => {
      // The authenticated provider owns the lifetime of administration
      // dialogs that only manage account and access metadata.
      const context =
        options?.lifetime === "session" ? unlockedAccount() : dataContext;
      if (!context) return;
      registerModal(({ visible, hide, replace }) => {
        const navigate = contextNavigation(useNavigate(), context);
        const pathname = useLocation().pathname;

        const [loading, process] = useLoading();
        const [actionError, setActionError] = useState<string | null>(null);

        const content = props.content({ hide, replace });

        const { useFullscreen, noFullscreen, ...modalProps } =
          props.modalProps?.({ hide }) ?? {};

        const submitAction =
          typeof modalProps.onRequestSubmit === "function"
            ? () => modalProps.onRequestSubmit?.()
            : props.onPrimaryAction
              ? () => props.onPrimaryAction?.({ hide, navigate, pathname })
              : null;
        const onRequestSubmit = submitAction
          ? () =>
              process(async () => {
                if (!currentModalContext(context)) return;
                setActionError(null);

                try {
                  await submitAction();
                } catch (error) {
                  setActionError(actionErrorMessage(error));
                }
              })
          : undefined;

        const dataProps =
          useFullscreen && !noFullscreen
            ? {
                ["data-fullheight"]: "true",
                ["data-fullwidth"]: "true",
              }
            : {};

        return (
          <Modal
            {...dataProps}
            {...modalProps}
            open={visible}
            closeButtonLabel={
              modalProps.closeButtonLabel ?? uiText("Schließen", "Close")
            }
            secondaryButtonText={
              modalProps.secondaryButtonText ?? uiText("Abbrechen", "Cancel")
            }
            onRequestClose={hide}
            primaryButtonDisabled={
              loading() || modalProps.primaryButtonDisabled
            }
            primaryButtonLoading={loading()}
            onRequestSubmit={onRequestSubmit}
          >
            <ModalActionError message={actionError} />

            {content}
          </Modal>
        );
      }, options, context);
    },

    showForm: (props, options) => {
      const _MyModal = ({
        hide,
        visible,
        submissionError,
      }: Parameters<MyModal["render"]>[0] & {
        submissionError: string | null;
      }) => {
        const context = MyForm.$useContext();
        const fieldCount = useFormFieldCount();
        const content = props.content({ hide, context });

        const {
          useFullscreen,
          noFullscreen,
          primaryButtonText,
          ...modalProps
        } = props.modalProps?.({ hide, context }) ?? {};
        const onRequestSubmit =
          typeof props.onSubmit === "function"
            ? () => {
                if (!context.loading() && !modalProps.primaryButtonDisabled)
                  context.submit();
              }
            : undefined;

        const fullscreen = fieldCount >= 4 || (useFullscreen && !noFullscreen);
        const dataProps = fullscreen
          ? {
              ["data-fullheight"]: "true",
              ["data-fullwidth"]: "true",
            }
          : {};

        return (
          <Modal
            {...modalProps}
            {...dataProps}
            open={visible}
            onRequestClose={hide}
            secondaryButtonText={uiText("Abbrechen")}
            onRequestSubmit={onRequestSubmit}
            closeButtonLabel={uiText("Abbrechen")}
            // shouldSubmitOnEnter
            primaryButtonDisabled={
              context.loading() || modalProps.primaryButtonDisabled
            }
            primaryButtonLoading={context.loading()}
            primaryButtonText={primaryButtonText}
            // primaryButtonText={!!noFullscreen && primaryButtonText}
          >
            <div className="space-y-2 my-container">
              <ModalActionError message={submissionError} />
              {content}

              {/*!noFullscreen && <>
              <div style={{ height: '1rem' }} />
              <MyForm.SubmitButton>{primaryButtonText}</MyForm.SubmitButton>
            </>*/}
            </div>
          </Modal>
        );
      };

      _interface.show(({ id, visible, hide, replace, setLocation }) => {
        const navigate = contextNavigation(useNavigate(), dataContext);
        const pathname = useLocation().pathname;
        const [submissionError, setSubmissionError] = useState<string | null>(
          null,
        );

        return (
          <MyForm
            onSubmit={async (context) => {
              if (!currentDataContext(dataContext)) return;
              if (props.modalProps?.({ hide, context }).primaryButtonDisabled)
                return;
              setSubmissionError(null);
              try {
                await props.onSubmit({ hide, context, navigate, pathname });
              } catch (error) {
                setSubmissionError(actionErrorMessage(error));
              }
            }}
          >
            <_MyModal
              id={id}
              hide={hide}
              replace={replace}
              visible={visible}
              setLocation={setLocation}
              submissionError={submissionError}
            />
          </MyForm>
        );
      }, options);
    },
  };

  props.interfaceRef.current = _interface;

  useEffect(() => {
    const listener = (e: PopStateEvent) => {
      if (closingHistory.current) {
        const expiredDocument =
          history.state?.sortsysModal === true &&
          modals().some(
            (modal) =>
              modal.location?.url === window.location.href &&
              !currentModalContext(modal.context),
          );
        if (expiredDocument) {
          e.stopImmediatePropagation();
          history.back();
          return;
        }
        closingHistory.current = false;
        window.dispatchEvent(
          new CustomEvent("sortsys:modal-location", {
            detail: { closed: true },
          }),
        );
        return;
      }
      if (restoringBack.current) {
        restoringBack.current = false;
        e.stopImmediatePropagation();
        if (closeAfterRestore.current) {
          closeAfterRestore.current = false;
          closingHistory.current = true;
          history.back();
        }
        return;
      }
      let active: MyModal | null = null;
      for (const modal of modals()) {
        if (modal.visible && currentModalContext(modal.context)) active = modal;
      }

      if (!active) {
        if (history.state?.sortsysModal === true) {
          e.stopImmediatePropagation();
          window.dispatchEvent(new Event("sortsys:modal-location"));
        }
        return;
      }

      e.stopImmediatePropagation();
      // A location listener can already reopen this dialog before the browser
      // delivers its Forward event. That event belongs to the open dialog.
      if (active.location?.url === window.location.href) return;
      if (active.options?.onRequestClose) {
        active.options.onRequestClose();
        // Read-only dialogs can close synchronously at the Back destination.
        // Restore the original entry only when an editor still needs its save
        // or discard guard; otherwise a second traversal races a quick Forward.
        if (!active.visible) {
          window.dispatchEvent(
            new CustomEvent("sortsys:modal-location", {
              detail: { closed: true },
            }),
          );
          return;
        }
      }
      restoringBack.current = true;
      history.go(1);

      if (!active.options?.onRequestClose) {
        active.visible = false;
        forceUpdate();
      }
    };

    window.addEventListener("popstate", listener, { capture: true });
    return () =>
      window.removeEventListener("popstate", listener, { capture: true });
  });

  return (
    <>
      {modals().map((modal) => {
        const hide = () => hideModal(modal);

        return (
          <_MyModal
            key={modal.id}
            context={modal.context}
            render={modal.render}
            props={{
              hide,
              replace: (callback) => {
                if (!currentModalContext(modal.context)) return;
                modalsRef.current = modals().filter((m) => m.id !== modal.id);
                forceUpdate();
                window.setTimeout(() => {
                  if (currentModalContext(modal.context)) callback();
                }, 0);
              },
              id: modal.id,
              visible: modal.visible,
              setLocation: (location) => setLocation(modal, location),
            }}
          />
        );
      })}
    </>
  );
}

function _MyModal({
  context,
  props,
  render,
}: {
  context: ModalContext;
  render: MyModal["render"];
  props: Parameters<MyModal["render"]>[0];
}) {
  useDataContext();
  const active = currentModalContext(context);
  useEffect(() => {
    if (!active) props.hide();
  }, [active, props.hide]);
  if (!active) return null;
  // Render callbacks may use hooks. Their component must unmount as a whole
  // when the context expires, rather than conditionally omitting those hooks.
  return <_ModalContent props={props} render={render} />;
}

function _ModalContent({
  props,
  render,
}: {
  render: MyModal["render"];
  props: Parameters<MyModal["render"]>[0];
}) {
  return render(props);
}
