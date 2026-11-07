# Leitlinien für verständliche Bedienoberflächen

Diese Regeln gelten für Webapp-Seiten, gemeinsame Komponenten und Dialoge.

- HeroUI-Komponenten und deren Interaktionsverhalten verwenden. Layouts mit
  Tailwind und Gestaltung mit gemeinsamen Design-Tokens umsetzen. Eigenes CSS
  auf produktspezifische Layouts, Dokumentansichten und den Ladewürfel begrenzen;
  überholte Bedienelement-Stile entfernen.
- Seiten an der Aufgabe ausrichten: eindeutiger Titel, sichtbarer Kontext und
  klare Hauptaktion. Zusammengehöriges bündeln, Nebenaktionen zurücknehmen.
  Berechtigungen, Tastenkürzel, gespeicherte Arbeit und Browsernavigation erhalten.
- Abstände, Typografie und Inhaltsbreiten vereinheitlichen. Schmale Bildschirme
  und 200 % Zoom ohne seitenweites horizontales Scrollen unterstützen. Dichte
  Tabellen erhalten einen beschrifteten eigenen Scrollbereich. Wichtige
  Zeilenaktionen bleiben erreichbar. Listen über „Mehr anzeigen“ nachladen,
  sichtbare Ergebnisse erhalten und bei Filter- oder Sortierwechsel zurücksetzen.
- Beschriftungen knapp, konkret und begrifflich einheitlich halten. Felder
  dauerhaft beschriften und bei Bedarf Beispiele und Einheiten angeben.
  Texte der Anwendung mit den vorhandenen Hilfen auf Deutsch und Englisch anbieten.
- Formulare auf die aktuelle Aufgabe begrenzen. Eingaben nach Fehlern erhalten,
  Meldungen ihren Feldern zuordnen und beim Absenden das erste ungültige Feld
  fokussieren. Korrekturmöglichkeiten erklären, zerstörerische Aktionen bestätigen
  lassen und doppeltes Absenden verhindern.
- Ladezustände, leere Ergebnisse, Erfolg und Fehler unterscheidbar machen.
  Wichtige Änderungen ankündigen, ohne unnötig den Fokus zu verschieben.
  Behebbare Fehler bieten einen erneuten Versuch. Optionale Editoren blockieren
  weder den Start noch die Wiederherstellung der übrigen Anwendung.
- Durchgängige Tastaturbedienung ermöglichen. Semantische Links, Schaltflächen
  und Überschriften einsetzen; reine Symbolschaltflächen zugänglich benennen.
  Fokus sichtbar halten. Dialoge begrenzen den Fokus, schließen vorhersehbar
  und geben ihn auch bei Verschachtelung an den Auslöser zurück.
- WCAG 2.2 AA anstreben. Text- und Bedienkontraste in beiden Farbschemata prüfen;
  Zustände nie ausschließlich durch Farbe vermitteln. Berührungsziele bevorzugt
  mindestens 44 CSS-Pixel groß gestalten. Dichte Bedienelemente erfüllen die
  WCAG-Anforderungen an Zielgröße oder Abstand. Reduzierte Bewegung beachten;
  wesentliche Aktionen nicht ausschließlich beim Darüberfahren anbieten.
- Symbole für Inhalt, Zustand oder sonst unbeschriftete Aktionen einsetzen.
  Dekorative Symbole in bereits beschrifteten Menüs weglassen. Die visuelle
  Hierarchie ruhig halten; Verwaltungs- und Alltagsseiten folgen denselben Mustern.
- Vor Abschluss die betroffenen Seiten in Lade-, Leer-, Daten- und Fehlerzuständen
  prüfen. Gepflegte Tests, vollständige Typprüfung und Produktionsbuild ausführen.
  Desktop und Mobilansicht, beide Sprachen und Farbschemata, Tastaturbedienung,
  Dialoge, Formulare und typische berechtigungsgeschützte Abläufe im Browser prüfen.

## Quellen

Plattformspezifische Maße und APIs müssen an das Web angepasst werden. Bei
abweichenden Empfehlungen haben die folgenden Web-Zugänglichkeitsregeln Vorrang.

- [Google: Gestaltung interaktiver Canvas-Oberflächen][canvas]
- [Google: Bedienelemente und Interaktion][google-ui]
- [Apple: Gestaltungsrichtlinien][hig]
- [Microsoft: verständliche Oberflächentexte][content]
- [Microsoft: Empfehlungen für Anwendungen][windows]
- [Apple: Gestaltungstipps][tips]
- [HeroUI: Komponenten und Dokumentation][heroui]
- [WCAG 2.2][wcag]
- [WAI-ARIA: empfohlene Interaktionsmuster][apg]

[canvas]: https://developers.google.com/assistant/interactivecanvas/design
[google-ui]: https://developers.google.com/style/ui-elements
[hig]: https://developer.apple.com/design/human-interface-guidelines/
[content]: https://learn.microsoft.com/en-us/power-platform/well-architected/experience-optimization/user-interface-content
[windows]: https://learn.microsoft.com/en-us/windows/apps/get-started/best-practices
[tips]: https://developer.apple.com/design/tips/
[heroui]: https://github.com/heroui-inc/heroui
[wcag]: https://www.w3.org/TR/WCAG22/
[apg]: https://www.w3.org/WAI/ARIA/apg/
