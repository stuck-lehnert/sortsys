import { useId, useRef, useState } from "react";
import {
  Select,
  SelectItem,
  useNotifications,
} from "@sortsys/react-components";
import { MyForm, type MyPublicFormContext } from "./MyForm";
import { client, organizationSettings } from "~/lib/client";
import { MyButton } from "./MyButton";
import { OrganizationEditConflict } from "~/lib/data/organization";
import { offerNumbering } from "~/lib/data/organizationData";
import { uiText } from "~/lib/i18n";
import {
  previewInvoiceNumbers,
  previewOfferNumbers,
  parseStartNumber,
  projectNumberFromId,
  type InvoiceNumberingScheme,
} from "~/lib/invoiceNumbering";

const EXAMPLE_PROJECT_ID = 238427n.toString(32);
export function InvoiceNumberingForm({
  forOffers = false,
}: {
  forOffers?: boolean;
}) {
  const notifications = useNotifications();
  const previewId = useId();
  const [scheme, setScheme] = useState<InvoiceNumberingScheme>("sequential");
  const [start, setStart] = useState("1");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const edit = useRef<Awaited<ReturnType<typeof organizationSettings.numbering>> | null>(null);
  const loadSequence = useRef(0);
  const [conflict, setConflict] = useState(false);
  const [formVersion, setFormVersion] = useState(0);
  const options: Array<{
    id: InvoiceNumberingScheme;
    label: string;
    description: string;
  }> = [
    {
      id: "sequential",
      label: uiText("Global fortlaufend", "Global sequence"),
      description: forOffers
        ? uiText(
            "Haupt- und Nebenangebote teilen sich einen Zähler.",
            "Main and alternative offers share one counter.",
          )
        : uiText(
            "Ein gemeinsamer Zähler für alle Rechnungen.",
            "One shared counter for all invoices.",
          ),
    },
    {
      id: "dateSeparated",
      label: uiText("Datumsbasiert mit Trennzeichen", "Date with separators"),
      description: uiText(
        "JJ-MM-TT und globale Nummer. Der Zähler läuft über Datumsgrenzen weiter.",
        "YY-MM-DD and a global number. The counter continues across dates.",
      ),
    },
    {
      id: "dateCompact",
      label: uiText("Datumsbasiert kompakt", "Compact date"),
      description: uiText(
        "JJMMTT direkt vor der global fortlaufenden Nummer.",
        "YYMMDD followed directly by the global sequence.",
      ),
    },
    {
      id: "projectLocal",
      label: uiText(
        "Projektbasiert, lokal fortlaufend",
        "Project with local sequence",
      ),
      description: uiText(
        "Die achtstellige Nummer aus der Projekt-ID steht vor einem eigenen Zähler je Projekt.",
        "The eight-digit number derived from the project ID precedes a separate counter per project.",
      ),
    },
    {
      id: "projectGlobal",
      label: uiText(
        "Projektbasiert, global fortlaufend",
        "Project with global sequence",
      ),
      description: uiText(
        "Die achtstellige Nummer aus der Projekt-ID steht vor einem gemeinsamen Zähler für alle Projekte.",
        "The eight-digit number derived from the project ID precedes one shared counter across all projects.",
      ),
    },
  ];
  const available = options.filter(
    (option) => !forOffers || !option.id.startsWith("project"),
  );
  const selectedOption = available.find((option) => option.id === scheme)!;
  const today = new Date();
  const startNumber = parseStartNumber(start);
  const examples = forOffers
    ? startNumber
      ? previewOfferNumbers(offerNumbering({ scheme, startNumber }), today)
      : []
    : previewInvoiceNumbers(
        { scheme, startNumber: start },
        { date: today, projectId: EXAMPLE_PROJECT_ID },
      );

  async function load(context: MyPublicFormContext) {
    const sequence = ++loadSequence.current;
    const opened: NonNullable<typeof edit.current> = forOffers
      ? await organizationSettings.offerNumbering().then((offerEdit) => ({
          value: offerEdit.value,
          save: (input) => offerEdit.save(offerNumbering(input)),
        }))
      : await organizationSettings.numbering();
    if (sequence !== loadSequence.current) return;

    edit.current = opened;
    const config = opened.value;
    setScheme(config.scheme);
    setStart(config.startNumber);
    context.setValues({ startNumber: config.startNumber });
    setLoaded(true);
  }
  async function save(context: MyPublicFormContext) {
    const startNumber = parseStartNumber(context.getValues().startNumber);
    if (!startNumber) return;
    setSaving(true);
    try {
      if (!edit.current) throw new Error("load-failed");
      await edit.current.save({ scheme, startNumber });
      if (!forOffers) await client.invalidate("settings.invoiceNumbering.get");
      notifications.success({
        title: forOffers
          ? uiText("Angebotsnummern gespeichert", "Offer numbering saved")
          : uiText("Rechnungsnummern gespeichert", "Invoice numbering saved"),
      });
    } catch (error) {
      if (error instanceof OrganizationEditConflict) setConflict(true);
      throw error;
    } finally {
      setSaving(false);
    }
  }
  return (
    <><MyForm key={formVersion} className="max-w-none gap-6" notifyLoaded={load} onSubmit={save}>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,28rem)_16rem]">
        <Select
          value={scheme}
          onChange={(event: { target: { value: string } }) => {
            const selected = available.find(
              (option) => option.id === event.target.value,
            );
            if (selected) setScheme(selected.id);
          }}
          disabled={!loaded || saving}
          labelText={
            forOffers
              ? uiText("Angebotsnummer-Schema", "Offer numbering scheme")
              : uiText("Rechnungsnummer-Schema", "Invoice numbering scheme")
          }
          aria-describedby={`${previewId}-description`}
        >
          {available.map((option) => (
            <SelectItem key={option.id} value={option.id} text={option.label} />
          ))}
        </Select>
        <MyForm.Input
          required
          name="startNumber"
          inputMode="numeric"
          labelText={
            scheme === "projectLocal"
              ? uiText("Startnummer je Projekt", "Starting number per project")
              : uiText("Globale Startnummer", "Global starting number")
          }
          onValueChange={setStart}
          rules={[
            (value) =>
              parseStartNumber(value)
                ? null
                : uiText(
                    "Bitte eine gültige positive Startnummer eingeben.",
                    "Enter a valid positive starting number.",
                  ),
          ]}
        />
      </div>
      <p
        id={`${previewId}-description`}
        className="max-w-prose text-sm text-muted"
      >
        {selectedOption.description}
      </p>
      <section
        aria-labelledby={previewId}
        className="border-t border-separator pt-5"
      >
        <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h2 id={previewId} className="text-base font-medium">
            {uiText("Vorschau", "Preview")}
          </h2>
          {scheme.startsWith("project") && (
            <p className="text-sm text-muted">
              {uiText("Beispielprojekt", "Example project")}:{" "}
              <span className="font-mono tabular-nums">
                {projectNumberFromId(EXAMPLE_PROJECT_ID)}
              </span>
            </p>
          )}
        </div>
        <div
          role="status"
          aria-live="polite"
          aria-label={
            forOffers
              ? uiText("Beispiel-Angebotsnummern", "Example offer numbers")
              : uiText("Beispiel-Rechnungsnummern", "Example invoice numbers")
          }
        >
          {examples.length ? (
            <ol className="divide-y divide-separator">
              {examples.map((number, index) => (
                <li
                  key={index}
                  className="flex min-w-0 items-baseline gap-4 py-2 first:pt-0"
                >
                  <span aria-hidden className="w-6 shrink-0 text-sm text-muted">
                    {index + 1}.
                  </span>
                  <code className="min-w-0 break-all font-mono text-lg tabular-nums">
                    {number}
                  </code>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">
              {uiText(
                "Gib eine gültige Startnummer für die Vorschau ein.",
                "Enter a valid starting number to see the preview.",
              )}
            </p>
          )}
        </div>
      </section>
      <MyForm.SubmitButton>{uiText("Speichern", "Save")}</MyForm.SubmitButton>
    </MyForm>
    {conflict && <MyButton kind="secondary" onClick={() => {
      ++loadSequence.current; edit.current = null; setLoaded(false); setConflict(false); setFormVersion(value => value + 1);
    }}>{uiText("Aktuellen Stand laden", "Load current settings")}</MyButton>}</>
  );
}
