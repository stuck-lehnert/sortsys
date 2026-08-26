import type { Route } from "./+types/docs.$id";
import { useState } from "react";
import { Link } from "react-router";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { ScriptEditor } from "~/components/ScriptEditor";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { getDocArticle, getDocArticleSections, type DocArticle } from "~/lib/docs";
import { Icons } from "~/lib/icons";
import { ScriptConsole, useClientScriptRunner } from "~/lib/clientScriptRuntime";
import { NotFound } from "./_404";

type ScriptExample = NonNullable<DocArticle['scriptExamples']>[number];

function renderDocText(text: string) {
  return text.split(/(<kbd>.*?<\/kbd>)/g).map((part, index) => {
    const match = part.match(/^<kbd>(.*?)<\/kbd>$/);
    if (!match) return part;
    return <kbd key={`${match[1]}-${index}`}>{match[1]}</kbd>;
  });
}

export function meta({ params }: Route.MetaArgs) {
  const article = getDocArticle(params.id);
  return [
    { title: article ? article.title : "Artikel nicht gefunden" },
  ];
}

export default function DocArticlePage({ params }: Route.ComponentProps) {
  const article = getDocArticle(params.id);
  if (!article) return <NotFound reason="pageNotFound" />;

  const sections = getDocArticleSections(article);

  return <div className="docs-page">
    <header className="ss-page-header">
      <div className="ss-page-header__main">
        <div className="docs-entry-category">{article.category}</div>
        <h1 className="ss-page-header__title docs-article-title">{article.title}</h1>
      </div>
    </header>

    <Link to="/docs" className="docs-back-link">Zur Dokumentation</Link>

    <section className="docs-summary" aria-labelledby="docs-summary-heading">
      <h2 id="docs-summary-heading">Kurzfassung</h2>
      <p>{renderDocText(article.lead)}</p>
    </section>

    <nav className="docs-toc" aria-label="Inhaltsverzeichnis">
      <div className="docs-toc-title">Inhalt</div>
      <ol>
        {sections.map((section, index) => <li key={section.heading}>
          <a href={`#section-${index + 1}`}>{section.heading}</a>
        </li>)}
        {!!article.scriptExamples?.length && <li><a href="#docs-script-examples-heading">Ausführbare Beispiele</a></li>}
        {!!article.faqs?.length && <li><a href="#docs-faq-heading">Häufige Fragen</a></li>}
      </ol>
    </nav>

    <div className="docs-article-sections">
      {sections.map((section, index) => <section key={section.heading} className="docs-article-section" aria-labelledby={`section-${index + 1}`}>
        <h2 id={`section-${index + 1}`}>{section.heading}</h2>
        <div className="docs-entry-body docs-article-body">
          {section.paragraphs.map(paragraph => <p key={paragraph}>{renderDocText(paragraph)}</p>)}
        </div>
      </section>)}
    </div>

    {!!article.scriptExamples?.length && <section className="docs-script-examples" aria-labelledby="docs-script-examples-heading">
      <h2 id="docs-script-examples-heading">Ausführbare Beispiele</h2>
      {article.scriptExamples.map(example => <DocScriptExample key={example.title} example={example} />)}
    </section>}

    {!!article.faqs?.length && <section className="docs-faq-section" aria-labelledby="docs-faq-heading">
      <h2 id="docs-faq-heading">Häufige Fragen</h2>
      <div className="docs-faq-list">
        {article.faqs.map(faq => <details key={faq.question} className="docs-faq">
          <summary>{faq.question}</summary>
          <div className="docs-entry-body docs-faq-body">
            {faq.answer.map(paragraph => <p key={paragraph}>{renderDocText(paragraph)}</p>)}
          </div>
        </details>)}
      </div>
    </section>}
  </div>;
}

function DocScriptExample(props: { example: ScriptExample }) {
  const [code, setCode] = useState(props.example.code);
  const [isRunning, runScript, scriptLogs] = useClientScriptRunner();
  const [runResult, setRunResult] = useState<{ ok: boolean; message: string } | null>(null);

  async function runExample() {
    setRunResult(null);
    try {
      const result = await runScript(code);
      if (!result.ok) {
        setRunResult({ ok: false, message: result.error?.message || 'Skript fehlgeschlagen.' });
        return;
      }

      setRunResult({ ok: true, message: 'Beispiel abgeschlossen.' });
    } catch (err) {
      setRunResult({ ok: false, message: (err as Error)?.message || 'Skript fehlgeschlagen.' });
    }
  }

  return <article className="docs-script-example">
    <div className="docs-script-example-head">
      <div>
        <h3>{props.example.title}</h3>
        <p className="light">{props.example.description}</p>
      </div>
      <MyButton size="sm" renderIcon={Icons.Resume} loading={isRunning} disabled={!code.trim()} onClick={runExample}>Ausführen</MyButton>
    </div>

    {!!runResult && (runResult.ok
      ? <AutoHideSuccessCallout resetKey={runResult.message} onHidden={() => setRunResult(null)}>{runResult.message}</AutoHideSuccessCallout>
      : <MyCallout icon={Icons.Deny} color="red">{runResult.message}</MyCallout>)}

    <div className="docs-script-example-editor">
      <ScriptEditor value={code} onChange={setCode} onRun={() => {
        if (isRunning || !code.trim()) return;
        void runExample();
      }} />
    </div>
    <ScriptConsole entries={scriptLogs} />
  </article>;
}
