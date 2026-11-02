import { Card } from "@heroui/react";
import { uiText } from "~/lib/i18n";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import type { Remark } from "~/type-helpers";

type RemarkResourceType = 'project' | 'customer' | 'tool' | 'contact';

export function showRemarkFormModal(props: {
  modals: ReturnType<typeof useMyModals>;
  resourceType: RemarkResourceType;
  resourceId: string;
  remark?: Remark;
}) {
  const { modals, resourceType, resourceId, remark } = props;

  modals.showForm({
    content: ({ context }) => (
      <>
        <MyForm.Input
          required
          textArea
          name="body"
          labelText={uiText("Vermerk")}
        />
        {!!remark && (
          <NotifyLoaded
            onLoad={() => context.setValues({ body: remark.body })}
          />
        )}
      </>
    ),
    onSubmit: async ({ context, hide }) => {
      const body = `${context.getValues().body ?? ''}`.trim();
      const [data, err] = remark
        ? await client.mutate('remarks.update', { id: remark.id, body })
        : await client.mutate('remarks.create', { resourceType, resourceId, body });
      if (err) throw err;
      if (!data) return;
      hide();
    },
    modalProps: () => ({
      noFullscreen: true,
      modalHeading: remark ? uiText("Vermerk bearbeiten") : uiText("Vermerk erstellen"),
      primaryButtonText: remark ? uiText("Speichern") : uiText("Erstellen"),
    }),
  });
}

function showDeleteRemarkModal(modals: ReturnType<typeof useMyModals>, remark: Remark) {
  modals.showForm({
    content: () => (
      <>
        <p className="light">
          {uiText("Dieser Vermerk wird dauerhaft gelöscht.")}
        </p>
        <MyForm.Checkbox
          required
          name="_understood"
          labelText={uiText(
            "Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.",
          )}
        />
      </>
    ),
    onSubmit: async ({ hide }) => {
      const [data, err] = await client.mutate('remarks.delete', { id: remark.id });
      if (err) throw err;
      if (!data) return;
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Vermerk löschen"),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}

export function Remarks({ resourceType, resourceId, canManage }: {
  resourceType: RemarkResourceType;
  resourceId: string;
  canManage: boolean;
}) {
  const modals = useMyModals();
  const [remarks, err] = useClientStream(() => client.streamQuery('remarks.list', { resourceType, resourceId }), [resourceType, resourceId]);
  const rows = remarks ?? [];

  if (!rows.length && !err) return null;

  return (
    <section className="space-y-1 pb-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-lg font-semibold">{uiText("Vermerke")}</h3>
        {canManage && (
          <MyButton
            kind="secondary"
            size="sm"
            renderIcon={Icons.Plus}
            onClick={() => {
              showRemarkFormModal({ modals, resourceType, resourceId });
            }}
          >
            {uiText("Vermerk")}
          </MyButton>
        )}
      </div>

      {!!err && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("Vermerke konnten nicht geladen werden: ")}
          {err.message}
        </MyCallout>
      )}

      {!!rows.length && (
        <div
          className={[
            "grid gap-3",
            "[grid-template-columns:repeat(auto-fit,minmax(min(100%,16rem),1fr))]",
          ].join(" ")}
        >
          {rows.map((remark) => (
            <Card
              key={remark.id}
              variant="secondary"
              className="min-w-0 gap-0.5 border border-warning/30 bg-warning-soft p-3"
            >
              <Card.Header className="min-h-5 pr-8">
                <time
                  dateTime={remark.createdAt.toISOString()}
                  className="text-sm text-muted"
                >
                  {formatDate(remark.createdAt, "long")}
                </time>
                {canManage && (
                  <div className="absolute right-1 top-1">
                    <MyDropdown
                      size="sm"
                      ariaLabel={uiText("Vermerkaktionen", "Note actions")}
                      items={[
                        {
                          label: uiText("Bearbeiten"),
                          renderIcon: Icons.Edit,
                          onClick: () =>
                            showRemarkFormModal({
                              modals,
                              resourceType,
                              resourceId,
                              remark,
                            }),
                        },
                        {
                          label: uiText("Löschen"),
                          renderIcon: Icons.Delete,
                          onClick: () => showDeleteRemarkModal(modals, remark),
                        },
                      ]}
                    />
                  </div>
                )}
              </Card.Header>
              <Card.Content className="whitespace-pre-wrap break-words text-sm leading-relaxed">
                {remark.body}
              </Card.Content>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
