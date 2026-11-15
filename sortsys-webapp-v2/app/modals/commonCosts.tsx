import { uiText } from "~/lib/i18n";
import { useEffect, useState } from "react";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { MyTable } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client, commonCostSettings } from "~/lib/client";
import { Loading } from "@sortsys/react-components";
import { MyCallout } from "~/components/MyCallout";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { formatCurrency, formatDate, formatNumber } from "~/lib/format";
import { dailyReportDayKey } from "~/lib/tiles";
import { parseFloatCustom } from "~/lib/utils";

const COMMON_COST_TYPES = ["fgk", "mgk", "ngk"] as const;
type CommonCostType = (typeof COMMON_COST_TYPES)[number];

function commonCostLabel(type: CommonCostType) {
  if (type === "fgk") return "LKG";
  if (type === "mgk") return "MGK";
  return "NUGK";
}

function commonCostDescription(type: CommonCostType) {
  if (type === "fgk") return uiText("Lohngemeinkosten (interne Arbeitszeit)");
  if (type === "mgk")
    return "Materialgemeinkosten (Lieferscheine: Produkte + Sonderposten)";
  return uiText("Nachunternehmergemeinkosten (SUB-Arbeitszeit)");
}

export function showManageCommonCostsModal(modals: MyModalsInterface) {
  // Each dialog owns this readiness value. The content and button props are
  // evaluated in the same render; no synthetic business-data field is needed.
  let readyToSave = false;
  modals.showForm({
    content: ({ context }) => {
      const [settings, error] = useClientStream(() => {
        return client.streamQuery("settings.costs.get", undefined);
      }, []);

      const [initialized, setInitialized] = useState(false);
      const session = useSessionInfo();
      const writable =
        session.canAccess("organization", "calculation", "create") ||
        session.canAccess("organization", "calculation", "update");

      readyToSave = initialized && !!settings && !error && writable;

      useEffect(() => {
        if (!settings || error) {
          setInitialized(false);
          return;
        }
        if (initialized) return;

        context.setValues({
          fgkRelativeFactor: (settings.fgk?.relativeFactor ?? 0) * 100,
          fgkConstant: settings.fgk?.constant ?? 0,

          mgkRelativeFactor: (settings.mgk?.relativeFactor ?? 0) * 100,
          mgkConstant: settings.mgk?.constant ?? 0,

          ngkRelativeFactor: (settings.ngk?.relativeFactor ?? 0) * 100,
          ngkConstant: settings.ngk?.constant ?? 0,
        });

        setInitialized(true);
      }, [settings, error, initialized]);

      const history = settings?.history ?? [];
      if (error)
        return (
          <MyCallout color="red">
            {uiText(
              "Die Gemeinkosten konnten nicht geladen werden.",
              "Overhead rates could not be loaded.",
            )}
          </MyCallout>
        );
      if (!settings)
        return (
          <Loading
            active
            description={uiText(
              "Gemeinkosten werden geladen …",
              "Loading overhead rates…",
            )}
          />
        );

      return (
        <>
          <p className="light">
            {uiText(
              "Die Gemeinkosten werden historisch gespeichert und gelten immer ab dem gewählten Stichtag um 00:00 Uhr. Ein neuer Eintrag überschreibt keine alten Werte, sondern ergänzt die Historie für spätere Buchungen. Die Berechnung erfolgt je betroffener Kostenposition nach der Formel",
            )}
            <b>{uiText("originale Kosten * relativer Faktor + Konstante")}</b>
            {uiText(
              ". So kannst du Änderungen transparent zu einem bestimmten Datum wirksam machen.",
            )}
          </p>

          <MyForm.DateInput
            required
            name="effectiveAt"
            disabled={!writable}
            labelText={uiText("Gültig ab")}
          />

          <MyDivider />

          {COMMON_COST_TYPES.map((type) => {
            const key = type;

            return (
              <div key={type}>
                <h4 className="text-lg leading-snug font-semibold">
                  {commonCostLabel(type)}
                </h4>
                <p className="light">{commonCostDescription(type)}</p>

                <MyForm.Input
                  required
                  name={`${key}RelativeFactor`}
                  disabled={!writable}
                  labelText={uiText("Relativer Faktor in % (z.B. 20)")}
                  type="number"
                  rules={[MyForm.Input.rules.posnum]}
                />

                <MyForm.Input
                  required
                  name={`${key}Constant`}
                  disabled={!writable}
                  labelText={uiText("Konstante (EUR)")}
                  type="number"
                  rules={[MyForm.Input.rules.num]}
                />

                {type !== "ngk" && <MyDivider />}
              </div>
            );
          })}

          <MyDivider />

          <h4 className="text-lg leading-snug font-semibold">
            {uiText("Historie")}
          </h4>
          <MyTable
            rows={history.map((entry, index) => ({
              ...entry,
              id:
                entry.id ??
                `${entry.type}-${entry.effectiveAt?.toString() ?? ""}-${index}`,
            }))}
            columns={[
              {
                label: uiText("Typ"),
                render: (row) => commonCostLabel(row.type),
                sortKey: (row) => commonCostLabel(row.type),
              },
              {
                label: uiText("Gültig ab"),
                render: (row) => formatDate(row.effectiveAt),
                sortKey: (row) => row.effectiveAt?.getTime() ?? 0,
              },
              {
                label: uiText("Relativer Faktor"),
                render: (row) => `${formatNumber(row.relativeFactor * 100)} %`,
                sortKey: (row) => row.relativeFactor,
              },
              {
                label: uiText("Konstante"),
                render: (row) => formatCurrency(row.constant),
                sortKey: (row) => row.constant,
              },
            ]}
            loadMore={{}}
            autoConvertSmallViewport
          />

          <NotifyLoaded
            onLoad={() => {
              context.field("effectiveAt")?.setValue(new Date());
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      if (!readyToSave)
        throw new Error(
          uiText(
            "Die Gemeinkosten sind nicht zur Bearbeitung freigegeben.",
            "Overhead rates are not available for editing.",
          ),
        );

      const effectiveAtInput = values.effectiveAt
        ? new Date(values.effectiveAt)
        : null;
      if (!effectiveAtInput || isNaN(effectiveAtInput.getTime())) {
        throw new Error(uiText("Ungültiges Datum"));
      }
      const effectiveAt = dailyReportDayKey(effectiveAtInput);

      const parseValue = (name: string) => {
        const value = parseFloatCustom(values[name]);
        if (isNaN(value))
          throw new Error(
            uiText(`Ungültiger Zahlenwert: ${name}`, `Invalid number: ${name}`),
          );
        return value;
      };

      const payloadByType: Record<
        CommonCostType,
        {
          relativeFactor: number;
          constant: number;
        }
      > = {
        fgk: {
          relativeFactor: parseValue("fgkRelativeFactor") / 100,
          constant: parseValue("fgkConstant"),
        },
        mgk: {
          relativeFactor: parseValue("mgkRelativeFactor") / 100,
          constant: parseValue("mgkConstant"),
        },
        ngk: {
          relativeFactor: parseValue("ngkRelativeFactor") / 100,
          constant: parseValue("ngkConstant"),
        },
      };

      await commonCostSettings.save(
        COMMON_COST_TYPES.map((type) => ({
          type,
          effectiveAt,
          ...payloadByType[type],
        })),
      );

      await Promise.all([
        client.invalidateCascading("projects.costs.get"),
        client.invalidateCascading("settings.costs.get"),
      ]);

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Gemeinkosten verwalten"),
      primaryButtonText: uiText("Speichern"),
      primaryButtonDisabled: !readyToSave,
    }),
  });
}
