import { uiText } from "~/lib/i18n";
import { Modal } from "@sortsys/react-components";
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { MyCallout } from "~/components/MyCallout";
import { MyForm, type MyPublicFormContext } from "~/components/MyForm";
import { useMyModals, type MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { sanitizeHtml } from "~/lib/sanitizeHtml";

type SerializedError = {
  name: string;
  message: string;
  stack?: string;
};

type ScriptOption = {
  id: string;
  label: string;
  value?: unknown;
};

type ScriptField = {
  name: string;
  label: string;
  type?: 'text' | 'textarea' | 'number' | 'checkbox' | 'select' | 'multiselect' | 'date';
  placeholder?: string;
  required?: boolean;
  initialValue?: unknown;
  options?: ScriptOption[];
  validateCallbackId?: string;
  filterOptionsCallbackId?: string;
};

type ScriptFormConfig = {
  title?: string;
  content?: string;
  primaryButtonText?: string;
  fields?: ScriptField[];
};

type ScriptRunResult = {
  ok: boolean;
  error?: SerializedError;
};

export type ScriptLogEntry = {
  id: number;
  timestamp: Date;
  values: unknown[];
};

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

const ALLOWED_SCRIPT_IMPORTS = ['sortsys-client', 'sortsys-popups', 'sortsys-modal-forms', 'sortsys-log', 'sortsys-utils'] as const;
const SCRIPT_TIMEOUT_MS = 120_000;

function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message || uiText('Unbekannter Fehler'),
      stack: err.stack,
    };
  }

  return {
    name: 'Error',
    message: `${err ?? uiText('Unbekannter Fehler')}`,
  };
}

function errorFromSerialized(error: SerializedError) {
  const err = new Error(error.message);
  err.name = error.name;
  err.stack = error.stack;
  return err;
}

function createObjectUrl(source: string) {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}

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

function assertAllowedImports(code: string) {
  const allowed = ALLOWED_SCRIPT_IMPORTS.join('|');
  const stripped = code.replace(new RegExp(`\\bimport\\s*\\(\\s*(['"])(?:${allowed})\\1\\s*\\)`, 'g'), '');
  if (/\bimport\s*(?:\(|[\w*{])/.test(stripped) || /(^|\n)\s*export\s+/m.test(stripped)) {
    throw new Error(uiText(`Nur dynamische Imports dieser Module sind erlaubt: ${ALLOWED_SCRIPT_IMPORTS.join(', ')}`, `Only dynamic imports of these modules are allowed: ${ALLOWED_SCRIPT_IMPORTS.join(', ')}`));
  }
}

function replaceAllowedImports(code: string, urls: Record<(typeof ALLOWED_SCRIPT_IMPORTS)[number], string>) {
  return code.replace(/\bimport\s*\(\s*(['"])(sortsys-client|sortsys-popups|sortsys-modal-forms|sortsys-log|sortsys-utils)\1\s*\)/g, (_match, _quote, moduleName) => {
    return `import(${JSON.stringify(urls[moduleName as keyof typeof urls])})`;
  });
}

function createBridgeModuleSources() {
  const clientModule = `
const rpc = globalThis.__sortsysRpc;
export const client = {
  query(path, input, opts) { return rpc('client.query', { path, input, opts }); },
  mutate(path, input, opts) { return rpc('client.mutate', { path, input, opts }); },
  invalidate(path) { return rpc('client.invalidate', { path }); },
  invalidateCascading(path) { return rpc('client.invalidateCascading', { path }); },
  streamQuery() { throw new Error('streamQuery is not available inside client scripts. Use query instead.'); },
  login() { throw new Error('login is not available inside client scripts.'); },
  logout() { throw new Error('logout is not available inside client scripts.'); },
  setToken() { throw new Error('setToken is not available inside client scripts.'); },
  restoreSession() { throw new Error('restoreSession is not available inside client scripts.'); },
};
`;

  const popupsModule = `
const rpc = globalThis.__sortsysRpc;
function normalize(input) {
  input = input && typeof input === 'object' ? input : {};
  return {
    title: String(input.title ?? ${JSON.stringify(uiText('Bestätigung', 'Confirmation'))}),
    content: String(input.content ?? ''),
    buttonText: String(input.buttonText ?? ${JSON.stringify(uiText('Bestätigen', 'Confirm'))}),
  };
}
export function requireConfirmation(input) {
  return rpc('popup.confirm', { ...normalize(input), danger: false });
}
export function requireDangerConfirmation(input) {
  return rpc('popup.confirm', { ...normalize(input), danger: true });
}
`;

  const formsModule = `
const rpc = globalThis.__sortsysRpc;
const registerCallback = globalThis.__sortsysRegisterCallback;
const fieldKeys = new Set(['name', 'label', 'type', 'placeholder', 'required', 'initialValue', 'options']);

function normalizeOption(option, index) {
  if (option && typeof option === 'object') {
    const id = option.id ?? option.value ?? index;
    return {
      id: String(id),
      label: String(option.label ?? option.name ?? id),
      value: option.value ?? option.id ?? option.label ?? option.name ?? id,
    };
  }

  return { id: String(option ?? index), label: String(option ?? ''), value: option };
}

function prepareField(field) {
  const out = {};
  for (const key of fieldKeys) {
    if (field?.[key] !== undefined) out[key] = field[key];
  }
  if (Array.isArray(out.options)) out.options = out.options.map(normalizeOption);
  if (typeof field?.validate === 'function') out.validateCallbackId = registerCallback(field.validate);
  if (typeof field?.filterOptions === 'function') out.filterOptionsCallbackId = registerCallback(async query => {
    const options = await field.filterOptions(query);
    return Array.isArray(options) ? options.map(normalizeOption) : [];
  });
  return out;
}

export async function showModalForm(config) {
  config = config && typeof config === 'object' ? config : {};
  const prepared = {
    title: String(config.title ?? ${JSON.stringify(uiText('Formular', 'Form'))}),
    content: String(config.content ?? ''),
    primaryButtonText: String(config.primaryButtonText ?? ${JSON.stringify(uiText('Speichern', 'Save'))}),
    fields: Array.isArray(config.fields) ? config.fields.map(prepareField) : [],
  };

  const result = await rpc('modalForm.show', prepared);
  if (!result?.confirmed) return null;

  if (typeof config.onSubmit === 'function') {
    return await config.onSubmit(result.values ?? {});
  }

  return result.values ?? {};
}
`;

  const logModule = `
const rpc = globalThis.__sortsysRpc;

function normalizeValue(value) {
  try {
    structuredClone(value);
    return value;
  } catch {
    return String(value);
  }
}

export function log(...values) {
  return rpc('log.write', { values: values.map(normalizeValue) });
}
`;

  const utilsModule = `
const rpc = globalThis.__sortsysRpc;
const htmlEscapes = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const base64Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

function assertBytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected Uint8Array.');
  return value;
}

function toFiniteNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError('Expected finite numbers.');
  return value;
}

function toFiniteNumbers(values) {
  return Array.from(values, toFiniteNumber);
}

function positiveInteger(value) {
  if (!Number.isInteger(value) || value < 1) throw new TypeError('Expected positive integer.');
  return value;
}

function normalizeBase64(value) {
  let clean = String(value).replace(/\\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (clean.length % 4 === 1) throw new TypeError('Invalid base64 string.');
  clean += '='.repeat((4 - clean.length % 4) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || /=/.test(clean.slice(0, -2))) {
    throw new TypeError('Invalid base64 string.');
  }
  return clean;
}

function base64Value(char) {
  const value = base64Alphabet.indexOf(char);
  if (value < 0) throw new TypeError('Invalid base64 string.');
  return value;
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => htmlEscapes[char]);
}

export function urlEncode(value) {
  return encodeURIComponent(String(value));
}

export function urlDecode(value) {
  return decodeURIComponent(String(value));
}

export function utf8Encode(value) {
  return textEncoder.encode(String(value));
}

export function utf8Decode(bytes) {
  return textDecoder.decode(assertBytes(bytes));
}

export function toBase64(bytes) {
  bytes = assertBytes(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += base64Alphabet[a >> 2];
    out += base64Alphabet[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? base64Alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? base64Alphabet[c & 63] : '=';
  }
  return out;
}

export function fromBase64(value) {
  const clean = normalizeBase64(value);
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let outIndex = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c1 = base64Value(clean[i]);
    const c2 = base64Value(clean[i + 1]);
    const c3 = clean[i + 2] === '=' ? 0 : base64Value(clean[i + 2]);
    const c4 = clean[i + 3] === '=' ? 0 : base64Value(clean[i + 3]);
    const n = (c1 << 18) | (c2 << 12) | (c3 << 6) | c4;

    out[outIndex++] = n >> 16;
    if (outIndex < out.length) out[outIndex++] = (n >> 8) & 255;
    if (outIndex < out.length) out[outIndex++] = n & 255;
  }

  return out;
}

export function toBase64Url(bytes) {
  return toBase64(bytes).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
}

export function fromBase64Url(value) {
  return fromBase64(value);
}

export function sum(...values) {
  return toFiniteNumbers(values).reduce((total, value) => total + value, 0);
}

export function mean(...values) {
  const numbers = toFiniteNumbers(values);
  if (numbers.length === 0) throw new TypeError('Expected at least one number.');
  return sum(...numbers) / numbers.length;
}

export function median(...values) {
  const numbers = toFiniteNumbers(values).sort((a, b) => a - b);
  if (numbers.length === 0) throw new TypeError('Expected at least one number.');
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 === 1 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function min(...values) {
  const numbers = toFiniteNumbers(values);
  if (numbers.length === 0) throw new TypeError('Expected at least one number.');
  return Math.min(...numbers);
}

export function max(...values) {
  const numbers = toFiniteNumbers(values);
  if (numbers.length === 0) throw new TypeError('Expected at least one number.');
  return Math.max(...numbers);
}

export function clamp(value, minValue, maxValue) {
  value = toFiniteNumber(value);
  minValue = toFiniteNumber(minValue);
  maxValue = toFiniteNumber(maxValue);
  if (minValue > maxValue) throw new TypeError('Expected min <= max.');
  return Math.min(Math.max(value, minValue), maxValue);
}

export function round(value, decimals = 0) {
  value = toFiniteNumber(value);
  decimals = toFiniteNumber(decimals);
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function unique(values) {
  return Array.from(new Set(Array.from(values ?? [])));
}

export function chunk(values, size) {
  values = Array.from(values ?? []);
  size = positiveInteger(size);
  const out = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function range(start, end, step = 1) {
  start = toFiniteNumber(start);
  if (end === undefined) {
    end = start;
    start = 0;
  } else {
    end = toFiniteNumber(end);
  }
  step = toFiniteNumber(step);
  if (step === 0) throw new TypeError('Expected non-zero step.');
  const out = [];
  if (step > 0) for (let value = start; value < end; value += step) out.push(value);
  else for (let value = start; value > end; value += step) out.push(value);
  return out;
}

export function isBlank(value) {
  return value === null || value === undefined || String(value).trim() === '';
}

export function sleep(ms) {
  ms = toFiniteNumber(ms);
  if (ms < 0) throw new TypeError('Expected non-negative milliseconds.');
  return rpc('utils.sleep', { ms });
}
`;

  return { clientModule, popupsModule, formsModule, logModule, utilsModule };
}

function createWorkerSource(userModuleUrl: string) {
  return `
const pending = new Map();
const callbacks = new Map();
let nextId = 1;

function serializeError(err) {
  if (err instanceof Error) return { name: err.name || 'Error', message: err.message || ${JSON.stringify(uiText('Unbekannter Fehler', 'Unknown error'))}, stack: err.stack };
  return { name: 'Error', message: String(err ?? ${JSON.stringify(uiText('Unbekannter Fehler', 'Unknown error'))}) };
}

function lockGlobal(name) {
  try { Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false }); }
  catch { try { globalThis[name] = undefined; } catch {} }
}

for (const name of [
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Worker', 'SharedWorker',
  'localStorage', 'sessionStorage', 'document', 'window', 'self', 'indexedDB', 'caches',
  'importScripts', 'navigator', 'location', 'history', 'open', 'alert', 'confirm', 'prompt',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'console', 'Function', 'eval',
]) lockGlobal(name);

globalThis.__sortsysRegisterCallback = fn => {
  const id = 'cb_' + nextId++;
  callbacks.set(id, fn);
  return id;
};

globalThis.__sortsysRpc = (kind, payload) => new Promise((resolve, reject) => {
  const id = 'rpc_' + nextId++;
  pending.set(id, { resolve, reject });
  postMessage({ type: 'request', id, kind, payload });
});

onmessage = async event => {
  const message = event.data || {};
  if (message.type === 'response') {
    const current = pending.get(message.id);
    if (!current) return;
    pending.delete(message.id);
    if (message.error) current.reject(Object.assign(new Error(message.error.message), message.error));
    else current.resolve(message.value);
    return;
  }

  if (message.type === 'callback') {
    try {
      const callback = callbacks.get(message.callbackId);
      if (typeof callback !== 'function') throw new Error(${JSON.stringify(uiText('Callback nicht gefunden.', 'Callback not found.'))});
      const value = await callback(...(message.args ?? []));
      postMessage({ type: 'callbackResult', id: message.id, value });
    } catch (err) {
      postMessage({ type: 'callbackResult', id: message.id, error: serializeError(err) });
    }
  }
};

import(${JSON.stringify(userModuleUrl)})
  .then(() => postMessage({ type: 'done' }))
  .catch(error => postMessage({ type: 'error', error: serializeError(error) }));
`;
}

function createUserModuleSource(code: string) {
  return `
const window = undefined;
const document = undefined;
const localStorage = undefined;
const sessionStorage = undefined;
const indexedDB = undefined;
const caches = undefined;
const navigator = undefined;
const location = undefined;
const history = undefined;
const fetch = undefined;
const XMLHttpRequest = undefined;
const WebSocket = undefined;
const Worker = undefined;
const SharedWorker = undefined;
const importScripts = undefined;
const alert = undefined;
const confirm = undefined;
const prompt = undefined;
const setTimeout = undefined;
const clearTimeout = undefined;
const setInterval = undefined;
const clearInterval = undefined;
const queueMicrotask = undefined;
const requestAnimationFrame = undefined;
const cancelAnimationFrame = undefined;
const requestIdleCallback = undefined;
const cancelIdleCallback = undefined;
const console = undefined;

${code}
`;
}

function showScriptConfirmation(modals: MyModalsInterface, input: { title?: string; content?: string; buttonText?: string; danger?: boolean }) {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean, hide: () => void) => {
      if (settled) return;
      settled = true;
      resolve(value);
      hide();
    };

    modals.show(({ visible, hide }) => <Modal
      open={visible}
      modalHeading={input.title || uiText('Bestätigung', 'Confirmation')}
      primaryButtonText={input.buttonText || uiText('Bestätigen', 'Confirm')}
      secondaryButtonText={uiText("Abbrechen")}
      danger={!!input.danger}
      onRequestClose={() => settle(false, hide)}
      onRequestSubmit={() => settle(true, hide)}
    >
      <div className="script-confirmation-content" data-danger={input.danger ? 'true' : undefined}>
        {!!input.danger && <MyCallout icon={Icons.Deny} color="red">{uiText("Gefährliche Aktion. Prüfe die Auswirkungen vor dem Fortfahren.", "Dangerous action. Review the impact before continuing.")}</MyCallout>}
        <div className="script-html-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(input.content ?? '') }} />
      </div>
    </Modal>);
  });
}

function normalizeOptions(value: unknown): ScriptOption[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (entry && typeof entry === 'object') {
      const anyEntry = entry as Record<string, unknown>;
      const id = anyEntry.id ?? anyEntry.value ?? index;
      return {
        id: `${id}`,
        label: `${anyEntry.label ?? anyEntry.name ?? id}`,
        value: anyEntry.value ?? anyEntry.id ?? anyEntry.label ?? anyEntry.name ?? id,
      };
    }

    return { id: `${entry ?? index}`, label: `${entry ?? ''}`, value: entry };
  });
}

function normalizeFormValues(fields: ScriptField[], values: Record<string, unknown>) {
  const normalized = { ...values };
  for (const field of fields) {
    const value = normalized[field.name];
    if ((field.type === 'multiselect' || field.type === 'select') && Array.isArray(value)) {
      normalized[field.name] = value.map(entry => {
        if (entry && typeof entry === 'object') {
          const anyEntry = entry as Record<string, unknown>;
          return anyEntry.value ?? anyEntry.id ?? anyEntry.label ?? anyEntry.name ?? anyEntry;
        }
        return entry;
      });
    }
  }
  return normalized;
}

function fieldInitialValue(field: ScriptField) {
  if (field.initialValue !== undefined) return field.initialValue;
  if (field.type === 'checkbox') return false;
  if (field.type === 'multiselect' || field.type === 'select') return [];
  return '';
}

function ScriptModalForm(props: {
  config: ScriptFormConfig;
  visible: boolean;
  hide: () => void;
  callCallback: (callbackId: string, args: unknown[]) => Promise<unknown>;
  resolve: (value: { confirmed: boolean; values?: Record<string, unknown> }) => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const fields = props.config.fields ?? [];

  const settle = (value: { confirmed: boolean; values?: Record<string, unknown> }) => {
    props.resolve(value);
    props.hide();
  };

  async function validateCallbacks(values: Record<string, unknown>) {
    for (const field of fields) {
      if (!field.validateCallbackId) continue;
      const result = await props.callCallback(field.validateCallbackId, [values[field.name], values]);
      if (typeof result === 'string' && result.trim()) return result.trim();
      if (result === false) return uiText(`${field.label} ist ungültig.`, `${field.label} is invalid.`);
    }
    return null;
  }

  function renderField(field: ScriptField) {
    const type = field.type ?? 'text';
    const requiredRules = field.required ? [MyForm.Input.rules.required] : [];

    if (type === 'checkbox') {
      return <MyForm.Checkbox key={field.name} name={field.name} labelText={field.label} />;
    }

    if (type === 'date') {
      return <MyForm.DateInput
        key={field.name}
        name={field.name}
        labelText={field.label}
        required={!!field.required}
        rules={field.required ? [MyForm.DateInput.rules.required] : []}
      />;
    }

    if (type === 'select' || type === 'multiselect') {
      const staticOptions = normalizeOptions(field.options ?? []);
      return <MyForm.MultiSelect
        key={field.name}
        name={field.name}
        labelText={field.label}
        minSelectedItems={field.required ? 1 : undefined}
        maxSelectedItems={type === 'select' ? 1 : undefined}
        getOptions={async ({ query }) => {
          if (field.filterOptionsCallbackId) {
            return normalizeOptions(await props.callCallback(field.filterOptionsCallbackId, [query]));
          }

          const lowerQuery = query.trim().toLowerCase();
          if (!lowerQuery) return staticOptions;
          return staticOptions.filter(option => option.label.toLowerCase().includes(lowerQuery));
        }}
        renderItem={({ item }) => item.label}
        stringifyItem={({ item }) => item.label}
      />;
    }

    return <MyForm.Input
      key={field.name}
      name={field.name}
      labelText={field.label}
      type={type === 'number' ? 'number' : 'text'}
      textArea={type === 'textarea' ? true : undefined}
      placeholder={field.placeholder}
      required={!!field.required}
      rules={requiredRules}
    />;
  }

  const modalContent = <ScriptModalFormContent
    config={props.config}
    visible={props.visible}
    error={error}
    fields={fields}
    settle={settle}
    renderField={renderField}
  />;

  return <MyForm
    className="p-0 max-w-none"
    notifyLoaded={(context) => context.setValues(Object.fromEntries(fields.map(field => [field.name, fieldInitialValue(field)])))}
    onSubmit={async (context: MyPublicFormContext) => {
      setError(null);
      const values = normalizeFormValues(fields, context.getValues());
      const validationError = await validateCallbacks(values);
      if (validationError) {
        setError(validationError);
        return;
      }

      settle({ confirmed: true, values });
    }}
  >
    {modalContent}
  </MyForm>;
}

function ScriptModalFormContent(props: {
  config: ScriptFormConfig;
  visible: boolean;
  error: string | null;
  fields: ScriptField[];
  settle: (value: { confirmed: boolean; values?: Record<string, unknown> }) => void;
  renderField: (field: ScriptField) => ReactNode;
}) {
  const context = MyForm.$useContext();

  return <Modal
    data-fullheight="true"
    data-fullwidth="true"
    open={props.visible}
    modalHeading={props.config.title || 'Formular'}
    primaryButtonText={props.config.primaryButtonText || uiText('Speichern')}
    secondaryButtonText={uiText("Abbrechen")}
    primaryButtonDisabled={context.loading()}
    onRequestClose={() => props.settle({ confirmed: false })}
    onRequestSubmit={() => context.submit()}
  >
    <div className="space-y-2 my-container">
      {!!props.config.content && <div className="script-html-content" dangerouslySetInnerHTML={{ __html: sanitizeHtml(props.config.content) }} />}
      {!!props.error && <MyCallout icon={Icons.Deny} color="red">{props.error}</MyCallout>}
      {props.fields.map(props.renderField)}
    </div>
  </Modal>;
}

function showScriptModalForm(modals: MyModalsInterface, config: ScriptFormConfig, callCallback: (callbackId: string, args: unknown[]) => Promise<unknown>) {
  return new Promise<{ confirmed: boolean; values?: Record<string, unknown> }>((resolve) => {
    let settled = false;
    const settle = (value: { confirmed: boolean; values?: Record<string, unknown> }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    modals.show(({ visible, hide }) => <ScriptModalForm
      config={config}
      visible={visible}
      hide={hide}
      resolve={settle}
      callCallback={callCallback}
    />);
  });
}

async function handleClientRequest(
  kind: string,
  payload: any,
  modals: MyModalsInterface,
  callCallback: (callbackId: string, args: unknown[]) => Promise<unknown>,
  sleep: (ms: unknown) => Promise<void>,
  onLog?: (values: unknown[]) => void,
) {
  if (kind === 'client.query') return await client.queryDynamic(payload.path, payload.input, payload.opts);
  if (kind === 'client.mutate') return await client.mutateDynamic(payload.path, payload.input, payload.opts);
  if (kind === 'client.invalidate') return await client.invalidate(payload.path);
  if (kind === 'client.invalidateCascading') return await client.invalidateCascading(payload.path);
  if (kind === 'popup.confirm') return await showScriptConfirmation(modals, payload);
  if (kind === 'modalForm.show') return await showScriptModalForm(modals, payload, callCallback);
  if (kind === 'utils.sleep') return await sleep(payload?.ms);
  if (kind === 'log.write') {
    onLog?.(Array.isArray(payload?.values) ? payload.values : []);
    return null;
  }
  throw new Error(`Unbekannte Skript-Anfrage: ${kind}`);
}

export function runClientScript(modals: MyModalsInterface, code: string, onLog?: (values: unknown[]) => void): Promise<ScriptRunResult> {
  assertAllowedImports(code);

  const bridgeSources = createBridgeModuleSources();
  const urls = {
    'sortsys-client': createObjectUrl(bridgeSources.clientModule),
    'sortsys-popups': createObjectUrl(bridgeSources.popupsModule),
    'sortsys-modal-forms': createObjectUrl(bridgeSources.formsModule),
    'sortsys-log': createObjectUrl(bridgeSources.logModule),
    'sortsys-utils': createObjectUrl(bridgeSources.utilsModule),
  };
  const userModuleUrl = createObjectUrl(createUserModuleSource(replaceAllowedImports(code, urls)));
  const workerUrl = createObjectUrl(createWorkerSource(userModuleUrl));
  const worker = new Worker(workerUrl, { type: 'module', name: 'sortsys-client-script' });
  const pendingCallbacks = new Map<string, PendingResolver>();
  const sleepWaiters = new Set<{ timeout: number; resolve: () => void }>();
  let nextCallbackId = 1;
  let active = true;

  const cleanup = () => {
    active = false;
    for (const waiter of sleepWaiters) {
      window.clearTimeout(waiter.timeout);
      waiter.resolve();
    }
    sleepWaiters.clear();
    worker.terminate();
    URL.revokeObjectURL(workerUrl);
    URL.revokeObjectURL(userModuleUrl);
    Object.values(urls).forEach(URL.revokeObjectURL);
  };

  const callCallback = (callbackId: string, args: unknown[]) => new Promise<unknown>((resolve, reject) => {
    const id = `main_cb_${nextCallbackId++}`;
    pendingCallbacks.set(id, { resolve, reject });
    worker.postMessage({ type: 'callback', id, callbackId, args });
  });

  const sleep = (ms: unknown) => {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      return Promise.reject(new Error(uiText("sleep erwartet nicht-negative Millisekunden.")));
    }

    if (ms > SCRIPT_TIMEOUT_MS) {
      return Promise.reject(new Error(uiText(`sleep darf höchstens ${SCRIPT_TIMEOUT_MS} ms dauern.`, `sleep may take at most ${SCRIPT_TIMEOUT_MS} ms.`)));
    }

    return new Promise<void>((resolve) => {
      const waiter = {
        timeout: 0,
        resolve,
      };
      waiter.timeout = window.setTimeout(() => {
        sleepWaiters.delete(waiter);
        resolve();
      }, ms);
      sleepWaiters.add(waiter);
    });
  };

  return new Promise<ScriptRunResult>((resolve) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      resolve({ ok: false, error: { name: 'TimeoutError', message: uiText('Skript wurde nach 120 Sekunden beendet.') } });
    }, SCRIPT_TIMEOUT_MS);

    const finish = (result: ScriptRunResult) => {
      window.clearTimeout(timeout);
      cleanup();
      resolve(result);
    };

    worker.onmessage = async (event) => {
      const message = event.data ?? {};

      if (message.type === 'done') {
        finish({ ok: true });
        return;
      }

      if (message.type === 'error') {
        finish({ ok: false, error: message.error });
        return;
      }

      if (message.type === 'callbackResult') {
        const pending = pendingCallbacks.get(message.id);
        if (!pending) return;
        pendingCallbacks.delete(message.id);
        if (message.error) pending.reject(errorFromSerialized(message.error));
        else pending.resolve(message.value);
        return;
      }

      if (message.type === 'request') {
        try {
          const value = await handleClientRequest(message.kind, message.payload, modals, callCallback, sleep, onLog);
          if (active) worker.postMessage({ type: 'response', id: message.id, value });
        } catch (err) {
          if (active) worker.postMessage({ type: 'response', id: message.id, error: serializeError(err) });
        }
      }
    };

    worker.onerror = (event) => {
      finish({ ok: false, error: { name: 'Error', message: event.message } });
    };
  });
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
      const result = await runClientScript(modals, code, appendLog);
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
