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
results; empty results have no pagination. Customer and project page-size
changes reset to the first page, matching the React Pagination component.
Both lists retain unrelated repeated query values and fragments.

Customer details now have a dedicated typed route with salutation, name,
address and channel attributes, customer-scoped remarks and activity, and
initially collapsed linked contacts and projects. Related queries require
their resource view permissions and reject stale scope responses. Related
projects must match the requested customer. A combined loading-error message
retains successful sections and offers a retry. Customer creation/editing fields and write
coordination are tested groundwork; no customer mutation actions are exposed.
The coordinator owns its loaded baseline, validates selected contact IDs,
journals before each separate write and uses read-only known-ID recovery.
Production receipt storage, the create/edit dialog and navigation entry points,
detail actions, exports and live updates remain pending.

The persistent header exposes global search, opened by its magnifier or
Ctrl+K / Cmd+K. Search uses the permission-gated generated queries for projects,
tools, users, products, customers, contacts, vendors and numeric delivery-note
lookup. Results reject stale account responses. The command palette also
supports command-only search and recent actions. The command palette
currently exposes project creation, vendor creation, product creation and
opening the existing planning screen.

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
project. Contacts are not edited by the project form. The completed-project
notice uses the shared informational callout with the Webapp's colors, leading
border, padding and Carbon `TaskComplete` icon. Tests cover both themes,
directional geometry and the project outer-scroll layout at 320px with doubled
text; these checks do not establish rendered visual acceptance.

The overview also queries active tool bookings with the canonical project and
unfinished filters. Its initially collapsed section has a 320px scrolling
viewport, a five-column desktop table and compact attribute cards below 1400px.
Tool and user references are real links. Date sorting and 25/50/100-row pagination
are local to the table; page-size changes reset to the first page. The server
retains its own visibility filter and default 1000-row bound. Live refresh,
booking/return/transfer actions, project tabs, contact editing, remaining actions
and exports are still incomplete.
Customer and contact details use dedicated read-only views. Contact details
include canonical name handling, nullable first-name fields, bilingual
attributes and real map, email and phone links. Remarks are scoped to the
contact. Related customers and projects start collapsed; queries check session
scope and resource visibility, retain successful sections on partial failure
and provide a retry. Project queries retain the server's assigned-project
visibility.

Contact create/edit has typed drafts, form fields, RPC access, strict
receipts, write coordination and a dialog. Query text splits into first and
remaining names. Payloads preserve all six owned fields, explicit nulls,
optional addresses and ordered phone/email channels. Editing requires a
fresh full baseline. Prepared, dispatching and acknowledged stages prevent
uncertain writes from being replayed; create recovery needs the genuine
acknowledged ID, while known-target updates can be verified with reads.
The dialog is not connected to production session or navigation entries.
Production receipt storage remains unimplemented.

Tool lists use the Webapp's five columns: number, status, brand, category and
model. Numeric and localized status sorting, stable lowercase string sorting
and top pagination use the `Tools` URL keys. Page-size changes reset to the
first page while preserving repeated filters and fragments. Compact cards use
real encoded detail links and small status tags; desktop rows use medium tags.
Typed list reads check authentication, tool visibility and session binding
before and after the request. The existing status, brand, category and archive
URL filters remain active. Only `archived=yes` selects archived tools; the
default list excludes them. Tool-filter and archive controls are active. The
dialog provides the canonical status options and one selected brand/category
preview with removal. Unresolved text cannot become a selected filter. Option
loaders check current scope and `view:tools` before and after actual
brand/category reads. Dialogs disable when their session scope changes, and
applying a result rejects changed session, permission or route state. Filter
changes preserve unrelated repeated URL values, paging and fragments. The
controls use the shared operational tag; their canonical action icons, exports
and live stream updates remain pending.

Tool details now use a typed read-only view with canonical title and status
priority, conditional model/status attributes, bilingual EUR prices and real
brand/category filter links. The shared status tag matches the Webapp's color
mixes and medium/small geometry. Tool-scoped remarks and activity remain
read-only. Tool detail reads reject changed sessions, revoked visibility and
mismatched response IDs. Tested inventory and tracking query helpers preserve
tool ownership, inventory permissions and the server's responsible-user
tracking visibility. Tool-history project and user reference helpers reject
changed scope and mismatched identifiers. User references require `view:users`
before and after the actual read. These helpers are not connected to
booking-history UI. Archive and inventory notices, booking-history sections
and tool mutation workflows remain pending.

User lists use the Webapp's first-name, last-name and contract columns, stable
case-insensitive empty-last sorting and top 25/50/100 pagination. The Users URL
keys preserve unrelated repeated parameters and fragments. Compact cards show
canonical names with genuine encoded detail links. Only `archived=yes` selects
archived users: the request includes `includeArchived:true`, then the visible
rows retain only archived records. Active requests omit `includeArchived`.
List reads check current authentication, session binding and user visibility
before and after the request. The archive control uses the shared operational
tag. Canonical compact-card and archive icons, exports and live updates remain
pending.

User details now use a dedicated typed route with canonical names,
first/last-name fields, a system-monospace username, contract labels and genuine
email, phone and supervisor links. Hourly costs follow the Webapp's truthy
condition, omitting zero; leave days use a null-only condition and retain zero.
User and supervisor reads require the current owner/session scope and user
visibility before and after the request, rejecting empty and mismatched IDs.
A supervisor lookup failure leaves the main user content intact. Main-read
failures offer a retry.

User details display deactivation and archive notices. Future deactivation
uses a strict date comparison; English and German dates follow the Webapp.
Deactivation uses the warning callout, and archive notices use informational
styling. The unavailable Carbon Lock and Archive icons are omitted.
Booked tools, mutation actions and live updates remain pending. Logged-in
route/workflow and rendered visual acceptance remain open.

User-scoped booked-tools read helpers have functional tests for the exact
responsible-user and unfinished filters, immutable results, current owner/session
and page permissions, stable actor/visibility snapshots and rejection of
mismatched or finished records. They preserve responsible-user access without a
global tracking role and legitimate empty colleague results. The helpers are not
connected to the user-detail UI.

Contact lists use the Webapp's salutation/first-name/last-name/address columns,
stable case-insensitive empty-last sorting and top 25/50/100 pagination. Contacts
URL state preserves unrelated repeated query values and fragments. Compact cards
show the original contact name, address, email and phone fields with genuine
detail, map, mail and phone links; null-only channel labels and canonical German
fallback labels are preserved. List reads use the empty contacts.list input and
check current authentication, session binding and contact visibility before and
after the request. Exports and live updates remain pending; no inactive export
controls are shown.

Product lists use the Webapp's number/name/manufacturer columns, stable numeric
and case-insensitive sorting, top 25/50/100 pagination and compact number/title
cards. The Products URL keys retain sort and page state while preserving
unrelated repeated parameters and fragments. Category filtering uses the server's
nullable category input; brand filtering is local, case-insensitive and exact
without trimming original values. The filter dialog supports one manufacturer
and one category, original-label previews, removal/reselection and validation of
unresolved text. Option reads require the current session, route and product
visibility before and after each request. Changed scope disables submission while
retaining cancellation. Canonical action and product icons, exports and live
updates remain pending; no substitute icons or inactive export controls are shown.

Product details use a typed view with the canonical truthy brand/name
title, conditional attributes, category tags and initially expanded unit
conversions. Conversion ordering is stable and does not mutate source data.
Number formatting uses two to four decimal places. Latest prices include zero
values and use localized EUR formatting. Product and price reads check current
session, owner and visibility before and after the request and reject
mismatched product identifiers. Price-read failures retain product details and
offer a separate retry.

Product price history now includes a collapsed disclosure, date/price/vendor
desktop columns and compact attribute cards. Records start newest first with
stable ordering; date and price headers support sorting. The 320px viewport has
local 25/50/100 pagination below it. Vendor names use real encoded links and
separately guarded reads that require product, price-record and vendor visibility
before and after the request. Missing vendor identifiers are omitted.

Product price history includes a 150px linear-area chart above the table when
at least two records are available, with a 32px gap. Touch and pointer selection
display localized dates and EUR prices per base unit. Chart data is reversed
from a copy, without mutating the records. Rendered visual comparison,
category editing, deletion and live updates remain pending.

Product creation is active from the command palette and collapsed
master-data sidebar for users with both product visibility and product
management permission. Product-detail editing uses the header action or
Ctrl+E. The action rows are text-only where the canonical Carbon icon is
unavailable; no replacement icon is presented as a match.

The dialog preserves immutable edit numbers, canonical nullable fields,
UTF-8 limits, zero-inclusive numeric validation and copied unit conversions.
Unit suggestions are connected; the number-suggestion action is not active.
Writes use scope-specific secure receipts, a fresh edit baseline and one
mutation dispatch. Recovery never repeats a write or infers a create ID.
Navigation and completion callbacks require verified current records.
Authenticated production acceptance remains open.

Delivery-note lists now use the Webapp's number, recorded-date, effective-date
and comment columns. Numeric and date sorting, stable case-insensitive empty-last
comment sorting and top 25/50/100 pagination use the DeliveryNotes URL keys while
preserving unrelated repeated parameters and fragments. Number cells and compact
cards expose genuine encoded detail links. Compact cards show the canonical
delivery-note title and created date, without adding effective-date or comment
fields. Typed reads send the empty `deliveryNotes.list` input and check current
authentication, session binding and delivery-note visibility before and after the
request. The canonical compact-card icon, import workflow, exports and live stream
updates remain pending.

Delivery-note details now use a dedicated typed read-only route with the
canonical number title, project, comment, created-date, author and cost
attributes. Project, author and product references use genuine encoded links
and scoped reads. Project reads preserve server-authorized assigned-project
access. Note costs require delivery-note visibility, without an additional
product-price role. Independent failures retain successful content and offer
read retries.

Product and special-item sections start expanded when records exist. Their
400px viewports use desktop tables and compact attribute cards below 1000px
or with enlarged text. Product rows preserve selected-unit conversion,
quarter-compatible automatic units, base quantities, missing prices and zero
costs. Only average-price and cost headers are sortable; sorting and bottom
25/50/100 pagination use the Products URL keys and retain unrelated repeated
parameters and fragments. Special-item sorting and pagination are local.
Product references complete independently; obsolete responses and late
failures cannot replace current results. Editing, deletion, imports, exports
and live updates remain pending. Logged-in route/workflow and rendered visual
acceptance remain open.

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
scoped dialog and navigates only to the verified vendor ID. These vendor
action rows currently omit the canonical Carbon icon; existing icon-backed
rows retain their icons.

Nested vendor creation is active from the price vendor picker. Vendor
deletion, matching menu icons, live updates, live storage and authenticated
production/native/visual acceptance remain pending.

Product-price entry is active from the product-detail header for users with
product and price-record visibility plus `manage:productPriceRecords`. The
text-only ghost action opens the scoped dialog. It does not yet reproduce
the Webapp's icon dropdown; the canonical Carbon menu and price icons remain
pending.

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

Vendor lists now use the Webapp's name/description columns, stable lowercase
sorting and local pagination with 25, 50 or 100 rows per page. Compact cards
show the unchanged vendor name with real encoded detail links. List reads
check authentication, vendor visibility and session binding before and after
the request. The canonical compact-card icon, live stream updates and exports
remain pending.

Vendor details use the Webapp's header-only view, preserving the server-provided
name without displaying generic descriptions or timestamps.
Typed reads check authentication, vendor visibility, session binding and the
returned identifier. The scoped edit dialog reloads this detail only after
verified success. Vendor deletion and the matching icon menu remain pending.
Other resource detail routes still use generic views.

Project Regie-report cards, local ISO-week ranges, project-filtered querying and
URL-backed top pagination have tested components. Their loading/error states,
retry callback, permission-based tab visibility, encoded detail links and 320px
layout also have functional coverage. These components are not connected to an
active route; the project overview does not expose a report tab.

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
detail tabs/actions, contact editing, active customer creation/editing and actions,
other CRUD forms, costs and bookings, report workflows, file operations, imports,
tool transfers, remaining planning actions, table sorting outside projects,
customers, tools and vendors, chat/proposals, settings, administration and exports still need
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

## Current validation status

At the hierarchy-layout checkpoint, a fresh isolated run passed 60 focused
functional tests: 58 client tests and two shared UI tests. Coverage includes
price/product-master receipts, contact drafts and typed RPC access, contact
receipts and write coordination, eight contact-dialog cases, supervisor
graphs and scoped reads, five supervisor-layout cases and the shared error
callout. These tests use fake RPC responses and, where needed, an in-memory
journal; they do not establish authenticated production acceptance.

The hierarchy layout has working direct-report and expand-all controls,
encoded user links, cycle termination, loading/empty/partial-error states
and scope-reset behavior. A 320px German/RTL case with doubled Ubuntu text
passed using widget-local constraints. Session/route integration and
Webapp-equivalent German name ordering remain pending.

Five tests in `contact_form_fields_test.dart` remain unvalidated. The focused
60-test run does not replace those cases or establish a full-suite gate.
The latest full, unexcluded suites predate the contact additions: 616 client
successes with one vendor-lock assertion failure, and 62 shared UI successes
with one warning-callout test load error. Both failures remain unresolved.

Fresh analyzer validation received all 362 expected reports: 358 Dart files
and four configuration files. Version, subscriptions, roots, overlays,
priority files and shutdown were acknowledged. Busy-to-idle was observed,
with no missing or unexpected reports, no protocol errors, server exit zero
and unchanged protected resolver/native metadata. Diagnostics remain: the
warning-callout test calls the nonexistent `BoxBorder.resolve` method, and
two contact test files have string-interpolation lints. This is not a clean
analyzer gate. The unreachable contact-RPC null branch was removed, matching
the generated non-null query contract; its warnings are resolved.

Fresh JavaScript and WebAssembly release builds passed. Exactly 33
Tabler/Ubuntu runtime files per target matched their sources; Carbon assets
and provenance were outside the audit. All 444 maintained source, asset,
test, manifest, documentation and protected-metadata fingerprints stayed
unchanged during build validation. Release compilation does not verify
inactive workflow integration, rendered appearance or native-device behavior.

After that checkpoint, the canonical archive notice was added to the active
tool-detail layout. It uses the already-loaded archive timestamp, local dates
and informational styling, immediately after the header. No new RPC is used.
The unavailable Carbon Archive icon is omitted.

Four real-layout tests were added for an unarchived tool, bilingual/themed
placement, local-date and future-timestamp semantics, and narrow German
LTR/RTL rendering with doubled Ubuntu text. These four cases remain
unvalidated. The 60-test, 362-report and release-build evidence above predates
the archive-notice change and does not establish acceptance of the latest
code.

Webapp parity is incomplete. Customer create/edit actions remain inactive.
The contact dialog is implemented but lacks production receipt storage and
session/navigation integration. Other detail/CRUD workflows, the active
supervisor hierarchy, import/export, authenticated acceptance, rendered
comparison and native-device acceptance remain pending. No deployment or
store release has been performed.

## Historical intermediate checkpoint

- Analyzer protocol validation received 311 expected file reports without
  diagnostic entries, acknowledged subscriptions, configuration overlays,
  analysis roots, priority files and shutdown, observed busy-to-idle, and
  exited with code 0 without protocol errors.
- Verified intermediate validation passed 623 tests (567 client and 56 shared
  UI), including contracts,
  transport, project and planning payloads/write coordination, list URL state,
  pagination, the matrix and toolbar, assignment/absence dialogs, assignment
  deletion, project-block forms and edit/delete recovery, absence-action drafts,
  canonical routes, the active project overview layout, typed dates and
  disclosures, shared inline-link semantics and keyboard scrolling, customer
  sorting/cards/page composition, customer detail attributes and links,
  customer form/write groundwork, first-page reset on page-size changes,
  repeated-query preservation, active booked-tools query payload, stable date
  sorting, local pagination, desktop/compact layouts and state/retry handling,
  inactive project-report cards, ISO-week boundaries, URI preservation, tab
  navigation fixtures and permission visibility, global search and control
  geometry, the active completed-project callout in both themes and RTL, and
  passive lifecycle-intent validation, contact names/null fields and bilingual
  labels, actual contactId filters, linked cards, partial errors/retry and
  320px doubled-text outer scrolling. Contact-read regressions also cover
  permission revocation, changed sessions, assigned-project visibility and
  rejection of broader snapshots after a role change. Customer and contact
  page titles follow the Webapp's nonempty-name behavior. Finish/resume actions
  remain pending.
- The unchanged API generator checkpoint has seven passing regression tests;
  generated artifacts matched the authoritative contract on regeneration and
  check.
- JavaScript and WebAssembly web release compilation: successful. The current
  bundle audit checked 33 Tabler/Ubuntu runtime files in each build,
  byte-identical to source. Carbon assets were outside that audit's scope.
  Font provenance JSON is retained as source-only metadata.
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
