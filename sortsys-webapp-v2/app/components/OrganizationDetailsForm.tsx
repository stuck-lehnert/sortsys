import { Tile, useNotifications } from "@sortsys/react-components";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";

export function OrganizationDetailsForm() {
  const notifications = useNotifications();
  async function load(context: MyPublicFormContext) {
    const [profile, error] = await client.query(
      "settings.organization.get",
      undefined,
      { strategy: "network-first" },
    );
    if (error || !profile) throw error ?? new Error("load-failed");
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
    const [, error] = await client.mutate("settings.organization.set", {
      companyName: value("companyName"),
      address,
    });
    if (error) throw error;
    await client.invalidate("auth.sessionInfo");
    await client.invalidate("settings.organization.get");
    notifications.success({
      title: uiText("Organisation gespeichert", "Organization saved"),
    });
  }
  return (
    <Tile className="space-y-4">
      <MyForm
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
    </Tile>
  );
}
