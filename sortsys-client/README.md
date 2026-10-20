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
retains successful sections and offers a retry. Customer creation and editing
use the active scoped dialog, durable secure receipts and verified-ID
navigation. The coordinator owns its loaded baseline, validates selected
contact IDs and journals each separate write. Read-only recovery never
repeats a mutation. The contact picker supports nested creation while
preserving the customer draft and existing selections.

The customer action menu keeps the persistent Ctrl+E editor and opens the
guarded deletion dialog. Deletion requires the irreversible confirmation
and a genuine server acknowledgement. Its journal interlocks with
create/edit, and uncertain dispatches are never replayed. Exports and live
updates remain pending.

The persistent header exposes global search, opened by its magnifier or
Ctrl+K / Cmd+K. Search uses the permission-gated generated queries for projects,
tools, users, products, customers, contacts, vendors and numeric delivery-note
lookup. Results reject stale account responses. The command palette also
supports command-only search and recent actions. The command palette
currently exposes project, customer, contact, vendor and product creation,
and opening the existing planning screen.

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
booking/return/transfer actions, project tabs, remaining actions and exports
are still incomplete.
Customer and contact details use dedicated views. Contact details
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
Global `contacts.create` and detail-header/Ctrl+E editing use the existing
session binding with view/manage guards and per-target one-open protection.
A separate FlutterSecureStorage namespace persists receipts; iOS uses
device-bound app Keychain accessibility. Navigation and detail reload use
verified readbacks. Authenticated production and native-device acceptance
remain pending.

Contact details expose Edit and Delete in Webapp order with a shared busy
state and the persistent Ctrl+E editor. Deletion requires view/delete roles,
the irreversible confirmation and a genuine server acknowledgement. Its
version-two journal shares the known-target edit key and in-process lock;
uncertain dispatches are never replayed. Only the acknowledged contact ID
on the same complete owned URI returns to the contact list.

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
styling. Both notices now use the canonical Carbon Locked and Box icons.
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
from a copy, without mutating the records. Rendered visual comparison
and live updates remain pending.

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
Record price, Edit categories, Edit and Delete appear in Webapp order.
Category editing requires product visibility and manage:products; deletion
requires product visibility and delete:products. The menu uses Carbon
OverflowMenuVertical, CurrencyEuro, Edit and TrashCan. Unavailable actions
are omitted. All four workflows share current-route and live busy guards;
deletion uses the scoped acknowledged workflow described below.

The price dialog uses the tested typed draft, controller-owned form fields
and scoped vendor lookups. Functional tests exercise unit/vendor selection and
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
verified success. The canonical icon menu also opens the scoped deletion
workflow described above. Some resource detail routes still use generic views.

Project Regie-report cards, local ISO-week ranges, project-filtered querying
and URL-backed top pagination are connected to the active project report tab.
The real router exposes /projects/:id/regieReports. Header editing and the
completed-project notice are shared with the overview. Tab visibility follows
the canonical tools/report permissions; project and report reads check current
session scope. Loading/error states, retry, encoded links and narrow German
RTL navigation have functional coverage. Report exports, live updates and
authenticated acceptance remain pending.

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

Generated API coverage does not establish workflow coverage. Remaining
project detail tabs/actions, entity action menus, other CRUD forms, costs
and bookings, report workflows, file operations, imports, tool transfers,
remaining planning actions, table sorting outside projects, customers,
tools and vendors, chat/proposals, settings, administration and exports
still need implementation or Webapp parity. Typst rendering, OnlyOffice
and draw.io are not integrated yet. Desktop platform runners are pending.

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

### Active contact-deletion checkpoint

Fresh complete, unexcluded suites passed 1,004 client tests across 149 files
and 72 shared UI tests across 18 files: 1,076 tests across 167 files. Both
runners reported success and exited with code zero, without failures, errors,
skips or stderr. Exact suite sets and selected source-declared literal names
were checked. All 57 contact-delete foundation, adapter and dialog cases and
11 contact-entry cases ran, including eight new menu, ownership and router
cases. The 66 product-delete cases, 16 product-menu/router cases, ten customer
entry cases and three master-entry cases also ran. The earlier seven product
menu additions and actual final SessionController/GoRouter tests remain covered.

Static validation received all 450 clean analysis-error notifications:
446 Dart files and four YAML files. All 446 explicit Dart getErrors queries
were clean. Status subscriptions, roots, all overlays, priority files,
queries and shutdown were acknowledged. Busy-to-idle was observed; protocol
errors and server stderr were empty, and the server exited with code zero.

Thirty-six eligible files matched the Dart formatter with language version
3.11 and an 80-column page width. The product detail screen's two historical
formatter regions were audited privately and restored before tests. Manual
review covered complete changed files, purpose grouping, braced callbacks,
wrapping and ownership across awaited operations. Corrections separated test
cases and strengthened duplicate-query ordering and decoded-route-ID checks.

The full gate and each release used entirely new physical, writable,
byte-identical client/UI siblings before offline Pub. Client resolution used
enforce-lockfile. All 622 maintained file hashes and private original input
bytes were checked before and after execution. Original private analysis
options and the absent UI lockfile were restored. Seven protected maintained
resolver/native configuration absences remained unchanged.

Fresh JavaScript and WebAssembly release builds passed in separate new pairs,
with no build stderr and code-zero exits:

- JavaScript: 4,430,189 bytes,
  SHA-256 `ab1d7c06b231114a73ed6076002b3e20bd877da154237c1522df1cde10564cd6`.
- WebAssembly: 4,133,891 bytes,
  SHA-256 `cae4145b9ef3272cc0ad8365e172e6cfacd3695da99f94e3b821f6ed7241c343`.

Both bundles passed the fixed 33-file Tabler/Ubuntu and separate 19-file
Carbon audits. All 16 added SVG hashes, viewBoxes and geometry counts and
five pinned Ubuntu file hashes matched. The two provenance JSON files
remained source-only and absent from the runtime bundles.

Contact details expose Edit then Delete with genuine 16px Carbon icons.
Unavailable actions are omitted. The persistent Ctrl+E editor retains its
standalone API and Contact-valued save callback. Editing and deletion share
one live busy flag. The page keeps its action state through delete-role loss
while the same view owner survives. The real final SessionController, binding,
current view, displayed contact ID and complete captured URI govern callbacks.

The 640px danger dialog uses the existing contactName helper, the linked-data
warning, bold irreversible text and the required checkbox. Its baseline
freezes all nine generated Contact fields, including raw nullable names,
absent versus explicit-null address values, ordered channels and timestamps.
Tests cover confirmation, busy submit/cancel/back guards, lost acknowledgements,
reopening, stale responses, held callbacks, mutable parent snapshots and
320px doubled German RTL layout. Menu tests exercise both themes.

Deletion and known-target editing share the actual JSON scope tuple
[origin, tenant, user, contactId], the sortsys.contact_write.v1. key namespace
and the existing contacts:$scope in-process lock. New-contact creation keeps
its separate null-target scope. Strict version-one edit and version-two delete
envelopes reject each other. Actual legacy edit and delete coordinators block
pending incompatible journals before business requests. Storage tests use
in-memory plugin mocks.

Intent and dispatch are persisted and read back before one generated ID-only
delete request. A genuine positive acknowledgement is required; absence and
HTTP 404 do not establish success. Uncertain dispatches are never replayed.
Exact-nonce proven-unsent discard and acknowledged cleanup remain view/target
bound after delete-role loss. Cleanup faults retain the confirmed contact ID.
Only the matching acknowledged ID on the same captured complete URI navigates
to /contacts. Duplicate-query ordering, fragments, targets and ownership changes
are checked. The actual unauthenticated final-session detail route rejects
actions and Ctrl+E without changing its owned URI before navigation or disposal.

Customer create/edit, nested contact creation and the earlier customer/product
deletion workflows remain active. Other entity details and CRUD workflows,
supervisor hierarchy and German ordering, delivery-note forms, import/export
and live updates remain incomplete. Rendered browser comparison, authenticated
service workflows and native-device secure-storage acceptance remain open.
No deployment or store release has been performed.

### Earlier active product-deletion checkpoint

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
