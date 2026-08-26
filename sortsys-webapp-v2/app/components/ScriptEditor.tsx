import { useEffect, useRef } from "react";

let scriptTypeLibsLoaded = false;
let scriptImportCompletionsLoaded = false;

const SCRIPT_IMPORT_MODULES = [
  'sortsys-client',
  'sortsys-popups',
  'sortsys-modal-forms',
  'sortsys-log',
  'sortsys-utils',
] as const;

const SCRIPT_IMPORT_EXPORTS = [
  { symbol: 'client', moduleName: 'sortsys-client' },
  { symbol: 'requireConfirmation', moduleName: 'sortsys-popups' },
  { symbol: 'requireDangerConfirmation', moduleName: 'sortsys-popups' },
  { symbol: 'showModalForm', moduleName: 'sortsys-modal-forms' },
  { symbol: 'log', moduleName: 'sortsys-log' },
  { symbol: 'escapeHtml', moduleName: 'sortsys-utils' },
  { symbol: 'urlEncode', moduleName: 'sortsys-utils' },
  { symbol: 'urlDecode', moduleName: 'sortsys-utils' },
  { symbol: 'toBase64', moduleName: 'sortsys-utils' },
  { symbol: 'fromBase64', moduleName: 'sortsys-utils' },
  { symbol: 'toBase64Url', moduleName: 'sortsys-utils' },
  { symbol: 'fromBase64Url', moduleName: 'sortsys-utils' },
  { symbol: 'utf8Decode', moduleName: 'sortsys-utils' },
  { symbol: 'utf8Encode', moduleName: 'sortsys-utils' },
  { symbol: 'sum', moduleName: 'sortsys-utils' },
  { symbol: 'mean', moduleName: 'sortsys-utils' },
  { symbol: 'median', moduleName: 'sortsys-utils' },
  { symbol: 'min', moduleName: 'sortsys-utils' },
  { symbol: 'max', moduleName: 'sortsys-utils' },
  { symbol: 'clamp', moduleName: 'sortsys-utils' },
  { symbol: 'round', moduleName: 'sortsys-utils' },
  { symbol: 'unique', moduleName: 'sortsys-utils' },
  { symbol: 'chunk', moduleName: 'sortsys-utils' },
  { symbol: 'range', moduleName: 'sortsys-utils' },
  { symbol: 'isBlank', moduleName: 'sortsys-utils' },
  { symbol: 'sleep', moduleName: 'sortsys-utils' },
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function importedNamesFrom(source: string) {
  return source
    .split(',')
    .map(part => part.trim().split(':')[0]?.trim())
    .filter(Boolean);
}

function scriptImportForSymbol(symbol: string) {
  return SCRIPT_IMPORT_EXPORTS.find(entry => entry.symbol === symbol);
}

function missingNameFromMarker(marker: any) {
  const match = String(marker.message ?? '').match(/Cannot find name ['"]([^'"]+)['"]/);
  return match?.[1] ?? null;
}

function importEditForSymbol(monaco: any, model: any, moduleName: string, symbol: string) {
  const modulePattern = escapeRegExp(moduleName);
  const importPattern = new RegExp(`^(\\s*const\\s+\\{\\s*)([^}]*)(\\s*\\}\\s*=\\s*await\\s+import\\(\\s*['"]${modulePattern}['"]\\s*\\)\\s*;?\\s*)$`);
  const anyImportPattern = /^const\s+\{[^}]*\}\s*=\s*await\s+import\(/;
  let insertLine = 1;
  let sawImport = false;

  for (let lineNumber = 1; lineNumber <= model.getLineCount(); lineNumber += 1) {
    const line = model.getLineContent(lineNumber);
    const match = line.match(importPattern);
    if (match) {
      const names = importedNamesFrom(match[2]);
      if (names.includes(symbol)) return [];

      const source = match[2].trim();
      return [{
        range: new monaco.Range(lineNumber, match[1].length + 1, lineNumber, match[1].length + match[2].length + 1),
        text: source ? `${source}, ${symbol}` : symbol,
      }];
    }

    const trimmed = line.trim();
    if (anyImportPattern.test(trimmed)) {
      insertLine = lineNumber + 1;
      sawImport = true;
      continue;
    }

    if (!sawImport && trimmed === '') {
      insertLine = lineNumber + 1;
      continue;
    }

    break;
  }

  return [{
    range: new monaco.Range(insertLine, 1, insertLine, 1),
    text: `const { ${symbol} } = await import('${moduleName}');\n`,
  }];
}

function importEditsOverlapCompletion(importEdits: any[], completionRange: any) {
  return importEdits.some(edit => {
    const range = edit.range;
    if (range.startLineNumber !== completionRange.startLineNumber) return false;
    return range.startColumn <= completionRange.endColumn && range.endColumn >= completionRange.startColumn;
  });
}

const SCRIPT_TYPES = `
declare module "sortsys-client" {
  import type {
    CacheMode,
    MutateInput,
    MutateOutput,
    MutatePath,
    QueryInput,
    QueryOutput,
    QueryPath,
  } from "@sortsys/v2-client";

  type ScriptQueryPath = Exclude<QueryPath, \`admin.\${string}\`>;
  type ScriptMutatePath = Exclude<MutatePath, \`admin.\${string}\`>;
  type ScriptClientError = Error & { message: string };

  export const client: {
    query<PathT extends ScriptQueryPath>(
      path: PathT,
      input: QueryInput<PathT>,
      opts?: { strategy?: CacheMode },
    ): Promise<[QueryOutput<PathT> | null, ScriptClientError | null]>;

    mutate<PathT extends ScriptMutatePath>(
      path: PathT,
      input: MutateInput<PathT>,
      opts?: {},
    ): Promise<[MutateOutput<PathT>, null] | [null, ScriptClientError]>;

    invalidate(pathOrKey: ScriptQueryPath | string): Promise<void>;
    invalidateCascading(pathOrKey: ScriptQueryPath | string): Promise<void>;
  };
}

declare module "sortsys-popups" {
  export type ConfirmationInput = { title: string; content: string; buttonText: string };
  export function requireConfirmation(input: ConfirmationInput): Promise<boolean>;
  export function requireDangerConfirmation(input: ConfirmationInput): Promise<boolean>;
}

declare module "sortsys-log" {
  export function log(...values: unknown[]): Promise<void>;
}

declare module "sortsys-utils" {
  export function escapeHtml(value: unknown): string;
  export function urlEncode(value: unknown): string;
  export function urlDecode(value: string): string;
  export function toBase64(bytes: Uint8Array): string;
  export function fromBase64(value: string): Uint8Array;
  export function toBase64Url(bytes: Uint8Array): string;
  export function fromBase64Url(value: string): Uint8Array;
  export function utf8Decode(bytes: Uint8Array): string;
  export function utf8Encode(value: string): Uint8Array;
  export function sum(...values: number[]): number;
  export function mean(...values: number[]): number;
  export function median(...values: number[]): number;
  export function min(...values: number[]): number;
  export function max(...values: number[]): number;
  export function clamp(value: number, min: number, max: number): number;
  export function round(value: number, decimals?: number): number;
  export function unique<T>(values: Iterable<T> | ArrayLike<T>): T[];
  export function chunk<T>(values: Iterable<T> | ArrayLike<T>, size: number): T[][];
  export function range(end: number): number[];
  export function range(start: number, end: number, step?: number): number[];
  export function isBlank(value: unknown): boolean;
  export function sleep(ms: number): Promise<void>;
}

declare module "sortsys-modal-forms" {
  export type ModalFormOption = string | number | { id?: string | number; value?: unknown; label?: string; name?: string };
  export type ModalFormField = {
    name: string;
    label: string;
    type?: "text" | "textarea" | "number" | "checkbox" | "select" | "multiselect" | "date";
    placeholder?: string;
    required?: boolean;
    initialValue?: unknown;
    options?: ModalFormOption[];
    validate?: (value: unknown, values: Record<string, unknown>) => string | false | null | undefined | Promise<string | false | null | undefined>;
    filterOptions?: (query: string) => ModalFormOption[] | Promise<ModalFormOption[]>;
  };
  export function showModalForm(config: {
    title: string;
    content?: string;
    primaryButtonText?: string;
    fields: ModalFormField[];
    onSubmit?: (values: Record<string, unknown>) => unknown | Promise<unknown>;
  }): Promise<Record<string, unknown> | null>;
}
`;

export function ScriptEditor(props: {
  value: string;
  onChange: (value: string) => void;
  onRun?: () => void;
  readOnly?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<any>(null);
  const modelRef = useRef<any>(null);
  const monacoRef = useRef<any>(null);
  const onRunRef = useRef(props.onRun);

  onRunRef.current = props.onRun;

  useEffect(() => {
    let disposed = false;

    async function start() {
      if (!containerRef.current || typeof window !== 'object') return;

      const [monaco, editorWorker, tsWorker, v2ClientTypes] = await Promise.all([
        import('monaco-editor'),
        import('monaco-editor/esm/vs/editor/editor.worker?worker'),
        import('monaco-editor/esm/vs/language/typescript/ts.worker?worker'),
        import('~/lib/scriptClientTypes.generated').then(module => module.SCRIPT_CLIENT_TYPES),
      ]);
      if (disposed || !containerRef.current) return;

      (window as any).MonacoEnvironment = {
        getWorker(_moduleId: string, label: string) {
          if (label === 'typescript' || label === 'javascript') return new tsWorker.default();
          return new editorWorker.default();
        },
      };

      const tsDefaults = (monaco.languages as any).typescript;
      const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      const theme = () => themeMedia.matches ? 'vs-dark' : 'vs';
      const scriptCompilerOptions = {
        allowJs: true,
        checkJs: true,
        allowNonTsExtensions: true,
        lib: ['es2022'],
        target: tsDefaults.ScriptTarget.Latest,
        module: tsDefaults.ModuleKind.ESNext,
        moduleResolution: tsDefaults.ModuleResolutionKind.NodeJs,
        moduleDetection: tsDefaults.ModuleDetectionKind?.Force ?? 3,
        noEmit: true,
        strict: false,
        noImplicitAny: false,
        skipLibCheck: true,
      };

      monacoRef.current = monaco;
      tsDefaults.typescriptDefaults.setEagerModelSync(true);
      tsDefaults.javascriptDefaults.setEagerModelSync(true);
      tsDefaults.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      tsDefaults.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      tsDefaults.typescriptDefaults.setCompilerOptions(scriptCompilerOptions);
      tsDefaults.javascriptDefaults.setCompilerOptions(scriptCompilerOptions);
      if (!scriptTypeLibsLoaded) {
        tsDefaults.javascriptDefaults.addExtraLib(v2ClientTypes, 'file:///node_modules/@sortsys/v2-client/index.d.ts');
        tsDefaults.javascriptDefaults.addExtraLib(SCRIPT_TYPES, 'file:///sortsys-script-env.d.ts');
        tsDefaults.typescriptDefaults.addExtraLib(v2ClientTypes, 'file:///node_modules/@sortsys/v2-client/index.d.ts');
        tsDefaults.typescriptDefaults.addExtraLib(SCRIPT_TYPES, 'file:///sortsys-script-env.d.ts');
        scriptTypeLibsLoaded = true;
      }
      if (!scriptImportCompletionsLoaded) {
        const createImportCompletionProvider = () => ({
          triggerCharacters: ["'", '"'],
          provideCompletionItems(model: any, position: any) {
            const line = model.getLineContent(position.lineNumber);
            const beforeCursor = line.slice(0, position.column - 1);
            const stringMatch = beforeCursor.match(/\bimport\s*\(\s*(['"])([^'"]*)$/);
            const openMatch = beforeCursor.match(/\bimport\s*\(\s*$/);

            if (stringMatch || openMatch) {
              const prefix = stringMatch?.[2] ?? '';
              const range = stringMatch
                ? new monaco.Range(position.lineNumber, position.column - prefix.length, position.lineNumber, position.column)
                : new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column);

              return {
                suggestions: SCRIPT_IMPORT_MODULES.map(moduleName => ({
                  label: moduleName,
                  kind: monaco.languages.CompletionItemKind.Module,
                  detail: 'Client-Skript-Modul',
                  insertText: stringMatch ? moduleName : `'${moduleName}'`,
                  range,
                })),
              };
            }

            const word = model.getWordUntilPosition(position);
            const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
            const beforeWord = line.slice(0, word.startColumn - 1).trimEnd();
            if (beforeWord.endsWith('.')) return { suggestions: [] };

            return {
              suggestions: SCRIPT_IMPORT_EXPORTS.map(({ symbol, moduleName }) => {
                const importEdits = importEditForSymbol(monaco, model, moduleName, symbol);
                const overlaps = importEditsOverlapCompletion(importEdits, range);

                return {
                  label: symbol,
                  kind: symbol === 'client' ? monaco.languages.CompletionItemKind.Variable : monaco.languages.CompletionItemKind.Function,
                  detail: `Auto-Import aus ${moduleName}`,
                  insertText: overlaps ? `const { ${symbol} } = await import('${moduleName}');\n\n${symbol}` : symbol,
                  additionalTextEdits: overlaps ? undefined : importEdits,
                  range,
                  sortText: `0_${symbol}`,
                };
              }),
            };
          },
        });

        const createImportCodeActionProvider = () => ({
          provideCodeActions(model: any, _range: any, context: any) {
            const actions = (context.markers ?? []).flatMap((marker: any) => {
              const symbol = missingNameFromMarker(marker);
              const entry = symbol ? scriptImportForSymbol(symbol) : null;
              if (!entry) return [];

              const edits = importEditForSymbol(monaco, model, entry.moduleName, entry.symbol);
              if (!edits.length) return [];

              return [{
                title: `Auto-Import ${entry.symbol} aus ${entry.moduleName}`,
                kind: 'quickfix',
                diagnostics: [marker],
                edit: {
                  edits: edits.map(edit => ({
                    resource: model.uri,
                    edit,
                  })),
                },
              }];
            });

            return { actions, dispose() {} };
          },
        });

        monaco.languages.registerCompletionItemProvider('javascript', createImportCompletionProvider());
        monaco.languages.registerCompletionItemProvider('typescript', createImportCompletionProvider());
        monaco.languages.registerCodeActionProvider('javascript', createImportCodeActionProvider());
        monaco.languages.registerCodeActionProvider('typescript', createImportCodeActionProvider());
        scriptImportCompletionsLoaded = true;
      }

      const model = monaco.editor.createModel(
        props.value,
        'javascript',
        monaco.Uri.file(`/sortsys/client-script-${Date.now()}.mjs`),
      );
      modelRef.current = model;

      const editor = monaco.editor.create(containerRef.current, {
        model,
        theme: theme(),
        automaticLayout: true,
        minimap: { enabled: false },
        fontFamily: 'JetBrains Mono Variable, monospace',
        fontSize: 16,
        lineHeight: 24,
        fixedOverflowWidgets: true,
        readOnly: props.readOnly,
        scrollBeyondLastLine: false,
      });
      editorRef.current = editor;

      const handleRunKeyDown = (event: KeyboardEvent) => {
        if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey) || event.altKey || event.shiftKey) return;
        const run = onRunRef.current;
        if (!run) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        run();
      };

      containerRef.current.addEventListener('keydown', handleRunKeyDown, true);

      const updateTheme = () => monaco.editor.setTheme(theme());
      themeMedia.addEventListener('change', updateTheme);

      editor.onDidChangeModelContent(() => props.onChange(editor.getValue()));

      editor.onDidDispose(() => {
        containerRef.current?.removeEventListener('keydown', handleRunKeyDown, true);
        themeMedia.removeEventListener('change', updateTheme);
      });
    }

    void start();

    return () => {
      disposed = true;
      editorRef.current?.dispose?.();
      editorRef.current = null;
      modelRef.current?.dispose?.();
      modelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (editor.getValue() !== props.value) editor.setValue(props.value);
  }, [props.value]);

  useEffect(() => {
    editorRef.current?.updateOptions?.({ readOnly: props.readOnly });
  }, [props.readOnly]);

  return <div ref={containerRef} className="script-editor" />;
}

export function ScriptCodePreview(props: { value: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let disposed = false;

    async function render() {
      if (!containerRef.current || typeof window !== 'object') return;
      const monaco = await import('monaco-editor');
      if (disposed || !containerRef.current) return;

      const themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
      const theme = () => themeMedia.matches ? 'vs-dark' : 'vs';
      monaco.editor.setTheme(theme());

      const html = await monaco.editor.colorize(props.value || ' ', 'javascript', {});
      if (!disposed && containerRef.current) containerRef.current.innerHTML = html;
    }

    void render();

    return () => {
      disposed = true;
    };
  }, [props.value]);

  return <div className="script-code-preview" aria-label="Skriptvorschau">
    <div ref={containerRef} className="script-code-preview-content" />
  </div>;
}
