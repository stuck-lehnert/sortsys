# sortsys_ui

Local Flutter UI and forms package used by `../sortsys-client`.

The existing Webapp is the design and workflow reference. Its shared control
styles live in `sortsys-react-components`. Colors, Ubuntu typography, square
surfaces and grouped navigation follow the Webapp. Custom navigation and form
icons use Tabler SVG assets.

Reference files:

- `../sortsys-react-components/src/styles.css`
- `../sortsys-react-components/src/index.tsx`
- `../sortsys-react-components/src/my-form.tsx`
- `../sortsys-webapp-v2/app/routes/(shell)/_layout.tsx`
- `../sortsys-webapp-v2/app/routes/(shell)/deployments.tsx`

## Components

Import `package:sortsys_ui/sortsys_ui.dart`.

- `SsTheme`, `SsColors` and `SsIcon` provide shared tokens and asset rendering.
  The customer channel-removal control uses the Webapp's Carbon `TrashCan` icon.
- `SsInfoCallout` supports informational, warning and error variants. The error
  variant uses the Webapp's danger-color mixes for its border, background,
  text and optional icon while retaining the directional leading border.
  Its tests cover both themes, LTR/RTL geometry and an actual optional asset.
  The completed-project notice uses the Carbon `TaskComplete` icon; user
  deactivation uses warning styling with Carbon Locked, and user/tool
  archive notices use Carbon Box.
- `SsTag` provides the Webapp's neutral, green, red, magenta and cyan color
  mixes and medium/small geometry. Tool details use it for canonical statuses.
- `SsOperationalTag` provides the Webapp's default-blue color mixes, square
  geometry, hover and keyboard-focus behavior. It supports real actions,
  disabled actions and noninteractive content. Active tool-filter controls use
  it without substituting unavailable action icons.
- `SsPressable` separates keyboard, focus and pointer behavior from visual
  geometry. Buttons, surfaces, list tiles, badges, progress indicators and
  page headers apply their own presentation.
- `SsLink` inherits surrounding typography and exposes a real URI to semantics.
  Enter activates it; Space and Shift+Space scroll instead. The client owns
  navigation or URL launching and its error handling.
- `SsAttributeList` and `SsAttribute` provide responsive bordered attribute
  cards with uppercase visual labels and preserved accessible label text.
  Equal-height rows support asynchronous and layout-builder children.
- `SsDisclosure` starts collapsed, supports keyboard activation and retains
  child state while excluding collapsed content from focus and semantics.
- `SsDataTable`, `SsTableSortHeader` and `SsPagination` support typed rows,
  sorting and responsive pagination. Empty tables retain their headers.
- `SsWorkspaceLayout`, `SsNavigationItem` and `SsNavigationSection` provide
  responsive grouped side navigation with a persistent header.
- `SsTabs<T>` provides typed, scrollable tabs with keyboard movement and
  selected-state semantics.
- `SsTextField` supports labelled text inputs, including search, email,
  password, phone and numeric input configurations.
- `SsCheckbox` is a controlled checkbox; `SsCheckboxField` participates in
  `Form` validation, saving and resetting.
- `SsTextAreaField` provides multiline editing. Its default viewport starts at
  four lines and grows to twelve; callers can configure both limits. Whitespace
  and newlines are retained.
- `SsDateField` provides keyboard editing, calendar selection, month navigation,
  clearing and Form save/reset/validation. Valid typed dates normalize to
  `dd.MM.yyyy` on blur.
- `SsSelectField<T>` and `SsChoiceBar<T>` provide typed choices.
- `SsAutocompleteField<T>` and `SsMultiAutocompleteField<T>` provide typed
  asynchronous single and multiple selection. Multiple selection can compose
  the entity picker for nested creation while retaining current selections.
- `SsSuggestionField` supports both free text and actual suggestion selection.
  Product unit lookups are connected to the active product-master dialog.
  These control tests do not establish authenticated, rendered or native-device
  acceptance.
- `SsEntityPicker<T>` keeps existing-entity and create choices distinct. Only a
  verified returned entity can become the selection. Cancellation, errors,
  capability changes and stale results do not create synthetic IDs. The price
  vendor picker connects nested vendor creation while retaining the price
  form's values; the selected vendor remains absent from its mutation payload.

The client supplies authorization, RPC calls and mappings to generated API
models. Flutter's text-editing and select infrastructure remains in use.
Project and planning forms use `SsDateField`. The planning toolbar hides its
visible label while retaining the editable input's accessible name; the
calendar has a distinct action name. Remaining control/workflow parity and
rendered visual acceptance are still open.

## Form behavior

The login username input is the minimum-height reference. Shared text/date
field frames have a 44px minimum; larger text and multiline content can grow.
The current application login measurement is 44px for username and password.

Date text accepts `d.M.yyyy` and ISO `yyyy-MM-dd` without date rollover. Partial
text remains editable; malformed nonempty text fails validation even when the
field is optional. Programmatic changes and Form reset update the text, and
late calendar results cannot overwrite intervening edits or a reset. Callers
remain responsible for civil-date versus instant conversion at API boundaries.

Call `FormState.validate()` before saving a form. A typed autocomplete rejects
nonempty unresolved search text during validation; it does not turn that text
into an entity ID. Empty optional selections remain valid unless a caller's
validator requires a value.

Supply authorized typed loaders and a `displayString` function. Multiple
selection also requires `optionKey`, which supplies stable entity identity for
option deduplication and removal. Saved selection lists are unmodifiable.

For nested multiple-selection creation, supply createLabel and onCreate.
Keep createLabel stable when capabilities change; setting onCreate to null
hides creation and rejects a pending result while retaining the query.
The callback returns a verified entity or null. Successful creation appends
the returned entity to the current selection without duplicate keys.
The underlying entity picker's canCreateQuery filters creation choices;
callers remain responsible for authorization and current-scope checks.

Use `queryIdentity` for the account, instance and query scope. A scope change
creates a new input lifecycle and resets the field to its supplied initial
value. That initial value must belong to the new scope. Late responses from
an old input cannot replace current options.

Lookups use a cancellable 250ms debounce. Disabling or disposing the input
cancels pending waits. An already-started loader remains responsible for its
own network and session cancellation. Lookup failures are shown as errors,
with configurable text.

## Development

Both sibling packages must be available to the same Flutter environment.
For package analysis, run from this directory:

```sh
flutter pub get
flutter analyze --no-pub
```

Run the combined functional suite from the consuming client so component
assets use the same package-prefixed paths as the application:

```sh
cd ../sortsys-client
flutter pub get
flutter test --no-pub test ../sortsys-flutter-ui/test
```

Keep SDK resolver files local to the environment that generates them. Do not
copy `.dart_tool`, native SDK configuration or build caches between machines
or containers. The application lockfile pins the consuming client's resolved
dependencies.

Run the normal Dart formatter before review, then check semantic statement
groups and blank lines after completed control-flow constructs, including
nested control flow. Ordinary widget arguments, callback properties and
closing delimiters do not require extra gaps. Check the final source even
where the formatter removes required control-flow spacing.

## Bundled assets

Tabler outline SVGs are pinned to `v3.34.1`; the original MIT license is in
`assets/icons/tabler/LICENSE`. The Carbon vectors come from
`@carbon/icons-react` 11.89.0, pinned by the Webapp lockfile. Seventeen
components have 18 SVG assets, including both User size variants. The
archive's SHA-512 integrity was verified. Their original paths and viewBoxes
are unchanged; conversion notices retain attribution. The original Apache-2.0
license is bundled at `assets/icons/carbon/LICENSE`.

Ubuntu Regular, Medium and Bold come from Google Fonts revision
`bed55e0de5cfa8f5fb94f9a1f49409b5ec504469`. Original font files, `UFL.txt`,
`METADATA.pb` and provenance records are retained under `assets/fonts/ubuntu/`.
Fonts are bundled for offline use. The manifest declares 52 runtime files:
27 Tabler icons and their license, 18 Carbon SVG variants and their license,
three font faces and two font notices/metadata files. Font provenance and
`assets/carbon_icon_provenance.json` remain source-only metadata. The Carbon
record contains source-module and SVG hashes for the 16 added variants.

## Current validation status

### Active product-deletion checkpoint

Fresh full, unexcluded suites passed 939 client tests across 144 files and
72 shared UI tests across 18 files: 1,011 tests across 162 files. Both runners
reported success and exited with code zero, without failures, errors, skips
or stderr. Exact suite sets and selected source-declared literal names were
checked. The 66 product-delete foundation, adapter, interlock and dialog cases,
16 menu/router cases, ten customer-entry cases and three master-entry cases
all ran. This includes the seven new product-menu cases and the actual final
SessionController/GoRouter unauthenticated route test.

Static validation received all 437 clean analysis-error notifications:
433 Dart files and four YAML files. All 433 explicit Dart getErrors queries
were clean. Status subscriptions, roots, all overlays, priority files,
queries and shutdown were acknowledged. Busy-to-idle was observed; protocol
errors and server stderr were empty, and the server exited with code zero.

Twenty eligible files matched the Dart 3.11, 80-column formatter. The product
detail screen differed only in its two protected historical formatting
regions; these were audited privately and restored before tests. Manual
review covered complete changed files, purpose grouping, braced callbacks,
wrapping and ownership across awaited operations. Concrete corrections
preserved captured callbacks and checked shortcut rejection before navigation.

Each validation and release used entirely new physical, writable,
byte-identical client/UI siblings before offline Pub. Client resolution
used enforce-lockfile. All 609 maintained file hashes and private original
input bytes were checked before and after execution. Original private
analysis options and the absent UI lockfile were restored. Seven protected
maintained resolver/native configuration absences remained unchanged.

Fresh JavaScript and WebAssembly release builds passed in separate new pairs,
with no build stderr and code-zero exits:

- JavaScript: 4,406,059 bytes,
  SHA-256 `8e629b427e9641316d1cc54f3aae58f6ba891fb0ebbb235afee988dabee0e49a`.
- WebAssembly: 4,120,736 bytes,
  SHA-256 `dafb7f7372cf4a203e769911082e109f6917bfadce949587f3a99a840b5e90e3`.

Both bundles passed the fixed 33-file Tabler/Ubuntu and separate 19-file
Carbon audits. All 16 added SVG hashes, viewBoxes and geometry counts and
five pinned Ubuntu file hashes matched. The two provenance JSON files
remained source-only and absent from the runtime bundles.

Product details expose Record price, Edit categories, Edit and Delete in
Webapp order with the genuine Carbon icons. Unavailable actions are omitted.
The persistent Ctrl+E master editor retains its standalone API. All four
workflows share live busy gates; a captured master-owner token prevents a
retired callback from clearing a replacement's gate. Current binding,
visibility, decoded product ID and the complete captured URI remain required.

Deletion uses the real final SessionController and requires product view and
delete permissions. The 640px danger dialog retains the linked-data warning,
including cost estimates, bold irreversible text and the required checkbox.
Its baseline freezes all nine generated Product fields, including the raw
unit map and ordered categories. Tests cover confirmation, busy submit/cancel/
back guards, stale responses, held callbacks, mutable parent snapshots and
320px doubled German RTL layout.

The strict version-two deletion receipt shares the existing product-master
journal key. Legacy master and deletion envelopes reject each other. Deletion
acquires the existing master, price and category in-process locks in that
order and refuses pending related journals. Active price/category construction
also checks the master journal before a new write; existing own-receipt
recovery remains unchanged. These are not cross-process locking guarantees.

Intent and dispatch are persisted and read back before one delete request.
A genuine acknowledgement is required; absence and HTTP 404 do not prove
success. Uncertain dispatches are never replayed. Exact-nonce proven-unsent
discard and acknowledged cleanup remain view/owner-bound after delete-role
loss. Cleanup faults preserve a genuinely confirmed product ID. Only the
matching acknowledged ID on the same captured complete URI navigates to
/products. Query-order, fragment, target or ownership changes prevent that
redirect. Platform-storage tests use in-memory mocks, not operator storage.

Customer create/edit and active nested contact creation remain connected;
the earlier customer-deletion and checkbox-lifecycle checks remain included.
Other entity actions and detail/CRUD workflows, supervisor hierarchy and
German ordering, delivery-note forms, import/export and live updates remain
incomplete. Rendered browser comparison, authenticated service workflows and
native-device secure-storage acceptance remain open. No deployment or store
release has been performed.

### Earlier active customer-deletion checkpoint

Both full, unexcluded suites passed: 865 client tests across 138 files and
72 shared UI tests across 18 files, for 937 tests across 156 files. Every
expected file and source-declared literal case was reported. All 59 explicit
customer-deletion, menu and checkbox-lifecycle cases ran, including the seven
new customer-menu/navigation cases. Both runners reported success and exited
with code zero, without failures, errors, skips or stderr.

Fresh static validation received all 424 clean reports: 420 Dart files and
four YAML files. Status subscriptions, roots, overlays, priority files and
shutdown were acknowledged. Busy-to-idle was observed; diagnostics, protocol
errors and server stderr were empty, and the server exited with code zero.
New or changed functional regions across nine files matched the Dart 3.11
formatter. Manual review checked purpose grouping, braced guards and wrapping;
unrelated historical formatting remained unchanged.

Each validation used entirely new physical, writable, byte-identical client
and UI siblings before offline Pub. The 509 source, test, asset and web inputs,
523 maintained fingerprints and four tool inputs were checked before and
after execution. Maintained projects stayed read-only. Original private
metadata bytes and absences were restored, including the absent UI lockfile.

Fresh JavaScript and WebAssembly release builds passed in separate new pairs,
with no build stderr and code-zero exits:

- JavaScript: 4,379,095 bytes,
  SHA-256 `155cc18b9e225a345d855a293eeb8724df7778e46db3b411e691c46b251c95db`.
- WebAssembly: 4,077,316 bytes,
  SHA-256 `440a4487ded5b971ad540f60aa3e45b109939ee78336002b878077be58655bad`.

Each bundle passed the fixed 33-file Tabler/Ubuntu audit and the separate
19-file Carbon audit. The 16 added SVG hashes, viewBoxes and geometry counts
and all five pinned Ubuntu file hashes matched. Both provenance JSON files
remained source-only and absent from the runtime bundles and manifests.

Customer details now expose the canonical Edit/Delete menu. The persistent
Ctrl+E editor and its standalone API remain available. Both actions share
one live busy guard. Deletion uses the real final SessionController, current
binding and view/delete permissions, the linked-data warning and required
irreversible confirmation. The 640px danger dialog blocks submit, cancel and
back while busy and freezes the complete customer baseline.

A strict nine-field version-two deletion receipt shares the actor's existing
customer journal key and in-process lock with create/edit. The envelopes
reject each other, so pending writes block incompatible operations. Intent
and dispatch are persisted and read back before one delete request. A genuine
server acknowledgement is required; a missing record is not proof of deletion,
and uncertain dispatches are never replayed. Proven-unsent discard and
acknowledged local cleanup retain current view/owner checks after delete-role
loss. Cleanup faults retain an already confirmed customer ID.

Verified deletion navigates to /customers only from the same captured full
URI, binding and customer ID. Changed query values, fragments, decoded paths
or ownership cannot redirect a newer page. Shared checkbox fields now reject
held callbacks after disposal or widget rebinding; regression tests also
verify that the current callback still changes the field.

These checks cover customer create/edit, active contact integration and the
new menu cases. Remaining entity actions and detail/CRUD workflows, product
deletion, supervisor hierarchy and German ordering, import/export and live
updates remain incomplete. Rendered browser comparison, authenticated
service workflows and native-device secure-storage acceptance remain open.
No deployment or store release has been performed.

The preceding customer-delete foundation checkpoint passed 915 tests across
154 files and received 419 clean reports. Deletion was not yet connected to
the UI at that checkpoint.

### Earlier active-category checkpoint

The active-category checkpoint passed both full, unexcluded suites:
811 client tests across 133 files and 70 shared UI tests across 17 files,
for 881 passing tests across 150 files. Every expected test file was
reported. Both runners reported success and exited with code zero,
with no failures, errors or skipped cases. Validation used entirely new
physical, writable sibling copies before offline dependency resolution.
Maintained sources stayed read-only. SHA-256 checks verified that all
495 copied source, test, asset and web inputs matched the maintained
files before and after execution. Original private metadata bytes and
absences were restored after Pub, including the absent UI lockfile.

The preceding picker checkpoint passed 865 tests and received 406 clean
reports, with 491 copied inputs and 505 maintained fingerprints unchanged.
The Unicode-license registration checkpoint passed 859 tests and received
404 clean reports, with 489 copied inputs and 503 maintained fingerprints
unchanged.

The preceding category-access checkpoint passed 858 tests and received
402 clean reports, with 487 copied inputs and 501 maintained fingerprints
unchanged. The coordinator checkpoint passed 844 tests and received
397 clean reports, with 482 copied inputs and 496 maintained fingerprints
unchanged. Category editing was not yet exposed at those checkpoints.

The category-receipt checkpoint passed 827 tests and received 394 clean
reports, with 479 copied inputs and 493 maintained fingerprints unchanged.
The matcher checkpoint passed 811 tests and received 391 clean reports,
with 476 copied inputs and 490 maintained fingerprints unchanged.

The earlier category-draft checkpoint passed 802 tests and received 388 clean
reports, with 473 copied inputs and 487 maintained fingerprints unchanged.
The product-menu checkpoint passed 790 tests and received 386 clean reports,
with 471 copied inputs and 485 maintained fingerprints unchanged.

The full runs include the previously unvalidated seven tool/customer-detail
cases and five contact-form cases. The warning-callout border assertion,
vendor concurrency assertion and two interpolation lints are corrected.
The shared fail-fast lock still reports PROJECT_WRITE_BUSY; its behavior
has not changed. Earlier focused runs and the historical checkpoint below
remain separate evidence.

Customer creation is active through the canonical customers.create command.
Detail-header editing and Ctrl+E open the same scoped customer dialog.
The real SessionController supplies binding, owner and view/manage checks;
one customer dialog can be open per session. Customer fields retain raw
editing values, ordered channels and explicit nulls. Updates use a fresh
baseline and send changed fields. Selected contact IDs are validated.

Customer create/edit receipts use a separate FlutterSecureStorage namespace
with strict ten-field envelopes, canonical intent validation and targeted
cleanup.
iOS uses device-bound app Keychain accessibility. Customer and contact-link
writes have separate durable stages. Recovery reads known IDs and never
repeats a mutation or infers a create ID. Verified success retains its
customer ID if receipt deletion fails, including failures after deletion.
Navigation and detail reload use the verified ID.

The customer contact picker supports nested contact creation for users with
the required customer and contact permissions. It opens the existing contact
dialog and appends only its verified returned record. Existing selections
and raw customer fields survive the nested dialog. Cancellation restores the
query, an already selected exact name suppresses creation, and revoked or
stale results cannot become selections. Actual nested-dialog tests hold
readback to verify that neither selection nor the customer write completes
early. Typed fakes, memory receipts and secure-storage plugin mocks supply
the test data; authenticated service and native persistence acceptance
remain open.

Global contacts.create and contact-detail header/Ctrl+E editing remain
active. They use actual session permissions, per-target one-open protection,
scoped secure receipts and verified records. Unacknowledged create dispatches
remain blocked; known-target updates support read-only verification.

Project details now expose the permission-filtered Overview and
Time-and-material reports tabs. The canonical /projects/:id/regieReports
route uses the real router and scoped project reads, retains the project
header, editing and completed-project notice, and renders the existing
project-filtered report cards and URL-backed top pagination. Encoded detail
links, loading/error states and retry remain available. New tests cover the
actual route with encoded IDs and repeated URI values, unauthenticated
final-session rejection, and integrated German RTL tab navigation at 320 px
with doubled Ubuntu text. The earlier report and overview regressions also
pass. Report exports, live updates and authenticated acceptance remain open.

Canonical Carbon icons are connected to project, customer, contact, product
and vendor creation commands. The project, vendor and product action menus,
user archive/deactivation notices and the tool archive notice also use them.
The archive's SHA-512 integrity matched the maintained lockfile's 11.89.0 pin.
Conversion preserved original geometry and viewBoxes, including the User
component's distinct 16px branch and 32-unit fallback. The shared asset test
renders all 44 registered icons; a separate test checks User asset selection,
dimensions and semantics. Attribution and the original Apache-2.0 license
are retained. Further action-menu integration remains pending.

Fifteen new functional cases cover the actual vendor confirmation dialog,
role-filtered icon menu, required checkbox, busy submit/close/back guards,
full-baseline conflicts, unreadable journals, lost acknowledgements across
reopening, stale replies and genuine-ID/current-route navigation. They also
cover proven-unsent discard and acknowledged local cleanup after delete-role
loss, cleanup faults before/after receipt removal, actual unauthenticated
final-session rejection and 320px doubled-text German RTL layouts. Pending
create/edit receipts block deletion. Unacknowledged deletion cannot be
replayed or cleared as success. Caller/navigation errors remain outside the
business-write catch. These tests use typed fakes and memory journals; they
do not establish authenticated service or native storage acceptance.

Eight product-menu and route cases check canonical price/category/edit
order, genuine icons, actual callbacks, unavailable/empty actions and busy
updates to already-open items. The busy test requires all three items to
exist before checking their disabled callbacks. Cases also cover category-only
menus at 320px doubled-text German RTL, decoded route IDs with retained query
and fragment state, and the real unauthenticated final-session edit owner
remaining mounted after menu closure. Its Ctrl+E handler stays outside the
transient overlay. Price and category flows remain page-owned and mutually
busy with master editing. Existing coordinators, receipts and role checks
are unchanged. An optional builder preserves the standalone edit-action API.
Presentation callbacks in these tests do not perform business mutations.

Product categories have an immutable typed draft with exact raw wire
values. Its 12 functional tests cover selection copies, ordering, case and
duplicate preservation, clearing, target validation, Unicode whitespace,
BOM preservation, UTF-8 boundaries and invalid surrogate pairs. Validation
matches the backend's trimmed 127-byte limit without altering selections.

The native-safe category matcher has nine functional tests. It uses pinned
Unicode 17 data rather than native lowercase defaults, keeps ECMAScript query
trimming separate from Rust value validation, and supports full default case
conversion, including final sigma. An exhaustive fresh probe matched Node's
Unicode 17 behavior for all 1,112,064 scalar values and 2,048 surrogate units,
four sigma contexts per value, and all trim boundaries. No differences were
found. This is default lowercase, not case folding or locale collation.

The backend's Rust 1.99 pin also uses Unicode 17.0.0. Category input/readback
helpers preserve raw submitted values and compute Rust trimming and
first-spelling deduplication separately. Sixteen functional tests cover exact
category multisets, known target IDs, immutable copies, the eight-field
receipt codec, dates, nonce and stage validation, genuine acknowledgement
values, payload ownership, UTF-8 size bounds and clearing. Readback ignores
category order and does not claim ownership of unrelated product fields.

The offline Unicode generator verifies pinned input hashes. Separate checks
reproduced its output, evaluated all mappings and properties, retained the
exact 1,995-byte Unicode License V3, and rejected corrupt or missing inputs
without clobbering output. Python syntax and wrapping were checked manually;
black, ruff, autopep8 and yapf were unavailable, so no Python formatter run is
claimed. The full license is now registered once with Flutter at actual
application startup. A functional test checks repeated registration, the
Unicode package attribution, complete license paragraphs and indentation,
and the original 1,995-byte UTF-8 text.

Category write coordination has 17 functional tests. Prepared and
dispatching receipts are persisted and read back before one mutation
dispatch. A fresh category-owned baseline, scoped in-process lock and
nonce checks guard conflicts and stale ownership. Genuine acknowledgement
and known-ID readback confirm success; uncertain writes are not replayed.
Read-only recovery and proven-unsent discard remain available after
manage-role loss. Cleanup faults retain an already verified product.

Typed RPC access and the real final-session binding have ten functional
tests for exact descriptors, raw immutable payloads, current actor and
permissions, response IDs, read snapshots and unauthenticated rejection.
Four secure-storage tests cover all receipt stages, actor/product
isolation, targeted cleanup, strict decoding and safe failed writes.
They use the in-memory plugin mock, not native or operator storage.
The app-specific namespace uses device-bound iOS accessibility.

The category-owned picker has six functional cases. It retains raw query
and selection spelling, shows the first 20 stable matches including selected
options, toggles exact checkbox values and never turns unresolved text into
a category. Chips are noninteractive. Tests cover outside-click geometry,
keyboard activation, stale owners, disabled callbacks and 320px doubled-text
German RTL in both themes. The pinned matcher preserves Webapp query rules
without changing shared autocomplete behavior.

Category editing is active through the actual product-detail menu for current
users with product visibility and manage:products. Record price, Edit
categories and Edit appear in canonical order; category editing uses the
genuine Carbon Edit icon. The page owns the opening lifecycle, captures the
live decoded product route and complete URI, and preserves final-session
binding checks. Only a verified same-ID result on that captured current route
triggers detail reload. Price, category and master actions disable each other
while busy; the persistent master Ctrl+E owner remains outside the overlay.

Thirteen dialog cases cover raw selections, clearing and no-op, single submit,
busy cancel/back guards, journal and option failures, explicit retries,
acknowledgement loss and read-only recovery without replay. They also cover
proven-unsent discard with preserved draft/query after manage-role loss,
cleanup faults before/after removal, frozen baselines, unowned server changes,
owned conflicts, stale options/callbacks, invalid legacy categories, actual
unauthenticated final-session rejection and narrow RTL layouts in both themes.
The modal uses the real category coordinator and scoped secure receipt adapter.
All 88 category cases and 23 menu/vendor-entry/vendor-dialog cases ran in the
full suite. Domain fakes, memory receipts and plugin mocks are test fixtures,
not authenticated service or native-device acceptance.

The formatter check used the resolved package's Dart 3.11 language version.
Thirty-four eligible files required no changes. The full ProductDetailScreen
comparison differed only in two unchanged historical hunks; its new category
integration blocks matched the formatter. Manual review covered purpose
gaps, braced guards and wrapping. No new formatting-only project tests
were added.

Fresh static validation received all 410 expected reports: 406 Dart files
and four configuration files. Status subscriptions, roots, overlays,
priority files and shutdown were acknowledged. Busy-to-idle was observed.
There were no diagnostics, missing or unexpected reports, protocol errors
or server stderr. The server exited with code zero. Protected resolver and
native metadata paths remained unchanged, including absent files.

Fresh JavaScript and WebAssembly release builds passed with customer and
contact workflows, nested contact creation, active project reports, vendor
deletion, active product-category editing and Unicode license registration.
Canonical icons are bundled. The fixed audit checked exactly 33
Tabler/Ubuntu runtime files per target. A separate audit checked all
19 Carbon files: 18 SVG variants and their license. Every audited file
matched its source. All 16 added Carbon SVG provenance hashes and five
Ubuntu provenance hashes matched. Both source-only provenance files were
absent from the bundles. All 509 maintained source, asset, test, manifest,
documentation and protected-metadata fingerprints stayed unchanged during
build validation. Four tool inputs were checked separately and also
remained unchanged.

Webapp parity remains incomplete. Product deletion, remaining
action menus, other detail/CRUD workflows, the active supervisor hierarchy
and its German name ordering, import/export, rendered comparison,
authenticated acceptance and native-device acceptance remain pending.
No deployment or store release has been performed.

## Historical intermediate checkpoint

Verified intermediate validation passed 623 tests: 567 client tests and
56 shared UI tests. Analyzer protocol validation received 311 expected file
reports without diagnostics, acknowledged subscriptions, configuration
overlays, roots, priority files and shutdown, observed busy-to-idle, and
exited with code 0 without protocol errors. JavaScript and WebAssembly release
builds passed. The scoped bundle audit checked exactly 33 Tabler/Ubuntu
runtime files per build, byte-identical to source; Carbon assets were
excluded. Maintained sources, lockfiles and the fingerprinted SDK/resolver
metadata remained unchanged during validation.

Tests cover form save/reset/validation, checkbox keyboard and disabled
semantics, exact textarea content, stale and scoped autocomplete responses,
multiple-selection deduplication, lookup failures, calendar selection and
clearing, typed-date parsing/validation and stale calendar responses, project
and customer URL state and pagination, shared attribute/disclosure behavior,
inline URL semantics and Enter/Space separation, grouped navigation and 320px
layouts with doubled text. Density regressions
check regular/small/icon buttons, text inputs, table cells, page headers,
pagination and the header/sidebar border-box geometry. The actual application
login verifies username/password height equality using bundled Ubuntu. Planning
controls, absence dialogs and assignment deletion have 320px/text-scale-2
action, busy-state and recovery checks. The block form and prepared-operation
recovery dialog also passed at 320px with doubled text. Customer cards use the active page's outer-scroll
layout in the 320px/text-scale-2 regression, including the last contact field.
Bounded compact rows also verify Space scrolling without link activation.
An earlier `America/New_York` run passed all 28 block cases and eight
absence-action draft cases with a measured local offset of `-04:00`; it
predates the current detail-control and customer-list changes. Tabs and
page-size controls have functional keyboard/action checks. The active project
bookings table uses shared table, link, attribute, disclosure and pagination
controls. Its regressions cover canonical query filters, stable date sorting,
local page-size reset, desktop headers and compact conditional fields, bounded
320px/text-scale-2 scrolling, and loading/error/empty states with retry.
The completed-project callout has both-theme, directional-geometry and
320px/text-scale-2 outer-scroll coverage. Project Regie-report components have
functional card, local ISO-week, pagination, permission-visibility and
navigation-fixture coverage, but are not connected to an active project route.

The active user list uses shared table, pagination, link and operational-tag
controls. Regressions cover archive inputs and filtering, current-scope and
permission checks, stable localized sorting, preserved URL state, actual
row/archive actions and compact scrolling at 320px with doubled Ubuntu text.

The active user-detail layout uses shared header, attribute and link controls.
Functional regressions cover original names and whitespace, exact translated
labels, cost/leave zero semantics, localized prices, system-monospace username,
genuine encoded supervisor and mail/phone links, mismatched supervisor omission,
section ordering and outer scrolling at 320px with doubled Ubuntu text.

The active delivery-note list uses shared table, sort-header, pagination, link
and surface controls. Functional regressions cover exact empty query inputs and
pre/post scope checks, numeric/date/comment sorting, preserved URL values,
genuine number/row actions, top pagination and page-size reset/clamping, bilingual
empty headers and compact scrolling at 320px with doubled Ubuntu text.

The active delivery-note detail route uses shared header, attribute,
disclosure, table, sort-header, pagination, link and surface controls.
Functional regressions cover exact scoped note/cost/reference inputs,
assigned-project visibility, zero/null and unit-conversion semantics,
bilingual attributes, actual links, sorting, preserved URL state, pagination,
compact scrolling and doubled-text outer scrolling at 320px. Async result
tests cover independent completion, immutable snapshots, partial failures,
mismatched identifiers, obsolete responses and disposal. These checks do not
establish logged-in workflow, rendered visual, native-device or live-session
acceptance.

Delivery-note creation/editing has tested, inactive typed draft and lookup
helpers. Drafts preserve the canonical signed/comma numeric rules, nonzero
entered quantities, selected-unit conversion, zero optional prices, UTF-8
limits and immutable row/unit snapshots. Create and edit payloads preserve
their different date and line-comment fields. Project and product searches
retain original input and result order, check current form/session scope and
management permissions before and after each read, and return immutable lists.
Project lookups retain server-authorized assigned-project access and reject
changed global visibility. Product lookups additionally require product
visibility. The active form, safe save/delete workflows, imports, exports and
live updates remain pending. These tests do not establish logged-in workflow,
rendered visual, native-device or live-session acceptance.

Delivery-note form state also has functional coverage for create defaults,
edit quantity prefill, matching project/product references, valid-unit
retention and first-option selection. Removed row controllers remain
available until the enclosing form is disposed. These state components are
not connected to an active create/edit form.

The shared single-selection autocomplete accepts an optional caller-owned
focus node and retains its internal fallback. Functional tests cover actual
focus and selection, query-scope reset, focus-node replacement and disposal
without disposing caller-owned nodes. Remaining form, workflow, rendered
visual, native-device and live-session acceptance is still pending.

Product form fields now accept an optional scoped unit-lookup callback.
Their shared SsSuggestionField allows free text as well as actual suggestion
selection. It prepares a copied option list per scope, uses trimmed lowercase
queries with a 250 ms delay, and preserves original option strings and order.
Functional integration tests cover selection, custom-unit payloads,
added-row focus, keyboard scrolling and selection, stale results, disposal,
lookup failure and disabled fields at 320 px with enlarged Ubuntu text.
These are unit-field interaction tests. The product-master dialog and
create/edit entries are now connected; authenticated acceptance remains open.

Automatic delivery-unit matching retains floating-point rounding for large
finite ratios and falls back when quotient or quarter calculations overflow,
matching the Webapp without bounded-integer conversion. Regression cases
cover these behaviors. Full form, CRUD, import/export, live-update, rendered
visual, native-device and live-session acceptance remains pending.

Vendor editing is active from the detail header for users with
`view:productVendors` and `manage:productVendors`; Ctrl+E opens the same dialog.
The text-only action does not yet match the Webapp's icon dropdown. Create
and edit dialogs use required Name and optional Description inputs,
initial-query/edit prefill, immutable edit IDs, canonical trimmed/null
payloads and trimmed UTF-8 limits of 127 bytes for names and 255 bytes for
descriptions.

Vendor writes persist prepared, dispatching and acknowledged receipts in
scope-specific secure storage. Each save dispatches at most one mutation.
An unacknowledged creation remains blocked; similar vendors never establish
ownership. Updates check a fresh baseline before dispatch and recover by
reading the known target without resubmission. Proven-unsent operations can
be discarded. Verified results remain known successes if receipt cleanup
fails.

Functional tests cover actual inputs, canonical payloads, conflicts and
no-op edits, storage failures, read-only recovery, stale ownership and
permission changes, busy cancellation, German fields at 320 px with doubled
Ubuntu text, and the detail-header/dialog route with verified closing.
RPC/storage tests use fakes and an in-memory plugin mock. Vendor creation
is active from the command palette and collapsed master-data sidebar for
users with vendor visibility and `manage:productVendors`. It opens the
scoped dialog and navigates only to the verified vendor ID. Vendor creation
rows now use the canonical Carbon TagGroup icon.

Nested vendor creation is active from the price vendor picker. The vendor
detail menu now uses the canonical Carbon icons. Edit requires vendor
visibility and `manage:productVendors`; Delete requires vendor visibility and
`delete:productVendors`. Deletion uses the Webapp's required confirmation
checkbox and warning. A fresh full baseline must match before one dispatch.
The scoped journal and lock are shared with create/edit operations in the
same scope. Only a genuine acknowledgement establishes deletion; missing
records and HTTP 404 do not. Navigation returns to the vendor list only if
the acknowledged ID and current detail route match. Live updates, live
storage and authenticated production/native/visual acceptance remain open.

Product-price entry is active from the product-detail dropdown for users
with product and price-record visibility plus `manage:productPriceRecords`.
Record price appears before Edit, matching the active Webapp actions. The
menu uses Carbon OverflowMenuVertical, CurrencyEuro and Edit. Unavailable
actions are omitted. Category editing and product deletion remain inactive;
the menu does not expose non-working entries.

The dialog uses the tested typed draft, controller-owned form fields and
scoped vendor lookups. Functional tests exercise unit/vendor selection and
removal, date input, the purchase checkbox, arithmetic and UTF-8 validation,
and German fields at 320 px with enlarged Ubuntu text. Copied conversion
baselines, signed comma prices, canonical trimmed/null comments, local
start-of-day timestamps and omission of the selected vendor from this form's
mutation payload are preserved. New price entries submit trimmed comment
text or explicit null for blank input, matching the actual Webapp form
runtime. Previously stored untrimmed receipts remain readable and recover
only through their acknowledged ID.

Each save persists prepared and dispatching receipts before one create
request. Only a genuine server acknowledgement and exact-ID, product-scoped
list readback confirm success. Unacknowledged dispatches remain blocked;
matching price rows never establish ownership or trigger a retry.
Proven-unsent operations can be discarded. Acknowledged receipts recover
through reads only and check the reviewed nonce. Verified creation is
distinguished from receipt-cleanup failure, so cleanup does not invite a
second submission.

The production adapter uses Flutter secure storage with actor/product-scoped
keys. Functional storage tests use an in-memory platform mock, not real
credentials. Dialog tests cover actual header opening, verified close, no
replay, read-only recovery, unsent discard, busy cancellation guards and late
disposal. These tests do not establish live storage, cross-tab locking or
authenticated production workflow acceptance. Remaining forms, import/export,
live updates, rendered visual comparison and native-device acceptance remain
pending.

The client connects existing project-block markers to its scoped edit/delete
workflow. Typed absence-action drafts and known-ID/actor target checks are
tested, but decision/deletion journaling, scoped dispatch, dialogs and management
routing remain pending. Block creation, active absence decisions/deletion,
planning export/print and broader screen/session/router coverage remain pending.
The project overview, customer list and dedicated customer/contact details use
shared attribute cards and inline links. Contact details include nullable
first-name fields, bilingual labels, real map/email/phone links, contact-scoped
remarks and initially collapsed related customers/projects. Related queries
check session scope and resource visibility, retain successful sections on
partial failure and provide a retry. Contact tests cover canonical name
whitespace, null-only channel fallback, exact contactId filters, grouped
customer-card attributes and outer scrolling at 320px with doubled text.
Contact-read regressions also cover permission revocation, changed sessions,
assigned-project visibility and rejection of broader snapshots after a role
change.

Contact create/edit has typed drafts, form fields, RPC access, strict
receipts, write coordination and a dialog. Query text splits into first and
remaining names. Payloads preserve all six owned fields, explicit nulls,
optional addresses and ordered phone/email channels. Editing requires a
fresh full baseline. Prepared, dispatching and acknowledged stages prevent
uncertain writes from being replayed; create recovery needs the genuine
acknowledged ID, while known-target updates can be verified with reads.
Global `contacts.create` and detail-header/Ctrl+E editing use the existing
session binding with view/manage guards and per-target one-open protection.
A separate FlutterSecureStorage namespace persists receipts; iOS uses
device-bound app Keychain accessibility. Navigation and detail reload use
verified readbacks. Authenticated production and native-device acceptance
remain pending.

Customer details include customer-scoped remarks/activity and collapsed
contact/project sections. Global customer creation and detail-header/Ctrl+E
editing use the active scoped dialog and secure receipts. The contact picker
opens nested contact creation, preserves the customer draft and appends only
verified returned records. Functional coverage includes cleanup failures,
read-only recovery, stale ownership, actual nested dialogs and narrow German
RTL layouts. Customer deletion, matching action menus, complete project
details, remaining forms and exports are pending. These checks do not
establish rendered, production-storage, cross-tab-locking, authenticated
service or native-device acceptance.
