import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { useMyModals } from "~/hooks/useMyModals";
import { uiText } from "~/lib/i18n";
import { unlockedAccount } from "./crypto/session";

export type ScriptLogEntry = {
  id: number;
  timestamp: Date;
  values: unknown[];
};

function formatLogValue(value: unknown) {
  if (typeof value === 'string') return value;
  if (value instanceof Date) return value.toISOString();
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function logValueType(value: unknown) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'object';
  return typeof value;
}

function renderJsonSyntax(source: string) {
  const nodes: ReactNode[] = [];
  const tokenPattern = /("(?:\\.|[^"\\])*"(?=\s*:)|"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/g;
  let lastIndex = 0;

  for (const match of source.matchAll(tokenPattern)) {
    const token = match[0];
    const index = match.index ?? 0;
    if (index > lastIndex) nodes.push(source.slice(lastIndex, index));

    const tokenType = token.startsWith('"')
      ? source.slice(index + token.length).trimStart().startsWith(':') ? 'key' : 'string'
      : token === 'true' || token === 'false' ? 'boolean'
        : token === 'null' ? 'null'
          : 'number';

    nodes.push(<span key={`${index}-${token}`} data-token={tokenType}>{token}</span>);
    lastIndex = index + token.length;
  }

  if (lastIndex < source.length) nodes.push(source.slice(lastIndex));
  return nodes;
}

function renderLogValue(value: unknown, index: number) {
  const type = logValueType(value);
  const source = formatLogValue(value);
  return <pre key={index} className="script-console-value" data-type={type}>
    {type === 'object' ? renderJsonSyntax(source) : source}
  </pre>;
}

export function useClientScriptRunner() {
  const modals = useMyModals();
  const runningRef = useRef(false);
  const nextLogIdRef = useRef(1);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<ScriptLogEntry[]>([]);

  const clearLogs = useCallback(() => {
    setLogs([]);
    nextLogIdRef.current = 1;
  }, []);

  const appendLog = useCallback((values: unknown[]) => {
    setLogs(current => [...current, {
      id: nextLogIdRef.current++,
      timestamp: new Date(),
      values,
    }]);
  }, []);

  const run = useCallback(async (code: string) => {
    if (runningRef.current) throw new Error(uiText("Es läuft bereits ein Skript."));
    runningRef.current = true;
    setRunning(true);
    clearLogs();
    try {
      const account = unlockedAccount();
      const { runClientScript } = await import("./clientScriptRuntime");
      const result = await runClientScript(modals, code, { account, onLog: appendLog });
      if (result.ok) appendLog(['-- Skript abgeschlossen']);
      return result;
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [appendLog, clearLogs, modals]);

  return [running, run, logs, clearLogs] as const;
}

export function ScriptConsole(props: { entries: ScriptLogEntry[]; resizable?: boolean; defaultHeight?: number }) {
  const [height, setHeight] = useState(props.defaultHeight ?? 220);

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (!props.resizable) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = height;

    const move = (moveEvent: PointerEvent) => {
      const nextHeight = Math.max(96, Math.min(560, startHeight + startY - moveEvent.clientY));
      setHeight(nextHeight);
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
  }

  if (!props.entries.length) return null;

  return <div
    className="script-console"
    data-resizable={props.resizable ? 'true' : undefined}
    style={props.resizable ? { height } : undefined}
    role="log"
    aria-label={uiText("Skript-Konsole", "Script console")}
  >
    {!!props.resizable && <div
      className="script-console-resize-handle"
      role="separator"
      aria-orientation="horizontal"
      aria-label={uiText("Konsolenhöhe ändern", "Resize console")}
      tabIndex={0}
      onPointerDown={startResize}
      onKeyDown={event => {
        if (event.key === 'ArrowUp') setHeight(current => Math.min(560, current + 24));
        if (event.key === 'ArrowDown') setHeight(current => Math.max(96, current - 24));
      }}
    />}
    <div className="script-console-body">
      <div className="script-console-title">{uiText("Konsole", "Console")}</div>
      {props.entries.map(entry => <div key={entry.id} className="script-console-entry">
        <span className="script-console-time">{entry.timestamp.toLocaleTimeString()}</span>
        <div className="script-console-values">{entry.values.map(renderLogValue)}</div>
      </div>)}
    </div>
  </div>;
}
