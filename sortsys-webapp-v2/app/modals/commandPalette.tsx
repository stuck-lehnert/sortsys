import { Autocomplete, Label, ListBox, SearchField } from "@heroui/react";
import { uiText } from "~/lib/i18n";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
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
  query: string;
  links: SearchLink[];
  finished: boolean;
};

function useEntitySearchEntries(query: string, close: () => void) {
  const navigate = useNavigate();
  const trimmedQuery = normalizeSearch(query);
  const [results, setResults] = useState<SearchResults | null>(null);

  useEffect(() => {
    setResults(null);
    if (!trimmedQuery) return;

    const groups: SearchLink[][] = [];
    let active = true;
    const publish = (finished: boolean) => {
      if (active)
        setResults({ query: trimmedQuery, links: groups.flat(), finished });
    };

    // Reserve each group's place before its query completes. A slow category
    // does not hide ready matches, and the final order stays deterministic.
    function load<Row>(
      request: Promise<readonly [readonly Row[] | null, unknown]>,
      link: (row: Row) => SearchLink,
    ) {
      const index = groups.length;
      groups.push([]);
      return request.then(([rows]) => {
        if (!active || !rows?.length) return;
        groups[index] = rows.slice(0, 8).map(link);
        publish(false);
      });
    }

    const timeout = window.setTimeout(() => {
      const filter = { search: trimmedQuery };
      const rawNumber = trimmedQuery.startsWith("#")
        ? trimmedQuery.slice(1)
        : trimmedQuery;
      const autoId = Number.parseInt(rawNumber, 10);
      const work = [
        load(client.query("projects.list", filter), (project) => ({
          id: `project:${project.id}`,
          title: project.title,
          subtitle: uiText("Projekt"),
          icon: Icons.Project,
          href: `/projects/${project.id}`,
        })),
        load(client.query("tools.list", filter), (tool) => ({
          id: `tool:${tool.id}`,
          title: `${tool.customId} ${toolTitle(tool)}`,
          subtitle: uiText("Werkzeug"),
          icon: Icons.Tool,
          href: `/tools/${tool.id}`,
        })),
        load(client.query("users.list", filter), (user) => ({
          id: `user:${user.id}`,
          title: userFullName(user),
          subtitle: uiText("Benutzer"),
          icon: Icons.User,
          href: `/users/${user.id}`,
        })),
        load(client.query("products.list", filter), (product) => ({
          id: `product:${product.id}`,
          title: `${product.customId} ${productTitle(product)}`,
          subtitle: uiText("Produkt"),
          icon: Icons.Product,
          href: `/products/${product.id}`,
        })),
        load(client.query("customers.list", filter), (customer) => ({
          id: `customer:${customer.id}`,
          title: customerName(customer),
          subtitle: uiText("Kunde"),
          icon: Icons.Customer,
          href: `/customers/${customer.id}`,
        })),
        load(client.query("contacts.list", filter), (contact) => ({
          id: `contact:${contact.id}`,
          title: contactName(contact),
          subtitle: uiText("Kontakt"),
          icon: Icons.Contact,
          href: `/contacts/${contact.id}`,
        })),
        load(client.query("products.vendors.list", filter), (vendor) => ({
          id: `productVendor:${vendor.id}`,
          title: vendor.name,
          subtitle: uiText("Händler"),
          icon: Icons.ProductVendor,
          href: `/products/vendors/${vendor.id}`,
        })),
      ];
      if (Number.isFinite(autoId)) {
        const request = client
          .query("deliveryNotes.get", { autoId })
          .then(([note]) => [note ? [note] : null, null] as const);
        work.push(
          load(request, (note) => ({
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
          })),
        );
      }
      void Promise.allSettled(work).then(() => publish(true));
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [trimmedQuery]);

  const current = results?.query === trimmedQuery ? results : null;
  const entries: PaletteEntry[] = useMemo(
    () =>
      (current?.links ?? []).map(({ href, ...link }) => ({
        ...link,
        group: uiText("Treffer", "Results"),
        run: () => {
          close();
          navigate(href);
        },
      })),
    [current, close, navigate],
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
          <div className="flex min-h-0 w-full flex-col gap-4">
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
