// Representative content for visual QA and compiled layout checks. No live data.
export function pdfFixtures({ buildPdfProductSection, buildRegieReportPdfDocument, buildTablePdfDocument }) {
  const date = new Date('2026-10-03T12:00:00Z');
  const project = 'Neubau Schulzentrum · Musterstadt';
  const sender = { name: 'Musterbau GmbH', lines: ['Musterstraße 1', '12345 Musterstadt'] };
  const facts = (rows, title = 'Übersicht') => ({ title, columns: ['Angabe', 'Wert'], rows, withHeader: false, align: ['left', 'left'], columnWidths: ['1fr', '2fr'] });
  const summary = rows => ({ ...facts(rows), presentation: 'summary' });
  const text = (title, value) => ({ title, columns: ['Inhalt'], rows: [[value]], withHeader: false });
  const description = 'Die Nordfassade wurde für die Montage vorbereitet. Lose Bauteile wurden entfernt und der Untergrund gereinigt. Anschließend wurden die Befestigungspunkte gemeinsam mit der Bauleitung geprüft.\nDie Arbeiten am südlichen Zugang werden am nächsten Arbeitstag fortgesetzt. Der Zugang bleibt bis zur Freigabe gesperrt.';
  const base = { exportedAt: date, layout: { sender }, reportLabel: project };
  const materialRows = [
    { number: 'M-101', name: 'Beton C25/30 für Fundamente, einschließlich Lieferung', quantity: '2,00 m³', baseQuantity: '2.000,00 l', price: '0,15 €/l', cost: '300,00 €' },
    { number: 'M-102', name: 'Dämmplatten mit erhöhter Druckfestigkeit, 120 mm', quantity: '48,00 Stück', price: '12,50 €/Stück', cost: '600,00 €' },
    { number: '2147483647', name: 'Edelstahl-Befestigungssystem für die Nordfassade', quantity: '150,00 Stück', price: '3,40 €/Stück', cost: '510,00 €' },
  ];
  const letter = {
    ...base, title: 'Lieferschein #123', reportLabel: 'Lieferschein', showReportLabel: false,
    layout: { ...base.layout, kind: 'letter', form: 'B', date,
      recipient: { name: 'Auftraggeber GmbH', lines: ['Projektleitung', 'Zielstraße 23', '54321 Beispielstadt'] },
      information: [{ label: 'Lieferscheinnummer', value: '#123' }],
      footer: ['Musterbau GmbH · Musterstraße 1 · 12345 Musterstadt'],
    },
    sections: [summary([['Projekt', project], ['Lieferdatum', '3. Oktober 2026'], ['Gesamtkosten', { value: '1.410,00 €', bold: true }]]), buildPdfProductSection(materialRows), text('Kommentar', 'Bitte die Lieferung am nördlichen Baustellenzugang entgegennehmen. Die Mengen wurden vor Ort geprüft.')],
  };
  const workerNames = ['Anna Musterfrau', 'Maximilian Beispielmann', 'Alexandra Langnamensbeispiel'];
  const weekly = {
    ...base, title: 'Bauwochenbericht · KW 40', sections: [summary([['Projekt', project], ['Zeitraum', '28. September 2026 bis 4. Oktober 2026'], ['Berichtstage', { value: '5', emphasis: 'secondary' }], ['Gesamtstunden', { value: '120 h', bold: true }]]),
      { title: 'Arbeitszeit je Mitarbeiter und Tag', subtitle: 'Alle Zeiten in Stunden; – bedeutet keine erfasste Arbeitszeit.', columns: ['Mitarbeiter', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So', 'Gesamt'],
        rows: workerNames.map(name => [name, '8', '8,5', '7,5', '8', '8', '-', '-', '40']), totalRows: [['Gesamt', '24', '25,5', '22,5', '24', '24', '-', '-', '120']],
        align: ['left', ...Array(8).fill('right')], columnWidths: ['2.6fr', ...Array(7).fill('0.65fr'), '0.9fr'] },
      { title: 'Beschreibung der Arbeiten', presentation: 'entries', columns: ['Tag', 'Inhalt'], rows: [['Montag, 28. September 2026', description], ['Dienstag, 29. September 2026', description]] },
    ],
  };
  const regie = buildRegieReportPdfDocument({ projectTitle: project, productsById: new Map([['product-1', { id: 'product-1', customId: 'M-104', name: 'Schutzfolie für Fenster und Baustellenzugänge', regieReportName: 'Abdeckfolie für Fenster und Zugänge', baseUnit: 'm²', otherUnits: {} }]]), usersById: new Map(workerNames.map((name, index) => [`user-${index}`, { firstName: name, lastName: '' }])),
    report: { id: 'report', projectId: 'project', autoId: 45, day: date, createdAt: date, createdByUserId: 'user-0', summary: description, products: [{ id: 'record-1', reportId: 'report', productId: 'product-1', quantity: 20 }], specialRecords: [{ id: 'special', reportId: 'report', name: 'Vorbereitung und Absicherung der Zufahrt', amount: 1, unit: 'Pauschale', comment: null }],
      workHours: workerNames.flatMap((_, index) => Array.from({ length: 5 }, (_, day) => ({ id: `${index}-${day}`, reportId: 'report', userId: `user-${index}`, day: new Date(Date.UTC(2026, 8, 28 + day, 12)), hours: 8 }))),
    },
  });
  const costs = { ...base, title: 'Projektkostenbericht', sections: [
    { ...facts([['Gesamtkosten', { value: '2.991,00 €', bold: true }], ['Rechnungssummen', '4.000,00 €'], ['Gewinn/Verlust', { value: '+1.009,00 €', bold: true, detail: '25,23 %' }]]), presentation: 'metrics' },
    { title: 'Gemeinkosten', columns: ['Kostenart', 'Basis', 'Gemeinkosten'], rows: [['Lohngemeinkosten', '1.200,00 €', '240,00 €'], ['Materialgemeinkosten', '1.410,00 €', '141,00 €']], align: ['left', 'right', 'right'], columnWidths: ['2fr', '1fr', '1fr'] },
    buildPdfProductSection(materialRows),
    { title: 'Arbeitszeit', columns: ['Tag', 'Mitarbeiter', 'Stunden', 'Kosten'], rows: workerNames.map(name => ['03.10.2026', name, '8', '400,00 €']), align: ['left', 'left', 'right', 'right'], columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'] },
  ] };
  const inventory = { ...base, title: 'Inventurübersicht', reportLabel: 'Prüfzeitraum: letzte 30 Tage', sections: [summary([['Zeitraum', '30 Tage'], ['Keine Inventur', { value: '2', bold: true }], ['Inventiert', { value: '24', emphasis: 'secondary' }]]),
    { title: 'Keine Inventur in den letzten 30 Tagen', columns: ['Nummer', 'Werkzeug', 'Letzter Verantwortlicher', 'Status', 'Letzte Inventur'], rows: [['W-101', 'Bosch Professional Akku-Bohrhammer mit Zubehör', workerNames[1], 'verfügbar', '01.08.2026'], ['W-102', 'Hilti Trennschleifer für Beton und Stahl', workerNames[2], 'defekt', '–']], align: Array(5).fill('left'), columnWidths: ['0.8fr', '2.1fr', '1.55fr', '0.95fr', '1.15fr'] },
  ] };
  const daily = { ...base, title: 'Bautagesbericht · 3. Oktober 2026', sections: [summary([['Projekt', project], ['Tag', '3. Oktober 2026'], ['Gesamtstunden', { value: '24 h', bold: true }]]), text('Beschreibung der Arbeiten', description), facts([['Temperatur', '0 °C'], ['Niederschlag', '0 mm'], ['Wind', '12 km/h']], 'Wetter')], imageSections: [{ title: 'Fotos', images: [{ url: '', shadowPath: '/preview/landscape.svg', title: 'Foto 1', caption: 'Nordfassade · 03.10.2026' }, { url: '', shadowPath: '/preview/portrait.svg', title: 'Foto 2', caption: 'Seitlicher Zugang · 03.10.2026' }] }] };
  const contacts = {
    ...base, title: 'Projektdatenblatt',
    sections: [facts([['Projekt', { value: project, bold: true }], ['Anschrift', 'Baustellenstraße 10, 12345 Musterstadt'], ['Verantwortlicher Projektleiter', workerNames[1]]], 'Projektdaten')],
    cardSections: [{ title: 'Ansprechpartner', cards: workerNames.map((name, index) => ({
      title: name, badge: ['Bauleitung', 'Auftraggeber', 'Fachplanung'][index],
      items: [
        { label: 'Telefon', value: `Büro: +49 123 456-${789 + index}${index === 0 ? '\nMobil: +49 170 1234567' : ''}` },
        { label: 'E-Mail', value: ['bauleitung@example.test', 'auftraggeber@example.test', 'fachplanung@example.test'][index] },
        ...(index === 1 ? [] : [{ label: 'Anschrift', value: 'Musterstraße 1\n12345 Musterstadt' }]),
      ],
    })) }],
    trailingSections: [{ title: 'Vermerke', presentation: 'entries', columns: ['Datum', 'Vermerk'], rows: [['3. Oktober 2026', description]] }],
  };
  const wide = { ...base, ...buildTablePdfDocument({ title: 'Werkzeugexport', headers: ['Nummer', 'Bezeichnung', 'Hersteller', 'Verantwortlicher', 'Status', 'Standort', 'Letzte Inventur', 'Kommentar'], rows: [['W-101', 'Akku-Bohrhammer mit Zubehör', 'Bosch Professional', workerNames[1], 'verfügbar', 'Lager Nord', '03.10.2026', 'Vollständig geprüft und einsatzbereit.']] }) };
  const screenshotCosts = {
    ...base, title: 'Projektkostenbericht', reportLabel: 'Akustikdecken Bankfiliale · Musterstadt',
    layout: { sender: { name: 'Malerbetrieb Beispiel GmbH', lines: [] } },
    sections: [
      { ...facts([['Gesamtkosten', { value: '751,27 €', bold: true }], ['Angebotssummen', '14.538,33 €']], 'Zusammenfassung'), presentation: 'metrics', subtitle: 'Gewinn/Verlust kann nicht berechnet werden, da Rechnungssummen fehlen.' },
      { title: 'Angebotssummen', columns: ['Erfasst am', 'Betrag', 'Kommentar'], rows: [['31.01.2026', '14.538,33 €', 'Angebot für Malerarbeiten gemäß Leistungsverzeichnis.']], align: ['left', 'right', 'left'], columnWidths: ['1.1fr', '1.1fr', '2.4fr'] },
      { ...facts([['Arbeitszeit', '751,27 €']], 'Kostenbereiche'), align: ['left', 'right'], columnWidths: ['2fr', '1fr'] },
      { title: 'Arbeitszeit', columns: ['Tag', 'Mitarbeiter', 'Stunden', 'Kosten'], rows: [['29.09.2026', 'Nico Beispiel', '7,44', '385,09 €'], ['29.09.2026', 'Paul Beispiel', '7,28', '-'], ['29.09.2026', 'Katharina Beispiel', '7,95', '366,18 €']], align: ['left', 'left', 'right', 'right'], columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'] },
    ],
  };
  const long = { ...letter, title: 'Lieferschein #124 · umfangreiche Lieferung', layout: { ...letter.layout, information: [{ label: 'Lieferscheinnummer', value: '#124' }] }, sections: [summary([['Projekt', project], ['Lieferdatum', '3. Oktober 2026'], ['Gesamtkosten', { value: '27.000,00 €', bold: true }]]), buildPdfProductSection(Array.from({ length: 90 }, (_, index) => ({ number: `M-${String(index + 1).padStart(3, '0')}`, name: `Position ${index + 1}: Fassadenelement mit Befestigungszubehör und projektbezogenem Zuschnitt`, quantity: '12,00 Stück', price: '25,00 €/Stück', cost: '300,00 €' }))), text('Kommentar', description)], signatures: [{ title: 'Bauleitung' }, { title: 'Auftraggeber' }] };
  const presence = { ...weekly, title: 'Bauwochenbericht · Anwesenheit', sections: [
    summary([['Projekt', project], ['Zeitraum', '28. September 2026 bis 4. Oktober 2026'], ['Berichtstage', { value: '5', emphasis: 'primary' }]]),
    { ...weekly.sections[1], title: 'Anwesenheit je Mitarbeiter und Tag', subtitle: 'X bedeutet erfasste Anwesenheit; – bedeutet keine erfasste Arbeitszeit.', columns: weekly.sections[1].columns.slice(0, -1), rows: weekly.sections[1].rows.map(row => [row[0], ...row.slice(1, -1).map(value => value === '-' ? '-' : 'X')]), totalRows: undefined, align: ['left', ...Array(7).fill('center')], columnWidths: ['2.6fr', ...Array(7).fill('0.65fr')] }, weekly.sections[2],
  ] };
  const weekCosts = { ...costs, title: 'Projektkostenbericht · KW 40', sections: [
    { ...facts([['Einzelkosten', { value: '2.610,00 €', bold: true }], ['Produkte', '1.410,00 €'], ['Arbeitszeit', '1.200,00 €']]), presentation: 'metrics' }, ...costs.sections.slice(1),
  ] };
  const narrow = { ...base, ...buildTablePdfDocument({ title: 'Tabellenexport · Lieferungen', headers: ['Datum', 'Nummer', 'Projekt'], rows: [['03.10.2026', '#123', project], ['04.10.2026', '#124', project]] }) };
  const manyContacts = {
    ...contacts, title: 'Projektdatenblatt · umfangreiche Kontaktliste',
    cardSections: [{ title: 'Ansprechpartner', cards: Array.from({ length: 12 }, (_, index) => ({
      ...contacts.cardSections[0].cards[index % 3], title: `Kontakt ${index + 1}: ${workerNames[index % 3]}`,
    })) }],
  };
  return [letter, weekly, { ...regie, ...base }, costs, inventory, daily, contacts, wide, screenshotCosts, long, presence, weekCosts, narrow, manyContacts];
}

export const pdfFixtureNames = ['lieferschein', 'bauwochenbericht', 'regiebericht', 'projektkosten-gesamt', 'inventur', 'bautagesbericht', 'projektdatenblatt', 'tabellenexport-breit', 'projektkosten', 'lieferschein-mehrseitig', 'bauwochenbericht-anwesenheit', 'projektkosten-woche', 'tabellenexport', 'projektdatenblatt-mehrseitig'];

// One continuous report with short weeks surrounding a table spanning pages.
export function weeklyProjectCostsFixture({ buildWeeklyProjectCostsPdfDocument, buildPdfProductSection }) {
  const amounts = ['1.200,00 €', '10.600,00 €', '1.100,00 €'];
  const materials = ['400,00 €', '600,00 €', '300,00 €'];
  const labor = ['800,00 €', '10.000,00 €', '800,00 €'];
  const weeks = [39, 40, 41].map((number, index) => ({
    label: `KW ${number} / 2026`,
    start: new Date(Date.UTC(2026, 8, 21 + index * 7, 12)),
    end: new Date(Date.UTC(2026, 8, 27 + index * 7, 12)),
    sections: [
      { title: '', presentation: 'metrics', withHeader: false, columns: ['Kennzahl', 'Wert'], columnWidths: ['2fr', '1fr'],
        rows: [['Einzelkosten', { value: amounts[index], bold: true }], ['Produkte', materials[index]], ['Arbeitszeit', labor[index]]] },
      buildPdfProductSection([{ number: `M-${101 + index}`, name: ['Fassadenbefestigung', 'Dämmplatten', 'Montagematerial'][index], quantity: '1 Pauschale', price: `${materials[index]}/Pauschale`, cost: materials[index] }]),
      { title: 'Arbeitszeit', columns: ['Tag', 'Mitarbeiter', 'Stunden', 'Kosten'], align: ['left', 'left', 'right', 'right'], columnWidths: ['0.9fr', '1.7fr', '0.7fr', '0.9fr'],
        rows: index === 1
          ? Array.from({ length: 100 }, (_, n) => [`${28 + n % 3}.09.2026`, `Mitarbeiter ${n + 1}`, '2', '100,00 €'])
          : ['Anna Musterfrau', 'Maximilian Beispielmann'].map(name => [index === 0 ? '21.09.2026' : '05.10.2026', name, '8', '400,00 €']),
        totalRows: [['Gesamt', '', index === 1 ? '200' : '16', labor[index]]] },
    ],
  }));
  return {
    ...buildWeeklyProjectCostsPdfDocument({
      projectTitle: 'Neubau Schulzentrum · Musterstadt',
      exportedAt: new Date('2026-10-12T12:00:00Z'),
      overviewSections: [
        { title: 'Zusammenfassung', presentation: 'metrics', withHeader: false, columns: ['Kennzahl', 'Wert'], columnWidths: ['2fr', '1fr'], rows: [['Einzelkosten gesamt', { value: '12.900,00 €', bold: true }]] },
        { title: 'Einzelkosten je Woche', columns: ['Woche', 'Produkte', 'Arbeitszeit', 'Einzelkosten'], align: ['left', 'right', 'right', 'right'], columnWidths: ['1.4fr', '1fr', '1fr', '1fr'],
          rows: weeks.map((week, index) => [week.label, materials[index], labor[index], amounts[index]]), totalRows: [['Gesamt', '1.300,00 €', '11.600,00 €', '12.900,00 €']] },
      ],
      weeks,
    }),
    layout: { sender: { name: 'Musterbau GmbH', lines: ['Musterstraße 1', '12345 Musterstadt'] } },
  };
}
