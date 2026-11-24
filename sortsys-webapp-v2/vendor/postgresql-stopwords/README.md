# Stoppwörter für die Dateisuche

`words.json` enthält die deutschen und englischen Stoppwortlisten aus dem
Fedora-Paket `postgresql-server-18.3-12.fc45`. Die Einträge aus
`tsearch_data/german.stop` (231) und `tsearch_data/english.stop` (127) stehen
in unveränderter Reihenfolge im JSON. Die Webapp verwendet sie beim Aufbau
und bei der Abfrage des lokalen Indexes für Dokumenttexte.

Die Webapp liefert den [PostgreSQL-Lizenztext](../../public/licenses/postgresql-stopwords/COPYRIGHT.txt)
und die [Herkunftshinweise zu Snowball](../../public/licenses/postgresql-stopwords/SNOWBALL-README.txt)
aus dem PostgreSQL-Tag `REL_18_3` unverändert mit aus.
