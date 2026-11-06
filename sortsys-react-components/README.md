# @sortsys/react-components

This package contains the React controls and CSS used by the sortsys web application. It includes application-shell elements, menus and modals, form controls, tables, pagination, loading states, tags, tiles, and other data-display components.

## Use from the repository

The package exports source files directly and is consumed as a local dependency by `sortsys-webapp-v2`.

```tsx
import { Button, Heading } from "@sortsys/react-components";
import "@sortsys/react-components/styles.css";

export function SaveAction() {
  return (
    <section>
      <Heading level={2}>Änderungen</Heading>
      <Button kind="primary">Speichern</Button>
    </section>
  );
}
```

Shared styles live in `src/styles.css`. The public exports are declared in `package.json` and `src/index.tsx`; update the declaration files when adding a public component.

React 19 and React DOM 19 are peer dependencies.

## Keyboard behavior

Autocomplete suggestions support Tab/Shift-Tab and arrow keys using the same
active result. Enter selects it; Escape dismisses suggestions. Tabbing beyond the
first/last result continues through the form without accepting a suggestion or
invoking the create action.

For a field added by an explicit user action, set `focusOnMount` on `MyForm.Input`
or `MyForm.MultiSelect` for that new row's first field. The request waits until
field registration/prefill has finished disabling the form, then focuses once.
It does not refocus on typing or subsequent form updates. Dialog autofocus remains
separate so initial and asynchronously loaded fields do not steal the dialog's
focus. Keep initial row requests false and enable them in the add-row handler.

## License

This package is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).

