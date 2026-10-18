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
`assets/icons/tabler/LICENSE`.

Ubuntu Regular, Medium and Bold come from Google Fonts revision
`bed55e0de5cfa8f5fb94f9a1f49409b5ec504469`. Original font files, `UFL.txt`,
`METADATA.pb` and provenance records are retained under `assets/fonts/ubuntu/`.
Fonts are bundled for offline use. The manifest declares 33 runtime files:
27 icons, their license, three font faces and two font notices/metadata files.
`provenance.json` is retained as source-only metadata and is not declared as a
runtime asset.

## Validation checkpoint

The combined client/package suite passed 271 functional tests. Strict analysis
reported zero findings with complete reports for all 161 current Dart source
and test files. JavaScript and WebAssembly release compilation passed. Both
output bundles contain exactly the 33 manifest-declared shared UI asset files,
byte-identical to their sources.

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
page-size controls have functional keyboard/action checks.

The client connects existing project-block markers to its scoped edit/delete
workflow. Typed absence-action drafts and known-ID/actor target checks are
tested, but decision/deletion journaling, scoped dispatch, dialogs and management
routing remain pending. Block creation, active absence decisions/deletion,
planning export/print and broader screen/session/router coverage remain pending.
The project overview and customer list now use shared attribute cards and
inline links, but complete project details, customer creation/editing and
details, remaining forms and exports are not finished. These checks do not
establish visual, production-storage, cross-tab-locking, live-session or
native-device acceptance.
