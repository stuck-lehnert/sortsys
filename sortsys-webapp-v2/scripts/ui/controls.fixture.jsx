import {
  Button,
  Checkbox,
  ComboBox,
  Content,
  DatePicker,
  DatePickerInput,
  FilterableMultiSelect,
  Header,
  HeaderMenuButton,
  HeaderName,
  Modal,
  Select,
  SelectItem,
  SideNav,
  SideNavItems,
  SideNavLink,
  SideNavMenu,
  SideNavMenuItem,
  SkipToContent,
  Tile,
  TextInput,
} from "@sortsys/react-components";
import { MyForm } from "@sortsys/react-components/my-form";
import {
  NotificationProvider,
  useNotifications,
} from "@sortsys/react-components/notifications";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link, MemoryRouter, useLocation } from "react-router";
import { MyDropdown } from "~/components/MyDropdown";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { ApplicationFixture } from "./application.fixture.jsx";
import { FormFieldsFixture } from "./form-fields.fixture.jsx";
import { MyExpandable } from "~/components/MyExpandable";
import { AttrList } from "~/components/AttrList";
import { MyModalsProvider, useMyModals } from "~/hooks/useMyModals";
import { I18nProvider, useI18n } from "~/lib/i18n";

const parameters = new URLSearchParams(window.location.search);
const requestedLocale = parameters.get("locale") === "en" ? "en" : "de";
const theme = parameters.get("theme") === "dark" ? "dark" : "light";
document.documentElement.classList.toggle("dark", theme === "dark");
document.documentElement.dataset.theme = theme;
document.body.dataset.ssTheme = theme;
window.__uiEvents = [];

function record(event) {
  window.__uiEvents.push(event);
}

function FixtureIcon(props) {
  return (
    <svg
      viewBox="0 0 20 20"
      width="20"
      height="20"
      data-fixture-icon="true"
      {...props}
    >
      <path d="M4 4h12v12H4z" fill="currentColor" />
    </svg>
  );
}

function FieldsFixture() {
  const [enabled, setEnabled] = useState(false);
  const [choice, setChoice] = useState("");
  const [items, setItems] = useState([
    { id: "alpha", name: "Alpha" },
    { id: "beta", name: "Beta" },
    { id: "mueller", name: "Müller" },
  ]);
  const [selected, setSelected] = useState(null);
  const [multiple, setMultiple] = useState([]);
  const [dates, setDates] = useState(null);

  return (
    <Tile role="region" className="space-y-4" aria-label="Field controls">
      <h2 className="text-xl font-semibold">Field controls</h2>
      <Checkbox
        labelText="Enabled"
        checked={enabled}
        onChange={(event) => setEnabled(event.target.checked)}
      />
      <Select
        labelText="Provider"
        value={choice}
        onChange={(event) => {
          setChoice(event.currentTarget.value);
        }}
      >
        <SelectItem value="" text="Choose provider" />
        <SelectItem value="alpha" text="Alpha" />
        <SelectItem value="beta" text="Beta" />
        <SelectItem value="disabled" text="Disabled provider" disabled />
      </Select>
      <ComboBox
        titleText="Single selection"
        items={items}
        selectedItem={selected}
        itemToString={(item) => item?.name ?? ""}
        onChange={({ selectedItem }) => setSelected(selectedItem)}
      />
      <FilterableMultiSelect
        titleText="Multiple selection"
        items={items}
        selectedItems={multiple}
        itemToString={(item) => item?.name ?? ""}
        clearSelectionText="Clear selection"
        createActionLabel={({ query }) => `Create ${query}`}
        onCreateAction={(name) => {
          const item = { id: `created-${name}`, name };
          setItems((current) => [...current, item]);
          setMultiple((current) => [...current, item]);
        }}
        onChange={({ selectedItems }) => setMultiple(selectedItems)}
      />
      <DatePicker value={dates} onChange={setDates}>
        <DatePickerInput id="fixture-date" labelText="Date" />
      </DatePicker>
      <output aria-label="Field values" className="block break-words text-sm">
        {JSON.stringify({
          enabled,
          choice,
          single: selected?.id ?? null,
          multiple: multiple.map((item) => item.id),
          dates: dates?.map((date) => date.toISOString()) ?? null,
        })}
      </output>
    </Tile>
  );
}

function FormFixture() {
  const [fail, setFail] = useState(false);
  const [submissions, setSubmissions] = useState(0);
  const [values, setValues] = useState(null);

  return (
    <Tile role="region" aria-label="Validated form">
      <h2 className="mb-4 text-xl font-semibold">Validated form</h2>
      <MyForm
        notifyLoaded={(form) => form.setValues({ name: "", quantity: 3 })}
        onSubmit={async (form) => {
          setSubmissions((count) => count + 1);
          const next = form.getValues();
          await new Promise((resolve) => window.setTimeout(resolve, 80));
          if (fail) {
            throw new Error("Synthetic save failed. Please retry.");
          }

          setValues(next);
        }}
      >
        <MyForm.Input name="name" labelText="Name" required />
        <MyForm.Input
          name="quantity"
          labelText="Quantity (kg)"
          type="number"
          min={0}
          required
        />
        <MyForm.SubmitButton>Save form</MyForm.SubmitButton>
        <Button
          type="button"
          kind="secondary"
          onClick={() => setFail((value) => !value)}
        >
          {fail ? "Allow saving" : "Fail saving"}
        </Button>
      </MyForm>
      <output aria-label="Submission state" className="mt-4 block text-sm">
        {JSON.stringify({ submissions, values })}
      </output>
    </Tile>
  );
}

function MenusFixture() {
  const [selected, setSelected] = useState(true);
  const [action, setAction] = useState("");

  return (
    <Tile role="region" aria-label="Menus">
      <h2 className="mb-4 text-xl font-semibold">Menus</h2>
      <MyDropdown
        label="File actions"
        items={[
          {
            label: "Rename",
            renderIcon: FixtureIcon,
            onClick: () => setAction("rename"),
          },
          {
            label: "Delete",
            renderIcon: FixtureIcon,
            onClick: () => setAction("delete"),
          },
          { label: "Excel", renderIcon: FixtureIcon, showIcon: true },
          { label: "Hidden action", hideIf: true },
          { label: "Disabled action", disabled: true },
          {
            label: "Show archived",
            selectable: true,
            selected,
            onClick: () => setSelected((value) => !value),
          },
        ]}
      />
      <output aria-label="Menu state" className="block text-sm">
        {JSON.stringify({ action, selected })}
      </output>
    </Tile>
  );
}

function DialogsFixture() {
  const [open, setOpen] = useState(false);
  const [nested, setNested] = useState(false);
  const [full, setFull] = useState(false);
  const [editor, setEditor] = useState(false);
  const [count, setCount] = useState(0);

  return (
    <Tile role="region" aria-label="Dialogs">
      <h2 className="mb-4 text-xl font-semibold">Dialogs</h2>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => setOpen(true)}>Open dialog</Button>
        <Button kind="secondary" onClick={() => setFull(true)}>
          Open full-size dialog
        </Button>
        <Button kind="secondary" onClick={() => setEditor(true)}>
          Open editor dialog
        </Button>
      </div>
      <Modal
        open={open}
        modalHeading="Parent dialog"
        primaryButtonText="Confirm parent"
        secondaryButtonText="Cancel parent"
        closeButtonLabel="Close parent"
        onRequestClose={() => setOpen(false)}
        onRequestSubmit={() => setCount((value) => value + 1)}
      >
        <TextInput
          labelText="Parent text"
          defaultValue="Retained parent text"
        />
        <Button onClick={() => setNested(true)}>Open nested dialog</Button>
        <Modal
          open={nested}
          modalHeading="Nested dialog"
          primaryButtonText="Confirm nested"
          secondaryButtonText="Cancel nested"
          closeButtonLabel="Close nested"
          onRequestClose={() => setNested(false)}
          onRequestSubmit={() => setCount((value) => value + 10)}
        >
          <TextInput labelText="Nested text" defaultValue="Retained text" />
        </Modal>
      </Modal>
      <Modal
        open={full}
        passiveModal
        data-fullwidth
        data-fullheight
        modalHeading="Full-size document"
        closeButtonLabel="Close document"
        onRequestClose={() => setFull(false)}
      >
        <div className="flex h-full min-h-0 flex-col" data-testid="editor-area">
          <p>Document toolbar</p>
          <iframe
            title="Synthetic editor"
            className="min-h-0 flex-1"
            srcDoc={`<!doctype html><html lang="en"><head>
            <title>Editor fixture</title></head><body><p>Editor ready</p></body></html>`}
          />
        </div>
      </Modal>
      <Modal
        open={editor}
        passiveModal
        edgeToEdge
        data-fullwidth
        data-fullheight
        modalLabel="Spreadsheet export"
        modalHeading="Projects.xlsx"
        closeButtonLabel="Close editor"
        onRequestClose={() => setEditor(false)}
      >
        <iframe
          title="Edge-to-edge editor"
          className="h-full min-h-0 w-full flex-1 border-0"
          srcDoc="<!doctype html><html lang='en'><title>Editor</title><p>Editor ready</p></html>"
        />
      </Modal>
      <output aria-label="Dialog confirmations" className="mt-4 block">
        {count}
      </output>
    </Tile>
  );
}

const existingAsyncContact = { id: "1dag4dqo8npse", name: "Existing contact" };

async function prepareAsyncChoices() {
  await new Promise((resolve) => window.setTimeout(resolve, 700));
  return { prepared: true };
}

async function loadAsyncChoices({ query, init }) {
  if (!init?.prepared) {
    throw new Error("Fixture choices require completed preparation");
  }

  const request = { query, finished: false };
  window.__sortsysAutocompleteRequests ??= [];
  window.__sortsysAutocompleteRequests.push(request);
  await new Promise((resolve) =>
    window.setTimeout(resolve, query === "slow" ? 700 : 180),
  );
  request.finished = true;

  if (query === "failure") {
    throw new Error("Synthetic suggestion failure");
  }

  const result =
    query === "slow"
      ? { id: "slow", name: "Slow stale result" }
      : query === "fresh"
        ? { id: "fresh", name: "Fresh result" }
        : { id: "alpha", name: "Alpha contact" };

  return [existingAsyncContact, existingAsyncContact, result, result];
}

const asyncSuggestions = {
  prepare: prepareAsyncChoices,
  getItems: loadAsyncChoices,
  stringify: ({ item }) => item.name,
};

function AsyncAutocompleteFixture() {
  return (
    <Tile role="region" aria-label="Async autocomplete">
      <h2 className="text-xl font-semibold">Async autocomplete</h2>
      <MyForm
        notifyLoaded={(form) =>
          form.setValues({
            people: [existingAsyncContact, existingAsyncContact],
          })
        }
      >
        <MyForm.Input
          name="single"
          labelText="Async single"
          suggestions={asyncSuggestions}
        />
        <MyForm.MultiSelect
          name="people"
          labelText="Async people"
          prepare={prepareAsyncChoices}
          getOptions={loadAsyncChoices}
          renderItem={({ item }) => item.name}
          stringifyItem={({ item }) => item.name}
          clearSelectionText="Clear async selection"
        />
      </MyForm>
    </Tile>
  );
}

function ModalSizingFields({ count }) {
  const [extra, setExtra] = useState(false);

  return (
    <>
      <h3 className="text-lg font-semibold">Form details</h3>
      {Array.from({ length: count + Number(extra) }, (_, index) => (
        <MyForm.Input
          key={index}
          name={`field-${index}`}
          labelText={`Field ${index + 1}`}
        />
      ))}
      <Button kind="secondary" onClick={() => setExtra((value) => !value)}>
        {extra ? "Remove extra field" : "Add extra field"}
      </Button>
    </>
  );
}

function ModalSizingFixture() {
  const modals = useMyModals();

  return (
    <Tile role="region" aria-label="Form dialog sizing">
      <h2 className="text-xl font-semibold">Form dialog sizing</h2>
      {[2, 3, 4].map((count) => (
        <Button
          key={count}
          kind="secondary"
          onClick={() =>
            modals.showForm({
              content: () => <ModalSizingFields count={count} />,
              onSubmit: async () => {},
              modalProps: () => ({ modalHeading: `${count}-field form` }),
            })
          }
        >
          {`Open ${count}-field form`}
        </Button>
      ))}
      <AttrList>
        <AttrList.Attr name="Attribute label" value="Attribute value" />
      </AttrList>
    </Tile>
  );
}

function ExpandableFixture() {
  return (
    <Tile role="region" aria-label="Expandable section">
      <MyExpandable title="Additional details">
        <TextInput labelText="Retained detail" defaultValue="" />
      </MyExpandable>
    </Tile>
  );
}

function TableFixture() {
  const [mode, setMode] = useState("populated");
  const [opened, setOpened] = useState("");
  const rows = [
    {
      id: "1",
      name: "Alpha",
      description: "A long description that must wrap without overflowing.",
    },
    { id: "2", name: "Beta", description: "Second row" },
    { id: "3", name: "Müller", description: "Unicode content" },
  ];

  return (
    <Tile role="region" aria-label="Data table">
      <h2 className="mb-4 text-xl font-semibold">Data table</h2>
      <div className="mb-4 flex flex-wrap gap-2">
        {["populated", "loading", "empty", "error"].map((value) => (
          <Button key={value} kind="secondary" onClick={() => setMode(value)}>
            {value}
          </Button>
        ))}
      </div>
      <MyTable
        persistentId="fixture"
        rows={mode === "empty" ? [] : rows}
        loading={mode === "loading"}
        error={
          mode === "error" ? new Error("Synthetic table failure") : undefined
        }
        columns={[
          {
            label: "Name",
            render: (row) => row.name,
            sortKey: (row) => row.name,
          },
          {
            label: "Description",
            render: (row) => row.description,
            wrap: true,
          },
        ]}
        onRowClick={(row) => setOpened(row.id)}
      />
      <output aria-label="Table state" className="mt-4 block text-sm">
        {JSON.stringify({ opened })}
      </output>
    </Tile>
  );
}

function ProgressiveTableFixture() {
  const [filtered, setFiltered] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [mounted, setMounted] = useState(true);
  const rows = Array.from({ length: filtered ? 2 : 7 }, (_, index) => ({
    id: `progressive-${index}`,
    name: `Entry ${String(index + 1).padStart(2, "0")}`,
    revision: refresh,
  }));

  return (
    <Tile role="region" aria-label="Progressive table">
      <h2 className="text-xl font-semibold">Progressive table</h2>
      <div className="flex flex-wrap gap-2">
        <Button kind="secondary" onClick={() => setFiltered((value) => !value)}>
          Toggle filter
        </Button>
        <Button
          kind="secondary"
          onClick={() => setRefresh((value) => value + 1)}
        >
          Refresh rows
        </Button>
        <Button kind="secondary" onClick={() => setMounted((value) => !value)}>
          Toggle table
        </Button>
      </div>
      {mounted && (
        <MyTable
          persistentId="progressive-fixture"
          aria-label="Progressive entries"
          rows={rows}
          loadMore={{ batchSize: 3 }}
          autoConvertSmallViewport
          columns={[
            {
              label: "Entry",
              render: (row) => row.name,
              sortKey: (row) => row.name,
            },
          ]}
        />
      )}
    </Tile>
  );
}

function NotificationsFixture() {
  const notifications = useNotifications();
  const idRef = useRef(null);
  const [dismissals, setDismissals] = useState([]);
  const [actionCount, setActionCount] = useState(0);
  const sequence = useRef(0);

  function push(options) {
    sequence.current += 1;
    const id = `notice-${sequence.current}`;
    idRef.current = id;
    notifications.push({
      id,
      title: `Notification ${sequence.current}`,
      duration: null,
      onDismiss: (reason) => {
        setDismissals((current) => [...current, { id, reason }]);
        record({ type: "dismiss", id, reason });
      },
      ...options,
    });
  }

  return (
    <Tile role="region" aria-label="Notification controls">
      <h2 className="mb-4 text-xl font-semibold">Notifications</h2>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => push({ content: "Persistent content" })}>
          Add persistent
        </Button>
        <Button onClick={() => push({ duration: 1500 })}>Add timed</Button>
        <Button onClick={() => push({ duration: 1500, pauseOnHover: false })}>
          Add unpaused
        </Button>
        <Button
          onClick={() =>
            push({
              actions: [
                {
                  label: "Apply action",
                  onClick: () => setActionCount((count) => count + 1),
                },
              ],
            })
          }
        >
          Add action
        </Button>
        <Button
          onClick={() =>
            notifications.update(idRef.current, {
              title: "Updated notification",
            })
          }
        >
          Update latest
        </Button>
        <Button onClick={() => notifications.dismiss(idRef.current)}>
          Dismiss latest
        </Button>
        <Button onClick={notifications.clear}>Clear notifications</Button>
      </div>
      <output aria-label="Notification state" className="mt-4 block text-sm">
        {JSON.stringify({ dismissals, actionCount })}
      </output>
    </Tile>
  );
}

function ShellFixture() {
  const [small, setSmall] = useState(window.innerWidth <= 1000);
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const update = () => setSmall(window.innerWidth <= 1000);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return (
    <>
      <SkipToContent>Skip to content</SkipToContent>
      <Header>
        {small && (
          <HeaderMenuButton
            aria-label="Main navigation"
            aria-controls="fixture-navigation"
            isActive={expanded}
            onClick={() => setExpanded((value) => !value)}
          />
        )}
        <HeaderName as={Link} to="/home">
          sortsys
        </HeaderName>
      </Header>
      <SideNav
        id="fixture-navigation"
        aria-label="Main navigation"
        closeButtonLabel="Close navigation"
        expanded={expanded}
        isSmall={small}
        onOverlayClick={() => setExpanded(false)}
      >
        <SideNavItems>
          <SideNavLink
            as={Link}
            to="/home"
            isActive={location.pathname === "/home"}
            onClick={() => setExpanded(false)}
          >
            Home
          </SideNavLink>
          <SideNavMenu title="Projects">
            <SideNavMenuItem
              as={Link}
              to="/projects"
              onClick={() => setExpanded(false)}
            >
              All projects
            </SideNavMenuItem>
          </SideNavMenu>
        </SideNavItems>
      </SideNav>
      <Content className="main-container">
        <MyHeader title="Navigation fixture" />
        <output aria-label="Current location">{location.pathname}</output>
        <Link to="/home">Content link</Link>
      </Content>
    </>
  );
}

function FixtureContent() {
  const { setLocale } = useI18n();

  useEffect(() => {
    setLocale(requestedLocale);
    window.__uiSetLocale = setLocale;

    return () => {
      delete window.__uiSetLocale;
    };
  }, [setLocale]);

  if (parameters.get("screen") === "application") {
    return <ApplicationFixture />;
  }

  return (
    <>
      <MyModalsProvider>
        <NotificationProvider
          closeLabel="Close notification"
          regionLabel="Notifications"
          maxVisible={2}
        >
          {parameters.get("screen") === "shell" ? (
            <ShellFixture />
          ) : (
            <main className="mx-auto flex min-h-dvh max-w-5xl flex-col gap-6 p-4 sm:p-8">
              <MyHeader title="HeroUI workflow fixtures" />
              <FieldsFixture />
              <AsyncAutocompleteFixture />
              <FormFixture />
              <MenusFixture />
              <DialogsFixture />
              <FormFieldsFixture />
              <ModalSizingFixture />
              <ExpandableFixture />
              <TableFixture />
              <ProgressiveTableFixture />
              <NotificationsFixture />
            </main>
          )}
        </NotificationProvider>
      </MyModalsProvider>
    </>
  );
}

const root = createRoot(document.getElementById("root"));
window.__uiUnmount = () => root.unmount();
root.render(
  <I18nProvider>
    <MemoryRouter initialEntries={[parameters.get("path") ?? "/home"]}>
      <FixtureContent />
    </MemoryRouter>
  </I18nProvider>,
);
