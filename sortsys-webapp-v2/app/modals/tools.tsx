import { Tag } from "@sortsys/react-components";
import { MyButton } from "~/components/MyButton";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { toolStatus, toolStatusTagType, toolTitle, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import { parseFloatCustom } from "~/lib/utils";
import type { Project, Tool, ToolTracking, User } from "~/type-helpers";

const TOOL_SELECTION_TITLE_MAX = 12;

function toolSelectionChipLabel(tool: Tool) {
  const title = toolTitle(tool);
  const shortened = title.length > TOOL_SELECTION_TITLE_MAX
    ? `${title.slice(0, TOOL_SELECTION_TITLE_MAX)}…`
    : title;
  return `${tool.customId} ${shortened}`;
}

type CreateToolModalOptions = {
  initialQuery?: string;
  onCreated?: (tool: Tool) => void | Promise<void>;
};

export function showCreateToolModal(modals: MyModalsInterface, options: CreateToolModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input required
        name="customId" labelText="Nummer" type="number"
        rules={[MyForm.Input.rules.posint]}
        suffix={<MyButton kind="ghost" size="sm" className="ss-input-suffix-btn" title="Nummer automatisch vorschlagen" aria-label="Nummer automatisch vorschlagen" onClick={async () => {
          const [id, err] = await client.query('tools.suggestNextCustomId', undefined);
          if (err) throw err;
          if (id) context.field('customId')?.setValue(id.toString());
        }}><Icons.Magic /></MyButton>}
      />
      <p className="light">Interne Werkzeugnummer für Suche, Listen und Zuordnung.</p>

      <MyDivider />

      <MyForm.Input required
        name="brand" labelText="Marke"
        suggestions={{
          prepare: () => client.query('tools.brands', undefined).then(([data]) => data ?? []),
          getItems: ({ query, init }) => init.filter((brand) => {
            return brand.toLowerCase().includes(query);
          }).map(brand => ({ id: brand })),
          stringify: ({ item }) => item.id,
        }}
      />

      <MyForm.Input required
        name="category" labelText="Kategorie"
        suggestions={{
          prepare: () => client.query('tools.categories', undefined).then(([data]) => data ?? []),
          getItems: ({ query, init }) => init.filter((category) => {
            return category.toLowerCase().includes(query);
          }).map(category => ({ id: category })),
          stringify: ({ item }) => item.id,
        }}
      />

      <MyForm.Input name="label" labelText="Modell" />
      {!!options.initialQuery && <NotifyLoaded onLoad={() => context.field('label')?.setValue(options.initialQuery)} />}
      <p className="light">Modellbezeichnung oder ergänzende Typangabe.</p>

      <MyDivider />

      <MyForm.Input
        name="purchasePrice" labelText="Kaufpreis (EUR)"
        type="number" rules={[MyForm.Input.rules.posnum]}
      />

      <MyForm.Input
        name="usageCostPerDay" labelText="Nutzungskosten pro Tag (EUR)"
        type="number" rules={[MyForm.Input.rules.posnum]}
      />
      <p className="light">Tagessatz für interne Kostenberechnungen und Berichte.</p>
    </>,
    modalProps: ({ }) => ({
      modalHeading: 'Werkzeug erstellen',
      primaryButtonText: 'Erstellen',
    }),
    onSubmit: async ({ hide, context, navigate }) => {
      const values = context.getValues();

      values.customId = parseInt(values.customId);
      if (isNaN(values.customId)) return;

      if (values.purchasePrice) {
        values.purchasePrice = parseFloatCustom(values.purchasePrice);
        if (isNaN(values.purchasePrice)) return;
      }

      if (values.usageCostPerDay) {
        values.usageCostPerDay = parseFloatCustom(values.usageCostPerDay);
        if (isNaN(values.usageCostPerDay)) return;
      }

      const [data, err] = await client.mutate('tools.create', values as any);
      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query('tools.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/tools/${data.id}`);
      hide();
    },
  });
}

export function showModifyToolModal(modals: MyModalsInterface, tool: Tool) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Select
        name="status" labelText="Status"
        getOptions={() => [
          { id: 'none', label: 'Kein Status' },
          { id: 'lost', label: 'Abhanden' },
          { id: 'broken', label: 'Defekt' },
        ]}
        buildOption={option => ({
          text: option.label,
          value: option.id,
        })}
      />

      <MyDivider />

      <MyForm.Input required
        name="brand" labelText="Marke"
        suggestions={{
          prepare: () => client.query('tools.brands', undefined).then(([data]) => data ?? []),
          getItems: ({ query, init }) => init.filter((brand) => {
            return brand.toLowerCase().includes(query);
          }).map(brand => ({ id: brand })),
          stringify: ({ item }) => item.id,
        }}
      />

      <MyForm.Input required
        name="category" labelText="Kategorie"
        suggestions={{
          prepare: () => client.query('tools.categories', undefined).then(([data]) => data ?? []),
          getItems: ({ query, init }) => init.filter((brand) => {
            return brand.toLowerCase().includes(query);
          }).map(brand => ({ id: brand })),
          stringify: ({ item }) => item.id,
        }}
      />

      <MyForm.Input name="label" labelText="Modell" />
      <p className="light">Modellbezeichnung oder ergänzende Typangabe.</p>

      <MyDivider />

      <MyForm.Input
        name="purchasePrice" labelText="Kaufpreis (EUR)"
        type="number" rules={[MyForm.Input.rules.posnum]}
      />

      <MyForm.Input
        name="usageCostPerDay" labelText="Nutzungskosten pro Tag (EUR)"
        type="number" rules={[MyForm.Input.rules.posnum]}
      />
      <p className="light">Tagessatz für interne Kostenberechnungen und Berichte.</p>

      <NotifyLoaded onLoad={() => context.setValues({
        ...tool, status: tool.status ?? 'none',
      })} />
    </>,
    onSubmit: async ({ hide, context, navigate, pathname }) => {
      const values = context.getValues();

      if (values.purchasePrice) {
        values.purchasePrice = parseFloatCustom(values.purchasePrice);
        if (isNaN(values.purchasePrice)) return;
      }

      if (values.usageCostPerDay) {
        values.usageCostPerDay = parseFloatCustom(values.usageCostPerDay);
        if (isNaN(values.usageCostPerDay)) return;
      }

      if (values.status === 'none') values.status = null;

      const [data, err] = await client.mutate('tools.update', {
        id: tool.id,
        data: values as any,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: ({ }) => ({
      modalHeading: 'Werkzeug bearbeiten',
      primaryButtonText: 'Speichern',
      modalLabel: `${tool.customId} ${toolTitle(tool)}`,
    }),
  });
}

export function showDeleteToolModal(modals: MyModalsInterface, tool: Tool) {
  modals.showForm({
    content: () => <>
      <p className="light">
        Alle mit diesem Werkzeug in Verbindung stehenden Daten werden damit ebenfalls gelöscht.
        {" "}<b>Diese Aktion kann nicht rückgängig gemacht werden.</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText="Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann."
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('tools.delete', { id: tool.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/tools/${tool.id}`) navigate('/tools');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: 'Werkzeug löschen',
      modalLabel: `${tool.customId} ${toolTitle(tool)}`,
      primaryButtonText: 'Löschen',
    }),
  });
}

export function showTrackToolsModal(modals: MyModalsInterface, props: {
  tools?: Tool[];
  project?: Project;
  responsibleUser?: User;
}) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.MultiSelect
        name="responsible" labelText="Verantwortlicher"
        minSelectedItems={1} maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('users.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />
      <p className="light">Wer hat das Werkzeug bzw. die Werkzeuge entgegengenommen?</p>

      <MyForm.MultiSelect
        name="project" labelText="Projekt"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('projects.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => item.title}
        renderTile={item => <SmallProjectTile data={item} noLink />}
        createAction={createEntityAction.project}
      />
      <p className="light">Mit welchem Projekt ist diese Buchung verknüpft?</p>

      <MyForm.MultiSelect
        name="tools" labelText="Werkzeuge"
        minSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('tools.list', { search: query });
          if (err) throw err;
          if (!data) return [];

          let exactMatchIndex = -1;
          const parsedNumber = parseInt(query);
          if (!isNaN(parsedNumber) && parsedNumber >= 0) {
            exactMatchIndex = data.findIndex(({ customId }) => customId === parsedNumber);
          }

          if (exactMatchIndex >= 0) {
            const exactMatch = data[exactMatchIndex];
            data.splice(exactMatchIndex, 1);
            data.unshift(exactMatch);
          }

          return data;
        }}
        renderItem={({ item }) => <div className="flex w-full justify-between items-center gap-2">
          <span>{item.customId} {toolTitle(item)}</span>
          <Tag type={toolStatusTagType(item)} size="sm">{toolStatus(item)}</Tag>
        </div>}
        stringifyItem={({ item }) => toolSelectionChipLabel(item)}
        createAction={createEntityAction.tool}
      />
      <p className="light">Welche Werkzeuge wurden ausgegeben?</p>

      <MyForm.Input name="comment" labelText="Kommentar" />
      <p className="light">Gibt es wichtige Details zu dieser Buchung, die dokumentiert werden sollen?</p>

      <NotifyLoaded onLoad={() => {
        if (props.tools?.length) context.field('tools')?.setValue(props.tools);
        if (props.project) context.field('project')?.setValue([props.project]);
        if (props.responsibleUser) context.field('responsible')?.setValue([props.responsibleUser]);
      }} />
    </>;
    },
    onSubmit: async ({ hide, context }) => {
      const values = context.getValues();

      if (!values.tools.length) return;
      if (!values.responsible.length) return;

      const project: Project | null = values.project.at(0) ?? null;
      const responsible: User = values.responsible[0];

      let tools = values.tools as Tool[];
      const failedTools: Tool[] = [];

      await Promise.all(tools.map(async (tool) => {
        if (tool.available) return;

        const [data, err] = await client.mutate('tools.untrack', { id: tool.id });
        if (err || !data) failedTools.push(tool);
      }));

      tools = tools.filter(tool => !failedTools.includes(tool));

      await Promise.all(tools.map(async tool => {
        const [data, err] = await client.mutate('tools.track', {
          id: tool.id,
          data: {
            projectId: project?.id,
            responsibleUserId: responsible.id,
            comment: values.comment,
          },
        });

        if (err || !data) failedTools.push(tool);
      }));

      if (failedTools.length) {
        context.field('tools')?.setValue(failedTools);
        return;
      }

      hide();
    },
    modalProps: () => ({
      modalHeading: 'Werkzeuge einbuchen',
      primaryButtonText: 'Buchen',
    }),
  });
}

export function showToolTransferModal(modals: MyModalsInterface, props: {
  tool: Tool;
  tracking: ToolTracking;
  isRequest: boolean;
}) {
  modals.showForm({
    content: () => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <p className="light">Die Umbuchung setzt einen neuen Verantwortlichen voraus. Das Projekt kann bei Bedarf mitgeführt werden.</p>

      <MyForm.MultiSelect
        name="transferToUser" labelText="Neuer Verantwortlicher"
        minSelectedItems={1} maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('users.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => userFullName(item)}
        createAction={createEntityAction.user}
      />

      <MyForm.MultiSelect
        name="project" labelText="Neues Projekt"
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [data, err] = await client.query('projects.list', { search: query });
          if (err) throw err;
          return data ?? [];
        }}
        renderItem={({ item }) => item.title}
        createAction={createEntityAction.project}
      />

      <MyForm.Input name="notes" labelText="Kommentar" />
    </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      console.log(values);

      if (!values.transferToUser.length) return;

      const transferToUser: User = values.transferToUser[0];
      const project: Project | null = values.project.at(0) ?? null;

      if (props.isRequest) {
        const [data, err] = await client.mutate('tools.trackings.transfers.request', {
          toolTrackingId: props.tracking.id,
          projectId: project?.id,
          transferToUserId: transferToUser.id,
          notes: values.notes,
        });

        if (err) throw err;
        if (!data) return;
      } else {
        {
          const [data, err] = await client.mutate('tools.untrack', { id: props.tracking.toolId });
          if (err) throw err;
          if (!data) return;
        }

        const [data, err] = await client.mutate('tools.track', {
          id: props.tracking.toolId,
          data: {
            projectId: project?.id,
            responsibleUserId: transferToUser.id,
            comment: values.notes,
          },
        });

        if (err) throw err;
        if (!data) return;

        client.invalidateCascading('tools.trackings');
      }

      hide();
    },
    modalProps: ({ }) => ({
      modalHeading: props.isRequest ? 'Werkzeugumbuchung anfragen' : 'Werkzeug umbuchen',
      primaryButtonText: props.isRequest ? 'Anfrage stellen' : 'Umbuchen',
      modalLabel: `${props.tool.customId} ${toolTitle(props.tool)}`,
    }),
  });
}

export function showCreateToolInventoryModal(modals: MyModalsInterface, tool: Tool) {
  modals.showForm({
    content: () => <>
      <MyForm.Input name="comment" labelText="Kommentar" />
      <p className="light">Notiere Zustand, Fehlteile oder besondere Auffälligkeiten der Inventur.</p>
    </>,
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();

      const [data, err] = await client.mutate('tools.inventories.create', {
        toolId: tool.id,
        comment: values.comment,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: 'Inventur aufzeichnen',
      modalLabel: `${tool.customId} ${toolTitle(tool)}`,
      primaryButtonText: 'Speichern',
    }),
  });
}
