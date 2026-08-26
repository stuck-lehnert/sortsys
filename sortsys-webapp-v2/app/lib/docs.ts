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
    { heading: 'Einordnung', start: 0, end: 1 },
    { heading: 'Was zur Projektakte gehört', start: 1, end: 4 },
    { heading: 'Nachweise und Kosten', start: 4, end: 6 },
    { heading: 'Abschluss und Benennung', start: 6 },
  ],
  bautagesbericht: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Regeln für die Erfassung', start: 2, end: 4 },
    { heading: 'Gute Beschreibung', start: 4 },
  ],
  regiebericht: [
    { heading: 'Zweck', start: 0, end: 3 },
    { heading: 'Inhalt', start: 3, end: 5 },
    { heading: 'Ablage im Projekt', start: 5 },
  ],
  lieferschein: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Materialpositionen', start: 2, end: 4 },
    { heading: 'Prüfung und Zuordnung', start: 4 },
  ],
  werkzeugbuchung: [
    { heading: 'Zweck', start: 0, end: 3 },
    { heading: 'Übergaben und Historie', start: 3, end: 5 },
    { heading: 'Projektkosten', start: 5 },
  ],
  einsatzplanung: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Planung im Projektalltag', start: 2, end: 4 },
    { heading: 'Planung und Ist-Dokumentation', start: 4 },
  ],
  urlaub: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Auswirkung auf Planung', start: 2 },
  ],
  produkt: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Preise und Einheiten', start: 2, end: 3 },
    { heading: 'Projektbezug und Kosten', start: 3 },
  ],
  kunde: [
    { heading: 'Zweck', start: 0, end: 2 },
    { heading: 'Abgrenzung zum Projekt', start: 2, end: 4 },
    { heading: 'Ansprechpartner', start: 4 },
  ],
  kontakt: [
    { heading: 'Zweck', start: 0, end: 1 },
    { heading: 'Abgrenzung zum Benutzerkonto', start: 1, end: 2 },
    { heading: 'Zuordnung und Kommunikation', start: 2 },
  ],
  rollen: [
    { heading: 'Grundprinzip', start: 0, end: 2 },
    { heading: 'Projektrechte und Bereichsrechte', start: 2, end: 4 },
    { heading: 'Administratoren', start: 4 },
  ],
  tastaturkuerzel: [
    { heading: 'Grundprinzip', start: 0, end: 1 },
    { heading: 'Verfügbare Kürzel', start: 1 },
  ],
};

export const DOC_ARTICLES: DocArticle[] = [
  {
    id: 'client-skripte',
    title: 'Client-Skripte',
    lead: 'Client-Skripte automatisieren Abläufe direkt im Browser, laufen aber in einer abgeschotteten Sandbox.',
    category: 'Automation',
    paragraphs: [
      'Client-Skripte werden unter Verwaltung > Skripte angelegt. Beim Erstellen wird zuerst ein Name vergeben, danach wird der JavaScript-Code im Editor bearbeitet und gespeichert.',
      'Skripte sind JavaScript-Module. Top-Level-Await ist erlaubt. Statische Imports und Exports sind nicht erlaubt; verwende immer dynamische Imports wie await import(\'sortsys-client\').',
      'Nur fünf Module sind verfügbar: sortsys-client für TRPC-Aufrufe, sortsys-popups für bestätigte Dialoge, sortsys-modal-forms für Vollbild-Formulare, sortsys-log für bewusstes Logging und sortsys-utils für sichere Hilfsfunktionen. Andere Imports werden vor Ausführung abgelehnt.',
      'console ist nicht verfügbar. Verwende stattdessen const { log } = await import(\'sortsys-log\').',
      'Der Code läuft in einem Worker und nicht im Seitenkontext. Browser- und Seitenzugriffe wie window, self, document, localStorage, sessionStorage, fetch, alert oder prompt sind gesperrt.',
      'Alle Dialoginhalte aus Skripten werden als HTML behandelt und vor Anzeige bereinigt. Script-Tags, iframes, Event-Handler und unsichere Links werden entfernt.',
      'client.query und client.mutate geben immer ein Tupel zurück: Das erste Element enthält Daten, das zweite einen Fehler oder null. Prüfe den Fehler und wirf ihn bewusst, damit die Ausführung sauber abbricht.',
      'Die Beispiele unten sind echte ausführbare Skripte. Du kannst sie im Editor verändern und direkt starten; gespeichert werden Änderungen dort nicht.',
    ],
    scriptExamples: [
      {
        title: 'Bestätigung anzeigen',
        description: 'Nutzt sortsys-popups. HTML im content-Feld wird bereinigt, bevor der Dialog angezeigt wird.',
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
        description: 'Nutzt sortsys-client. Jede Abfrage liefert [daten, fehler]; Fehler sollten explizit geworfen werden.',
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
        description: 'Nutzt sortsys-modal-forms mit Pflichtfeld, Validierung und gefilterten Optionen.',
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
        description: 'Nutzt sortsys-utils für HTML-Escaping, URL-Encoding, UTF-8/Base64 und einfache Statistik.',
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
          'Nein. Es läuft in einem Worker ohne window, document, DOM, Storage oder fetch. Kommunikation läuft nur über die freigegebenen Bridge-Module.',
        ],
      },
      {
        question: 'Wann brauche ich requireDangerConfirmation?',
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
      'Zum Projekt gehören Kunde, Adresse, verantwortliche Personen, Einsatzplanung, Dateien, Bautagesberichte, Regieberichte, Lieferscheine, Werkzeugbuchungen und Kosten. Diese Daten werden getrennt erfasst, aber über das Projekt gemeinsam auffindbar.',
      'Die Projektadresse beschreibt den Ort der Leistung. Sie kann von der Kundenadresse abweichen, wenn ein Kunde mehrere Baustellen oder Niederlassungen hat.',
      'Projektzuweisungen bestimmen, welche Personen fachlich mit dem Projekt verbunden sind. Sie helfen bei Einsatzplanung, eingeschränkter Projektsicht und Zuordnung von Verantwortung.',
      'Bautagesberichte dokumentieren den normalen Fortschritt auf dem Projekt. Regieberichte dokumentieren Zusatzleistungen. Lieferscheine dokumentieren Material. Werkzeugbuchungen zeigen, welche Werkzeuge auf dem Projekt eingesetzt oder dorthin übergeben wurden.',
      'Die Kostenübersicht entsteht aus gebuchten Vorgängen und hinterlegten Preisen. Sie ist keine eigene Datenerfassung, sondern eine Zusammenstellung aus Material, Arbeitszeit, Werkzeugkosten, Sonderposten, Angeboten, Rechnungen und Gemeinkosten.',
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
    ],
    keywords: ['auftrag', 'baustelle', 'kunde', 'adresse', 'kosten', 'projektakte', 'projektzuweisung', 'abschluss'],
  },
  {
    id: 'bautagesbericht',
    title: 'Bautagesbericht',
    lead: 'Ein Bautagesbericht dokumentiert die Arbeiten eines einzelnen Tages auf einem Projekt.',
    category: 'Baustelle',
    paragraphs: [
      'Der Bautagesbericht beschreibt einen Kalendertag auf einem Projekt. Er enthält Datum, ausgeführte Arbeiten, Wetter und Arbeitszeiten.',
      'Der Bericht gehört immer zu einem Projekt. Dadurch werden Tagesnachweise später in der Projektakte, in Exporten und in der Kostenübersicht wiedergefunden.',
      'Pro Projekt und Tag soll es einen eindeutigen Tagesbericht geben. Das verhindert doppelte Nachweise und hält Wochenexporte sauber.',
      'Arbeitszeiten im Bautagesbericht beschreiben reguläre Projektarbeit. Zusatzleistungen, die separat freigegeben oder abgerechnet werden müssen, gehören in einen Regiebericht.',
      'Ein guter Tagesbericht nennt die erledigten Arbeiten konkret genug, damit Büro, Bauleitung oder Auftraggeber den Fortschritt später nachvollziehen können.',
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
    ],
    keywords: ['tagesbericht', 'bauwochenbericht', 'wetter', 'arbeitszeit', 'nachweis', 'projekt', 'fortschritt'],
  },
  {
    id: 'regiebericht',
    title: 'Regiebericht',
    lead: 'Ein Regiebericht dokumentiert zusätzliche Leistungen, die nach Aufwand nachgewiesen werden.',
    category: 'Baustelle',
    paragraphs: [
      'Ein Regiebericht dokumentiert Leistungen, die zusätzlich oder nach Aufwand nachgewiesen werden. Er enthält Projekt, Datum, Beschreibung, Arbeitszeit, Material und freie Sonderpositionen.',
      'Der Projektbezug ist wichtig, weil Regieleistungen später zusammen mit anderen Projektdaten geprüft werden. Auftrag, Baustelle und Kunde ergeben sich aus dem Projekt.',
      'Regieberichte unterscheiden sich von Bautagesberichten. Der Bautagesbericht beschreibt den allgemeinen Baustellentag; der Regiebericht beschreibt eine prüfbare Zusatzleistung.',
      'Die Beschreibung sollte Leistung, Anlass und Umfang benennen. Kurze, konkrete Formulierungen erleichtern Freigabe, Rückfrage und Abrechnung.',
      'Material im Regiebericht kann aus Produktstämmen oder freien Sonderpositionen bestehen. Produktstämme helfen bei einheitlicher Benennung und Kostenfortschreibung.',
      'Regieberichte bleiben Teil der Projektakte. Sie können separat geöffnet, exportiert und im Projektkontext gefunden werden.',
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
    ],
    keywords: ['regie', 'zusatzleistung', 'abrechnung', 'sonderposition', 'nachweis', 'projekt', 'freigabe'],
  },
  {
    id: 'lieferschein',
    title: 'Lieferschein',
    lead: 'Ein Lieferschein ordnet Material und Mengen einem Projekt zu.',
    category: 'Material',
    paragraphs: [
      'Ein Lieferschein dokumentiert Materialbewegungen für ein Projekt. Er enthält Projekt, Nummer, Datum, Produkte, Mengen, Kommentare und freie Positionen.',
      'Der Projektbezug ordnet den Materialvorgang der richtigen Baustelle zu. Dadurch erscheinen Lieferungen in der Projektakte und können in Kostenübersichten berücksichtigt werden.',
      'Produkte aus dem Stamm sorgen für einheitliche Benennung, Suche und Preise. Freie Positionen sind nützlich, wenn Material einmalig ist oder noch kein Produktstamm existiert.',
      'Die Lieferscheinnummer ist ein wichtiges Suchmerkmal. Sie hilft bei Rückfragen, Rechnungsprüfung und Abgleich mit Papierbelegen oder Lieferantenunterlagen.',
      'Ein Lieferschein ist kein Rechnungsdokument. Er beschreibt zuerst den Materialvorgang; Kosten und Rechnungen werden daraus geprüft oder abgeleitet.',
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
    ],
    keywords: ['material', 'lieferung', 'produkt', 'kosten', 'rechnung', 'beleg', 'projekt'],
  },
  {
    id: 'werkzeugbuchung',
    title: 'Werkzeugbuchung',
    lead: 'Eine Werkzeugbuchung hält fest, wo ein Werkzeug ist und wer verantwortlich ist.',
    category: 'Werkzeuge',
    paragraphs: [
      'Werkzeugbuchungen entstehen bei Ausgabe, Rücknahme oder Umbuchung. Sie verbinden Werkzeug, verantwortliche Person, Projekt und Zeitraum.',
      'Der Projektbezug beschreibt, auf welcher Baustelle ein Werkzeug eingesetzt wird. Das hilft Bauleitung, Lager und Büro bei Suche, Verantwortung und Kostenbetrachtung.',
      'Aktive Buchungen zeigen den aktuellen Standort und die Zuständigkeit. Abgeschlossene Buchungen bilden die Historie eines Werkzeugs ab.',
      'Wenn ein Werkzeug auf ein anderes Projekt wechselt, sollte die Buchung angepasst werden. Sonst zeigt die Historie später falsche Projektkosten oder falsche Verantwortung.',
      'Umbuchungsanfragen unterstützen kontrollierte Übergaben. Sie verhindern, dass Werkzeug praktisch weitergegeben wurde, im System aber noch beim alten Verantwortlichen liegt.',
      'Werkzeugkosten können aus Buchungen in Projektkosten einfließen, wenn Kostensätze gepflegt sind. Dafür müssen Zeitraum und Projekt stimmen.',
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
    ],
    keywords: ['werkzeug', 'tracking', 'ausgabe', 'rücknahme', 'umbuchung', 'verantwortlich', 'projekt', 'lager'],
  },
  {
    id: 'einsatzplanung',
    title: 'Einsatzplanung',
    lead: 'Die Einsatzplanung ordnet Personen für Zeiträume Projekten zu.',
    category: 'Planung',
    paragraphs: [
      'Einsatzplanung beschreibt geplante Verfügbarkeit und Projektzuweisung. Sie ist keine Zeiterfassung und ersetzt keine Arbeitszeit im Bautagesbericht oder Regiebericht.',
      'Eine Planung verbindet Person, Zeitraum und Projekt. Sie zeigt, wer wann auf welcher Baustelle eingeplant ist.',
      'Projektzuweisungen helfen bei Wochenplanung, Kapazitätsprüfung und Abstimmung zwischen Bauleitung, Büro und Teams.',
      'Abwesenheiten werden gemeinsam mit Projektplanung betrachtet. Dadurch werden Doppelbelegungen und Konflikte früher sichtbar.',
      'Planung und Ist-Dokumentation bleiben getrennt. Was geplant war, steht in der Einsatzplanung; was tatsächlich passiert ist, steht in Tages- oder Regieberichten.',
      'Wenn ein Projekt abgeschlossen ist, sollte es nicht weiter als laufende Einsatzstelle genutzt werden. Offene Planungen sollten geprüft oder angepasst werden.',
    ],
    faqs: [
      {
        question: 'Ist Einsatzplanung Arbeitszeit?',
        answer: [
          'Nein. Sie zeigt geplante Zuweisung. Tatsächliche Stunden werden über Bautagesberichte oder Regieberichte dokumentiert.',
        ],
      },
    ],
    keywords: ['planung', 'projektzuweisung', 'kapazität', 'urlaub', 'verfügbarkeit', 'projekt', 'baustelle'],
  },
  {
    id: 'urlaub',
    title: 'Urlaub',
    lead: 'Urlaub beschreibt geplante Abwesenheit einer Person.',
    category: 'Personal',
    paragraphs: [
      'Urlaubseinträge enthalten Zeitraum, Status und optional eine Notiz. Sie können angefragt, genehmigt oder abgelehnt werden.',
      'Genehmigte Abwesenheiten beeinflussen die Einsatzplanung. Personen sollen nicht auf Projekte geplant werden, wenn sie nicht verfügbar sind.',
      'Abwesenheiten sind kein Projektvorgang. Sie wirken aber indirekt auf Projekte, weil verfügbare Kapazität für Baustellenplanung fehlt.',
      'Die Entscheidung liegt bei Vorgesetzten oder Benutzern mit entsprechender Berechtigung. Dadurch bleibt der Stand der Abwesenheiten nachvollziehbar.',
    ],
    keywords: ['abwesenheit', 'ferien', 'genehmigung', 'vorgesetzter', 'planung', 'projektkapazität'],
  },
  {
    id: 'produkt',
    title: 'Produkt',
    lead: 'Ein Produkt ist ein Material- oder Artikelstamm für Belege und Berichte.',
    category: 'Stammdaten',
    paragraphs: [
      'Produkte werden in Lieferscheinen und Regieberichten verwendet. Sie sorgen dafür, dass Material einheitlich benannt und gesucht werden kann.',
      'Ein Produkt hat eine Basiseinheit und kann zusätzliche Einheiten besitzen. Das unterstützt verschiedene Mengenangaben im Alltag.',
      'Preise werden als eigene Preisdatensätze geführt. Dadurch kann sich der Preis über die Zeit ändern, ohne den Produktstamm umzuschreiben.',
      'Produkte haben keinen festen Projektbezug. Der Projektbezug entsteht erst, wenn ein Produkt in einem Lieferschein oder Regiebericht verwendet wird.',
      'Saubere Produktstämme verbessern Projektkosten, weil Material in verschiedenen Projekten gleich benannt und ausgewertet wird.',
    ],
    faqs: [
      {
        question: 'Wann wird ein neues Produkt angelegt?',
        answer: [
          'Wenn Material regelmäßig verwendet, gesucht oder kalkuliert werden soll. Einmalige Positionen können als freie Position erfasst werden.',
        ],
      },
    ],
    keywords: ['material', 'artikel', 'preis', 'einheit', 'produktstamm', 'projektkosten'],
  },
  {
    id: 'kunde',
    title: 'Kunde',
    lead: 'Ein Kunde ist eine Organisation oder Person, für die Projekte angelegt werden.',
    category: 'Stammdaten',
    paragraphs: [
      'Kunden bündeln Projekte nach Auftraggeber. Sie helfen, Projektlisten, Kommunikation und Auswertungen fachlich zu ordnen.',
      'Kundendaten enthalten Name, Anrede und Adresse. Die Projektadresse kann davon abweichen, wenn ein Kunde mehrere Baustellen hat.',
      'Ein Kunde ist nicht identisch mit einem Projekt. Der Kunde beschreibt den Auftraggeber; das Projekt beschreibt den konkreten Auftrag oder die Baustelle.',
      'Mehrere Projekte können demselben Kunden zugeordnet sein. Dadurch bleiben wiederkehrende Auftraggeber zusammen sichtbar, ohne Projektakten zu vermischen.',
      'Kontakte werden getrennt vom Kunden gepflegt. Ein Kunde kann mehrere Ansprechpartner haben, und Kontakte können in unterschiedlichen Zusammenhängen verwendet werden.',
    ],
    faqs: [
      {
        question: 'Wann unterscheidet sich Kundenadresse von Projektadresse?',
        answer: [
          'Typisch bei Verwaltungen, Firmenzentralen oder Auftraggebern mit mehreren Baustellen. Die Kundenadresse bleibt Stammdatum, die Projektadresse beschreibt den Leistungsort.',
        ],
      },
    ],
    keywords: ['auftraggeber', 'organisation', 'kunde', 'projekt', 'adresse', 'baustelle'],
  },
  {
    id: 'kontakt',
    title: 'Kontakt',
    lead: 'Ein Kontakt ist eine erreichbare Person mit Kommunikationsdaten.',
    category: 'Stammdaten',
    paragraphs: [
      'Kontakte speichern Ansprechpartner mit Telefonnummern und E-Mail-Adressen. Sie können Kunden oder Projekten zugeordnet werden.',
      'Ein Kontakt ist kein Benutzerkonto. Benutzer melden sich im System an und besitzen Rechte; Kontakte dienen der fachlichen Kommunikation.',
      'Projektkontakte sind Ansprechpartner für eine konkrete Baustelle oder einen konkreten Auftrag. Kundenkontakte sind allgemeiner mit dem Auftraggeber verbunden.',
      'Mehrere Telefonnummern oder E-Mail-Adressen sind möglich, wenn eine Person über verschiedene Wege erreichbar ist.',
      'Ein sauber gepflegter Kontakt spart Rückfragen, weil Bauleitung und Büro im Projektkontext dieselben Ansprechpartner sehen.',
    ],
    keywords: ['ansprechpartner', 'telefon', 'email', 'kontaktperson', 'kunde', 'projektkontakt'],
  },
  {
    id: 'rollen',
    title: 'Rollen & Rechte',
    lead: 'Rollen steuern, welche Bereiche ein Benutzer sehen, bearbeiten oder löschen darf.',
    category: 'Administration',
    paragraphs: [
      'Das Rollenmodell besteht aus Vorlagen und Einzelrechten. Vorlagen setzen mehrere Rechte auf einmal und bilden typische Aufgaben wie Bauleitung, Lager oder Büro ab.',
      'Einzelrechte bestehen aus Bereich und Zugriffsstufe. Die Zugriffsstufen sind Lesen, Bearbeiten und Löschen. Bearbeiten enthält Lesen; Löschen bleibt getrennt.',
      'Projektrechte steuern, ob Benutzer Projekte allgemein sehen und bearbeiten dürfen. Ohne allgemeine Projektsicht können Benutzer je nach Zuordnung nur eingeschränkten Zugriff haben.',
      'Rechte auf Berichte, Lieferscheine, Werkzeuge oder Produkte wirken zusätzlich. Wer ein Projekt sehen kann, darf deshalb nicht automatisch alle zugehörigen Vorgänge bearbeiten.',
      'Administratoren besitzen alle Rechte. Diese Rolle sollte nur an Benutzer vergeben werden, die auch Benutzer, Organisation und Berechtigungen verwalten dürfen.',
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
    ],
    keywords: ['rollen', 'rechte', 'berechtigungen', 'vorlagen', 'administrator', 'bauleitung', 'lager', 'büro', 'projekte'],
  },
  {
    id: 'tastaturkuerzel',
    title: 'Tastaturkürzel',
    lead: 'Tastaturkürzel öffnen häufige Aktionen ohne Maus.',
    category: 'Bedienung',
    paragraphs: [
      'Tastaturkürzel funktionieren nur im passenden Kontext. In Eingabefeldern sind sie deaktiviert, damit normale Texteingabe nicht gestört wird.',
      '<kbd>Ctrl</kbd>+<kbd>E</kbd> öffnet die Bearbeitung auf Detailseiten, wenn du die nötigen Bearbeitungsrechte hast.',
      '<kbd>Ctrl</kbd>+<kbd>P</kbd> erstellt den PDF-Export der aktuellen Seite, wenn dort ein PDF verfügbar ist. Der Export wird in einem neuen Tab geöffnet.',
      '<kbd>Ctrl</kbd>+<kbd>N</kbd> öffnet die Neu-Anlage auf Listen- und Planungsseiten mit einer passenden Neu-Aktion.',
      '<kbd>Ctrl</kbd>+<kbd>K</kbd> öffnet die globale Suche.',
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
    ],
    keywords: ['tastatur', 'shortcut', 'shortcuts', 'ctrl', 'strg', 'bearbeiten', 'pdf', 'neu', 'suche'],
  },
];

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
  return DOC_ARTICLES.find(doc => doc.id === id) ?? null;
}

export function getDocArticleSections(article: DocArticle): DocSection[] {
  const config = DOC_SECTION_CONFIG[article.id];
  if (!config) return [{ heading: 'Überblick', paragraphs: article.paragraphs }];

  return config
    .map(section => ({
      heading: section.heading,
      paragraphs: article.paragraphs.slice(section.start, section.end),
    }))
    .filter(section => section.paragraphs.length > 0);
}
