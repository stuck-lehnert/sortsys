import { currentLocale } from "./i18n";
import { ENGLISH_DOCS, ENGLISH_DOC_SECTION_HEADINGS } from "./docs.en";

export type DocArticle = {
  id: string;
  title: string;
  lead: string;
  category: string;
  paragraphs: string[];
  scriptExamples?: Array<{
    title: string;
    description: string;
    code: string;
  }>;
  faqs?: Array<{
    question: string;
    answer: string[];
  }>;
  keywords: string[];
};

export type DocSection = {
  heading: string;
  paragraphs: string[];
};

const DOC_SECTION_CONFIG: Record<string, Array<{ heading: string; start: number; end?: number }>> = {
  'client-skripte': [
    { heading: 'Einordnung', start: 0, end: 1 },
    { heading: 'Aufbau eines Skripts', start: 1, end: 3 },
    { heading: 'Sicherheit und Grenzen', start: 3, end: 6 },
    { heading: 'Daten lesen und Fehler behandeln', start: 6, end: 7 },
    { heading: 'Beispiele verwenden', start: 7 },
  ],
  projekt: [
    { heading: 'Einordnung', start: 0, end: 2 },
    { heading: 'Was zur Projektakte gehört', start: 2, end: 8 },
    { heading: 'Nachweise und Kosten', start: 8, end: 10 },
    { heading: 'Abschluss und Benennung', start: 10 },
  ],
  bautagesbericht: [
    { heading: 'Zweck', start: 0, end: 3 },
    { heading: 'Regeln für die Erfassung', start: 3, end: 7 },
    { heading: 'Gute Beschreibung', start: 7 },
  ],
  regiebericht: [
    { heading: 'Zweck', start: 0, end: 4 },
    { heading: 'Inhalt', start: 4, end: 8 },
    { heading: 'Ablage im Projekt', start: 8 },
  ],
  lieferschein: [
    { heading: 'Zweck', start: 0, end: 3 },
    { heading: 'Materialpositionen', start: 3, end: 7 },
    { heading: 'Prüfung und Zuordnung', start: 7 },
  ],
  werkzeugbuchung: [
    { heading: 'Zweck', start: 0, end: 4 },
    { heading: 'Übergaben und Historie', start: 4, end: 8 },
    { heading: 'Projektkosten', start: 8 },
  ],
  einsatzplanung: [
    { heading: 'Zweck', start: 0, end: 3 },
    { heading: 'Planung im Projektalltag', start: 3, end: 8 },
    { heading: 'Planung und Ist-Dokumentation', start: 8 },
  ],
  urlaub: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Antrag und Entscheidung', start: 2, end: 5 },
    { heading: 'Auswirkung auf Planung', start: 5 },
  ],
  produkt: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Preise und Einheiten', start: 2, end: 6 },
    { heading: 'Projektbezug und Kosten', start: 6 },
  ],
  kunde: [
    { heading: 'Zweck', start: 0, end: 4 },
    { heading: 'Abgrenzung zum Projekt', start: 4, end: 7 },
    { heading: 'Ansprechpartner', start: 7 },
  ],
  kontakt: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Abgrenzung zum Benutzerkonto', start: 2, end: 4 },
    { heading: 'Zuordnung und Kommunikation', start: 4 },
  ],
  rollen: [
    { heading: 'Grundprinzip', start: 0, end: 4 },
    { heading: 'Projektrechte und Bereichsrechte', start: 4, end: 8 },
    { heading: 'Administratoren', start: 8 },
  ],
  tastaturkuerzel: [
    { heading: 'Grundprinzip', start: 0, end: 2 },
    { heading: 'Verfügbare Kürzel', start: 2 },
  ],
};

const GERMAN_DOC_ARTICLES: DocArticle[] = [
  {
    id: 'client-skripte',
    title: 'Client-Skripte',
    lead: 'Client-Skripte automatisieren Abläufe direkt im Browser, laufen aber in einer abgeschotteten Sandbox.',
    category: 'Automation',
    paragraphs: [
      'Client-Skripte werden unter Verwaltung > Skripte angelegt. Beim Erstellen wird zuerst ein Name vergeben, danach wird der JavaScript-Code im Editor bearbeitet und gespeichert.',
      `Skripte sind JavaScript-Module. Top-Level-Await ist erlaubt. Statische Imports und Exports sind nicht erlaubt; verwende immer dynamische Imports wie <code>await import('sortsys-client')</code>.`,
      `Nur fünf Module sind verfügbar: <code>sortsys-client</code> für TRPC-Aufrufe, <code>sortsys-popups</code> für bestätigte Dialoge, <code>sortsys-modal-forms</code> für Vollbild-Formulare, <code>sortsys-log</code> für bewusstes Logging und <code>sortsys-utils</code> für sichere Hilfsfunktionen. Andere Imports werden vor Ausführung abgelehnt.`,
      `<code>console</code> ist nicht verfügbar. Verwende stattdessen <code>const { log } = await import('sortsys-log')</code>.`,
      `Der Code läuft in einem Worker und nicht im Seitenkontext. Browser- und Seitenzugriffe wie <code>window</code>, <code>self</code>, <code>document</code>, <code>localStorage</code>, <code>sessionStorage</code>, <code>fetch</code>, <code>alert</code> oder <code>prompt</code> sind gesperrt.`,
      'Alle Dialoginhalte aus Skripten werden als HTML behandelt und vor Anzeige bereinigt. Script-Tags, iframes, Event-Handler und unsichere Links werden entfernt.',
      `<code>client.query</code> und <code>client.mutate</code> geben immer ein Tupel zurück: Das erste Element enthält Daten, das zweite einen Fehler oder <code>null</code>. Prüfe den Fehler und wirf ihn bewusst, damit die Ausführung sauber abbricht.`,
      'Die Beispiele unten sind echte ausführbare Skripte. Du kannst sie im Editor verändern und direkt starten; gespeichert werden Änderungen dort nicht.',
    ],
    scriptExamples: [
      {
        title: 'Bestätigung anzeigen',
        description: `Nutzt <code>sortsys-popups</code>. HTML im <code>content</code>-Feld wird bereinigt, bevor der Dialog angezeigt wird.`,
        code: `const { requireConfirmation } = await import('sortsys-popups');
const { log } = await import('sortsys-log');

const confirmed = await requireConfirmation({
  title: 'Skript-Beispiel',
  content: '<p>HTML ist erlaubt, aber <b>bereinigt</b>.</p><script>alert("entfernt")</script>',
  buttonText: 'Verstanden',
});

await log({ confirmed });
`,
      },
      {
        title: 'TRPC-Daten lesen',
        description: `Nutzt <code>sortsys-client</code>. Jede Abfrage liefert <code>[daten, fehler]</code>; Fehler sollten explizit geworfen werden.`,
        code: `const { client } = await import('sortsys-client');
const { requireConfirmation } = await import('sortsys-popups');

const [sessionInfo, err] = await client.query('auth.sessionInfo', undefined, { strategy: 'network-first' });
if (err) throw new Error(err.message);

const user = /** @type {any} */ (sessionInfo)?.user;
await requireConfirmation({
  title: 'Sitzung geladen',
  content: \`<p>Angemeldet als <b>\${user?.name ?? 'unbekannt'}</b>.</p>\`,
  buttonText: 'OK',
});
`,
      },
      {
        title: 'Modal-Formular öffnen',
        description: `Nutzt <code>sortsys-modal-forms</code> mit Pflichtfeld, Validierung und gefilterten Optionen.`,
        code: `const { showModalForm } = await import('sortsys-modal-forms');
const { requireConfirmation } = await import('sortsys-popups');
const { escapeHtml } = await import('sortsys-utils');

const values = await showModalForm({
  title: 'Skript-Formular',
  content: '<p>Formularwerte werden an das Skript zurückgegeben.</p>',
  primaryButtonText: 'Übernehmen',
  fields: [
    {
      name: 'title',
      label: 'Titel',
      required: true,
      placeholder: 'Kurzer Titel',
      validate(value) {
        if (String(value ?? '').trim().length < 3) return 'Titel braucht mindestens 3 Zeichen.';
        return null;
      },
    },
    {
      name: 'audience',
      label: 'Zielgruppe',
      type: 'select',
      options: ['Bauleitung', 'Lager', 'Büro', 'Geschäftsführung'],
      filterOptions(query) {
        const lower = query.toLowerCase();
        return ['Bauleitung', 'Lager', 'Büro', 'Geschäftsführung'].filter(item => item.toLowerCase().includes(lower));
      },
    },
    { name: 'note', label: 'Notiz', type: 'textarea' },
  ],
});

if (values) {
  await requireConfirmation({
    title: 'Formularwerte',
    content: \`<pre>\${escapeHtml(JSON.stringify(values, null, 2))}</pre>\`,
    buttonText: 'OK',
  });
}
`,
      },
      {
        title: 'Hilfsfunktionen nutzen',
        description: `Nutzt <code>sortsys-utils</code> für HTML-Escaping, URL-Encoding, UTF-8/Base64 und einfache Statistik.`,
        code: `const {
  escapeHtml,
  fromBase64Url,
  mean,
  median,
  sleep,
  sum,
  toBase64Url,
  urlEncode,
  utf8Decode,
  utf8Encode,
} = await import('sortsys-utils');
const { requireConfirmation } = await import('sortsys-popups');

const values = [7.5, 8, 6.25, 9];
const label = 'Regie & Material';
const encoded = toBase64Url(utf8Encode(label));
const decoded = utf8Decode(fromBase64Url(encoded));

await sleep(250);

await requireConfirmation({
  title: 'Utils',
  content: [
    '<p><b>' + escapeHtml(label) + '</b></p>',
    '<ul>',
    '<li>URL: <code>' + urlEncode(label) + '</code></li>',
    '<li>Base64URL: <code>' + encoded + '</code></li>',
    '<li>Roundtrip: <code>' + escapeHtml(decoded) + '</code></li>',
    '<li>Summe: <b>' + sum(...values) + '</b></li>',
    '<li>Mittelwert: <b>' + mean(...values) + '</b></li>',
    '<li>Median: <b>' + median(...values) + '</b></li>',
    '</ul>',
  ].join(''),
  buttonText: 'OK',
});
`,
      },
      {
        title: 'Sandbox prüfen',
        description: 'Zeigt, dass Seiten- und Browser-Globals im Skript nicht verfügbar sind.',
        code: `const { requireConfirmation } = await import('sortsys-popups');

const blocked = name => Reflect.get(globalThis, name);

await requireConfirmation({
  title: 'Sandbox',
  content: \`
    <ul>
      <li>window: <b>\${typeof blocked('window')}</b></li>
      <li>self: <b>\${typeof blocked('self')}</b></li>
      <li>document: <b>\${typeof blocked('document')}</b></li>
      <li>localStorage: <b>\${typeof blocked('localStorage')}</b></li>
      <li>setTimeout: <b>\${typeof blocked('setTimeout')}</b></li>
      <li>fetch: <b>\${typeof blocked('fetch')}</b></li>
    </ul>
  \`,
  buttonText: 'OK',
});
`,
      },
    ],
    faqs: [
      {
        question: 'Warum funktionieren normale Imports nicht?',
        answer: [
          'Die Skripte werden vor der Ausführung geprüft. Statische Imports würden beliebigen Code oder Browserpakete öffnen. Darum sind nur dynamische Imports der freigegebenen Module erlaubt.',
        ],
      },
      {
        question: 'Kann ein Skript direkt auf die Seite zugreifen?',
        answer: [
          `Nein. Es läuft in einem Worker ohne <code>window</code>, <code>document</code>, DOM, Storage oder <code>fetch</code>. Kommunikation läuft nur über die freigegebenen Bridge-Module.`,
        ],
      },
      {
        question: `Wann brauche ich <code>requireDangerConfirmation</code>?`,
        answer: [
          'Für Aktionen, die Daten verändern, löschen oder schwer rückgängig zu machen sind. Der Dialog sieht gefährlicher aus und zwingt zu einer bewussteren Bestätigung.',
        ],
      },
    ],
    keywords: ['skript', 'scripts', 'javascript', 'automation', 'sandbox', 'trpc', 'client', 'popup', 'modal', 'form', 'worker', 'utils', 'base64'],
  },
  {
    id: 'projekt',
    title: 'Projekt',
    lead: 'Ein Projekt ist ein Auftrag oder eine Baustelle, auf die operative Vorgänge gebucht werden.',
    category: 'Stammdaten',
    paragraphs: [
      'Ein Projekt bündelt alle Informationen, die zu einem Auftrag oder einer Baustelle gehören. Es ist die zentrale Akte für operative Arbeit, Nachweise und Auswertungen.',
      'Beim Anlegen genügen ein eindeutiger Titel und die Angaben, die bereits feststehen. Auftragsdatum, Kunde, Baustellenadresse, verantwortlicher Projektleiter und Ansprechpartner können später ergänzt oder korrigiert werden.',
      'Zum Projekt gehören Kunde, Adresse, verantwortliche Personen, Einsatzplanung, Dateien, Bautagesberichte, Regieberichte, Lieferscheine, Werkzeugbuchungen und Kosten. Diese Daten werden getrennt erfasst, aber über das Projekt gemeinsam auffindbar.',
      'Die Projektadresse beschreibt den Ort der Leistung. Sie kann von der Kundenadresse abweichen, wenn ein Kunde mehrere Baustellen oder Niederlassungen hat.',
      'Ansprechpartner lassen sich mit einer Rolle am Projekt hinterlegen, etwa Bauherr, Architekt oder Bauleitung. Derselbe Kontakt kann in mehreren Projekten verwendet werden, ohne seine Telefonnummern und E-Mail-Adressen mehrfach zu pflegen.',
      'Projektzuweisungen bestimmen, welche Personen fachlich mit dem Projekt verbunden sind. Sie helfen bei Einsatzplanung, eingeschränkter Projektsicht und Zuordnung von Verantwortung.',
      'Bautagesberichte dokumentieren den normalen Fortschritt auf dem Projekt. Regieberichte dokumentieren Zusatzleistungen. Lieferscheine dokumentieren Material. Werkzeugbuchungen zeigen, welche Werkzeuge auf dem Projekt eingesetzt oder dorthin übergeben wurden.',
      'Im Dateibereich liegen Baustellenfotos und andere Dokumente getrennt. Zeichnungen können dort ebenfalls abgelegt und, sofern das Format unterstützt wird, direkt betrachtet werden.',
      'Die Kostenübersicht entsteht aus gebuchten Vorgängen und hinterlegten Preisen. Sie ist keine eigene Datenerfassung, sondern eine Zusammenstellung aus Material, Arbeitszeit, Werkzeugkosten, Sonderposten, Angeboten, Rechnungen und Gemeinkosten.',
      'Angebots- und Rechnungssummen sowie Material-, Arbeitszeit-, Werkzeug- und sonstige Kosten werden netto geführt. Fehlende Produktpreise, Stundensätze oder Werkzeugtagessätze führen deshalb zu unvollständigen Kosten, nicht zu einem Ersatzwert.',
      'Ein abgeschlossenes Projekt bleibt im System erhalten. Der Abschluss markiert, dass die laufende Bearbeitung beendet ist; Nachweise, Dateien und Kosteninformationen bleiben für Rückfragen verfügbar.',
      'Sinnvoll ist ein Projektname, der Auftrag, Ort oder Baustelle eindeutig erkennbar macht. Das erleichtert Suche, mobile Auswahl und spätere Auswertung.',
    ],
    faqs: [
      {
        question: 'Wann wird ein neues Projekt angelegt?',
        answer: [
          'Ein neues Projekt wird angelegt, wenn Vorgänge getrennt nach Auftrag, Baustelle oder Kostenstelle ausgewertet werden sollen. Mehrere kleine Arbeiten können in einem Projekt bleiben, wenn sie fachlich zusammengehören.',
        ],
      },
      {
        question: 'Was passiert beim Abschließen eines Projekts?',
        answer: [
          'Das Projekt verschwindet aus laufenden Arbeitslisten, bleibt aber für Suche, Nachweise und Auswertungen erhalten. Bestehende Berichte und Belege werden nicht gelöscht.',
        ],
      },
      {
        question: 'Warum sehe ich ein Projekt nicht?',
        answer: [
          'Mögliche Gründe sind fehlende Rechte, eine fehlende Projektzuweisung oder ein Filter auf aktive Projekte. Benutzer mit allgemeiner Projektsicht sehen mehr als Benutzer, die nur eigene Projekte sehen dürfen.',
        ],
      },
      {
        question: 'Wo lege ich Baustellenfotos ab?',
        answer: [
          'Fotos zum Ablauf eines bestimmten Tages gehören an den Bautagesbericht. Allgemeine Aufnahmen, Pläne und Unterlagen werden im Dateibereich des Projekts abgelegt.',
        ],
      },
      {
        question: 'Warum sind die Projektkosten unvollständig?',
        answer: [
          'Prüfe fehlende Einkaufspreise, Stundensätze, Werkzeugtagessätze und Projektzuordnungen. Die Übersicht kann nur Vorgänge bewerten, für die ein Nettopreis oder Kostensatz vorliegt.',
        ],
      },
    ],
    keywords: ['auftrag', 'baustelle', 'kunde', 'adresse', 'kosten', 'netto', 'datei', 'foto', 'projektleiter', 'projektakte', 'projektzuweisung', 'abschluss'],
  },
  {
    id: 'bautagesbericht',
    title: 'Bautagesbericht',
    lead: 'Ein Bautagesbericht dokumentiert die Arbeiten eines einzelnen Tages auf einem Projekt.',
    category: 'Baustelle',
    paragraphs: [
      'Der Bautagesbericht beschreibt einen Kalendertag auf einem Projekt. Er enthält Datum, ausgeführte Arbeiten, Wetter und Arbeitszeiten.',
      'Fotos können direkt am Bericht abgelegt werden. Zusammen mit Wetterangaben und Arbeitszeiten bilden sie den Stand dieses Tages ab; allgemeine Projektdateien gehören dagegen in den Dateibereich des Projekts.',
      'Der Bericht gehört immer zu einem Projekt. Dadurch werden Tagesnachweise später in der Projektakte, in Exporten und in der Kostenübersicht wiedergefunden.',
      'Pro Projekt und Tag soll es einen eindeutigen Tagesbericht geben. Das verhindert doppelte Nachweise und hält Wochenexporte sauber.',
      'Wird ein bestehender Tagesbericht korrigiert, bleibt er demselben Projekt und Kalendertag zugeordnet. Für eine Ergänzung ist daher kein zweiter Bericht nötig.',
      'Arbeitszeiten im Bautagesbericht beschreiben reguläre Projektarbeit. Zusatzleistungen, die separat freigegeben oder abgerechnet werden müssen, gehören in einen Regiebericht.',
      'Jeder Arbeitszeiteintrag nennt eine Person und die geleisteten Stunden. Die hinterlegten Stunden fließen mit dem für die Person gültigen Kostensatz in die Projektkosten ein.',
      'Ein guter Tagesbericht nennt die erledigten Arbeiten konkret genug, damit Büro, Bauleitung oder Auftraggeber den Fortschritt später nachvollziehen können.',
      'Wetter und Fotos sollten nur den dokumentierten Tag betreffen. Eine kurze Bildauswahl ist später hilfreicher als viele beinahe gleiche Aufnahmen ohne erkennbaren Bezug zur beschriebenen Arbeit.',
      'Der Bauwochenbericht ist eine Eingabehilfe für mehrere Tagesberichte. Gespeichert bleiben einzelne Bautagesberichte pro Tag und Projekt.',
    ],
    faqs: [
      {
        question: 'Wann reicht ein Bautagesbericht?',
        answer: [
          'Er reicht für normale Tagesdokumentation auf einem Projekt. Sobald eine Leistung separat nach Aufwand nachgewiesen werden muss, wird zusätzlich ein Regiebericht erfasst.',
        ],
      },
      {
        question: 'Warum muss ein Projekt ausgewählt werden?',
        answer: [
          'Ohne Projekt wäre der Bericht fachlich nicht zuordenbar. Projektbezug steuert Suche, Export, Kostenübersicht und spätere Prüfung.',
        ],
      },
      {
        question: 'Was ist der Bauwochenbericht?',
        answer: [
          'Er ist eine gemeinsame Eingabemaske für mehrere Tage. Nach dem Speichern entstehen weiterhin einzelne Bautagesberichte je Projekt und Kalendertag.',
        ],
      },
      {
        question: 'Kann ich einen Bericht für die Zukunft anlegen?',
        answer: [
          'Nein. Ein Bautagesbericht hält tatsächlich ausgeführte Arbeit fest und kann deshalb nicht auf einen zukünftigen Kalendertag datiert werden.',
        ],
      },
    ],
    keywords: ['tagesbericht', 'bauwochenbericht', 'wetter', 'foto', 'arbeitszeit', 'kostensatz', 'nachweis', 'projekt', 'fortschritt'],
  },
  {
    id: 'regiebericht',
    title: 'Regiebericht',
    lead: 'Ein Regiebericht dokumentiert zusätzliche Leistungen, die nach Aufwand nachgewiesen werden.',
    category: 'Baustelle',
    paragraphs: [
      'Ein Regiebericht dokumentiert Leistungen, die zusätzlich oder nach Aufwand nachgewiesen werden. Er enthält Projekt, Datum, Beschreibung, Arbeitszeit, Material und freie Sonderpositionen.',
      'Der Bericht bezieht sich auf eine Kalenderwoche. Im Feld Woche kann ein beliebiger Tag dieser Woche gewählt werden; Arbeitszeiten werden anschließend einem Wochentag von Montag bis Sonntag zugeordnet.',
      'Der Projektbezug ist wichtig, weil Regieleistungen später zusammen mit anderen Projektdaten geprüft werden. Auftrag, Baustelle und Kunde ergeben sich aus dem Projekt.',
      'Regieberichte unterscheiden sich von Bautagesberichten. Der Bautagesbericht beschreibt den allgemeinen Baustellentag; der Regiebericht beschreibt eine prüfbare Zusatzleistung.',
      'Wenn dieselben Stunden sowohl im Bautagesbericht als auch im Regiebericht erfasst werden, erscheinen sie in beiden Nachweisen und können Kosten doppelt abbilden. Reguläre und zusätzliche Arbeitszeit sollten deshalb sauber getrennt werden.',
      'Die Beschreibung sollte Leistung, Anlass und Umfang benennen. Kurze, konkrete Formulierungen erleichtern Freigabe, Rückfrage und Abrechnung.',
      'Material im Regiebericht kann aus Produktstämmen oder freien Sonderpositionen bestehen. Produktstämme helfen bei einheitlicher Benennung und Kostenfortschreibung.',
      'Bei Produkten werden Menge und Einheit erfasst. Freie Sonderpositionen bestehen aus Bezeichnung, Menge und Einheit und sind für Einträge gedacht, die nicht im Produktstamm stehen.',
      'Regieberichte bleiben Teil der Projektakte. Sie können separat geöffnet, exportiert und im Projektkontext gefunden werden.',
      'Vor dem Export sollten Woche, Personen, Stunden und Mengen noch einmal geprüft werden. Der erzeugte Nachweis verwendet den aktuell gespeicherten Stand des Berichts.',
    ],
    faqs: [
      {
        question: 'Wann wird kein Regiebericht benötigt?',
        answer: [
          'Wenn Arbeit nur den normalen Tagesfortschritt beschreibt und keine separate Freigabe oder Abrechnung braucht, genügt der Bautagesbericht.',
        ],
      },
      {
        question: 'Was gehört in die Beschreibung?',
        answer: [
          'Die Beschreibung sollte sagen, welche Zusatzleistung ausgeführt wurde, warum sie nötig war und worauf sich Mengen oder Stunden beziehen.',
        ],
      },
      {
        question: 'Welches Datum wähle ich im Feld Woche?',
        answer: [
          'Wähle einen beliebigen Tag der betreffenden Woche. sortsys ordnet den Bericht der Kalenderwoche von Montag bis Sonntag zu.',
        ],
      },
      {
        question: 'Warum fehlen Kosten an einer Position?',
        answer: [
          'Die Kostenanzeige des Regieberichts bewertet Produktpositionen, wenn ein gültiger Einkaufspreis vorliegt. Arbeitszeiten und freie Sonderpositionen bleiben im Nachweis enthalten, werden dort aber nicht mit einem eigenen Preis bewertet.',
        ],
      },
    ],
    keywords: ['regie', 'kalenderwoche', 'montag', 'zusatzleistung', 'abrechnung', 'sonderposition', 'netto', 'nachweis', 'projekt', 'freigabe'],
  },
  {
    id: 'lieferschein',
    title: 'Lieferschein',
    lead: 'Ein Lieferschein ordnet Material und Mengen einem Projekt zu.',
    category: 'Material',
    paragraphs: [
      'Ein Lieferschein dokumentiert Materialbewegungen für ein Projekt. Er enthält Projekt, Nummer, Datum, Produkte, Mengen, Kommentare und freie Positionen.',
      'Das Belegdatum bestimmt, wann die Lieferung dem Projekt zugerechnet wird. Ein Kommentar eignet sich für Lieferant, Ablageort oder Abweichungen, die nicht Teil einer Materialposition sind.',
      'Der Projektbezug ordnet den Materialvorgang der richtigen Baustelle zu. Dadurch erscheinen Lieferungen in der Projektakte und können in Kostenübersichten berücksichtigt werden.',
      'Produkte aus dem Stamm sorgen für einheitliche Benennung, Suche und Preise. Freie Positionen sind nützlich, wenn Material einmalig ist oder noch kein Produktstamm existiert.',
      'Mengen können in einer passenden Produkteinheit eingegeben werden. Für Berechnung und Vergleich rechnet sortsys sie über den hinterlegten Faktor in die Basiseinheit des Produkts um.',
      'Die Lieferscheinnummer ist ein wichtiges Suchmerkmal. Sie hilft bei Rückfragen, Rechnungsprüfung und Abgleich mit Papierbelegen oder Lieferantenunterlagen.',
      'Die Nummer sollte mit dem externen Beleg übereinstimmen. Interne Hinweise gehören in den Kommentar, damit die Belegnummer bei Suche und Rechnungsabgleich unverändert bleibt.',
      'Ein Lieferschein ist kein Rechnungsdokument. Er beschreibt zuerst den Materialvorgang; Kosten und Rechnungen werden daraus geprüft oder abgeleitet.',
      'Für Produktpositionen werden die passenden Einkaufspreise aus dem Preisverlauf verwendet. Freie Positionen tragen ihren eigenen Nettopreis. Fehlt ein Preis, kann die Position dokumentiert werden, ihre Kosten bleiben aber offen.',
      'Korrekte Projektzuordnung ist wichtiger als lange Kommentare. Ein falsch zugeordnetes Material verfälscht Projektkosten und erschwert spätere Suche.',
    ],
    faqs: [
      {
        question: 'Kann ein Lieferschein ohne Projekt erfasst werden?',
        answer: [
          'Nein. Material soll immer einem Projekt zugeordnet werden, damit Nachweis, Suche und Kostenübersicht stimmen.',
        ],
      },
      {
        question: 'Wann nutze ich freie Positionen?',
        answer: [
          'Freie Positionen passen für einmaliges Material oder Leistungen, die nicht als Produktstamm gepflegt werden sollen.',
        ],
      },
      {
        question: 'Warum wird eine Menge anders angezeigt als eingegeben?',
        answer: [
          'Das Produkt kann eine andere Basiseinheit haben. sortsys rechnet die gewählte Einheit mit dem hinterlegten Faktor um und kann die Menge anschließend in einer passenden Einheit darstellen.',
        ],
      },
      {
        question: 'Warum hat eine Produktposition keine Kosten?',
        answer: [
          'Für den Belegzeitpunkt wurde kein passender Einkaufspreis gefunden. Ergänze den Preisverlauf am Produkt oder verwende bei einer freien Position einen eigenen Nettopreis.',
        ],
      },
    ],
    keywords: ['material', 'lieferung', 'lieferscheinnummer', 'einheit', 'einkaufspreis', 'produkt', 'kosten', 'rechnung', 'beleg', 'projekt'],
  },
  {
    id: 'werkzeugbuchung',
    title: 'Werkzeugbuchung',
    lead: 'Eine Werkzeugbuchung hält fest, wo ein Werkzeug ist und wer verantwortlich ist.',
    category: 'Werkzeuge',
    paragraphs: [
      'Werkzeugbuchungen entstehen bei Ausgabe, Rücknahme oder Umbuchung. Sie verbinden Werkzeug, verantwortliche Person, Projekt und Zeitraum.',
      'Der Werkzeugstatus beschreibt den Zustand unabhängig von der Buchung. Verfügbar, nicht verfügbar, defekt oder verloren sagt daher nicht automatisch, bei welcher Person oder auf welchem Projekt das Werkzeug gebucht ist.',
      'Der Projektbezug beschreibt, auf welcher Baustelle ein Werkzeug eingesetzt wird. Das hilft Bauleitung, Lager und Büro bei Suche, Verantwortung und Kostenbetrachtung.',
      'Aktive Buchungen zeigen den aktuellen Standort und die Zuständigkeit. Abgeschlossene Buchungen bilden die Historie eines Werkzeugs ab.',
      'Eine Inventur hält fest, wann ein Werkzeug zuletzt geprüft wurde und welche Auffälligkeiten bestanden. Sie ersetzt keine Rückgabe oder Umbuchung, wenn sich Verantwortung oder Projekt geändert haben.',
      'Wenn ein Werkzeug auf ein anderes Projekt wechselt, sollte die Buchung angepasst werden. Sonst zeigt die Historie später falsche Projektkosten oder falsche Verantwortung.',
      'Umbuchungsanfragen unterstützen kontrollierte Übergaben. Sie verhindern, dass Werkzeug praktisch weitergegeben wurde, im System aber noch beim alten Verantwortlichen liegt.',
      'Bei einer angefragten Übergabe bleibt die bisherige Buchung bestehen, bis die Anfrage bearbeitet wurde. So ist auch während der Abstimmung eine verantwortliche Person hinterlegt.',
      'Werkzeugkosten können aus Buchungen in Projektkosten einfließen, wenn Kostensätze gepflegt sind. Dafür müssen Zeitraum und Projekt stimmen.',
      'Für die Kostenberechnung wird der Nutzungssatz pro Tag verwendet. Kaufpreis und Nutzungssatz sind Nettobeträge und erfüllen unterschiedliche Zwecke: Inventarwert und laufende Projektkosten.',
    ],
    faqs: [
      {
        question: 'Wer ist verantwortlich?',
        answer: [
          'Verantwortlich ist die Person in der aktiven Buchung. Sie muss nicht zwingend Projektleiter sein, sondern die Person, die Werkzeug aktuell führt oder verwaltet.',
        ],
      },
      {
        question: 'Warum ist das Projekt wichtig?',
        answer: [
          'Das Projekt zeigt, wo das Werkzeug fachlich eingesetzt wird. Ohne diese Zuordnung sind Suche, Kosten und Baustellenübersicht ungenau.',
        ],
      },
      {
        question: 'Ändert eine Inventur die Werkzeugbuchung?',
        answer: [
          'Nein. Eine Inventur dokumentiert Prüfung und Zustand. Für einen Wechsel von Person oder Projekt ist weiterhin eine Rückgabe, Buchung oder Umbuchung erforderlich.',
        ],
      },
      {
        question: 'Was ist der Unterschied zwischen Status und Buchung?',
        answer: [
          'Der Status beschreibt den Zustand des Werkzeugs. Die Buchung nennt Verantwortlichen, Projekt und Zeitraum. Beide Angaben werden getrennt gepflegt.',
        ],
      },
    ],
    keywords: ['werkzeug', 'tracking', 'inventur', 'status', 'tagessatz', 'ausgabe', 'rücknahme', 'umbuchung', 'verantwortlich', 'projekt', 'lager'],
  },
  {
    id: 'einsatzplanung',
    title: 'Einsatzplanung',
    lead: 'Die Einsatzplanung ordnet Personen für Zeiträume Projekten zu.',
    category: 'Planung',
    paragraphs: [
      'Einsatzplanung beschreibt geplante Verfügbarkeit und Projektzuweisung. Sie ist keine Zeiterfassung und ersetzt keine Arbeitszeit im Bautagesbericht oder Regiebericht.',
      'Die Ansicht kann tage- oder wochenweise sowie nach Projekten oder Benutzern gegliedert werden. Die Daten bleiben gleich; nur die Blickrichtung auf den Plan ändert sich.',
      'Eine Planung verbindet Person, Zeitraum und Projekt. Sie zeigt, wer wann auf welcher Baustelle eingeplant ist.',
      'Ein Einsatz kann mehrere Tage umfassen und einen Kommentar tragen. Für kurze Änderungen lässt er sich direkt im gewählten Zeitraum bearbeiten, ohne einen neuen Eintrag anzulegen.',
      'Projektzuweisungen helfen bei Wochenplanung, Kapazitätsprüfung und Abstimmung zwischen Bauleitung, Büro und Teams.',
      'Abwesenheiten werden gemeinsam mit Projektplanung betrachtet. Dadurch werden Doppelbelegungen und Konflikte früher sichtbar.',
      'Neben Urlaub werden auch Unterbrechungen eines Projekts angezeigt. Überschneidungen mit Urlaub oder einer Projektunterbrechung sind im Plan markiert und sollten vor der Einsatzbestätigung geprüft werden.',
      'Planung und Ist-Dokumentation bleiben getrennt. Was geplant war, steht in der Einsatzplanung; was tatsächlich passiert ist, steht in Tages- oder Regieberichten.',
      'Eine Warnung im Plan ändert weder Urlaub noch Unterbrechung automatisch. Der zuständige Planer entscheidet, ob der Einsatz verschoben, gekürzt oder bewusst beibehalten wird.',
      'Wenn ein Projekt abgeschlossen ist, sollte es nicht weiter als laufende Einsatzstelle genutzt werden. Offene Planungen sollten geprüft oder angepasst werden.',
      'Für Besprechungen oder die Weitergabe an Teams kann der sichtbare Plan als PDF exportiert werden. Exportiert wird der aktuell gewählte Tag oder die aktuell gewählte Woche.',
    ],
    faqs: [
      {
        question: 'Ist Einsatzplanung Arbeitszeit?',
        answer: [
          'Nein. Sie zeigt geplante Zuweisung. Tatsächliche Stunden werden über Bautagesberichte oder Regieberichte dokumentiert.',
        ],
      },
      {
        question: 'Was bedeutet eine Warnung an einem Einsatz?',
        answer: [
          'Für denselben Zeitraum liegt Urlaub oder eine Projektunterbrechung vor. Der Eintrag bleibt bestehen, bis ein Planer ihn prüft und gegebenenfalls ändert.',
        ],
      },
      {
        question: 'Wann nutze ich Projekt- und wann Benutzerzeilen?',
        answer: [
          'Projektzeilen zeigen die Besetzung einer Baustelle. Benutzerzeilen zeigen, wie eine einzelne Person über Projekte und Abwesenheiten verteilt ist.',
        ],
      },
      {
        question: 'Was ist eine Projektunterbrechung?',
        answer: [
          'Sie sperrt einen Zeitraum am Projekt, etwa wegen Stillstand oder fehlender Zugänglichkeit. Betroffene Einsätze werden in der Planung als Konflikt markiert.',
        ],
      },
    ],
    keywords: ['planung', 'tag', 'woche', 'konflikt', 'unterbrechung', 'pdf', 'projektzuweisung', 'kapazität', 'urlaub', 'verfügbarkeit', 'projekt', 'baustelle'],
  },
  {
    id: 'urlaub',
    title: 'Urlaub',
    lead: 'Urlaub beschreibt geplante Abwesenheit einer Person.',
    category: 'Personal',
    paragraphs: [
      'Urlaubseinträge enthalten Zeitraum, Status und optional eine Notiz. Sie können angefragt, genehmigt oder abgelehnt werden.',
      'Von und Bis bezeichnen den ersten und letzten Abwesenheitstag. Für einzelne freie Tage werden beide Felder auf denselben Kalendertag gesetzt.',
      'Genehmigte Abwesenheiten beeinflussen die Einsatzplanung. Personen sollen nicht auf Projekte geplant werden, wenn sie nicht verfügbar sind.',
      'Auch beantragter Urlaub ist in der Einsatzplanung erkennbar, wird dort aber als Antrag gekennzeichnet. Erst die Entscheidung macht aus dem Antrag eine genehmigte oder abgelehnte Abwesenheit.',
      'Abwesenheiten sind kein Projektvorgang. Sie wirken aber indirekt auf Projekte, weil verfügbare Kapazität für Baustellenplanung fehlt.',
      'Ein Antrag bleibt der Person zugeordnet, unabhängig davon, auf welchen Projekten sie gerade eingeplant ist. Konflikte werden im Plan angezeigt und nicht durch eine automatische Umbuchung gelöst.',
      'Die Entscheidung liegt bei Vorgesetzten oder Benutzern mit entsprechender Berechtigung. Dadurch bleibt der Stand der Abwesenheiten nachvollziehbar.',
      'Eine Notiz sollte nur Angaben enthalten, die für die Entscheidung oder Vertretung gebraucht werden. Private Details zur Abwesenheit gehören nicht in den Urlaubsantrag.',
    ],
    faqs: [
      {
        question: 'Was ist der Unterschied zwischen beantragt und genehmigt?',
        answer: [
          'Beantragt bedeutet, dass die Entscheidung noch aussteht. Genehmigter Urlaub gilt als bestätigte Abwesenheit; ein abgelehnter Antrag wird nicht als Urlaub eingeplant.',
        ],
      },
      {
        question: 'Warum erscheint ein Antrag schon in der Einsatzplanung?',
        answer: [
          'Planer sollen mögliche Engpässe vor der Entscheidung sehen. Der Eintrag ist dort ausdrücklich als beantragt gekennzeichnet.',
        ],
      },
      {
        question: 'Wer darf über Urlaub entscheiden?',
        answer: [
          'Vorgesetzte und Benutzer mit den passenden Urlaubsrechten können Anträge bearbeiten. Fehlt diese Berechtigung, kann ein Antrag nicht genehmigt oder abgelehnt werden.',
        ],
      },
    ],
    keywords: ['abwesenheit', 'ferien', 'beantragt', 'genehmigt', 'abgelehnt', 'genehmigung', 'vorgesetzter', 'planung', 'projektkapazität'],
  },
  {
    id: 'produkt',
    title: 'Produkt',
    lead: 'Ein Produkt ist ein Material- oder Artikelstamm für Belege und Berichte.',
    category: 'Stammdaten',
    paragraphs: [
      'Produkte werden in Lieferscheinen und Regieberichten verwendet. Sie sorgen dafür, dass Material einheitlich benannt und gesucht werden kann.',
      'Hersteller, Kategorien und Beschreibung erleichtern Filter und Suche. Die Produktnummer sollte dauerhaft dasselbe Material bezeichnen, damit ältere Belege verständlich bleiben.',
      'Ein Produkt hat eine Basiseinheit und kann zusätzliche Einheiten besitzen. Das unterstützt verschiedene Mengenangaben im Alltag.',
      'Bei einer zusätzlichen Einheit wird hinterlegt, wie viele Basiseinheiten sie enthält. Der Faktor sollte vor der ersten Verwendung geprüft werden, weil eine spätere Änderung bereits erfasste Mengen anders lesbar machen kann.',
      'Preise werden als eigene Preisdatensätze geführt. Dadurch kann sich der Preis über die Zeit ändern, ohne den Produktstamm umzuschreiben.',
      'Ein Preisdatensatz enthält einen Gültigkeitszeitpunkt und kann einem Händler zugeordnet sein. Die Preisliste bleibt als Verlauf erhalten; ein neuer Einkaufspreis überschreibt ältere Werte nicht.',
      'Produkte haben keinen festen Projektbezug. Der Projektbezug entsteht erst, wenn ein Produkt in einem Lieferschein oder Regiebericht verwendet wird.',
      'Saubere Produktstämme verbessern Projektkosten, weil Material in verschiedenen Projekten gleich benannt und ausgewertet wird.',
      'Einkaufspreise und freie Positionspreise werden netto erfasst. Ohne passenden Preis bleibt das Material im Beleg sichtbar, kann in der Kostenübersicht aber nicht vollständig bewertet werden.',
    ],
    faqs: [
      {
        question: 'Wann wird ein neues Produkt angelegt?',
        answer: [
          'Wenn Material regelmäßig verwendet, gesucht oder kalkuliert werden soll. Einmalige Positionen können als freie Position erfasst werden.',
        ],
      },
      {
        question: 'Soll ich einen alten Preis überschreiben?',
        answer: [
          'Nein. Lege einen neuen Preisdatensatz mit dem passenden Gültigkeitszeitpunkt an. So bleiben frühere Einkaufspreise für ältere Belege erhalten.',
        ],
      },
      {
        question: 'Welche Einheit ist die Basiseinheit?',
        answer: [
          'Das ist die Einheit, in der Mengen intern verglichen und Kosten berechnet werden. Weitere Einheiten werden mit einem festen Faktor darauf umgerechnet.',
        ],
      },
    ],
    keywords: ['material', 'artikel', 'hersteller', 'kategorie', 'händler', 'preis', 'netto', 'einheit', 'produktstamm', 'projektkosten'],
  },
  {
    id: 'kunde',
    title: 'Kunde',
    lead: 'Ein Kunde ist eine Organisation oder Person, für die Projekte angelegt werden.',
    category: 'Stammdaten',
    paragraphs: [
      'Kunden bündeln Projekte nach Auftraggeber. Sie helfen, Projektlisten, Kommunikation und Auswertungen fachlich zu ordnen.',
      'Telefonnummern und E-Mail-Adressen können mit Bezeichnungen wie Zentrale, Buchhaltung oder Mobil gespeichert werden. So bleibt bei mehreren Einträgen erkennbar, welcher Kontaktweg wofür gedacht ist.',
      'Kundendaten enthalten Name, Anrede und Adresse. Die Projektadresse kann davon abweichen, wenn ein Kunde mehrere Baustellen hat.',
      'Die Kundenanschrift wird auf der Kundenseite angezeigt und kann direkt in einer Kartenanwendung geöffnet werden. Für die Anfahrt zur Baustelle ist weiterhin die Projektadresse maßgeblich.',
      'Ein Kunde ist nicht identisch mit einem Projekt. Der Kunde beschreibt den Auftraggeber; das Projekt beschreibt den konkreten Auftrag oder die Baustelle.',
      'Mehrere Projekte können demselben Kunden zugeordnet sein. Dadurch bleiben wiederkehrende Auftraggeber zusammen sichtbar, ohne Projektakten zu vermischen.',
      'Auf der Kundenseite sind die zugeordneten Projekte zusammengefasst. Ein neues Projekt sollte deshalb dem vorhandenen Kunden zugeordnet werden, statt für denselben Auftraggeber einen zweiten Kunden anzulegen.',
      'Kontakte werden getrennt vom Kunden gepflegt. Ein Kunde kann mehrere Ansprechpartner haben, und Kontakte können in unterschiedlichen Zusammenhängen verwendet werden.',
      'Direkte Telefonnummern am Kunden passen für allgemeine Stellen. Namentliche Ansprechpartner werden als Kontakte angelegt und anschließend mit dem Kunden oder einzelnen Projekten verknüpft.',
    ],
    faqs: [
      {
        question: 'Wann unterscheidet sich Kundenadresse von Projektadresse?',
        answer: [
          'Typisch bei Verwaltungen, Firmenzentralen oder Auftraggebern mit mehreren Baustellen. Die Kundenadresse bleibt Stammdatum, die Projektadresse beschreibt den Leistungsort.',
        ],
      },
      {
        question: 'Wann verwende ich einen vorhandenen Kunden?',
        answer: [
          'Wenn Auftraggeber und Stammdaten bereits bestehen, ordne das neue Projekt diesem Kunden zu. Ein zweiter Kundeneintrag würde Projekte und Kommunikation unnötig aufteilen.',
        ],
      },
      {
        question: 'Wann lege ich zusätzlich einen Kontakt an?',
        answer: [
          'Für eine namentliche Person mit eigener Erreichbarkeit. Allgemeine Nummern und Adressen wie Zentrale oder Buchhaltung können direkt am Kunden bleiben.',
        ],
      },
    ],
    keywords: ['auftraggeber', 'organisation', 'kunde', 'telefon', 'email', 'ansprechpartner', 'projekt', 'adresse', 'baustelle'],
  },
  {
    id: 'kontakt',
    title: 'Kontakt',
    lead: 'Ein Kontakt ist eine erreichbare Person mit Kommunikationsdaten.',
    category: 'Stammdaten',
    paragraphs: [
      'Kontakte speichern Ansprechpartner mit Telefonnummern und E-Mail-Adressen. Sie können Kunden oder Projekten zugeordnet werden.',
      'Neben Telefon und E-Mail kann ein Kontakt eine eigene Anschrift besitzen. Bezeichnungen wie Mobil, Büro oder Sekretariat machen mehrere Kommunikationswege unterscheidbar.',
      'Ein Kontakt ist kein Benutzerkonto. Benutzer melden sich im System an und besitzen Rechte; Kontakte dienen der fachlichen Kommunikation.',
      'Aus einem Kontakt entstehen weder Anmeldung noch Rechte. Wenn eine interne Person sortsys verwenden soll, braucht sie stattdessen ein Benutzerkonto.',
      'Projektkontakte sind Ansprechpartner für eine konkrete Baustelle oder einen konkreten Auftrag. Kundenkontakte sind allgemeiner mit dem Auftraggeber verbunden.',
      'Ein Kontakt kann mehreren Kunden und Projekten zugeordnet sein. Am Projekt lässt sich zusätzlich eine Rolle eintragen, ohne den Namen oder die Kommunikationsdaten des Kontakts zu verändern.',
      'Mehrere Telefonnummern oder E-Mail-Adressen sind möglich, wenn eine Person über verschiedene Wege erreichbar ist.',
      'Ein sauber gepflegter Kontakt spart Rückfragen, weil Bauleitung und Büro im Projektkontext dieselben Ansprechpartner sehen.',
      'Die Kontaktseite zeigt die verknüpften Kunden und Projekte. Dort lässt sich prüfen, wo eine Änderung an Telefonnummer oder E-Mail überall sichtbar wird.',
    ],
    faqs: [
      {
        question: 'Kann sich ein Kontakt anmelden?',
        answer: [
          'Nein. Kontakte haben keine Zugangsdaten und keine Rechte. Für interne Benutzer von sortsys wird ein Benutzerkonto angelegt.',
        ],
      },
      {
        question: 'Muss dieselbe Person mehrfach angelegt werden?',
        answer: [
          'Nein. Ein Kontakt kann mehreren Kunden und Projekten zugeordnet werden. Änderungen an seinen Kommunikationsdaten sind danach an allen Verknüpfungen sichtbar.',
        ],
      },
      {
        question: 'Wofür ist die Rolle am Projekt gedacht?',
        answer: [
          'Sie beschreibt die Funktion der Person in diesem Projekt, etwa Architekt oder Bauleitung. Der Kontakt selbst bleibt dadurch unverändert.',
        ],
      },
    ],
    keywords: ['ansprechpartner', 'telefon', 'email', 'anschrift', 'benutzerkonto', 'rolle', 'kontaktperson', 'kunde', 'projektkontakt'],
  },
  {
    id: 'rollen',
    title: 'Rollen & Rechte',
    lead: 'Rollen steuern, welche Bereiche ein Benutzer sehen, bearbeiten oder löschen darf.',
    category: 'Administration',
    paragraphs: [
      'Das Rollenmodell besteht aus Vorlagen und Einzelrechten. Vorlagen setzen mehrere Rechte auf einmal und bilden typische Aufgaben wie Bauleitung, Lager oder Büro ab.',
      'Eine Vorlage ist ein Ausgangspunkt für typische Aufgaben. Nach der Auswahl können einzelne Rechte ergänzt oder entfernt werden, wenn die tatsächliche Arbeit von der Vorlage abweicht.',
      'Einzelrechte bestehen aus Bereich und Zugriffsstufe. Die Zugriffsstufen sind Lesen, Bearbeiten und Löschen. Bearbeiten enthält Lesen; Löschen bleibt getrennt.',
      'Die Stufe gilt immer für einen bestimmten Bereich. Das Recht zum Bearbeiten von Produkten erlaubt beispielsweise keine Bearbeitung von Benutzern oder Projekten.',
      'Projektrechte steuern, ob Benutzer Projekte allgemein sehen und bearbeiten dürfen. Ohne allgemeine Projektsicht können Benutzer je nach Zuordnung nur eingeschränkten Zugriff haben.',
      'Einsatzplanung, Berichte und andere Projektvorgänge besitzen eigene Rechtebereiche. Allgemeine Projektsicht allein schaltet diese Funktionen nicht zur Bearbeitung frei.',
      'Rechte auf Berichte, Lieferscheine, Werkzeuge oder Produkte wirken zusätzlich. Wer ein Projekt sehen kann, darf deshalb nicht automatisch alle zugehörigen Vorgänge bearbeiten.',
      'Lese-, Bearbeitungs- und Löschrechte sollten je Bereich bewusst vergeben werden. Wer Einträge pflegen darf, braucht nicht automatisch das Recht, sie endgültig zu löschen.',
      'Administratoren besitzen alle Rechte. Diese Rolle sollte nur an Benutzer vergeben werden, die auch Benutzer, Organisation und Berechtigungen verwalten dürfen.',
      'Für die tägliche Arbeit ist meist eine passende Vorlage mit wenigen Ergänzungen besser geeignet. Administratorrechte schließen auch Organisations- und Rollenverwaltung sowie gefährliche Aktionen ein.',
    ],
    faqs: [
      {
        question: 'Warum gibt es Vorlagen und Einzelrechte?',
        answer: [
          'Vorlagen machen typische Rollen schnell verständlich. Einzelrechte bleiben nötig, weil Betriebe Aufgaben unterschiedlich verteilen.',
        ],
      },
      {
        question: 'Reicht Projektsicht für alle Projektdaten?',
        answer: [
          'Nein. Projektsicht öffnet den Projektkontext. Für Material, Regie, Tagesberichte, Werkzeuge oder Verwaltung können zusätzliche Rechte nötig sein.',
        ],
      },
      {
        question: 'Enthält Bearbeiten automatisch Löschen?',
        answer: [
          'Nein. Bearbeiten enthält Lesen, das Löschrecht wird getrennt vergeben. So können Benutzer Daten pflegen, ohne sie endgültig entfernen zu dürfen.',
        ],
      },
      {
        question: 'Was passiert beim Wechsel einer Vorlage?',
        answer: [
          'Die ausgewählte Vorlage setzt die zugehörigen Rechte als Ausgangspunkt. Prüfe danach die Einzelrechte, besonders wenn zuvor abweichende Rechte vergeben waren.',
        ],
      },
    ],
    keywords: ['rollen', 'rechte', 'berechtigungen', 'vorlagen', 'lesen', 'bearbeiten', 'löschen', 'administrator', 'bauleitung', 'lager', 'büro', 'projekte'],
  },
  {
    id: 'tastaturkuerzel',
    title: 'Tastaturkürzel',
    lead: 'Tastaturkürzel öffnen häufige Aktionen ohne Maus.',
    category: 'Bedienung',
    paragraphs: [
      'Tastaturkürzel funktionieren nur im passenden Kontext. In Eingabefeldern sind sie deaktiviert, damit normale Texteingabe nicht gestört wird.',
      'Das Kürzel richtet sich nach der gerade geöffneten Seite. Eine Aktion, die auf einer Projektdetailseite verfügbar ist, muss deshalb nicht in jeder Liste angeboten werden.',
      '<kbd>Ctrl</kbd>+<kbd>E</kbd> öffnet die Bearbeitung auf Detailseiten, wenn du die nötigen Bearbeitungsrechte hast.',
      '<kbd>Ctrl</kbd>+<kbd>P</kbd> erstellt den PDF-Export der aktuellen Seite, wenn dort ein PDF verfügbar ist. Der Export wird in einem neuen Tab geöffnet.',
      'Bei Kostenübersichten und Inventuren exportiert das Kürzel den dort angebotenen PDF-Bericht. Während ein Export läuft, wird kein zweiter gestartet.',
      '<kbd>Ctrl</kbd>+<kbd>N</kbd> öffnet die Neu-Anlage auf Listen- und Planungsseiten mit einer passenden Neu-Aktion.',
      '<kbd>Ctrl</kbd>+<kbd>K</kbd> öffnet die globale Suche.',
      '<kbd>Ctrl</kbd>+<kbd>S</kbd> speichert im Skript-Editor den aktuellen Stand. In anderen Formularen wird dieses Kürzel nicht als allgemeines Speichern behandelt.',
    ],
    faqs: [
      {
        question: 'Warum passiert nichts?',
        answer: [
          'Mögliche Gründe sind fehlende Rechte, falscher Seitentyp, aktives Eingabefeld oder laufender PDF-Export.',
        ],
      },
      {
        question: 'Was bedeutet Ctrl?',
        answer: [
          '<kbd>Ctrl</kbd> ist die Steuerungstaste. Auf deutschen Tastaturen ist sie oft mit <kbd>Strg</kbd> beschriftet.',
        ],
      },
      {
        question: 'Wo funktioniert Ctrl+S?',
        answer: [
          'Im Skript-Editor speichert es den aktuellen Code. In normalen Formularen gibt es kein allgemeines Speichern per Tastaturkürzel.',
        ],
      },
      {
        question: 'Warum reagiert ein Kürzel trotz passender Seite nicht?',
        answer: [
          'Prüfe, ob der Fokus in einem Eingabefeld liegt, ob die Aktion wegen fehlender Rechte ausgeblendet ist oder ob der Browser die Tastenkombination selbst verwendet.',
        ],
      },
    ],
    keywords: ['tastatur', 'shortcut', 'shortcuts', 'ctrl', 'strg', 'bearbeiten', 'pdf', 'neu', 'suche', 'skript', 'speichern'],
  },
];

export function getDocArticles(): DocArticle[] {
  return currentLocale() === "de"
    ? GERMAN_DOC_ARTICLES
    : GERMAN_DOC_ARTICLES.map(article => {
      const english = ENGLISH_DOCS[article.id];
      if (!english) return article;

      return {
        ...article,
        ...english,
        scriptExamples: article.scriptExamples?.map((example, index) => ({
          ...example,
          ...(english.scriptExamples?.[index] ?? {}),
        })),
      };
    });
}

export function normalizeDocText(value: string) {
  return value.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function docArticleText(doc: DocArticle) {
  return normalizeDocText([
    doc.category,
    doc.title,
    doc.lead,
    ...doc.paragraphs,
    ...(doc.scriptExamples ?? []).flatMap(example => [example.title, example.description, example.code]),
    ...(doc.faqs ?? []).flatMap(faq => [faq.question, ...faq.answer]),
    ...doc.keywords,
  ].join(' '));
}

export function getDocArticle(id: string | undefined) {
  if (!id) return null;
  return getDocArticles().find(doc => doc.id === id) ?? null;
}

export function getDocArticleSections(article: DocArticle): DocSection[] {
  const config = DOC_SECTION_CONFIG[article.id];
  if (!config) return [{ heading: currentLocale() === "en" ? "Overview" : "Überblick", paragraphs: article.paragraphs }];

  return config
    .map(section => ({
      heading: currentLocale() === "en" ? ENGLISH_DOC_SECTION_HEADINGS[section.heading] ?? section.heading : section.heading,
      paragraphs: article.paragraphs.slice(section.start, section.end),
    }))
    .filter(section => section.paragraphs.length > 0);
}
