# sortsys Flutter client

This client is under development. The existing Webapp and React Native app
remain in place. There is no deployment switch or store release in this change.

## Current scope

The client includes domain-first login, native credential storage, session
restoration, logout and permission-gated navigation. Browser bearer tokens stay
in memory.

Current screens cover recent activity, day/week planning in project/user
matrices and list/detail browsing for projects, products, tools, users, customers,
contacts, vendors, delivery notes and Regie reports. The project list uses the
Webapp's title/address columns, active/completed toggle, stable sorting and
URL-backed pagination with 25, 50 or 100 rows per page.

The customer list now has its own typed screen with the Webapp's five columns:
salutation, name, address, phone and email. It uses lowercase column keys,
direct string ordering, stable ties and missing values last. Sorting cycles
through ascending, descending and server order. Top pagination uses the
`Customers` URL keys and retains unrelated repeated parameters and fragments.
Compact customer cards use shared attribute cards and real title, map, email
and phone links. Headers remain visible during loading, errors and empty
results; empty results have no pagination. Customer creation/editing,
customer-specific details and actions, table exports and live list updates
remain pending.

The persistent header exposes global search, opened by its magnifier or
Ctrl+K / Cmd+K. Search uses the permission-gated generated queries for projects,
tools, users, products, customers, contacts, vendors and numeric delivery-note
lookup. Results reject stale account responses. The command palette also
supports command-only search and recent actions. Its current executable
commands are project creation and opening the existing planning screen.

Users with `manage:projects` can create a project from the collapsed master-data
sidebar group or the command palette; Ctrl+N also works on the project list.
The form covers title, optional address, customer, responsible project leader
and order-received date. It uses generated API inputs, scope-bound lookups and a
durable receipt before one mutation dispatch. Uncertain writes are not
replayed. An unacknowledged creation without a confirmed ID remains blocked;
the client does not infer ownership from matching project fields.

The dedicated project overview opens the same editor from its permission-gated
action menu or Ctrl+E. Updates use a fresh baseline, send only changed fields
and do not dispatch a no-op. The overview displays actual address, customer,
project-leader and order-date attributes, remarks, activity and initially
collapsed contacts. Dialog busy state is bound to the current session and
project. Contacts are not edited by the project form. Project tabs, tool
bookings, contact editing, remaining actions and exports are still incomplete.
Other resource detail routes, including customers, still use generic views.

The existing Webapp is the design and workflow reference. Its shared control
styles live in `sortsys-react-components`. The client uses the local
[`sortsys_ui`](../sortsys-flutter-ui/README.md) package for shared presentation
and forms, including typed single/multiple autocomplete, checkbox, textarea
and keyboard-editable date fields. Inline links, responsive attribute cards
and state-preserving disclosures are shared controls too. Navigation uses the Webapp's grouped sidebar and
persistent header. Products, delivery notes and vendors share the canonical
product-area tabs and paths. Legacy list/detail URLs redirect while preserving
query parameters, fragments and encoded IDs.

The shared shell owns the responsive outer gutter. Buttons, inputs, tables,
page headers and pagination use Webapp-derived geometry, including the
48px header, 256px desktop sidebar and 32px regular buttons. The login username
input is the height reference: shared text/date field frames have a 44px minimum.
The current login measurement is 44px for both username and password. Rendered
visual comparison remains pending. Planning defaults to the week view; the
active client has no bottom-tab bar.

API objects and endpoint descriptors are generated from
`../sortsys-api-v2/client/dist/generated/contract.d.ts`. The current contract
contains 312 unique object shapes, 89 queries and 151 mutations. Generated
nullable constructor fields default to null. Contract-optional fields preserve
absent, undefined and null as distinct values. Date and bigint fields use Dart
`DateTime` and `BigInt` values.

Generated API coverage does not establish workflow coverage. Remaining project
detail tabs/actions, contact editing, customer creation/editing and details,
other CRUD forms, costs and bookings, report workflows, file operations, imports,
tool transfers, remaining planning actions, table sorting outside projects and
customers, chat/proposals, settings, administration and exports still need
implementation or Webapp parity. Typst rendering, OnlyOffice and draw.io are not integrated yet. Desktop
platform runners are also pending.

## Planning workflows

The active project/user matrix supports day/week views, search, weekend and
empty-row controls, pinned labels and headers, absence rows and project-block
warnings. URL state follows the Webapp, row mode is saved locally, and scoped
full snapshots refresh every three seconds without overlapping requests.
Users without full planning visibility see their own assignments.

Users with `manage:projectDeployments` and `view:projectDeployments` can create
assignments from the toolbar or a cell and edit existing assignments. Creation
supports an ordered selection of multiple employees; editing selects one.
Updates contain only changed fields and use a fresh bounded baseline.

The edit dialog also offers deletion to users with
`delete:projectDeployments`. Its fresh snapshot must match the opened record.
Deletion is confirmed by the API's success acknowledgement. Lost acknowledgements
keep the operation blocked; recovery never infers deletion from a missing row
in a bounded snapshot. A stored acknowledgement can finish journal cleanup.
A prepared, proven-unsent deletion can be discarded. Both recovery actions
check the reviewed receipt nonce and display the stored target.

Authenticated users can enter their own leave or other absence. Users with
`manage:userVacations` can select another employee. Dates are inclusive civil
days, encoded at UTC midnight for stable API and receipt roundtrips. The server
determines approval status; the dialog returns the verified current record.

Assignment and absence writes persist a scoped receipt before one mutation
dispatch. Uncertain writes are not replayed. Creation and update recovery read
known record IDs; an unacknowledged creation remains blocked. Absence recovery also checks the
reviewed receipt nonce. Explicitly discarding a proven-unsent absence request
does not submit it or reopen its form.

Existing project-block markers open the interruption editor for users with
`manage:projectDeployments` and `view:projectDeployments`. The form selects a
real project and inclusive civil dates, requires a reason and accepts an optional
comment. Trimmed UTF-8 limits are 127 bytes for the reason and 255 for the comment;
input is not truncated. Changed date endpoints are encoded at UTC midnight.
Updates use a fresh complete baseline and send only changed fields.

Block deletion additionally requires `delete:projectDeployments` and uses the
original baseline, independent of unsaved form changes. Updates and deletion
share one scoped journal and lock. A receipt is persisted before one mutation
dispatch. Updates require known-ID readback of the requested target; API success
alone does not establish the resulting row. Deletion requires the genuine API
acknowledgement, never an absent row in a bounded snapshot.

Block recovery checks the reviewed receipt nonce and never repeats a mutation.
A proven-unsent operation can be discarded, an update can be verified by its
known ID, and an acknowledged deletion can finish journal cleanup. A deletion
without acknowledgement remains blocked. The dialog disables Close and Back
while busy and rejects a changed session or permission scope.

Absence-action drafts now use the server's `canApprove`, `canDeny` and
`canDelete` capabilities. Decisions require a requested record, and denial
reasons use the server's trimmed 255-byte UTF-8 limit. Known-ID decision target
checks include the captured actor and unchanged request fields; matching status
alone is insufficient. These are tested helpers, not enabled decision actions.
Durable action journaling, scoped dispatch, dialogs and the canonical absence
management route remain pending.

Absence decisions/deletion, a confirmed Webapp entry for block creation,
planning export/print and broader integrated screen/session/router regressions
remain pending. Injectable block-dialog tests do not establish production
storage, cross-tab locking or live-service acceptance.

## Platform projects

Android, iOS and web runners were created with the official Flutter 3.47.7
stable templates. Android and iOS use the application identifier
`app.sortsys.client`, separate from the existing mobile application's
`app.sortsys.mobile` identifier. No installed application was replaced.

Android declares network access, disables cleartext transport and backups, and
excludes shared preferences from cloud backup and device transfer. Release
signing is unconfigured; the template's debug-key release signing was removed.
iOS retains default App Transport Security and the generated scene lifecycle.

The launcher icons come from the existing sortsys brand asset. Regenerate them
with:

```sh
flutter pub get
dart run flutter_launcher_icons
```

## Development

Flutter 3.47.7 and Dart 3.13.5 were used for this checkpoint. Both this directory
and the sibling `../sortsys-flutter-ui` package must be accessible to the same
Flutter environment. In a container, mount the repository with both packages
and use `sortsys-client` as the working directory.

From this directory:

```sh
flutter pub get
flutter devices
flutter run
```

Android needs an Android SDK and a connected device or emulator. iOS needs
macOS, Xcode and a simulator or configured device signing. Chrome is needed
for an interactive web run. These platform prerequisites are not supplied by
the application sources.

### SDK and container changes

`.dart_tool/package_config.json` contains absolute SDK and package-cache paths.
It must be generated in the environment that performs the build. The same
applies to generated native SDK configuration files. Do not copy these files
between a development machine, a container and an isolated validation job.

If compilation reports missing packages under a different SDK or cache path,
regenerate the local metadata before building:

```sh
flutter clean
flutter pub get
flutter build web
```

For isolated validation, keep shared sources read-only and generate fresh
dependency metadata in a disposable build directory. The build can reference
the original code and assets read-only; a private source copy is not required.
Keep that build project's `package_config.json` and `package_graph.json`
together under its own `.dart_tool` directory.

Running isolated Pub resolution in the shared tree can overwrite the
developer's package resolution even though `.dart_tool` is ignored by Git.
Do not copy private resolver files, native SDK configuration or build caches
back into the shared project.

Regenerate and verify the API:

```sh
node tool/generate_contract.mjs
node tool/generate_contract.mjs --check
node --test tool/typed_contract.test.mjs
```

The generator currently uses the existing Webapp's installed TypeScript parser
read-only. Node 22 was used for these checks. Dart must be available for normal
formatting of generated sources; the generator then preserves the required
block spacing in maintained generated models and descriptors.

## Validation checkpoint

- Strict Dart/Flutter analysis: complete reports for all 161 current client and
  shared UI source/test files, with zero findings.
- Combined client/UI functional suite: 271 tests passed, including contracts,
  transport, project and planning payloads/write coordination, list URL state,
  pagination, the matrix and toolbar, assignment/absence dialogs, assignment
  deletion, project-block forms and edit/delete recovery, absence-action drafts,
  canonical routes, the active project overview layout, typed dates and
  disclosures, shared inline-link semantics and keyboard scrolling, customer
  sorting/cards/page composition, global search and control geometry.
- The unchanged API generator checkpoint has seven passing regression tests;
  generated artifacts matched the authoritative contract on regeneration and
  check.
- JavaScript and WebAssembly web release compilation: successful. Both bundles
  contain exactly the 33 manifest-declared shared UI assets, byte-identical to
  their sources. Font provenance JSON is retained as source-only metadata.
- Project list pagination and the command palette passed at a 320-pixel
  viewport with text scales 1 and 2. Shared sidebar navigation also passed at
  320 pixels with doubled text. Planning controls, absence dialogs and assignment
  deletion passed their 320px/text-scale-2 interaction, busy-state and recovery
  checks. The block form and prepared-operation recovery dialog also passed at
  320px with doubled text. Customer cards passed at 320px/text-scale 2 using
  the active page's outer-scroll layout, including scrolling to the last
  contact field. A separate bounded-card test verifies that Space scrolls
  without activating the focused link.
- An earlier `TZ=America/New_York` run passed all 28 block cases and eight
  absence-action draft cases with a measured local offset of `-04:00`. That
  focused run predates the current detail-control and customer-list changes;
  it is not a timezone rerun of the latest full source.
- Validation used the actual read-only sources with separate build metadata;
  the developer's resolver and native SDK metadata remained unchanged.

These checks do not verify a live authenticated session, visual acceptance or
mobile device behavior. The isolated Linux executor has no Android SDK or
macOS/Xcode environment. APK/iOS builds and the native XCTest cases have not
run. No build was published or deployed.

Run the application checks with:

```sh
flutter analyze --no-pub
flutter test --no-pub test ../sortsys-flutter-ui/test
flutter build web --release --no-pub
flutter build web --wasm --release --no-pub
```
