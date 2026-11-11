import { Tile, useNotifications } from "@sortsys/react-components";
import { useRef, useState } from "react";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { MyButton } from "./MyButton";
import { client, organizationSettings } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { OrganizationEditConflict } from "~/lib/data/organization";

export function OrganizationDetailsForm() {
  const notifications = useNotifications();
  const edit = useRef<Awaited<ReturnType<typeof organizationSettings.profile>> | null>(null);
  const loadSequence = useRef(0);
  const [conflict, setConflict] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  async function load(context: MyPublicFormContext) {
    const sequence = ++loadSequence.current;
    const opened = await organizationSettings.profile();
    if (sequence !== loadSequence.current) return;
    edit.current = opened;
    const profile = opened.value;
    context.setValues({
      companyName: profile.companyName ?? "",
      streetAddress: profile.address?.streetAddress ?? "",
      zip: profile.address?.zip ?? "",
      city: profile.address?.city ?? "",
      country: profile.address?.country ?? "",
    });
  }
  async function save(context: MyPublicFormContext) {
    const values = context.getValues();
    const value = (key: string) => String(values[key] ?? "").trim();
    const address = ["streetAddress", "zip", "city", "country"].some((key) =>
      value(key),
    )
      ? {
          streetAddress: value("streetAddress"),
          city: value("city"),
          zip: value("zip") || null,
          country: value("country") || null,
        }
      : null;
    if (!edit.current) throw new Error("load-failed");
    try { await edit.current.save({ companyName: value("companyName"), address }); }
    catch (error) { if (error instanceof OrganizationEditConflict) setConflict(true); throw error; }
    await client.invalidate("auth.sessionInfo");
    await client.invalidate("settings.organization.get");
    notifications.success({
      title: uiText("Organisation gespeichert", "Organization saved"),
    });
  }
  return (
    <Tile className="space-y-4">
      <MyForm
        key={formVersion}
        className="max-w-none space-y-4"
        notifyLoaded={load}
        onSubmit={save}
      >
        <MyForm.Input
          required
          name="companyName"
          labelText={uiText("Firmenname", "Company name")}
        />
        <MyForm.Input
          name="streetAddress"
          labelText={uiText("Straße und Hausnummer", "Street and number")}
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <MyForm.Input name="zip" labelText={uiText("PLZ", "Postal code")} />
          <MyForm.Input name="city" labelText={uiText("Ort", "City")} />
          <MyForm.Input name="country" labelText={uiText("Land", "Country")} />
        </div>
        <MyForm.SubmitButton>{uiText("Speichern", "Save")}</MyForm.SubmitButton>
      </MyForm>
      {conflict && <MyButton kind="secondary" onClick={() => {
        ++loadSequence.current; edit.current = null; setConflict(false); setFormVersion(value => value + 1);
      }}>{uiText("Aktuellen Stand laden", "Load current settings")}</MyButton>}
    </Tile>
  );
}
