import { uiText, useI18n } from "~/lib/i18n";
import { Heading, TextInput, Tile } from "@sortsys/react-components";
import { useDeferredValue, useMemo, useState } from "react";
import { Link } from "react-router";
import { MyHeader } from "~/components/MyHeader";
import {
  docArticleText,
  getDocArticles,
  normalizeDocText,
  type DocArticle,
} from "~/lib/docs";

export function meta() {
  return [{ title: uiText("Dokumentation") }];
}

export default function DocsPage() {
  const { locale } = useI18n();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(normalizeDocText(query.trim()));

  const articles = useMemo(() => {
    const localizedArticles = getDocArticles();
    if (!deferredQuery) {
      return localizedArticles;
    }

    return localizedArticles.filter((article) =>
      docArticleText(article).includes(deferredQuery),
    );
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

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <MyHeader
        title={uiText("Dokumentation")}
        subtitle={uiText(
          "Kurze Einstiege, danach ausführliche Kapitel zu Begriffen und Abläufen.",
        )}
        actions={
          <>
            <Link to="/licenses" className="link">
              {uiText("Lizenzen", "Licenses")}
            </Link>
            <a
              href="https://github.com/stuck-lehnert/sortsys/issues"
              target="_blank"
              rel="noreferrer"
              className="link"
            >
              {uiText("Problem melden")}
            </a>
          </>
        }
      />

      <TextInput
        id="docs-search"
        type="search"
        labelText={uiText("Artikel suchen")}
        value={query}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          setQuery(event.target.value);
        }}
        placeholder={uiText("z. B. Projekt, Lieferschein, Lager, Regie")}
      />

      {articleGroups.map(([category, group]) => (
        <section
          key={category}
          aria-labelledby={`docs-category-${category}`}
          className="space-y-3"
        >
          <Heading level={2} noMargin id={`docs-category-${category}`}>
            {category}
          </Heading>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {group.map((article) => (
              <Link
                key={article.id}
                to={`/docs/${article.id}`}
                className={[
                  "rounded-2xl text-foreground no-underline",
                  "focus-visible:outline-2 focus-visible:outline-offset-4",
                  "focus-visible:outline-focus",
                ].join(" ")}
              >
                <Tile className="h-full gap-3 transition-colors hover:bg-surface-secondary">
                  <Heading level={3} noMargin>
                    {article.title}
                  </Heading>
                  <p className="text-sm leading-relaxed text-muted">
                    {article.lead}
                  </p>
                </Tile>
              </Link>
            ))}
          </div>
        </section>
      ))}

      {!articles.length && (
        <Tile role="status">
          <p className="text-muted">
            {uiText("Kein passender Artikel gefunden.")}
          </p>
        </Tile>
      )}
    </div>
  );
}
