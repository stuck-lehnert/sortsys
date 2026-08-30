import { uiText } from "~/lib/i18n";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { contactName, customerName, formatDate, productTitle, toolTitle, userFullName } from "~/lib/format";
import { Icons, type Icon } from "~/lib/icons";
import { dailyReportDayKey } from "~/lib/tiles";
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

function useEntitySearchEntries(query: string, close: () => void) {
  const navigate = useNavigate();
  const [entries, setEntries] = useState<PaletteEntry[]>([]);
  const trimmedQuery = normalizeSearch(query);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setEntries([]);
    setSearching(!!trimmedQuery);
    if (!trimmedQuery) return;

    const timeout = window.setTimeout(async () => {
      const pushLink = (rows: PaletteEntry[], entry: Omit<PaletteEntry, 'run'> & { href: string }) => {
        rows.push({
          ...entry,
          run: () => {
            close();
            navigate(entry.href);
          },
        });
      };

      const [
        [projects],
        [tools],
        [users],
        [products],
        [customers],
        [contacts],
        [productVendors],
        [deliveryNote],
      ] = await Promise.all([
        client.query('projects.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('tools.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('users.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('products.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('customers.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('contacts.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        client.query('products.vendors.list', { search: trimmedQuery }).catch(() => [null, null] as const),
        (async () => {
          const raw = trimmedQuery.startsWith('#') ? trimmedQuery.slice(1) : trimmedQuery;
          const autoId = Number.parseInt(raw, 10);
          if (!Number.isFinite(autoId)) return [null, null] as const;
          const [note] = await client.query('deliveryNotes.get', { autoId }).catch(() => [null, null] as const);
          return [note ? [note] : null, null] as const;
        })(),
      ]);

      if (cancelled) return;

      const nextEntries: PaletteEntry[] = [];
      (projects ?? []).slice(0, 8).forEach(project => pushLink(nextEntries, {
        id: `project:${project.id}`,
        title: project.title,
        subtitle: uiText("Projekt"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.Project,
        href: `/projects/${project.id}`,
      }));
      (tools ?? []).slice(0, 8).forEach(tool => pushLink(nextEntries, {
        id: `tool:${tool.id}`,
        title: `${tool.customId} ${toolTitle(tool)}`,
        subtitle: uiText("Werkzeug"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.Tool,
        href: `/tools/${tool.id}`,
      }));
      (users ?? []).slice(0, 8).forEach(user => pushLink(nextEntries, {
        id: `user:${user.id}`,
        title: userFullName(user),
        subtitle: uiText("Benutzer"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.User,
        href: `/users/${user.id}`,
      }));
      (products ?? []).slice(0, 8).forEach(product => pushLink(nextEntries, {
        id: `product:${product.id}`,
        title: `${product.customId} ${productTitle(product)}`,
        subtitle: uiText("Produkt"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.Product,
        href: `/products/${product.id}`,
      }));
      (customers ?? []).slice(0, 8).forEach(customer => pushLink(nextEntries, {
        id: `customer:${customer.id}`,
        title: customerName(customer),
        subtitle: uiText("Kunde"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.Customer,
        href: `/customers/${customer.id}`,
      }));
      (contacts ?? []).slice(0, 8).forEach(contact => pushLink(nextEntries, {
        id: `contact:${contact.id}`,
        title: contactName(contact),
        subtitle: uiText("Kontakt"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.Contact,
        href: `/contacts/${contact.id}`,
      }));
      (productVendors ?? []).slice(0, 8).forEach(vendor => pushLink(nextEntries, {
        id: `productVendor:${vendor.id}`,
        title: vendor.name,
        subtitle: uiText("Händler"),
        group: uiText('Treffer', 'Results'),
        icon: Icons.ProductVendor,
        href: `/products/vendors/${vendor.id}`,
      }));
      (deliveryNote ?? []).slice(0, 3).forEach(note => pushLink(nextEntries, {
        id: `deliveryNote:${note.id}`,
        title: uiText(`Lieferschein #${note.autoId}`, `Delivery note #${note.autoId}`),
        subtitle: uiText(`Erfasst ${formatDate(note.createdAt)}`, `Recorded ${formatDate(note.createdAt)}`),
        group: uiText('Treffer', 'Results'),
        icon: Icons.DeliveryNote,
        href: `/products/deliveryNotes/${note.id}`,
      }));

      setEntries(nextEntries);
      setSearching(false);
    }, 180);

    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [close, navigate, trimmedQuery]);

  return { entries, searching };
}

function PaletteRow({ entry, active, onHover, optionId }: { entry: PaletteEntry; active: boolean; onHover: () => void; optionId: string }) {
  const Icon = entry.icon;
  return <button
    id={optionId}
    type="button"
    role="option"
    aria-selected={active}
    className={`command-palette-row${active ? ' is-active' : ''}`}
    onMouseEnter={onHover}
    onClick={() => void entry.run()}
  >
    <Icon size={20} className="shrink-0" />
    <span className="command-palette-row-main">
      <span className="command-palette-row-title">{entry.title}</span>
      {!!entry.subtitle && <span className="command-palette-row-subtitle">{entry.subtitle}</span>}
    </span>
    <span className="command-palette-row-group">{entry.group}</span>
  </button>;
}

function groupEntries(entries: PaletteEntry[]) {
  const groups = new Map<string, PaletteEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.group) ?? [];
    list.push(entry);
    groups.set(entry.group, list);
  }
  return [...groups.entries()];
}

export function showCommandPaletteModal(modals: MyModalsInterface) {
  modals.showDefault({
    content: ({ hide, replace }) => {
      const inputId = useId();
      const resultsId = useId();
      const [query, setQuery] = useState('');
      const [activeIndex, setActiveIndex] = useState(0);
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

      useEffect(() => {
        setActiveIndex(0);
      }, [query, entries.length]);

      function runActive() {
        const entry = entries[activeIndex];
        if (entry) void entry.run();
      }

      return <div className="command-palette">
        <label className="command-palette-label" htmlFor={inputId}>{uiText("Befehl oder Suche", "Command or search")}</label>
        <div className="command-palette-input-wrap">
          <Icons.Search size={20} />
          <input
            id={inputId}
            className="command-palette-input"
            role="combobox"
            aria-autocomplete="list"
            aria-controls={resultsId}
            aria-activedescendant={entries[activeIndex] ? `${resultsId}-${activeIndex}` : undefined}
            value={query}
            placeholder={uiText("Tippe > für Befehle, sonst Suche", "Type > for commands, otherwise search")}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                setActiveIndex(index => entries.length ? (index + 1) % entries.length : 0);
              } else if (event.key === 'ArrowUp') {
                event.preventDefault();
                setActiveIndex(index => entries.length ? (index - 1 + entries.length) % entries.length : 0);
              } else if (event.key === 'Enter') {
                event.preventDefault();
                runActive();
              }
            }}
          />
          <kbd>{uiText("Ctrl K")}</kbd>
        </div>
        <NotifyLoaded onLoad={() => document.getElementById(inputId)?.focus()} />

        <div id={resultsId} className="command-palette-results" role="listbox" aria-busy={searching}>
          {groupEntries(entries).map(([group, groupRows]) => <section key={group} className="command-palette-group">
            <div className="command-palette-group-title">{group}</div>
            {groupRows.map(entry => {
              const index = entries.indexOf(entry);
              return <PaletteRow
                key={entry.id}
                entry={entry}
                active={index === activeIndex}
                optionId={`${resultsId}-${index}`}
                onHover={() => setActiveIndex(index)}
              />;
            })}
          </section>)}
          {!entries.length && <div className="command-palette-empty" role="status">
            {searching ? uiText('Suche läuft …', 'Searching …') : uiText("Keine Treffer.", "No results.")}
          </div>}
        </div>
      </div>;
    },
    modalProps: ({ hide }) => ({
      modalHeading: uiText("Befehlspalette"),
      className: 'command-palette-modal',
      primaryButtonDisabled: true,
      secondaryButtonText: uiText("Schließen"),
      onSecondarySubmit: hide,
    }),
  });
}
