import { Accordion, Input as UIInput } from "@heroui/react";
import { MyHeader } from "~/components/MyHeader";
import { Tile } from "@sortsys/react-components";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";

import inventory from "~/generated/license-inventory.generated.json";
import {
  BUILD_REVISION_SHORT,
  BUILD_REVISION_URL,
  SORTSYS_LICENSE,
} from "~/lib/buildInfo";
import { uiText, useI18n } from "~/lib/i18n";

type LicenseEntry = {
  ecosystem: string;
  name: string;
  version: string;
  license: string;
  licenseUrl?: string;
  source: string;
};

type ComponentLicenses = {
  id: string;
  title: string;
  entries: LicenseEntry[];
};

export function meta() {
  return [{ title: uiText("Lizenzen", "Licenses") }];
}

function packageCount(count: number) {
  return uiText(
    `${count} ${count === 1 ? "Paket" : "Pakete"}`,
    `${count} ${count === 1 ? "package" : "packages"}`,
  );
}

function ComponentLicenseList({
  component,
  query,
}: {
  component: ComponentLicenses;
  query: string;
}) {
  const [expandedKeys, setExpandedKeys] = useState<Set<string | number>>(new Set());
  const entries = useMemo(() => {
    if (!query) return component.entries;

    if (component.title.toLocaleLowerCase().includes(query)) {
      return component.entries;
    }

    return component.entries.filter(entry =>
      [entry.name, entry.version, entry.license, entry.ecosystem]
        .some(value => value.toLocaleLowerCase().includes(query)));
  }, [component.entries, query]);

  return (
    <Accordion
      expandedKeys={query ? [component.id] : expandedKeys}
      onExpandedChange={(keys) => setExpandedKeys(new Set(keys))}
    >
      <Accordion.Item id={component.id}>
        <Accordion.Heading level={2}>
          <Accordion.Trigger className="min-h-11 text-base font-medium">
            <span className="min-w-0 flex-1 text-left">{component.title}</span>
            <span className="text-xs font-normal text-muted">
              {packageCount(entries.length)}
            </span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="min-w-0 px-0">
            <div className="divide-y divide-separator" role="list">
              {entries.map((entry) => (
                <div
                  className={[
                    "grid min-w-0 gap-2 py-3 text-sm",
                    "sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)]",
                  ].join(" ")}
                  key={`${entry.ecosystem}:${entry.name}:${entry.version}`}
                  role="listitem"
                >
                  <div
                    className={[
                      "flex min-w-0 flex-col gap-1 [&_a]:break-words [&_a]:text-accent",
                      "[&_span]:text-xs [&_span]:text-muted",
                    ].join(" ")}
                  >
                    <a href={entry.source} target="_blank" rel="noreferrer">
                      {entry.name}
                    </a>
                    <span>{entry.ecosystem}</span>
                  </div>
                  <code>{entry.version}</code>
                  {entry.licenseUrl ? (
                    <a href={entry.licenseUrl} target="_blank" rel="noreferrer">
                      {entry.license}
                    </a>
                  ) : (
                    <span>
                      {entry.license === "UNKNOWN"
                        ? uiText("Unbekannt", "Unknown")
                        : entry.license}
                    </span>
                  )}
                </div>
              ))}

              {!entries.length && (
                <p className="py-4 text-sm text-muted">
                  {uiText(
                    "Keine passenden Pakete gefunden.",
                    "No matching packages found.",
                  )}
                </p>
              )}
            </div>
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export default function LicensesPage() {
  const { locale } = useI18n();
  const [search, setSearch] = useState("");
  const query = useDeferredValue(search.trim().toLocaleLowerCase(locale));
  const components: ComponentLicenses[] = [
    {
      id: "api",
      title: uiText("API", "API"),
      entries: inventory.server.api,
    },
    {
      id: "job-runner",
      title: uiText("Job-Runner", "Job runner"),
      entries: inventory.server.jobRunner,
    },
    {
      id: "webapp",
      title: uiText("Webapp", "Web app"),
      entries: inventory.client.webapp,
    },
    {
      id: "postgresql",
      title: uiText("PostgreSQL", "PostgreSQL"),
      entries: [{
        ecosystem: uiText("Datenbank", "Database"),
        name: "PostgreSQL",
        version: "17",
        license: "PostgreSQL License",
        licenseUrl: "https://www.postgresql.org/about/licence/",
        source: "https://www.postgresql.org/",
      }],
    },
    {
      id: "onlyoffice",
      title: uiText("Euro-Office", "Euro-Office"),
      entries: [{
        ecosystem: uiText("Dokumentenserver", "Document server"),
        name: "Euro-Office",
        version: "sha256:b303064a69d0",
        license: "AGPL-3.0-only",
        licenseUrl: "https://github.com/Euro-Office/DocumentServer/blob/main/LICENSE",
        source: "https://github.com/Euro-Office/DocumentServer",
      }],
    },
    {
      id: "drawio",
      title: uiText("diagrams.net (draw.io)", "diagrams.net (draw.io)"),
      entries: [{
        ecosystem: uiText("Diagrammeditor", "Diagram editor"),
        name: "diagrams.net (draw.io)",
        version: "32.0.1",
        license: "Apache-2.0",
        licenseUrl: "https://github.com/jgraph/drawio/blob/dev/LICENSE",
        source: "https://github.com/jgraph/drawio",
      }],
    },
  ];

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <MyHeader
        title={uiText("Lizenzen", "Licenses")}
        subtitle={uiText(
          "Verwendete Open-Source-Pakete und die zugehörigen Lizenzangaben.",
          "Open-source packages used by sortsys and their license information.",
        )}
      >
        <Link className="text-accent hover:underline" to="/docs">
          {uiText("Hilfe & Begriffe", "Help & terms")}
        </Link>
      </MyHeader>

      <Tile className="flex flex-wrap gap-x-8 gap-y-4">
        <div>
          <span className="block text-xs font-medium text-muted">
            {uiText("Revision", "Revision")}
          </span>
          {BUILD_REVISION_URL ? (
            <a href={BUILD_REVISION_URL} target="_blank" rel="noreferrer">
              <code>{BUILD_REVISION_SHORT}</code>
            </a>
          ) : (
            <code>{BUILD_REVISION_SHORT}</code>
          )}
        </div>
        <div>
          <span className="block text-xs font-medium text-muted">
            {uiText("sortsys-Lizenz", "sortsys license")}
          </span>
          <a
            href="https://github.com/stuck-lehnert/sortsys/blob/master/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            {SORTSYS_LICENSE}
          </a>
        </div>
      </Tile>

      <label className="flex max-w-xl flex-col gap-2" htmlFor="license-search">
        <span className="text-sm font-medium">
          {uiText("Pakete suchen", "Search packages")}
        </span>
        <UIInput
          variant="secondary"
          id="license-search"
          className="w-full"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
          placeholder={uiText(
            "Name, Version oder Lizenz",
            "Name, version or license",
          )}
        />
      </label>

      <section
        className="space-y-3"
        aria-label={uiText("Komponenten", "Components")}
      >
        {components.map((component) => (
          <ComponentLicenseList
            key={component.id}
            component={component}
            query={query}
          />
        ))}
      </section>
    </div>
  );
}
