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

## License

This package is licensed under the [GNU Affero General Public License v3.0 only](../LICENSE).

