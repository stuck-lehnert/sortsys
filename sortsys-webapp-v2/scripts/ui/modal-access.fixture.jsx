import React, { useState } from "react";
import { MemoryRouter, useLocation } from "react-router";
import { MyModalsProvider, useMyModals } from "../../app/hooks/useMyModals";
import { MyForm } from "../../app/components/MyForm";
import { I18nProvider } from "../../app/lib/i18n";
import { dataSession } from "../../app/lib/client";

/** The fixture controls only the public lifetime notification. It uses the
 * actual dialog provider, render callbacks, forms and browser history. Native
 * tests separately exercise access loss delivered across API instances. */
export function showModalAccess(root) {
  let context = new AbortController();
  const listeners = new Set();
  Object.assign(dataSession, {
    context: () => context.signal,
    listenContext(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const revoke = () => {
    context.abort();
    context = new AbortController();
    for (const listener of listeners) listener();
  };
  let original;
  let replace;
  let setLocation;
  let receipt;
  let requestedClose = 0;
  let submitted = false;
  let completed = false;
  let release;
  let submit;
  const pending = new Promise((resolve) => {
    release = resolve;
  });

  const confidentialDialog = {
    content: ({ replace: replaceDialog }) => {
      const [value, setValue] = useState("Vertraulicher Entwurf 782169");
      replace = replaceDialog;
      return (
        <input
          aria-label="Vertraulicher Entwurf"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      );
    },
    modalProps: () => ({ modalHeading: "Vertraulicher Dialog 782169" }),
  };
  window.cryptoFixture.modalAccess = {
    revoke,
    grant() {
      // Additional rights retain the data lifetime and its in-progress form.
      for (const listener of listeners) listener();
    },
    state: () => ({ requestedClose, submitted, completed }),
    release: () => release(),
    submit: () => submit(),
    staleDialogs() {
      original.showDefault(confidentialDialog);
      original.showForm({
        content: () => (
          <MyForm.Input name="private" labelText="Alte Formularwerte" />
        ),
        modalProps: () => ({ modalHeading: "Altes Formular" }),
        onSubmit: async () => {},
      });
      original.show(() => <p>Alter Rohdialog</p>);
      receipt = original.trackLocation(
        { url: "/gaeb/stale", backgroundUrl: window.location.href },
        () => {},
      );
    },
    replaceThenRevoke() {
      replace(() => original.showDefault(confidentialDialog));
      revoke();
    },
    staleLocation() {
      setLocation?.({
        url: "/gaeb/stale",
        backgroundUrl: window.location.href,
      });
      receipt?.update({
        url: "/gaeb/stale",
        backgroundUrl: window.location.href,
      });
    },
  };

  function Actions() {
    const modals = useMyModals();
    const location = useLocation();
    original ??= modals;
    return (
      <>
        <output aria-label="Dialogseite">{location.pathname}</output>
        <button onClick={() => modals.showDefault(confidentialDialog)}>
          Dialog öffnen
        </button>
        <button
          onClick={() =>
            modals.showForm({
              content: () => {
                const form = MyForm.$useContext();
                submit = () => form.submit();
                return (
                  <MyForm.Input
                    name="private"
                    labelText="Vertrauliches Formular"
                  />
                );
              },
              modalProps: () => ({
                modalHeading: "Formular 927845",
                primaryButtonText: "Speichern",
              }),
              async onSubmit({ navigate }) {
                submitted = true;
                await pending;
                modals.showDefault(confidentialDialog);
                navigate("/private-completion");
                completed = true;
              },
            })
          }
        >
          Formular öffnen
        </button>
        <button
          onClick={() =>
            modals.show((props) => {
              setLocation = props.setLocation;
              return <p>Rohdialog 618273</p>;
            })
          }
        >
          Rohdialog öffnen
        </button>
        <button
          onClick={() => {
            receipt = modals.trackLocation(
              { url: "/gaeb/protected", backgroundUrl: window.location.href },
              () => {
                requestedClose++;
              },
            );
          }}
        >
          Dokumentadresse öffnen
        </button>
        <button
          onClick={() => {
            modals.trackLocation(
              { url: "/gaeb/parent", backgroundUrl: window.location.href },
              () => {
                requestedClose++;
              },
            );
            modals.trackLocation(
              { url: "/gaeb/child", backgroundUrl: window.location.href },
              () => {
                requestedClose++;
              },
            );
          }}
        >
          Verschachtelte Dokumentadressen öffnen
        </button>
      </>
    );
  }
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <MyModalsProvider>
          <main>
            <Actions />
          </main>
        </MyModalsProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
