import {
  Button,
  Form,
  Loading,
  TextInput,
  Tile,
} from "@sortsys/react-components";
import { MyHeader } from "~/components/MyHeader";
import { MyCallout } from "~/components/MyCallout";
import { useClientStream } from "~/hooks/useClientStream";
import { useTitle } from "~/hooks/useTitle";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";
import { from } from "rxjs";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";

type DocumentSearchResult = {
  id: string;
  projectId: string;
  projectTitle: string;
  fileName: string;
  mimeType: string;
  textExtractionStatus: string;
  excerpt: string | null;
  rank: number;
  modifiedAt: Date;
};

function highlightedExcerpt(excerpt: string): ReactNode[] {
  return excerpt.split(/(<<|>>)/).reduce<{
    highlighted: boolean;
    parts: ReactNode[];
  }>(
    (state, part, index) => {
      if (part === "<<") return { ...state, highlighted: true };
      if (part === ">>") return { ...state, highlighted: false };

      state.parts.push(
        state.highlighted ? (
          <mark key={index}>{part}</mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      );
      return state;
    },
    { highlighted: false, parts: [] },
  ).parts;
}

export function meta() {
  return [{ title: uiText("Dokumente", "Documents") }];
}

export default function DocumentsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const query = searchParams.get("q")?.trim() ?? "";
  const [input, setInput] = useState(query);

  useTitle(() => uiText("Dokumente", "Documents"), []);

  useEffect(() => {
    setInput(query);
  }, [query]);

  const [results, error] = useClientStream(
    () => query.length >= 2
      ? client.streamQuery("projects.files.search", { query, limit: 50n })
      : from([[[] as DocumentSearchResult[], null] as [DocumentSearchResult[], null]]),
    [query],
  );

  return (
    <div className="documents-search-page flex min-w-0 flex-col gap-4">
      <MyHeader
        title={uiText("Dokumente", "Documents")}
        subtitle={uiText(
          "PDF-Inhalte und Dateinamen projektübergreifend durchsuchen",
          "Search PDF contents and file names across projects",
        )}
      />

      <Form
        className="flex flex-col gap-3 sm:flex-row sm:items-end"
        role="search"
        onSubmit={(event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault();
          const nextQuery = input.trim();
          setSearchParams(nextQuery.length >= 2 ? { q: nextQuery } : {});
        }}
      >
        <TextInput
          type="search"
          autoFocus
          className="min-w-0 flex-1"
          labelText={uiText("Dokumente durchsuchen", "Search documents")}
          value={input}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
            setInput(event.currentTarget.value);
          }}
          placeholder={uiText(
            "Begriff, Aktenzeichen oder Inhalt",
            "Term, reference number, or content",
          )}
        />
        <Button type="submit" disabled={input.trim().length < 2}>
          {uiText("Suchen", "Search")}
        </Button>
      </Form>

      {!!error && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText(
            "Die Dokumentensuche ist fehlgeschlagen.",
            "Document search failed.",
          )}{" "}
          {error.message}
        </MyCallout>
      )}

      {query.length >= 2 && !error && !results && (
        <Loading
          description={uiText(
            "Dokumente werden gesucht …",
            "Searching documents …",
          )}
        />
      )}

      {query.length < 2 && (
        <Tile className="items-center gap-4 py-10 text-center text-muted">
          <Icons.DocumentAdd aria-hidden="true" />
          <p>
            {uiText(
              "Durchsuche alle PDFs, die du in deinen Projekten öffnen darfst. Eingescannte Dokumente werden automatisch erkannt.",
              "Search every PDF you can open in your projects. Scanned documents are recognized automatically.",
            )}
          </p>
        </Tile>
      )}

      {query.length >= 2 && !error && results?.length === 0 && (
        <Tile role="status" className="py-10 text-center text-muted">
          {uiText(
            "Keine passenden Dokumente gefunden.",
            "No matching documents found.",
          )}
        </Tile>
      )}

      {!!results?.length && (
        <section
          className="documents-search__results gap-3"
          aria-label={uiText("Suchergebnisse", "Search results")}
        >
          <p role="status" className="text-sm text-muted">
            {results.length === 1
              ? uiText("1 Treffer", "1 result")
              : uiText(
                  results.length + " Treffer",
                  results.length + " results",
                )}
          </p>

          {results.map((result) => (
            <article key={result.id} className="documents-search__result">
              <span
                className="documents-search__result-icon"
                aria-hidden="true"
              >
                {result.fileName.toLocaleLowerCase().endsWith(".pdf") ? (
                  <Icons.RegieReport />
                ) : (
                  <Icons.DocumentAdd />
                )}
              </span>

              <div className="documents-search__result-copy">
                <h2 className="text-2xl leading-snug font-semibold">
                  <Link
                    to={
                      "/projects/" +
                      result.projectId +
                      "/files?file=" +
                      result.id
                    }
                  >
                    {result.fileName}
                  </Link>
                </h2>
                <p className="documents-search__metadata">
                  <Link to={"/projects/" + result.projectId}>
                    {result.projectTitle}
                  </Link>
                  <span aria-hidden="true">·</span>
                  <span>{formatDate(result.modifiedAt)}</span>
                </p>

                {!!result.excerpt && (
                  <p className="documents-search__excerpt">
                    {highlightedExcerpt(result.excerpt)}
                  </p>
                )}

                {result.textExtractionStatus === "failed" && (
                  <p className="documents-search__status is-failed">
                    {uiText(
                      "Texterkennung fehlgeschlagen; der Dateiname bleibt durchsuchbar.",
                      "Text recognition failed; the file name remains searchable.",
                    )}
                  </p>
                )}
              </div>
            </article>
          ))}
        </section>
      )}
    </div>
  );
}
