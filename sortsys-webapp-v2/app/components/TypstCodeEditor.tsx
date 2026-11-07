import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { useTheme } from "~/hooks/useTheme";
import { uiText } from "~/lib/i18n";
export type TypstEditorHandle = { insert: (text: string) => void };
export function TypstCodeEditor({
  value,
  onChange,
  onSave,
  editorRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  editorRef?: Ref<TypstEditorHandle>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const editor = useRef<
    import("monaco-editor").editor.IStandaloneCodeEditor | null
  >(null);
  const callbacks = useRef({ onChange, onSave });
  callbacks.current = { onChange, onSave };
  const theme = useTheme();
  useImperativeHandle(
    editorRef,
    () => ({
      insert(text) {
        const current = editor.current,
          selection = current?.getSelection();
        if (current && selection) {
          current.executeEdits("insert-asset", [
            { range: selection, text, forceMoveMarkers: true },
          ]);
          current.focus();
        }
      },
    }),
    [],
  );
  useEffect(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];
    void Promise.all([
      import("monaco-editor"),
      import("monaco-editor/editor/editor.worker.js?worker"),
    ]).then(([monaco, worker]) => {
      if (disposed || !container.current) return;
      const environment = globalThis as typeof globalThis & {
        MonacoEnvironment?: {
          getWorker: (moduleId: string, label: string) => Worker;
        };
      };
      environment.MonacoEnvironment ??= {
        getWorker: () => new worker.default(),
      };
      if (
        !monaco.languages
          .getLanguages()
          .some((language) => language.id === "typst")
      ) {
        monaco.languages.register({ id: "typst" });
        monaco.languages.setMonarchTokensProvider("typst", {
          tokenizer: {
            root: [
              [/\/\/.*$/, "comment"],
              [/"(?:[^"\\]|\\.)*"/, "string"],
              [
                /#(?:let|set|show|if|else|for|import|include|context|return)\b/,
                "keyword",
              ],
              [/#[\w-]+/, "type.identifier"],
              [/\b\d+(?:\.\d+)?(?:pt|mm|cm|in|%|fr)?\b/, "number"],
              [/[{}()[\]]/, "delimiter"],
            ],
          },
        });
        monaco.languages.setLanguageConfiguration("typst", {
          comments: { lineComment: "//", blockComment: ["/*", "*/"] },
          brackets: [
            ["{", "}"],
            ["[", "]"],
            ["(", ")"],
          ],
          autoClosingPairs: [
            { open: "[", close: "]" },
            { open: "(", close: ")" },
            { open: "{", close: "}" },
            { open: '"', close: '"' },
          ],
        });
      }
      const model = monaco.editor.createModel(value, "typst");
      const instance = monaco.editor.create(container.current, {
        model,
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: "JetBrains Mono Variable, monospace",
        fontSize: 14,
        lineHeight: 21,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        ariaLabel: uiText("Typst-Vorlagencode", "Typst template source"),
        theme: theme === "dark" ? "vs-dark" : "vs",
      });
      editor.current = instance;
      cleanups.push(
        () => instance.dispose(),
        () => model.dispose(),
      );
      const changed = instance.onDidChangeModelContent(() =>
        callbacks.current.onChange(model.getValue()),
      );
      cleanups.push(() => changed.dispose());
      instance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        callbacks.current.onSave(),
      );
    });
    return () => {
      disposed = true;
      editor.current = null;
      for (const cleanup of cleanups.reverse()) cleanup();
    };
  }, []);
  useEffect(() => {
    const model = editor.current?.getModel();
    if (model && model.getValue() !== value)
      editor.current?.executeEdits("external-update", [
        { range: model.getFullModelRange(), text: value },
      ]);
  }, [value]);
  useEffect(() => {
    void import("monaco-editor").then((monaco) =>
      monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs"),
    );
  }, [theme]);
  return (
    <div
      ref={container}
      className="h-full min-h-80 w-full min-w-0"
      data-typst-editor
    />
  );
}
