import { uiText } from "~/lib/i18n";
import { createContext, useContext, useEffect, useRef, useState, type RefObject } from "react";
import { useForceUpdate } from "./useForceUpdate";
import { generateId } from "~/lib/utils";
import { Modal } from "@sortsys/react-components";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import type { PromiseOr } from "~/type-helpers";
import { useLocation, useNavigate } from "react-router";
import { useLoading } from "./useLoading";
import { MyCallout } from "~/components/MyCallout";

type MyModal = {
  id: string;
  render: (props: { id: string, hide: () => void, replace: (callback: () => void) => void, visible: boolean }) => React.ReactNode,
  options?: {};
  visible: boolean;
};

const MyModalsContext = createContext<MyModalsInterface>(null as any);

export function useMyModals() {
  return useContext(MyModalsContext);
}

export function MyModalsProvider({ children }: { children: React.ReactNode }) {
  const interfaceRef = useRef<MyModalsInterface>(null as any);

  return <>
    <MyModalsContext.Provider value={{
      show: (...args) => interfaceRef.current.show(...args),
      showDefault: (...args) => interfaceRef.current.showDefault(...args),
      showForm: (...args) => interfaceRef.current.showForm(...args),
    }}>
      {children}
    </MyModalsContext.Provider>

    <_Modals interfaceRef={interfaceRef} />
  </>;
}


export interface MyModalsInterface {
  show: (render: MyModal['render'], options?: MyModal['options']) => void;

  showDefault: (
    props: {
      content: (props: { hide: () => void; replace: (callback: () => void) => void }) => React.ReactNode;
      modalProps: (props: { hide: () => void }) => Omit<React.ComponentProps<typeof Modal>, 'id' | 'key' | 'open' | 'onRequestClose' | 'isFullWidth'> & {
        useFullscreen?: boolean;
        noFullscreen?: boolean;
      };
      onPrimaryAction?: (props: {
        hide: () => void;
        navigate: ReturnType<typeof useNavigate>;
        pathname: string;
      }) => PromiseOr<void>;
    },
    options?: MyModal['options'],
  ) => void;

  showForm: (
    props: {
      content: (props: { hide: () => void; context: MyPublicFormContext }) => React.ReactNode;

      modalProps?: (props: {
        hide: () => void;
        context: MyPublicFormContext;
      }) => Omit<React.ComponentProps<typeof Modal>, 'id' | 'key' | 'open' | 'onRequestClose' | 'isFullWidth' | 'primaryButtonDisabled' | 'secondaryButtonText' | 'secondaryButtonDisabled' | 'shouldSubmitOnEnter'> & {
        noFullscreen?: boolean;
      };

      onSubmit: (props: {
        hide: () => void;
        context: MyPublicFormContext;
        navigate: ReturnType<typeof useNavigate>;
        pathname: string;
      }) => PromiseOr<void>;
    },
    options?: MyModal['options'],
  ) => void;
}

function _Modals(props: {
  interfaceRef: RefObject<MyModalsInterface>;
}) {
  const forceUpdate = useForceUpdate();
  const modalsRef = useRef<MyModal[]>([]);
  const modals = () => modalsRef.current;

  const _interface: MyModalsInterface = {
    show: (render, options) => {
      modals().push({
        id: generateId(),
        visible: true,
        render,
        options,
      });
      forceUpdate();
    },

    showDefault: (props, options) => {
      _interface.show(({ visible, hide, replace }) => {
        const navigate = useNavigate();
        const pathname = useLocation().pathname;

        const [loading, process] = useLoading();
        const [actionError, setActionError] = useState<string | null>(null);

        const content = props.content({ hide, replace });

        const { useFullscreen, noFullscreen, ...modalProps } = props.modalProps?.({ hide }) ?? {};

        const submitAction = typeof modalProps.onRequestSubmit === 'function'
          ? () => modalProps.onRequestSubmit?.()
          : props.onPrimaryAction
            ? () => props.onPrimaryAction?.({ hide, navigate, pathname })
            : null;
        const onRequestSubmit = submitAction
          ? () => process(async () => {
            setActionError(null);

            try {
              await submitAction();
            } catch (error) {
              setActionError(error instanceof Error && error.message.trim()
                ? error.message
                : uiText("Die Aktion konnte nicht ausgeführt werden.", "The action could not be completed."));
            }
          })
          : undefined;

        const dataProps = useFullscreen && !noFullscreen ? {
          ['data-fullheight']: 'true',
          ['data-fullwidth']: 'true',
        } : {};

        return <Modal
          {...dataProps}
          {...modalProps}
          open={visible}
          closeButtonLabel={modalProps.closeButtonLabel ?? uiText("Schließen", "Close")}
          secondaryButtonText={modalProps.secondaryButtonText ?? uiText("Abbrechen", "Cancel")}
          onRequestClose={hide}
          primaryButtonDisabled={loading() || modalProps.primaryButtonDisabled}
          primaryButtonLoading={loading()}
          onRequestSubmit={onRequestSubmit}
        >
          {!!actionError && <MyCallout
            kind="error"
            title={uiText("Aktion fehlgeschlagen", "Action failed")}
            subtitle={actionError}
          />}

          {content}
        </Modal>;
      }, options);
    },

    showForm: (props, options) => {
      const _MyModal: MyModal['render'] = ({ hide, visible }) => {
        const context = MyForm.$useContext();
        const onRequestSubmit = typeof props.onSubmit === 'function'
          ? () => context.submit()
          : undefined;

        const content = props.content({ hide, context });

        const { noFullscreen, primaryButtonText, ...modalProps } = props.modalProps?.({ hide, context }) ?? {};

        const dataProps = !noFullscreen ? {
          ['data-fullheight']: 'true',
          ['data-fullwidth']: 'true',
        } : {};

        return <Modal
          {...modalProps}
          {...dataProps}
          open={visible}
          onRequestClose={hide}
          // primaryButtonDisabled={context.loading()}
          secondaryButtonText={uiText("Abbrechen")}
          onRequestSubmit={onRequestSubmit}
          closeButtonLabel={uiText("Abbrechen")}
          // shouldSubmitOnEnter
          primaryButtonDisabled={context.loading()}
          primaryButtonLoading={context.loading()}
          primaryButtonText={primaryButtonText}
          // primaryButtonDisabled={!noFullscreen || context.loading()}
          // primaryButtonText={!!noFullscreen && primaryButtonText}
        >
          <div className="space-y-2 my-container">
            {content}

            {/*!noFullscreen && <>
              <div style={{ height: '1rem' }} />
              <MyForm.SubmitButton>{primaryButtonText}</MyForm.SubmitButton>
            </>*/}
          </div>
        </Modal>
      };

      _interface.show(({ id, visible, hide, replace }) => {
        const navigate = useNavigate();
        const pathname = useLocation().pathname;

        return <MyForm onSubmit={context => props.onSubmit({ hide, context, navigate, pathname })}>
          <_MyModal id={id} hide={hide} replace={replace} visible={visible} />
        </MyForm>;
      }, options);
    },
  };

  props.interfaceRef.current = _interface;

  useEffect(() => {
    const listener = (e: PopStateEvent) => {
      let active: MyModal | null = null;
      for (const modal of modals()) {
        if (modal.visible) active = modal;
      }

      if (!active) return;

      e.stopImmediatePropagation();
      history.go(1);

      active.visible = false;
      forceUpdate();
    };

    window.addEventListener('popstate', listener, { capture: true });
    return () => window.removeEventListener('popstate', listener);
  });

  return <>
    {modals().map((modal) => {
      const hide = () => {
        modals().filter(m => m === modal).forEach(m => m.visible = false);
        forceUpdate();

        setTimeout(() => {
          modalsRef.current = modals().filter(m => m.id !== modal.id);
          forceUpdate();
        }, 2000);
      };

      return <_MyModal key={modal.id} render={modal.render} props={{
        hide,
        replace: (callback) => {
          modalsRef.current = modals().filter(m => m.id !== modal.id);
          forceUpdate();
          window.setTimeout(callback, 0);
        },
        id: modal.id,
        visible: modal.visible,
      }} />;
    })}
  </>;
}

function _MyModal({ props, render }: {
  render: MyModal['render'];
  props: Parameters<MyModal['render']>[0];
}) {
  return render(props);
}
