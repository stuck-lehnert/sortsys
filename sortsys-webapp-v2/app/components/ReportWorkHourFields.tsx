import { useRef, type ReactNode } from "react";
import { MyButton } from "~/components/MyButton";
import { MyForm, type MyMultiSelectCreateAction } from "~/components/MyForm";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";
import { focusReportHours } from "~/lib/reportForm";
import { SmallUserTile } from "~/lib/tiles";
import { parseFloatCustom } from "~/lib/utils";
import type { User } from "~/type-helpers";

type WorkHourFieldsProps = {
  fieldPrefix: string;
  createUser?: MyMultiSelectCreateAction<User>;
  focusEmployee: boolean;
  focusHoursOnSelect?: boolean;
  unavailableEmployee?: string;
  numberRule: "num" | "posnum";
  onRemove: () => void;
  children?: ReactNode;
};

function hoursInRange(value: string) {
  if (!value.trim()) return null;

  const hours = parseFloatCustom(value);
  if (hours < 0 || hours > 10)
    return uiText(
      "Stunden müssen zwischen 0 und 10 liegen",
      "Hours must be between 0 and 10",
    );

  return null;
}

export function ReportWorkHourFields({
  fieldPrefix,
  createUser,
  focusEmployee,
  focusHoursOnSelect,
  unavailableEmployee,
  numberRule,
  onRemove,
  children,
}: WorkHourFieldsProps) {
  const hoursInput = useRef<HTMLInputElement>(null);
  const removeLabel = uiText("Arbeitszeit entfernen");

  return (
    <div className="flex flex-col gap-2">
      {children}

      {unavailableEmployee != null ? (
        <p>
          {uiText("Mitarbeiter")}: {unavailableEmployee}
        </p>
      ) : (
        <MyForm.MultiSelect
          name={`${fieldPrefix}:user`}
          labelText={uiText("Mitarbeiter")}
          focusOnMount={focusEmployee}
          onValueChange={(selected) => {
            if (focusHoursOnSelect)
              focusReportHours(selected, () => hoursInput.current);
          }}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const [data, err] = await client.query("users.list", {
              search: query,
            });
            if (err) throw err;
            return data ?? [];
          }}
          renderItem={({ item }) => userFullName(item)}
          renderTile={(item) => <SmallUserTile data={item} noLink />}
          createAction={createUser}
        />
      )}

      <div className="flex gap-2 items-end">
        <div className="grow">
          <MyForm.Input
            required
            name={`${fieldPrefix}:hours`}
            ref={hoursInput}
            labelText={uiText("Stunden")}
            type="number"
            rules={[MyForm.Input.rules[numberRule], hoursInRange]}
            suffix={
              <MyButton
                kind="ghost"
                size="sm"
                className="ss-input-suffix-btn"
                title={removeLabel}
                aria-label={removeLabel}
                onClick={onRemove}
              >
                <Icons.Delete />
              </MyButton>
            }
          />
        </div>
      </div>
    </div>
  );
}
