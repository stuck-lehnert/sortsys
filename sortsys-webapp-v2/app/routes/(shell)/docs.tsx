import { uiText, useI18n } from "~/lib/i18n";
import { Heading, Tile } from "@sortsys/react-components";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";
import { docArticleText, getDocArticles, normalizeDocText, type DocArticle } from "~/lib/docs";

export function meta() {
  return [
    { title: uiText("Dokumentation") },
  ];
}

export default function DocsPage() {
  const { locale } = useI18n();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(normalizeDocText(query.trim()));

  const articles = useMemo(() => {
    const localizedArticles = getDocArticles();

    if (!deferredQuery) return localizedArticles;
    return localizedArticles.filter(article => docArticleText(article).includes(deferredQuery));
  }, [deferredQuery, locale]);

  const articleGroups = useMemo(() => {
    const groups = new Map<string, DocArticle[]>();
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
        <h1 className="ss-page-header__title docs-article-title">{uiText("Dokumentation")}</h1>
        <p className="light docs-page-lead">{uiText("Kurze Einstiege, danach ausführliche Kapitel zu Begriffen und Abläufen.")}</p>
      </div>
      <div className="ss-page-header__actions">
        <a
          href="https://github.com/stuck-lehnert/sortsys/issues"
          target="_blank"
          rel="noreferrer"
        >{uiText("Problem melden")}</a>
      </div>
    </header>

    <Tile className="docs-search-tile">
      <label className="docs-search-label" htmlFor="docs-search">{uiText("Artikel suchen")}</label>
      <input
        id="docs-search"
        className="docs-search-input"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder={uiText("z. B. Projekt, Lieferschein, Lager, Regie")}
      />
    </Tile>

    {articleGroups.map(([category, group]) => <section key={category} className="docs-category-section" aria-labelledby={`docs-category-${category}`}>
      <div className="docs-category-header">
        <Heading level={3} noMargin className="docs-category-title" id={`docs-category-${category}`}>{category}</Heading>
      </div>

      <div className="docs-card-grid">
        {group.map(article => <Link key={article.id} to={`/docs/${article.id}`} className="docs-page-card">
          <Tile className="docs-entry-card">
            <Heading level={3} noMargin>{article.title}</Heading>
            <p className="docs-entry-subtitle">{article.lead}</p>
          </Tile>
        </Link>)}
      </div>
    </section>)}

    {!articles.length && <Tile>
      <p className="light">{uiText("Kein passender Artikel gefunden.")}</p>
    </Tile>}
  </div>;
}
