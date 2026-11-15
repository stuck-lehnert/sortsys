import { useId, useState } from "react";
import { Checkbox, Select, SelectItem } from "@sortsys/react-components";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import {
  accessActions,
  accessPreset,
  DATA_ACTIONS,
  hasAccess,
  profilePatch,
  withActions,
  type AccessValue,
  type ManagedAction,
} from "~/lib/crypto/accessProfiles";
import { uiText } from "~/lib/i18n";

export function AccessLevelSelect({
  label,
  value,
  onChange,
  disabled = false,
  noneLabel,
  individual = false,
  actions = DATA_ACTIONS,
}: {
  label: string;
  value: AccessValue;
  onChange(value: AccessValue, actions: readonly ManagedAction[]): void;
  disabled?: boolean;
  noneLabel?: string;
  individual?: boolean;
  actions?: readonly ManagedAction[];
}) {
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  const preset = accessPreset(value);
  const labels = {
    read: uiText("Lesen", "Read"),
    create: uiText("Anlegen", "Create"),
    update: uiText("Bearbeiten", "Edit"),
    delete: uiText("Löschen", "Delete"),
    approve: uiText("Bestätigen", "Approve"),
    grant: uiText("Freigaben verwalten", "Manage grants"),
  };
  const extra = accessActions(value).filter(
    (action) => !actions.includes(action),
  );
  return (
    <div className="min-w-0 self-start space-y-2">
      {individual ? (
        <p className="text-sm font-medium">{label}</p>
      ) : (
        <Select
          labelText={label}
          value={expanded ? "custom" : preset}
          disabled={disabled}
          onChange={(event: { target: { value: string } }) => {
            const next = event.target.value;
            if (next === "custom") {
              setExpanded(true);
              return;
            }
            if (next === "none" || next === "read" || next === "write") {
              setExpanded(false);
              onChange(withActions(value, profilePatch(next)), ACTIONS);
            }
          }}
        >
          <SelectItem
            value="none"
            text={noneLabel ?? uiText("Kein Zugriff", "No access")}
          />
          <SelectItem value="read" text={uiText("Lesen", "Read")} />
          <SelectItem
            value="write"
            text={uiText("Lesen und bearbeiten", "Read and edit")}
          />
          <SelectItem value="custom" text={uiText("Individuell", "Custom")} />
        </Select>
      )}
      {(individual || expanded || preset === "custom") && (
        <fieldset
          className="space-y-2"
          aria-label={uiText(
            `Einzelrechte für ${label}`,
            `Individual permissions for ${label}`,
          )}
        >
          {actions.map((action) => (
            <Checkbox
              key={action}
              id={`${id}-${action}`}
              labelText={labels[action]}
              checked={hasAccess(value, action)}
              disabled={disabled}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                onChange(
                  withActions(value, { [action]: event.target.checked }),
                  [action],
                )
              }
            />
          ))}
          {!hasAccess(value, "read") &&
            actions.some(
              (action) => action !== "read" && hasAccess(value, action),
            ) && (
              <p className="text-sm text-muted">
                {uiText(
                  "Inhaltsänderungen benötigen auch Lesezugriff.",
                  "Content changes also require read access.",
                )}
              </p>
            )}
        </fieldset>
      )}
      {!individual && preset === "write" && !expanded && (
        <p className="text-sm text-muted">
          {uiText(
            "Anlegen und Löschen eingeschlossen.",
            "Includes creating and deleting.",
          )}
        </p>
      )}
      {extra.length > 0 && (
        <p className="text-sm text-muted">
          {uiText("Zusätzlich freigegeben:", "Additionally granted:")}{" "}
          {extra.map((action) => labels[action]).join(", ")}
        </p>
      )}
    </div>
  );
}
