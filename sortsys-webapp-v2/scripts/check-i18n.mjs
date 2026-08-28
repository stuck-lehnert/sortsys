import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "../app");
const ENGLISH_CATALOG_SOURCE = fs.readFileSync(path.join(ROOT, "lib/uiText.en.ts"), "utf8");
const ENGLISH_TEXT_KEYS = new Set(
  [...ENGLISH_CATALOG_SOURCE.matchAll(/^\s*("(?:\\.|[^"])*"):/gm)]
    .map(match => JSON.parse(match[1])),
);
const UI_ATTRIBUTES = new Set([
  "label", "labelText", "helperText", "title", "subtitle", "text", "placeholder",
  "aria-label", "closeButtonLabel", "primaryButtonText", "secondaryButtonText",
  "description", "modalHeading", "backwardText", "forwardText",
  "itemsPerPageText", "emptyText", "alt",
]);
const UI_PROPERTIES = new Set([
  "label", "title", "subtitle", "header", "emptyMessage", "reportLabel",
  "sheetName", "fileName", "modalHeading", "primaryButtonText",
  "secondaryButtonText", "text",
]);
const EXCLUDED = [
  "scriptClientTypes.generated.ts",
  "llmProposalI18n.ts",
  "uiText.en.ts",
  "i18n.tsx",
  "docs.ts",
  "docs.en.ts",
  "i18n.test.ts",
];
const GERMAN_UI_WORDS = /\b(der|die|das|den|dem|des|ein|eine|einen|einem|einer|kein|keine|keinen|nicht|und|oder|für|fur|mit|ohne|wird|wurde|werden|kann|konnte|bitte|muss|müssen|darf|soll|ist|sind|hat|haben|aus|auf|zur|zum|von|bei|bis|als|jetzt|noch|bereits|ungültig|gelöscht|gespeichert|auswählen|hinzufügen|entfernen|bearbeiten|anzeigen|ausblenden|schließen|öffnen|abbrechen|bestätigen|fehler|passwort|benutzer|projekt|datenbank|eintrag|einträge|stunden|auswahl|anhänge|übersicht|aktivität|urlaub|inventur|inventiert|werkzeug|lieferschein|regiebericht|bautagesbericht|kosten|zeitraum|datum|unterschrift|beschreibung|arbeit|arbeitszeit|foto|fotos|datei|dateien|kunde|kontakt|händler|vorgesetzter|erstellt|aktualisiert|geladen|laden|fehlgeschlagen|nummer|kennzahl|wert|letzte|letzter|verantwortlicher|zeile|seiten|zurück|weiter|speichern|löschen|erstellen|kommentar|gesperrt|beantragt|untergebene|keine|nur|freies|freien)\b/i;
const TECHNICAL_GERMAN_LITERALS = /^(projekt|datei-)$/i;
const failures = [];

function walk(target) {
  const stat = fs.statSync(target);

  if (stat.isDirectory()) {
    return fs.readdirSync(target).flatMap(entry => walk(path.join(target, entry)));
  }

  if (!/\.tsx?$/.test(target) || EXCLUDED.some(suffix => target.endsWith(suffix))) return [];
  return [target];
}

function lineOf(sourceFile, node) {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function isUiTextCall(node) {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isCallExpression(current)
      && ts.isIdentifier(current.expression)
      && current.expression.text === "uiText") return true;

    if (ts.isStatement(current)) return false;
  }

  return false;
}

function report(file, sourceFile, node, message) {
  failures.push(path.relative(path.resolve(ROOT, ".."), file) + ":" + lineOf(sourceFile, node) + " " + message);
}

for (const file of walk(ROOT)) {
  const source = fs.readFileSync(file, "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  function inspectUiProperty(node) {
    if (ts.isStringLiteral(node)) {
      if (!isUiTextCall(node) && /\p{L}/u.test(node.text) && !/^(proposal\.|[a-z]+:|[a-z0-9_.:\/#-]+$)/.test(node.text)) {
        report(file, sourceFile, node, "raw dynamic UI string: " + JSON.stringify(node.text));
      }
      return;
    }

    ts.forEachChild(node, inspectUiProperty);
  }

  function visit(node) {
    if (ts.isJsxText(node) && /\p{L}/u.test(node.text)) {
      report(file, sourceFile, node, "raw JSX text: " + JSON.stringify(node.text.trim()));
    }

    if (
      ts.isJsxAttribute(node)
      && UI_ATTRIBUTES.has(node.name.text)
      && node.initializer
      && ts.isStringLiteral(node.initializer)
    ) {
      report(file, sourceFile, node, "raw UI attribute: " + node.name.text);
    }

    if (ts.isPropertyAssignment(node)) {
      const propertyName = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)
        ? node.name.text
        : "";

      if (UI_PROPERTIES.has(propertyName)) inspectUiProperty(node.initializer);
    }

    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "uiText"
      && node.arguments.length < 2
    ) {
      const sourceArgument = node.arguments[0];

      if (ts.isStringLiteral(sourceArgument) || ts.isNoSubstitutionTemplateLiteral(sourceArgument)) {
        const key = sourceArgument.text.trim().replace(/\s+/g, " ");

        if (!ENGLISH_TEXT_KEYS.has(key)) {
          report(file, sourceFile, node, "uiText call has no English catalog entry: " + JSON.stringify(key));
        }
      } else {
        report(file, sourceFile, node, "dynamic uiText call requires explicit English text");
      }
    }

    if (
      (ts.isStringLiteral(node)
        || ts.isNoSubstitutionTemplateLiteral(node)
        || ts.isTemplateExpression(node))
      && !isUiTextCall(node)
    ) {
      const value = ts.isTemplateExpression(node)
        ? node.head.text + node.templateSpans.map(span => span.literal.text).join("")
        : node.text;

      if (GERMAN_UI_WORDS.test(value) && !TECHNICAL_GERMAN_LITERALS.test(value)) {
        report(file, sourceFile, node, "German runtime string outside uiText: " + JSON.stringify(value.slice(0, 120)));
      }
    }

    if (ts.isStringLiteral(node) && node.text === "de-DE") {
      report(file, sourceFile, node, "hardcoded formatter locale");
    }

    if (
      (file.endsWith("userActions.tsx") || file.endsWith("roleModel.ts"))
      && ts.isPropertyAssignment(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "description"
      && ts.isStringLiteral(node.initializer)
    ) {
      report(file, sourceFile, node.initializer, "raw action or role description");
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
}

if (failures.length) {
  console.error("Unlocalized user-facing strings found:\n" + failures.join("\n"));
  process.exit(1);
}

console.log("User-facing JSX and audited dynamic labels are localized.");
