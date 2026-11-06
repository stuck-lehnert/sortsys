Golden files from the development seed's native XML constructors (seed 42).
Regenerate from the repository root:

    CARGO_TARGET_DIR=/tmp/sortsys-seed-target cargo run --manifest-path sortsys-api-v2/Cargo.toml --bin seed_dev -- --write-gaeb-fixtures sortsys-gaeb/scripts/fixtures/native-seed

The browser tests validate every file against the bundled official XSD, edit the
supported phases, and exercise native derivation and invoice settlement. Runtime
seeding generates its positions from its own replay seed; it does not copy these
regression fixtures.

X31 contains six source-linked positions with 24 assisted measurement approaches.
The native FN91 rows remain independently executable without the editor's XML
comments. Browser tests check exact totals, source IDs and units, opening thresholds,
round trips, dimension editing, and the actual seeded canvas UI.
