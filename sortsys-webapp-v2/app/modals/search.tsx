import { uiText } from "~/lib/i18n";
import { MyForm } from "~/components/MyForm";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { useRefState } from "~/hooks/useRefState";
import { client } from "~/lib/client";
import { Fragment, useEffect, useId, useMemo, type ReactNode } from "react";
import { SmallContactTile, SmallCustomerTile, SmallDeliveryNoteTile, SmallProductTile, SmallProductVendorTile, SmallProjectTile, SmallToolTile, SmallUserTile } from "~/lib/tiles";
import { Tile } from "@sortsys/react-components";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { MyExpandable } from "~/components/MyExpandable";


export function showGlobalSearchModal(modals: MyModalsInterface) {
  function useQueryResults<
    ResolversT extends Record<string, (query: string) => Promise<[any, any]>>,
    ResultT = {
      [KeyT in keyof ResolversT]: Awaited<ReturnType<ResolversT[KeyT]>>[0] | null;
    }
  >(query: string, resolvers: ResolversT): ResultT  {
    query = query.trim().toLowerCase();

    const defaultValue = useMemo(() => {
      return Object.fromEntries(Object.keys(resolvers).map(key => [key, null])) as ResultT;
    }, []) ;

    const [res, setRes] = useRefState<ResultT>(defaultValue);

    useEffect(() => {
      setRes(defaultValue, res() !== null);
      if (!query) return;
      
      const timeout = setTimeout(async () => {
        const result = Object.fromEntries(
          await Promise.all(Object.entries(resolvers).map(async ([key, resolver]) => {
            const [data] = await resolver(query);
            return [key, data];
          }))
        );

        setRes(result, true);
      }, 250);

      return () => clearTimeout(timeout);
    }, [query]);

    return res();
  }

  modals.showDefault({
    content: ({ hide }) => {
      const inputId = useId();
      
      const [query, setQuery] = useRefState('');

      const queryResults = useQueryResults(query(), {
        projects: q => client.query('projects.list', { search: q }),
        tools: q => client.query('tools.list', { search: q }),
        users: q => client.query('users.list', { search: q }),
        products: q => client.query('products.list', { search: q }),
        customers: q => client.query('customers.list', { search: q }),
        contacts: q => client.query('contacts.list', { search: q }),
        deliveryNotes: async q => {
          if (q.startsWith('#')) q = q.substring(1);
          const int = parseInt(q);
          if (isNaN(int)) return [null, null];

          const [note] = await client.query('deliveryNotes.get', { autoId: int });
          if (note) return [[note], null];

          return [null, null];
        },
        productVendors: q => client.query('products.vendors.list', { search: q }),
      });

      // const projects = useQueryResults(query(), q => client.query('projects.list', { search: q }))
      // const tools = useQueryResults(query(), q => client.query('tools.list', { search: q }));
      // const users = useQueryResults(query(), q => client.query('users.list', { search: q }));
      // const products = useQueryResults(query(), q => client.query('products.list', { search: q }));
      // const customers = useQueryResults(query(), q => client.query('customers.list', { search: q }));
      // const contacts = useQueryResults(query(), q => client.query('contacts.list', { search: q }));

      const results = useMemo(() => {
        const {
          projects, tools, users, products, customers, contacts, deliveryNotes, productVendors,
        } = queryResults;

        const results: ReactNode[] = [];

        function pushCategory<RowT extends Record<string, any> & { id: string }>(title: string, rows: RowT[], render: (row: RowT) => ReactNode) {
          results.push(<MyExpandable key={title} initiallyExpanded title={`${title} (${rows.length})`}>
            <div className="space-y-2">
              {rows.map(row => <Fragment key={row.id}>{render(row)}</Fragment>)}
            </div>
          </MyExpandable>)
        }

        if (projects?.length) {
          pushCategory('Projekte', projects, project => <SmallProjectTile data={project} onLinkClick={hide} />)
        }

        if (tools?.length) {
          const data = [...tools];

          let exactMatchIndex = -1;
          const parsedNumber = parseInt(query().trim());
          if (!isNaN(parsedNumber) && parsedNumber >= 0) {
            exactMatchIndex = data.findIndex(({ customId }) => customId === parsedNumber);
          }

          if (exactMatchIndex >= 0) {
            const exactMatch = data[exactMatchIndex];
            data.splice(exactMatchIndex, 1);
            data.unshift(exactMatch);
          }

          pushCategory('Werkzeuge', data, tool => <SmallToolTile data={tool} onLinkClick={hide} />)
        }

        if (users?.length) {
          pushCategory(uiText('Benutzer'), users, user => <SmallUserTile data={user} onLinkClick={hide} />)
        }

        if (products?.length) {
          const data = [...products];

          let exactMatchIndex = -1;
          const parsedNumber = parseInt(query().trim());
          if (!isNaN(parsedNumber) && parsedNumber >= 0) {
            exactMatchIndex = data.findIndex(({ customId }) => customId === parsedNumber);
          }

          if (exactMatchIndex >= 0) {
            const exactMatch = data[exactMatchIndex];
            data.splice(exactMatchIndex, 1);
            data.unshift(exactMatch);
          }

          pushCategory('Produkte', data, product => <SmallProductTile data={product} onLinkClick={hide} />);
        }

        if (customers?.length) {
          pushCategory('Kunden', customers, customer => <SmallCustomerTile data={customer} onLinkClick={hide} />);
        }
        
        if (contacts?.length) {
          pushCategory('Kontakte', contacts, contact => <SmallContactTile data={contact} onLinkClick={hide} />);
        }

        if (deliveryNotes?.length) {
          pushCategory('Lieferscheine', deliveryNotes, deliveryNote => <SmallDeliveryNoteTile data={deliveryNote} onLinkClick={hide} />);
        }

        if (productVendors?.length) {
          pushCategory(uiText("Händler"), productVendors, vendor => <SmallProductVendorTile data={vendor} onLinkClick={hide} />);
        }

        return results;
      }, [queryResults]);

      return <div className="h-full max-h-full flex flex-col gap-2 items-stretch my-container" style={{ padding: 0 }}>
        <div className="shrink-0">
          <MyForm.Input id={inputId} labelText={uiText("Suchen")} onValueChange={q => setQuery(q, q !== query())} />
          <NotifyLoaded onLoad={() => document.getElementById(inputId)?.focus()} />
        </div>
        <div className="relative grow overflow-hidden">
          {!!results.length && <Tile className={`h-full max-h-full space-y-2 overflow-y-auto`} style={{
            padding: '0.5rem',
            backgroundColor: 'color-mix(in srgb, var(--ss-surface) 20%, transparent)',
            border: '1px solid var(--ss-border) !important',
          }}>
            {results}
          </Tile>}
        </div>
      </div>;
    },
    modalProps: ({ hide }) => ({
      modalHeading: uiText("Suchen"),
      primaryButtonDisabled: true,
      useFullscreen: true,
      secondaryButtonText: uiText("Schließen"),
      onSecondarySubmit: hide,
    }),
  });
}
