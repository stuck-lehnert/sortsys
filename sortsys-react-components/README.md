# Einheitliche Bedienung für sortsys

`@sortsys/react-components` sorgt für vertraute Abläufe in der gesamten Webapp:
Navigation, Menüs und Dialoge, Formulare, Tabellen, Nachladen, Ladezustände,
Schlagwörter, Kacheln und weitere Datenansichten teilen sich Komponenten und CSS.

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

Bei ausdrücklich hinzugefügten Formularzeilen `focusOnMount` auf dem ersten neuen
`MyForm.Input` oder `MyForm.MultiSelect` setzen. Die Anforderung wartet auf
Feldregistrierung und Vorbelegung und fokussiert anschließend einmalig. Tippen
oder spätere Aktualisierungen verschieben den Fokus nicht erneut. Die anfängliche
Dialogfokussierung bleibt getrennt; initiale und nachgeladene Felder nehmen dem
Dialog nicht den Fokus. Erste Zeilen erhalten keine Anforderung, neue Zeilen
erst im Handler zum Hinzufügen.

## Lizenz

Für dieses Paket gilt die [GNU Affero General Public License v3.0 only](../LICENSE).
