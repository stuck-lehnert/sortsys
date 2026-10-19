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
- `SsInfoCallout` provides the Webapp's informational colors, leading border,
  padding and icon geometry. The active completed-project notice uses it with
  the Carbon `TaskComplete` icon.
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
  asynchronous single and multiple selection.

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
`assets/icons/tabler/LICENSE`. The Carbon `TrashCan` and `TaskComplete` vectors
come from `@carbon/icons-react` 11.89.0, pinned by the Webapp lockfile. The
archive's SHA-512 integrity was verified. Their original paths and viewBoxes
are unchanged; conversion notices retain attribution. The original Apache-2.0
license is bundled at `assets/icons/carbon/LICENSE`.

Ubuntu Regular, Medium and Bold come from Google Fonts revision
`bed55e0de5cfa8f5fb94f9a1f49409b5ec504469`. Original font files, `UFL.txt`,
`METADATA.pb` and provenance records are retained under `assets/fonts/ubuntu/`.
Fonts are bundled for offline use. The manifest declares 36 runtime files:
27 Tabler icons and their license, two Carbon icons and their license, three
font faces and two font notices/metadata files.
`provenance.json` is retained as source-only metadata and is not declared as a
runtime asset.

## Validation checkpoint

Verified intermediate validation passed 577 tests: 523 client tests and
54 shared UI tests. Analyzer protocol validation received 292 expected file
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
This is form-field functionality, not an active product create/edit save
workflow.

Automatic delivery-unit matching retains floating-point rounding for large
finite ratios and falls back when quotient or quarter calculations overflow,
matching the Webapp without bounded-integer conversion. Regression cases
cover these behaviors. Full form, CRUD, import/export, live-update, rendered
visual, native-device and live-session acceptance remains pending.

Product-price entry is active from the product-detail header for users with
product and price-record visibility plus `manage:productPriceRecords`. The
text-only ghost action opens the scoped dialog. It does not yet reproduce
the Webapp's icon dropdown; the canonical Carbon menu and price icons remain
pending.

The dialog uses the tested typed draft, controller-owned form fields and
scoped vendor lookups. Functional tests exercise unit/vendor selection and
removal, date input, the purchase checkbox, arithmetic and UTF-8 validation,
and German fields at 320 px with enlarged Ubuntu text. Copied conversion
baselines, signed comma prices, raw comments, local start-of-day timestamps
and omission of the selected vendor from this form's mutation payload are
preserved.

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
change. Contact editing and deletion remain pending. Customer details include customer-scoped
remarks/activity and collapsed contact/project sections. Customer form fields
and scoped write coordination have functional tests, but no production
customer mutation action is exposed. Receipt persistence and the active
create/edit workflow remain pending, alongside complete project details,
remaining forms and exports. These checks do not
establish visual, production-storage, cross-tab-locking, live-session or
native-device acceptance.
