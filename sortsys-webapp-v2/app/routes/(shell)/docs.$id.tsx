import { Accordion } from "@heroui/react";
import { Tile } from "@sortsys/react-components";
import { useState } from "react";
import { Link } from "react-router";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";
import { ScriptEditor } from "~/components/ScriptEditor";
import {
  ScriptConsole,
  useClientScriptRunner,
} from "~/lib/clientScriptRuntime";
import {
  getDocArticle,
  getDocArticleSections,
  type DocArticle,
} from "~/lib/docs";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";
import type { Route } from "./+types/docs.$id";
import { NotFound } from "./_404";

type ScriptExample = NonNullable<DocArticle["scriptExamples"]>[number];

function renderDocText(text: string) {
  const parts = text.split(/(<(?:kbd|code)>.*?<\/(?:kbd|code)>)/g);

  return parts.map((part, index) => {
    const match = part.match(/^<(kbd|code)>(.*?)<\/\1>$/);
    if (!match) {
      return part;
    }

    const [, element, content] = match;
    const key = `${element}-${content}-${index}`;

    return element === "kbd" ? (
      <kbd
        key={key}
        className="rounded-sm border border-separator px-1 text-sm"
      >
        {content}
      </kbd>
    ) : (
      <code
        key={key}
        className="break-words rounded-sm bg-surface-secondary px-1 text-sm"
      >
        {content}
      </code>
    );
  });
}

export function meta({ params }: Route.MetaArgs) {
  const article = getDocArticle(params.id);

  return [{ title: article ? article.title : uiText("Artikel nicht gefunden") }];
}

export default function DocArticlePage({ params }: Route.ComponentProps) {
  const article = getDocArticle(params.id);
  if (!article) {
    return <NotFound reason="pageNotFound" />;
  }

  const sections = getDocArticleSections(article);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <MyHeader title={article.title} subtitle={article.category} />
      <Link
        to="/docs"
        className="link inline-flex min-h-11 items-center self-start"
      >
        {uiText("Zur Dokumentation")}
      </Link>

      <Tile
        role="region"
        aria-labelledby="docs-summary-heading"
        className="gap-3"
      >
        <h2 id="docs-summary-heading" className="text-xl font-semibold">
          {uiText("Kurzfassung")}
        </h2>
        <p className="leading-relaxed">{renderDocText(article.lead)}</p>
      </Tile>

      <Tile>
        <nav aria-label={uiText("Inhaltsverzeichnis")}>
          <h2 className="mb-3 text-lg font-semibold">{uiText("Inhalt")}</h2>
          <ol className="list-inside list-decimal space-y-2">
            {sections.map((section, index) => (
              <li key={section.heading}>
                <a className="link" href={`#section-${index + 1}`}>
                  {section.heading}
                </a>
              </li>
            ))}
            {!!article.scriptExamples?.length && (
              <li>
                <a className="link" href="#docs-script-examples-heading">
                  {uiText("Ausführbare Beispiele")}
                </a>
              </li>
            )}
            {!!article.faqs?.length && (
              <li>
                <a className="link" href="#docs-faq-heading">
                  {uiText("Häufige Fragen")}
                </a>
              </li>
            )}
          </ol>
        </nav>
      </Tile>

      {sections.map((section, index) => (
        <section
          key={section.heading}
          className="space-y-3"
          aria-labelledby={`section-${index + 1}`}
        >
          <h2
            id={`section-${index + 1}`}
            className="scroll-mt-24 text-xl font-semibold"
          >
            {section.heading}
          </h2>
          <div className="space-y-3 leading-relaxed">
            {section.paragraphs.map((paragraph) => (
              <p key={paragraph}>{renderDocText(paragraph)}</p>
            ))}
          </div>
        </section>
      ))}

      {!!article.scriptExamples?.length && (
        <section
          className="space-y-4"
          aria-labelledby="docs-script-examples-heading"
        >
          <h2
            id="docs-script-examples-heading"
            className="scroll-mt-24 text-xl font-semibold"
          >
            {uiText("Ausführbare Beispiele")}
          </h2>
          {article.scriptExamples.map((example) => (
            <DocScriptExample key={example.title} example={example} />
          ))}
        </section>
      )}

      {!!article.faqs?.length && (
        <section className="space-y-4" aria-labelledby="docs-faq-heading">
          <h2
            id="docs-faq-heading"
            className="scroll-mt-24 text-xl font-semibold"
          >
            {uiText("Häufige Fragen")}
          </h2>
          <Accordion allowsMultipleExpanded>
            {article.faqs.map((faq) => (
              <Accordion.Item key={faq.question} id={faq.question}>
                <Accordion.Heading level={3}>
                  <Accordion.Trigger>
                    {renderDocText(faq.question)}
                    <Accordion.Indicator />
                  </Accordion.Trigger>
                </Accordion.Heading>
                <Accordion.Panel>
                  <Accordion.Body className="space-y-3 leading-relaxed">
                    {faq.answer.map((paragraph) => (
                      <p key={paragraph}>{renderDocText(paragraph)}</p>
                    ))}
                  </Accordion.Body>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </section>
      )}
    </div>
  );
}

function DocScriptExample({ example }: { example: ScriptExample }) {
  const [code, setCode] = useState(example.code);
  const [isRunning, runScript, scriptLogs] = useClientScriptRunner();
  const [runResult, setRunResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function runExample() {
    setRunResult(null);

    try {
      const result = await runScript(code);
      if (!result.ok) {
        setRunResult({
          ok: false,
          message: result.error?.message || uiText("Skript fehlgeschlagen.", "Script failed."),
        });
        return;
      }

      setRunResult({
        ok: true,
        message: uiText("Beispiel abgeschlossen.", "Example completed."),
      });
    } catch (error) {
      setRunResult({
        ok: false,
        message: (error as Error)?.message || uiText("Skript fehlgeschlagen.", "Script failed."),
      });
    }
  }

  return (
    <Tile className="gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-48">
          <h3 className="text-lg font-semibold">{example.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-muted">
            {renderDocText(example.description)}
          </p>
        </div>
        <MyButton
          size="sm"
          renderIcon={Icons.Resume}
          loading={isRunning}
          disabled={!code.trim()}
          onClick={runExample}
        >
          {uiText("Ausführen")}
        </MyButton>
      </div>

      {!!runResult &&
        (runResult.ok ? (
          <AutoHideSuccessCallout
            resetKey={runResult.message}
            onHidden={() => setRunResult(null)}
          >
            {runResult.message}
          </AutoHideSuccessCallout>
        ) : (
          <MyCallout icon={Icons.Deny} color="red">
            {runResult.message}
          </MyCallout>
        ))}

      <div className="h-80 min-h-48 overflow-hidden rounded-lg border border-separator">
        <ScriptEditor
          value={code}
          onChange={setCode}
          onRun={() => {
            if (isRunning || !code.trim()) {
              return;
            }

            void runExample();
          }}
        />
      </div>
      <ScriptConsole entries={scriptLogs} />
    </Tile>
  );
}
