# Gemeinsame React-Komponenten

`@sortsys/react-components` enthält die gemeinsamen Bedienelemente und Stile der
Webapp. Dazu gehören Navigation, Menüs, Dialoge, Formulare und Tabellen sowie
Komponenten für Nachladen, Ladezustände, Schlagwörter, Kacheln und weitere Datenansichten.

## Im Repository verwenden

Das Paket exportiert seine Quellen direkt und ist als lokale Abhängigkeit in
`sortsys-webapp-v2` eingebunden.

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

Gemeinsame Stile liegen in `src/styles.css`, öffentliche Exporte in `package.json`
und dem Moduleinstieg unter `src/`. Bei neuen öffentlichen Komponenten die
Typdeklarationen ergänzen. React 19 und React DOM 19 sind Peer-Abhängigkeiten.

## Tastaturbedienung

Autocomplete-Ergebnisse verwenden für Tab, Umschalt+Tab und Pfeiltasten denselben
aktiven Eintrag. Enter wählt aus, Escape schließt die Vorschläge. Tab über den
ersten oder letzten Eintrag hinaus setzt die Formularnavigation fort, ohne eine
Auswahl oder eine Erstellaktion auszulösen.

Wenn der Benutzer eine Formularzeile hinzufügt, `focusOnMount` auf dem ersten
neuen `MyForm.Input` oder `MyForm.MultiSelect` setzen. Das Feld erhält den Fokus
einmalig, sobald es registriert und vorbelegt ist. Tippen oder spätere
Aktualisierungen verschieben den Fokus nicht erneut.

Beim Öffnen setzt der Dialog seinen Fokus selbst. Bereits vorhandene oder
nachgeladene Felder dürfen ihn nicht übernehmen. Deshalb `focusOnMount` erst im
Handler zum Hinzufügen setzen, nicht für die anfänglich sichtbaren Zeilen.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
