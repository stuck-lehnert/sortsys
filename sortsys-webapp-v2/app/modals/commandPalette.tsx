import { Autocomplete, Label, ListBox, SearchField } from "@heroui/react";
import { uiText } from "~/lib/i18n";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { map, Subscription, type Observable } from "rxjs";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import {
  client,
  contentAccess,
  streamDirectorySearch,
  toolResources,
} from "~/lib/client";
import {
  contactName,
  customerName,
  formatDate,
  productTitle,
  toolTitle,
  userFullName,
} from "~/lib/format";
import { Icons, type Icon } from "~/lib/icons";
import { useUserActions, type UserAction } from "~/lib/userActions";

type PaletteEntry = {
  id: string;
  title: string;
  subtitle?: ReactNode;
  icon: Icon;
  group: string;
  run: () => void | Promise<void>;
};

function normalizeSearch(value: string) {
  return value.trim().toLowerCase();
}

function actionMatches(action: UserAction, query: string) {
  if (!query) return true;
  const haystack = `${action.label} ${action.description} ${action.id}`.toLowerCase();
  return query.split(/\s+/g).every(part => haystack.includes(part));
}

type SearchLink = Omit<PaletteEntry, "run" | "group"> & { href: string };
type SearchResults = {
  scope: { query: string; accessContext: AbortSignal };
  links: SearchLink[];
  finished: boolean;
};

function useEntitySearchEntries(query: string, close: () => void) {
  const navigate = useNavigate();
  const access = useSessionInfo();
  const accessContext = contentAccess.context();
  const projects = access.canDo("view:projects");
  const tools = access.canDo("view:tools");
  const users = access.canDo("view:users");
  const products = access.canDo("view:products");
  const customers = access.canDo("view:customers");
  const contacts = access.canDo("view:contacts");
  const vendors = access.canDo("view:productVendors");
  const deliveryNotes = access.canDo("view:deliveryNotes");
  const trimmedQuery = normalizeSearch(query);
  const scope = useMemo(
    () => ({
      query: trimmedQuery,
      accessContext,
      projects,
      tools,
      users,
      products,
      customers,
      contacts,
      vendors,
      deliveryNotes,
    }),
    [
      trimmedQuery, accessContext, projects, tools, users, products,
      customers, contacts, vendors, deliveryNotes,
    ],
  );
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => {
    const { query, accessContext } = scope;
    if (!query || accessContext.aborted) return;

    const groups: SearchLink[][] = [];
    const subscriptions = new Subscription();
    let remaining = 0;
    const stop = () => subscriptions.unsubscribe();
    accessContext.addEventListener("abort", stop, { once: true });
    const publish = () => {
      if (!subscriptions.closed && !accessContext.aborted)
        setResults({
          scope,
          links: groups.flat(),
          finished: remaining === 0,
        });
    };

    // Reserve each group's place before its query completes. A slow category
    // does not hide ready matches, and the final order stays deterministic.
    function load<Row>(
      enabled: boolean,
      stream: () => Observable<[readonly Row[] | null, unknown]>,
      link: (row: Row) => SearchLink,
    ) {
      if (!enabled) return;
      const index = groups.length;
      groups.push([]);
      let initial = true;
      remaining++;
      const show = (rows: readonly Row[] | null) => {
        if (initial) {
          initial = false;
          remaining--;
        }
        groups[index] = rows?.map(link) ?? [];
        publish();
      };
      subscriptions.add(
        stream().subscribe({
          next: ([rows]) => show(rows),
          error: () => show(null),
        }),
      );
    }

    const timeout = window.setTimeout(() => {
      if (subscriptions.closed) return;
      const find = <Path extends Parameters<typeof streamDirectorySearch>[0]>(
        path: Path,
      ) => streamDirectorySearch(path, query);
      const number = /^#?(\d+)$/.exec(query);
      const autoId = number ? Number(number[1]) : NaN;
      load(scope.projects, () => find("projects.list"), (project) => ({
        id: `project:${project.id}`,
        title: project.title,
        subtitle: uiText("Projekt"),
        icon: Icons.Project,
        href: `/projects/${project.id}`,
      }));
      load(scope.tools, () => toolResources.streamSearch(query), (tool) => ({
        id: `tool:${tool.id}`,
        title: `${tool.customId} ${toolTitle(tool)}`,
        subtitle: uiText("Werkzeug"),
        icon: Icons.Tool,
        href: `/tools/${tool.id}`,
      }));
      load(scope.users, () => find("users.list"), (user) => ({
        id: `user:${user.id}`,
        title: userFullName(user),
        subtitle: uiText("Benutzer"),
        icon: Icons.User,
        href: `/users/${user.id}`,
      }));
      load(scope.products, () => find("products.list"), (product) => ({
        id: `product:${product.id}`,
        title: `${product.customId} ${productTitle(product)}`,
        subtitle: uiText("Produkt"),
        icon: Icons.Product,
        href: `/products/${product.id}`,
      }));
      load(scope.customers, () => find("customers.list"), (customer) => ({
        id: `customer:${customer.id}`,
        title: customerName(customer),
        subtitle: uiText("Kunde"),
        icon: Icons.Customer,
        href: `/customers/${customer.id}`,
      }));
      load(scope.contacts, () => find("contacts.list"), (contact) => ({
        id: `contact:${contact.id}`,
        title: contactName(contact),
        subtitle: uiText("Kontakt"),
        icon: Icons.Contact,
        href: `/contacts/${contact.id}`,
      }));
      load(scope.vendors, () => find("products.vendors.list"), (vendor) => ({
        id: `productVendor:${vendor.id}`,
        title: vendor.name,
        subtitle: uiText("Händler"),
        icon: Icons.ProductVendor,
        href: `/products/vendors/${vendor.id}`,
      }));
      if (scope.deliveryNotes && Number.isSafeInteger(autoId) && autoId > 0) {
        load(
          true,
          () => client.streamQuery("deliveryNotes.get", { autoId })
            .pipe(map(([note, error]) => [note ? [note] : null, error])),
          (note) => ({
            id: `deliveryNote:${note.id}`,
            title: uiText(
              `Lieferschein #${note.autoId}`,
              `Delivery note #${note.autoId}`,
            ),
            subtitle: uiText(
              `Erfasst ${formatDate(note.createdAt)}`,
              `Recorded ${formatDate(note.createdAt)}`,
            ),
            icon: Icons.DeliveryNote,
            href: `/products/deliveryNotes/${note.id}`,
          }),
        );
      }
      publish();
    }, 60);

    return () => {
      stop();
      accessContext.removeEventListener("abort", stop);
      window.clearTimeout(timeout);
    };
  }, [scope]);

  const current =
    results?.scope === scope && !scope.accessContext.aborted
      ? results
      : null;
  const entries: PaletteEntry[] = useMemo(
    () =>
      (current?.links ?? []).map(({ href, ...link }) => ({
        ...link,
        group: uiText("Treffer", "Results"),
        run: () => {
          if (scope.accessContext.aborted) return;
          close();
          navigate(href);
        },
      })),
    [current, scope, close, navigate],
  );
  const searching = !!trimmedQuery && !current?.finished;
  return { entries, searching };
}

export function showCommandPaletteModal(modals: MyModalsInterface) {
  modals.showDefault({
    content: ({ hide, replace }) => {
      const [query, setQuery] = useState('');
      const [recentActionIds, setRecentActionIds] = useState<string[]>([]);
      const { visibleActions, runAction } = useUserActions(modals);
      const commandQuery = normalizeSearch(query.startsWith('>') ? query.slice(1) : query);
      const commandOnly = query.trim().startsWith('>');
      const { entries: entityEntries, searching } = useEntitySearchEntries(commandOnly ? '' : query, hide);

      useEffect(() => {
        let active = true;
        client.query('personalization.actions.list', { limit: 10 }, { strategy: 'network-first' })
          .then(([rows]) => {
            if (!active) return;
            const seen = new Set<string>();
            const ids: string[] = [];
            for (const row of rows ?? []) {
              if (seen.has(row.actionId)) continue;
              seen.add(row.actionId);
              ids.push(row.actionId);
            }
            setRecentActionIds(ids);
          })
          .catch(() => null);
        return () => {
          active = false;
        };
      }, []);

      const entries = useMemo(() => {
        const visibleById = new Map(visibleActions.map(action => [action.id, action]));
        const runVisibleAction = (action: UserAction) => () => {
          replace(() => void runAction(action));
        };
        const recentActions = !commandQuery
          ? recentActionIds
            .map(id => visibleById.get(id))
            .filter((action): action is UserAction => !!action)
          : [];
        const recentIdSet = new Set(recentActions.map(action => action.id));

        const recentEntries: PaletteEntry[] = recentActions.map(action => ({
          id: `recent:${action.id}`,
          title: action.label,
          subtitle: action.description,
          group: uiText('Zuletzt verwendet', 'Recently used'),
          icon: action.icon,
          run: runVisibleAction(action),
        }));
        const commandEntries: PaletteEntry[] = visibleActions
          .filter(action => !recentIdSet.has(action.id))
          .filter(action => actionMatches(action, commandQuery))
          .map(action => ({
            id: `action:${action.id}`,
            title: action.label,
            subtitle: action.description,
            group: action.group === 'work' ? uiText('Arbeit', 'Work') : action.group === 'create' ? uiText('Anlegen', 'Create') : action.group === 'admin' ? uiText('Verwaltung', 'Administration') : uiText('Navigation', 'Navigation'),
            icon: action.icon,
            run: runVisibleAction(action),
          }));

        return [
          ...recentEntries,
          ...commandEntries,
          ...(commandOnly ? [] : entityEntries),
        ];
      }, [commandOnly, commandQuery, entityEntries, recentActionIds, replace, runAction, visibleActions]);

      return (
        <Autocomplete.Filter
          inputValue={query}
          onInputChange={setQuery}
          filter={() => true}
        >
          <div
            className="flex min-h-0 w-full flex-col gap-4"
            data-searching={searching}
          >
            <SearchField className="w-full" variant="secondary">
              <Label>{uiText("Befehl oder Suche", "Command or search")}</Label>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input
                  autoFocus
                  placeholder={uiText(
                    "Tippe > für Befehle, sonst Suche",
                    "Type > for commands, otherwise search",
                  )}
                />
              </SearchField.Group>
            </SearchField>
            <ListBox
              aria-label={uiText(
                "Befehle und Suchergebnisse",
                "Commands and search results",
              )}
              aria-busy={searching}
              items={entries}
              selectionMode="none"
              className="min-h-0 w-full flex-1 max-h-[60dvh] overflow-y-auto"
              onAction={(key) => {
                const entry = entries.find((candidate) => candidate.id === key);
                if (entry) {
                  void entry.run();
                }
              }}
              renderEmptyState={() => (
                <p role="status" className="p-6 text-center text-sm text-muted">
                  {searching
                    ? uiText("Suche läuft …", "Searching …")
                    : uiText("Keine Treffer.", "No results.")}
                </p>
              )}
            >
              {(entry) => (
                <ListBox.Item
                  id={entry.id}
                  textValue={entry.title}
                  className="gap-3 py-3"
                >
                  <entry.icon
                    size={20}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">
                      {entry.title}
                    </span>
                    {entry.subtitle && (
                      <span className="block text-xs text-muted">
                        {entry.subtitle}
                      </span>
                    )}
                  </span>
                  <span className="text-right text-xs text-muted">
                    {entry.group}
                  </span>
                </ListBox.Item>
              )}
            </ListBox>
          </div>
        </Autocomplete.Filter>
      );
    },
    modalProps: ({ hide }) => ({
      modalHeading: uiText("Befehlspalette"),
      className: 'command-palette-modal',
      placement: 'top',
      primaryButtonDisabled: true,
      secondaryButtonText: uiText("Schließen"),
      onSecondarySubmit: hide,
    }),
  });
}
