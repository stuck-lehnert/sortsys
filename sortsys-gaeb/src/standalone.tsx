import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button } from "@sortsys/react-components";
import {
  GaebEditor,
  createGaebXml,
  GAEB_PHASES,
  phaseCanEdit,
  MAX_GAEB_BYTES,
  type GaebPhase,
  gaebDocumentName,
  mergeGaebDocuments,
} from "./index";
import "./standalone.css";
import { text, type GaebLocale } from "./messages";
import { recovery } from "./core/recovery";

type LocalWindow = Window & {
  showOpenFilePicker?: (options: {
    multiple: boolean;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<FileSystemFileHandle[]>;
};
function App() {
  const [locale, setLocale] = useState<GaebLocale>("de");
  const t = (de: string, en: string) => text(locale, de, en);
  const [file, setFile] = useState<{
    name: string;
    xml: string;
    handle?: FileSystemFileHandle;
  } | null>(null);
  const [error, setError] = useState("");
  const [hasRecent, setHasRecent] = useState(false);
  const dirty = useRef(false);
  const editor = useRef<{ save: () => Promise<boolean> }>(null);
  const latestXml = useRef("");
  const originalXml = useRef("");
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    void recovery("get", "standalone-current")
      .then((value) => {
        if (value?.fileName) {
          setHasRecent(true);
          latestXml.current = value.source;
          originalXml.current = value.base;
          setFile({ name: value.fileName, xml: value.source });
        }
      })
      .catch(() => {});
  }, []);
  const input = useRef<HTMLInputElement>(null);
  const leave = async () =>
    !dirty.current || (await editor.current?.save()) === true;
  const load = async (value: File, handle?: FileSystemFileHandle) => {
    if (value.size > MAX_GAEB_BYTES)
      throw new Error(
        t("Die Datei überschreitet 20 MB.", "The file exceeds 20 MB."),
      );
    const diskXml = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(await value.arrayBuffer());
    const previous = !handle
      ? await recovery("get", `standalone-file:${value.name}`).catch(
          () => undefined,
        )
      : undefined;
    const xml = previous
      ? mergeGaebDocuments(previous.base, previous.source, diskXml, value.name)
      : diskXml;
    originalXml.current = diskXml;
    latestXml.current = xml;
    setFile({ name: value.name, xml, handle });
    await recovery("put", "standalone-current", {
      base: diskXml,
      source: xml,
      updatedAt: Date.now(),
      fileName: value.name,
    }).catch(() => {});
    dirty.current = false;
    setHasRecent(true);
    setError("");
  };
  const open = async () => {
    if (!(await leave())) return;
    try {
      const picker = (window as LocalWindow).showOpenFilePicker;
      if (!picker) {
        input.current?.click();
        return;
      }
      const [handle] = await picker.call(window, {
        multiple: false,
        types: [
          {
            description: "GAEB XML",
            accept: {
              "application/xml": [...GAEB_PHASES.map((p) => `.x${p}`), ".xml"],
            },
          },
        ],
      });
      if (handle) await load(await handle.getFile(), handle);
    } catch (failure) {
      if (!(failure instanceof DOMException && failure.name === "AbortError"))
        setError(
          failure instanceof Error
            ? failure.message
            : "Datei konnte nicht geöffnet werden.",
        );
    }
  };
  const create = async (phase: GaebPhase) => {
    if (!(await leave())) return;
    const name = `${gaebDocumentName(phase, locale)}.x${phase}`;
    latestXml.current = createGaebXml(phase, name);
    originalXml.current = latestXml.current;
    setFile({ name, xml: latestXml.current });
    await recovery("put", "standalone-current", {
      base: latestXml.current,
      source: latestXml.current,
      updatedAt: Date.now(),
      fileName: name,
    }).catch(() => {});
    dirty.current = false;
    setHasRecent(true);
    setError("");
  };
  return (
    <div className="gaeb-standalone">
      <nav>
        <strong>sortsys GAEB</strong>
        <Button size="sm" onClick={() => void open()}>
          {t("Datei öffnen", "Open file")}
        </Button>
        {file && (
          <>
            <span>{file.name}</span>
            <Button
              size="sm"
              kind="ghost"
              onClick={async () => {
                if (!(await editor.current?.save())) return;
                const url = URL.createObjectURL(
                  new Blob([latestXml.current], {
                    type: "application/xml;charset=utf-8",
                  }),
                );
                const anchor = document.createElement("a");
                anchor.href = url;
                anchor.download = file.name;
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 30000);
              }}
            >
              {t("Datei herunterladen", "Download file")}
            </Button>
            <Button
              size="sm"
              kind="ghost"
              onClick={async () => {
                if (await leave()) {
                  setFile(null);
                  dirty.current = false;
                }
              }}
            >
              {t("Schließen", "Close")}
            </Button>
          </>
        )}
        <Button
          size="sm"
          kind="ghost"
          onClick={() =>
            setLocale((current) => (current === "de" ? "en" : "de"))
          }
        >
          {locale === "de" ? "English" : "Deutsch"}
        </Button>
        <input
          ref={input}
          type="file"
          hidden
          accept={GAEB_PHASES.map((p) => `.x${p}`).join(",") + ",.xml"}
          onChange={(event) => {
            const value = event.target.files?.[0];
            if (value)
              void load(value).catch((failure) => setError(String(failure)));
            event.target.value = "";
          }}
        />
      </nav>
      {error && <p role="alert">{error}</p>}
      <main>
        {file ? (
          <GaebEditor
            key={file.name + file.xml}
            xml={file.xml}
            fileName={file.name}
            canEdit
            locale={locale}
            editorRef={editor}
            recoveryKey={`standalone-recovery:${file.name}`}
            savedLabel={
              !file.handle
                ? t("Im Browser gespeichert", "Saved in this browser")
                : undefined
            }
            onDirtyChange={(value) => {
              dirty.current = value;
            }}
            onSave={async (xml) => {
              if (file.handle) {
                const writable = await file.handle.createWritable();
                try {
                  await writable.write(xml);
                  await writable.close();
                } catch (failure) {
                  await writable.abort();
                  throw failure;
                }
              }
              await recovery("put", "standalone-current", {
                base: file.handle ? xml : originalXml.current,
                source: xml,
                updatedAt: Date.now(),
                fileName: file.name,
              });
              await recovery("put", `standalone-file:${file.name}`, {
                base: file.handle ? xml : originalXml.current,
                source: xml,
                fileName: file.name,
                updatedAt: Date.now(),
              });
              latestXml.current = xml;
            }}
          />
        ) : (
          <div className="gaeb-standalone-start">
            <h1>
              {t(
                "Direkt im Leistungsverzeichnis arbeiten.",
                "Work directly in your bill of quantities.",
              )}
            </h1>
            <p>
              {t(
                "GAEB-Dateien öffnen, Positionen und Aufmaß bearbeiten und im Originalformat speichern. Die Bearbeitung und Schemaprüfung laufen vollständig in deinem Browser.",
                "Open GAEB files, edit items and measured quantities, and save in the original format. Editing and schema validation run entirely in your browser.",
              )}
            </p>
            <section>
              {hasRecent && (
                <Button
                  kind="ghost"
                  onClick={async () => {
                    const value = await recovery("get", "standalone-current");
                    if (value?.fileName) {
                      originalXml.current = value.base;
                      latestXml.current = value.source;
                      setFile({ name: value.fileName, xml: value.source });
                    }
                  }}
                >
                  {t(
                    "Zuletzt bearbeitetes Dokument öffnen",
                    "Open the last edited document",
                  )}
                </Button>
              )}
              {GAEB_PHASES.filter(phaseCanEdit).map((phase) => (
                <Button key={phase} onClick={() => void create(phase)}>
                  {gaebDocumentName(phase, locale, true)}
                </Button>
              ))}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
