import { useId, useState } from "react";
import {
  Select,
  SelectItem,
  useNotifications,
} from "@sortsys/react-components";
import { MyForm, type MyPublicFormContext } from "./MyForm";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import {
  previewInvoiceNumbers,
  parseStartNumber,
  projectNumberFromId,
  type InvoiceNumberingScheme,
} from "~/lib/invoiceNumbering";

const EXAMPLE_PROJECT_ID = 238427n.toString(32);
export function InvoiceNumberingForm() {
  const notifications = useNotifications();
  const previewId = useId();
  const [scheme, setScheme] = useState<InvoiceNumberingScheme>("sequential");
  const [start, setStart] = useState("1");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const options: Array<{
    id: InvoiceNumberingScheme;
    label: string;
    description: string;
  }> = [
    {
      id: "sequential",
      label: uiText("Global fortlaufend", "Global sequence"),
      description: uiText(
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
  const selectedOption = options.find((option) => option.id === scheme)!;
  const examples = previewInvoiceNumbers(
    { scheme, startNumber: start },
    { date: new Date(), projectId: EXAMPLE_PROJECT_ID },
  );
  async function load(context: MyPublicFormContext) {
    const [config, error] = await client.query(
      "settings.invoiceNumbering.get",
      undefined,
      { strategy: "network-first" },
    );
    if (error || !config) throw error ?? new Error("load-failed");
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
      const [, error] = await client.mutate("settings.invoiceNumbering.set", {
        scheme,
        startNumber,
      });
      if (error) throw error;
      await client.invalidate("settings.invoiceNumbering.get");
      notifications.success({
        title: uiText(
          "Rechnungsnummern gespeichert",
          "Invoice numbering saved",
        ),
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <MyForm className="max-w-none gap-6" notifyLoaded={load} onSubmit={save}>
      <div className="grid items-start gap-4 md:grid-cols-[minmax(0,28rem)_16rem]">
        <Select
          value={scheme}
          onChange={(event: { target: { value: string } }) => {
            const selected = options.find(
              (option) => option.id === event.target.value,
            );
            if (selected) setScheme(selected.id);
          }}
          disabled={!loaded || saving}
          labelText={uiText(
            "Rechnungsnummer-Schema",
            "Invoice numbering scheme",
          )}
          aria-describedby={`${previewId}-description`}
        >
          {options.map((option) => (
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
          aria-label={uiText(
            "Beispiel-Rechnungsnummern",
            "Example invoice numbers",
          )}
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
  );
}
