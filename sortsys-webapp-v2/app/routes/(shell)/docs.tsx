import { Heading, Tile } from "@sortsys/react-components";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";
import { DOC_ARTICLES, docArticleText, normalizeDocText } from "~/lib/docs";

export function meta() {
  return [
    { title: "Dokumentation" },
  ];
}

export default function DocsPage() {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(normalizeDocText(query.trim()));

  const articles = useMemo(() => {
    if (!deferredQuery) return DOC_ARTICLES;
    return DOC_ARTICLES.filter(article => docArticleText(article).includes(deferredQuery));
  }, [deferredQuery]);

  const articleGroups = useMemo(() => {
    const groups = new Map<string, typeof DOC_ARTICLES>();
    for (const article of articles) {
      const group = groups.get(article.category) ?? [];
      group.push(article);
      groups.set(article.category, group);
    }
    return [...groups.entries()];
  }, [articles]);

  return <div className="docs-page">
    <header className="ss-page-header">
      <div className="ss-page-header__main">
        <h1 className="ss-page-header__title docs-article-title">Dokumentation</h1>
        <p className="light docs-page-lead">Kurze Einstiege, danach ausführliche Kapitel zu Begriffen und Abläufen.</p>
      </div>
    </header>

    <Tile className="docs-search-tile">
      <label className="docs-search-label" htmlFor="docs-search">Artikel suchen</label>
      <input
        id="docs-search"
        className="docs-search-input"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="z. B. Projekt, Lieferschein, Lager, Regie"
      />
    </Tile>

    {articleGroups.map(([category, group]) => <section key={category} className="docs-category-section" aria-labelledby={`docs-category-${category}`}>
      <div className="docs-category-header">
        <Heading level={3} noMargin id={`docs-category-${category}`}>{category}</Heading>
      </div>

      <div className="docs-card-grid">
        {group.map(article => <Link key={article.id} to={`/docs/${article.id}`} className="docs-page-card">
          <Tile className="docs-entry-card">
            <div className="docs-entry-category">{article.category}</div>
            <Heading level={3} noMargin>{article.title}</Heading>
          </Tile>
        </Link>)}
      </div>
    </section>)}

    {!articles.length && <Tile>
      <p className="light">Kein passender Artikel gefunden.</p>
    </Tile>}
  </div>;
}
