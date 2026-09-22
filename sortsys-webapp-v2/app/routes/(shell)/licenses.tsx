import { Tile } from "@sortsys/react-components";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";

import inventory from "~/generated/license-inventory.generated.json";
import {
  BUILD_REVISION_SHORT,
  BUILD_REVISION_URL,
  SORTSYS_LICENSE,
} from "~/lib/buildInfo";
import { Icons } from "~/lib/icons";
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
  const entries = useMemo(() => {
    if (!query) return component.entries;

    if (component.title.toLocaleLowerCase().includes(query)) {
      return component.entries;
    }

    return component.entries.filter(entry =>
      [entry.name, entry.version, entry.license, entry.ecosystem]
        .some(value => value.toLocaleLowerCase().includes(query)));
  }, [component.entries, query]);

  return <details className="license-component" open={query ? true : undefined}>
    <summary>
      <Icons.AccordionClosed className="license-component-chevron" aria-hidden="true" />
      <span className="license-component-title">{component.title}</span>
      <span className="license-component-count">{packageCount(entries.length)}</span>
    </summary>

    <div className="license-list" role="list">
      {entries.map(entry => <div
        className="license-entry"
        key={`${entry.ecosystem}:${entry.name}:${entry.version}`}
        role="listitem"
      >
        <div className="license-package">
          <a href={entry.source} target="_blank" rel="noreferrer">{entry.name}</a>
          <span>{entry.ecosystem}</span>
        </div>
        <code>{entry.version}</code>
        {entry.licenseUrl
          ? <a href={entry.licenseUrl} target="_blank" rel="noreferrer">{entry.license}</a>
          : <span>{entry.license === "UNKNOWN" ? uiText("Unbekannt", "Unknown") : entry.license}</span>}
      </div>)}

      {!entries.length && <p className="light license-empty">
        {uiText("Keine passenden Pakete gefunden.", "No matching packages found.")}
      </p>}
    </div>
  </details>;
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
      title: uiText("ONLYOFFICE Docs", "ONLYOFFICE Docs"),
      entries: [{
        ecosystem: uiText("Dokumentenserver", "Document server"),
        name: "ONLYOFFICE Docs",
        version: "9.3.1.2",
        license: "AGPL-3.0-only",
        licenseUrl: "https://github.com/ONLYOFFICE/DocumentServer/blob/master/LICENSE",
        source: "https://github.com/ONLYOFFICE/DocumentServer",
      }],
    },
    {
      id: "drawio",
      title: uiText("diagrams.net (draw.io)", "diagrams.net (draw.io)"),
      entries: [{
        ecosystem: uiText("Diagrammeditor", "Diagram editor"),
        name: "diagrams.net (draw.io)",
        version: "31.1.8",
        license: "Apache-2.0",
        licenseUrl: "https://github.com/jgraph/drawio/blob/dev/LICENSE",
        source: "https://github.com/jgraph/drawio",
      }],
    },
  ];

  return <div className="docs-page license-page">
    <header className="ss-page-header">
      <div className="ss-page-header__main">
        <h1 className="ss-page-header__title docs-article-title">
          {uiText("Lizenzen", "Licenses")}
        </h1>
        <p className="light docs-page-lead">
          {uiText(
            "Verwendete Open-Source-Pakete und die zugehörigen Lizenzangaben.",
            "Open-source packages used by sortsys and their license information.",
          )}
        </p>
      </div>
      <div className="ss-page-header__actions">
        <Link to="/docs">{uiText("Hilfe & Begriffe", "Help & terms")}</Link>
      </div>
    </header>

    <Tile className="license-build">
      <div>
        <span className="license-build-label">{uiText("Revision", "Revision")}</span>
        {BUILD_REVISION_URL
          ? <a href={BUILD_REVISION_URL} target="_blank" rel="noreferrer">
              <code>{BUILD_REVISION_SHORT}</code>
            </a>
          : <code>{BUILD_REVISION_SHORT}</code>}
      </div>
      <div>
        <span className="license-build-label">{uiText("sortsys-Lizenz", "sortsys license")}</span>
        <a
          href="https://github.com/stuck-lehnert/sortsys/blob/master/LICENSE"
          target="_blank"
          rel="noreferrer"
        >{SORTSYS_LICENSE}</a>
      </div>
    </Tile>

    <label className="docs-search-tile license-search" htmlFor="license-search">
      <span className="docs-search-label">{uiText("Pakete suchen", "Search packages")}</span>
      <input
        id="license-search"
        className="docs-search-input"
        type="search"
        value={search}
        onChange={event => setSearch(event.currentTarget.value)}
        placeholder={uiText("Name, Version oder Lizenz", "Name, version or license")}
      />
    </label>

    <section className="license-area" aria-label={uiText("Komponenten", "Components")}>
      {components.map(component =>
        <ComponentLicenseList key={component.id} component={component} query={query} />)}
    </section>
  </div>;
}
