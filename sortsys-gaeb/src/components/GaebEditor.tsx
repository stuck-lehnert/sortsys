import { measureShapesForUnit } from "../core/takeoff";
import { TakeoffTools } from "./TakeoffTools";
import { measurementField } from "../core/takeoffLabels";
import { useEventCallback } from "./useEventCallback";
import TrashCan from "@carbon/icons-react/es/TrashCan";
import Keyboard from "@carbon/icons-react/es/Keyboard";
import { macKeyboard } from "../canvas/keyboard";
import {
  DEFAULT_GAEB_VIEW,
  localGaebView,
  type GaebViewPreferences,
} from "../core/viewPreferences";
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@heroui/react";
import { Button, Modal } from "@sortsys/react-components";
import { GaebPositionSearch } from "./GaebPositionSearch";
import { GaebRibbon } from "./GaebRibbon";
import { GaebDocumentSplit } from "./GaebDocumentSplit";
import FolderAdd from "@carbon/icons-react/es/FolderAdd";
import View from "@carbon/icons-react/es/View";
import type { SharedFields, LiveSelection } from "../core/sharedFields";
import {
  rememberPositions,
  searchPositions as searchLocalPositions,
  type GaebPositionSearch as PositionSearch,
  type GaebPositionSuggestion,
} from "../core/positionLibrary";
import { migrateRichDrafts } from "../core/richText";
import { GaebDocument } from "../core/document";
import { validateGaebInBrowser } from "../core/validationClient";
import {
  phaseCanEdit,
  isTradePhase,
  MAX_GAEB_ATTACHMENT_BYTES,
  MAX_GAEB_BYTES,
  type GaebValidation,
} from "../core/types";
import { text, errorText, type GaebLocale } from "../messages";
import { mergeGaebDocuments } from "../core/mergeDocument";
import { recovery } from "../core/recovery";
import { EditorIconButton } from "./EditorIconButton";
import { GaebOutline, type HierarchyPlan } from "./GaebOutline";
import Undo from "@carbon/icons-react/es/Undo";
import Redo from "@carbon/icons-react/es/Redo";
import Printer from "@carbon/icons-react/es/Printer";
import TextBold from "@carbon/icons-react/es/TextBold";
import TextItalic from "@carbon/icons-react/es/TextItalic";
import TextUnderline from "@carbon/icons-react/es/TextUnderline";
import Paragraph from "@carbon/icons-react/es/Paragraph";
import DocumentAdd from "@carbon/icons-react/es/DocumentAdd";
import Attachment from "@carbon/icons-react/es/Attachment";
import AddAlt from "@carbon/icons-react/es/AddAlt";
import TreeView from "@carbon/icons-react/es/TreeView";
import Search from "@carbon/icons-react/es/Search";
import type { Collaborator } from "../canvas/types";
import {
  GaebDocumentCanvas,
  type CanvasFocus,
  type RichSelection,
} from "./GaebDocumentCanvas";

export type GaebEditorProps = {
  searchPositions?: PositionSearch;
  positionLibraryScope?: string;
  xml: string;
  fileName: string;
  locale?: GaebLocale;
  canEdit: boolean;
  onSave: (xml: string, base: string) => Promise<string | void>;
  onSaveError?: (
    error: unknown,
    stage: "drafts" | "validation" | "storage" | "merge",
  ) => void;
  recoveryKey?: string;
  remoteXml?: string;
  referenceXml?: string;
  documentTitle?: string;
  projectTitle?: string;
  headingLabel?: string;
  collaborators?: Collaborator[];
  connectionStatus?: "connecting" | "online" | "offline";
  onActiveField?: (key: string | null) => void;
  sharedFields?: SharedFields;
  onLiveSelection?: (selection: LiveSelection) => void;
  editorRef?: React.Ref<{ save: () => Promise<boolean> }>;
  savedLabel?: string;
  onDirtyChange?: (dirty: boolean) => void;
  viewPreferences?: GaebViewPreferences;
  onViewPreferencesChange?: (preferences: GaebViewPreferences) => void;
  onPrint?: (xml: string, referenceXml?: string) => Promise<void>;
  toolbarActions?: React.ReactNode;
  workflowNotice?: React.ReactNode;
};
type Drafts = Map<string, () => void>;

function selectionStyleActive(
  model: GaebDocument,
  selection: RichSelection | null,
  property: string,
  value: string,
) {
  if (!selection) return false;
  const item = model.entries.find((item) => item.key === selection.entryKey);
  const group = item && model.richGroups(item)[selection.index];
  let leaves = group?.leaves.filter((leaf) =>
    selection.start === selection.end
      ? selection.start >= leaf.start && selection.start <= leaf.end
      : leaf.end > selection.start && leaf.start < selection.end,
  );
  if (selection.start === selection.end) leaves = leaves?.slice(0, 1);
  return (
    !!leaves?.length &&
    leaves.every((leaf) =>
      (leaf.element.getAttribute("style") ?? "").split(";").some((part) => {
        const [key, entry] = part.split(":");
        return key?.trim() === property && entry?.trim() === value;
      }),
    )
  );
}

function downloadAttachment(model: GaebDocument, element: Element) {
  const base64 = model.value(element, "Data").replace(/\s/g, "");
  if (
    base64.length > Math.ceil(MAX_GAEB_ATTACHMENT_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)
  )
    throw new Error("document-too-large");
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  if (bytes.length > MAX_GAEB_ATTACHMENT_BYTES)
    throw new Error("document-too-large");
  const url = URL.createObjectURL(
    new Blob([bytes], { type: "application/octet-stream" }),
  );
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download =
    model.value(element, "Name").replace(/[\\/\u0000-\u001f]/g, "_") ||
    "attachment";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function GaebEditor({
  searchPositions,
  positionLibraryScope = "local",
  xml,
  fileName,
  locale = "de",
  canEdit,
  onSave,
  onSaveError,
  onDirtyChange,
  recoveryKey,
  remoteXml,
  referenceXml,
  documentTitle,
  projectTitle,
  headingLabel,
  collaborators = [],
  connectionStatus,
  onActiveField,
  sharedFields,
  onLiveSelection,
  editorRef,
  savedLabel,
  viewPreferences,
  onViewPreferencesChange,
  onPrint,
  toolbarActions,
  workflowNotice,
}: GaebEditorProps) {
  const useLocalPositionLibrary = !searchPositions;
  const t = (de: string, en: string) => text(locale, de, en);
  const initial = useMemo(() => {
    try {
      return { model: new GaebDocument(xml, fileName), error: null };
    } catch (error) {
      return { model: null, error };
    }
  }, [xml, fileName]);
  useEffect(() => {
    if (useLocalPositionLibrary && initial.model)
      void rememberPositions(positionLibraryScope, initial.model).catch(
        () => {},
      );
  }, [initial, useLocalPositionLibrary, positionLibraryScope]);
  const reference = useMemo(() => {
    try {
      return referenceXml
        ? new GaebDocument(referenceXml, "reference.xml")
        : undefined;
    } catch {
      return undefined;
    }
  }, [referenceXml]);
  const [model, setModel] = useState(initial.model);
  const modelRef = useRef(model);
  const [selected, setSelected] = useState(
    initial.model?.outlineEntries[0]?.key ?? "",
  );
  const lastEditedEntry = useRef<string | undefined>(undefined);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [view, setView] = useState(() => viewPreferences ?? localGaebView());
  const currentView = useRef(view);
  const viewChanged = useRef(onViewPreferencesChange);
  viewChanged.current = onViewPreferencesChange;
  const updateView = useCallback((patch: Partial<GaebViewPreferences>) => {
    const next = { ...currentView.current, ...patch };
    if (JSON.stringify(next) === JSON.stringify(currentView.current)) return;
    currentView.current = next;
    setView(next);
    if (viewChanged.current) viewChanged.current(next);
    else
      try {
        localStorage.setItem("sortsys-gaeb:view", JSON.stringify(next));
      } catch {
        /* Optional standalone preference. */
      }
  }, []);
  useEffect(() => {
    if (
      viewPreferences &&
      JSON.stringify(viewPreferences) !== JSON.stringify(currentView.current)
    ) {
      currentView.current = viewPreferences;
      setView(viewPreferences);
    }
  }, [viewPreferences]);
  const { outlineOpen, showFields } = view;
  const setOutlineOpen = (value: boolean | ((previous: boolean) => boolean)) =>
    updateView({
      outlineOpen:
        typeof value === "function"
          ? value(currentView.current.outlineOpen)
          : value,
    });
  const setShowFields = (value: boolean | ((previous: boolean) => boolean)) =>
    updateView({
      showFields:
        typeof value === "function"
          ? value(currentView.current.showFields)
          : value,
    });
  const outlineCommands = useRef<{
    addTitle: () => void;
    deleteEntry: () => void;
  }>(null);
  const printing = useRef(false);
  const root = useRef<HTMLElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [validation, setValidation] = useState<{
    source: string;
    value: GaebValidation;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [savedSource, setSavedSource] = useState(xml);
  const savedRef = useRef(xml);
  const pendingSave = useRef<Promise<boolean> | null>(null);
  const saveErrorHandler = useRef(onSaveError);
  saveErrorHandler.current = onSaveError;
  const observedRemote = useRef<string | undefined>(undefined);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(!recoveryKey);
  const [restoredDrafts, setRestoredDrafts] = useState<Array<[string, string]>>(
    [],
  );
  const [revision, setRevision] = useState(0);
  const [activeMeasure, setActiveMeasure] = useState<{
    entryKey: string;
    id: string;
  } | null>(null);
  const [focus, setFocus] = useState<CanvasFocus | null>(null);
  const focusSequence = useRef(0);
  const selectionRef = useRef<RichSelection | null>(null);
  const [richSelection, setRichSelection] = useState<RichSelection | null>(
    null,
  );
  const onSelection = useCallback((value: RichSelection | null) => {
    selectionRef.current = value;
    setRichSelection(value);
  }, []);
  const drafts = useRef<Drafts>(new Map()).current;
  const attachmentInput = useRef<HTMLInputElement>(null);
  const savingRef = useRef(false);
  const history = useRef<{ past: string[]; future: string[] }>({
    past: [],
    future: [],
  }).current;
  const lastAction = useRef<"text" | "native">("native");
  useEffect(
    () =>
      sharedFields?.subscribe(() => {
        // Whole-file history must never remove a live edit by another participant.
        history.past = [];
        history.future = [];
      }),
    [sharedFields, history],
  );
  const editable =
    canEdit &&
    recoveryReady &&
    !!model &&
    phaseCanEdit(model.phase) &&
    !model.signed;
  const dirty = !!model && (model.source !== savedSource || drafts.size > 0);
  const draftChanged = useCallback(() => {
    setRevision((value) => value + 1);
    setSaveBlocked(false);
    setSaveFailed(false);
    setError("");
  }, []);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange, revision]);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  const accept = useCallback((next: GaebDocument) => {
    modelRef.current = next;
    setModel(next);
    setError("");
    setSaveFailed(false);
    setSaveBlocked(false);
  }, []);
  const change = useCallback(
    (operation: (current: GaebDocument) => string) => {
      const current = modelRef.current;
      if (!current || !canEdit || current.signed) return;
      const source = operation(current);
      if (source === current.source) return;
      const next = new GaebDocument(source, fileName);
      history.past.push(current.source);
      history.future = [];
      let size = history.past.reduce((sum, entry) => sum + entry.length * 2, 0);
      while (
        history.past.length > 1 &&
        (history.past.length > 25 || size > 40 * 1024 * 1024)
      )
        size -= history.past.shift()!.length * 2;
      if (!drafts.size) lastAction.current = "native";
      accept(next);
    },
    [accept, canEdit, fileName, history],
  );
  const flushDrafts = useCallback(() => {
    for (const commit of [...drafts.values()]) commit();
    draftChanged();
  }, [drafts, draftChanged]);
  const run = (action: () => void) => {
    try {
      flushDrafts();
      action();
      return true;
    } catch (failure) {
      setError(errorText(locale, failure));
      return false;
    }
  };

  useEffect(() => {
    if (!model) return;
    const abort = new AbortController();
    setChecking(true);
    setValidation(null);
    const timeout = setTimeout(() => {
      void validateGaebInBrowser(model.source, model.identity, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted)
            setValidation({ source: model.source, value });
        })
        .catch((failure) => {
          if (!abort.signal.aborted) setError(errorText(locale, failure));
        })
        .finally(() => {
          if (!abort.signal.aborted) setChecking(false);
        });
    }, 350);
    return () => {
      clearTimeout(timeout);
      abort.abort();
    };
  }, [model, locale]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!recoveryReady) return false;
    if (pendingSave.current) return pendingSave.current;
    const task = (async () => {
      let stage: "drafts" | "validation" | "storage" | "merge" = "drafts";
      try {
        flushDrafts();
        if (!modelRef.current) return true;
        if (!canEdit || modelRef.current.signed)
          return modelRef.current.source === savedRef.current;
        savingRef.current = true;
        setSaving(true);
        setSaveFailed(false);
        while (modelRef.current.source !== savedRef.current) {
          const source = modelRef.current.source,
            base = savedRef.current;
          if (recoveryKey)
            await recovery("put", recoveryKey, {
              base,
              source,
              updatedAt: Date.now(),
            }).catch(() => {});
          stage = "validation";
          const result = await validateGaebInBrowser(
            source,
            modelRef.current.identity,
          );
          if (modelRef.current.source === source)
            setValidation({ source, value: result });
          if (!result.valid) throw new Error("autosave-invalid");
          stage = "storage";
          const stored = (await onSave(source, base)) ?? source;
          stage = "merge";
          const latest = modelRef.current.source;
          const merged = mergeGaebDocuments(source, latest, stored, fileName);
          if (merged !== latest) {
            accept(new GaebDocument(merged, fileName));
            history.past = [];
            history.future = [];
          }
          savedRef.current = stored;
          setSavedSource(stored);
          if (useLocalPositionLibrary)
            void rememberPositions(
              positionLibraryScope,
              new GaebDocument(stored, fileName),
            ).catch(() => {});
          // New input may have arrived while the network request was in flight.
          stage = "drafts";
          flushDrafts();
        }
        if (recoveryKey) await recovery("delete", recoveryKey).catch(() => {});
        setError("");
        return true;
      } catch (failure) {
        try {
          saveErrorHandler.current?.(failure, stage);
        } catch {
          /* Diagnostics must not interrupt recovery. */
        }
        const blocked =
          stage === "drafts" ||
          (failure instanceof Error && failure.message === "autosave-invalid");
        setSaveBlocked(blocked);
        setSaveFailed(!blocked);
        setError(errorText(locale, failure));
        return false;
      } finally {
        savingRef.current = false;
        setSaving(false);
      }
    })();
    pendingSave.current = task;
    try {
      return await task;
    } finally {
      pendingSave.current = null;
    }
  }, [
    accept,
    canEdit,
    fileName,
    flushDrafts,
    locale,
    onSave,
    useLocalPositionLibrary,
    positionLibraryScope,
    recoveryKey,
    recoveryReady,
  ]);
  useImperativeHandle(editorRef, () => ({ save }), [save]);
  useEffect(() => {
    if (!recoveryKey || !canEdit) {
      setRecoveryReady(true);
      return;
    }
    let active = true;
    void recovery("get", recoveryKey)
      .then((value) => {
        if (!active || !value) return;
        const restored = mergeGaebDocuments(
          value.base,
          value.source,
          xml,
          fileName,
        );
        setRestoredDrafts(
          migrateRichDrafts(
            new GaebDocument(restored, fileName),
            value.drafts ?? [],
          ),
        );
        if (restored !== xml) accept(new GaebDocument(restored, fileName));
      })
      .catch((failure) => {
        if (active) setError(errorText(locale, failure));
      })
      .finally(() => {
        if (active) setRecoveryReady(true);
      });
    return () => {
      active = false;
    };
  }, [recoveryKey]);
  useEffect(() => {
    if (!recoveryKey || !dirty || !recoveryReady) return;
    const timer = setTimeout(() => {
      const raw = [...drafts].flatMap(([key, commit]) => {
        const value = (commit as (() => void) & { value?: string }).value;
        return value === undefined ? [] : [[key, value] as [string, string]];
      });
      void recovery("put", recoveryKey, {
        base: savedRef.current,
        source: modelRef.current!.source,
        drafts: raw,
        updatedAt: Date.now(),
      }).catch(() => {});
    }, 150);
    return () => clearTimeout(timer);
  }, [recoveryKey, dirty, recoveryReady, revision, model]);
  useEffect(() => {
    if (!dirty || !editable || !recoveryReady || saveBlocked) return;
    const timer = setTimeout(
      () => {
        void save();
      },
      saveFailed ? 5000 : 700,
    );
    return () => clearTimeout(timer);
  }, [
    dirty,
    editable,
    recoveryReady,
    revision,
    model,
    saveFailed,
    saveBlocked,
    save,
  ]);
  useEffect(() => {
    if (
      !remoteXml ||
      remoteXml === observedRemote.current ||
      pendingSave.current
    )
      return;
    observedRemote.current = remoteXml;
    if (remoteXml === savedRef.current) return;
    try {
      flushDrafts();
      const current = modelRef.current!;
      const project = (xml: string) =>
        sharedFields?.project(xml, fileName) ?? xml;
      const merged = mergeGaebDocuments(
        project(savedRef.current),
        project(current.source),
        project(remoteXml),
        fileName,
      );
      accept(new GaebDocument(merged, fileName));
      savedRef.current = remoteXml;
      setSavedSource(remoteXml);
      // Historical whole-file snapshots must never undo a colleague's changes.
      history.past = [];
      history.future = [];
    } catch (failure) {
      setError(errorText(locale, failure));
      setSaveFailed(true);
    }
  }, [remoteXml, saving]);
  useEffect(() => {
    const retry = () => {
      if (modelRef.current?.source !== savedRef.current || drafts.size)
        void save();
    };
    window.addEventListener("online", retry);
    const hidden = () => {
      if (window.document.visibilityState === "hidden") retry();
    };
    window.document.addEventListener("visibilitychange", hidden);
    return () => {
      window.removeEventListener("online", retry);
      window.document.removeEventListener("visibilitychange", hidden);
    };
  }, [save]);
  const moveHistory = useCallback(
    (direction: "undo" | "redo") => {
      if (!canEdit || modelRef.current?.signed) return;
      const liveUndo =
        lastAction.current === "text" && sharedFields?.canUndo(direction);
      if (savingRef.current && !liveUndo) return;
      try {
        flushDrafts();
        if (lastAction.current === "text" && sharedFields?.undo(direction)) {
          history.past = [];
          history.future = [];
          return;
        }
        const from = direction === "undo" ? history.past : history.future;
        const to = direction === "undo" ? history.future : history.past;
        const source = from.pop();
        if (source) {
          to.push(modelRef.current!.source);
          accept(new GaebDocument(source, fileName));
        }
      } catch (failure) {
        setError(errorText(locale, failure));
      }
    },
    [accept, canEdit, fileName, flushDrafts, locale, sharedFields],
  );
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!root.current?.contains(event.target as Node)) return;
      if (
        root.current?.contains(event.target as Node) &&
        (event.ctrlKey || event.metaKey) &&
        !event.altKey
      ) {
        if (
          ["z", "y"].includes(event.key.toLowerCase()) &&
          (event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement) &&
          !event.target.classList.contains("gaeb-canvas-input")
        )
          return;
        if (event.key.toLowerCase() === "y") {
          event.preventDefault();
          moveHistory("redo");
          return;
        }
        if (event.key.toLowerCase() === "z") {
          event.preventDefault();
          moveHistory(event.shiftKey ? "redo" : "undo");
          return;
        }
        if (event.key.toLowerCase() === "f") {
          event.preventDefault();
          setSearchOpen(true);
          requestAnimationFrame(() => searchInput.current?.focus());
          return;
        }
      }
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        event.key.toLowerCase() === "s"
      ) {
        event.preventDefault();
        if (canEdit) void save();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [canEdit, save, moveHistory]);

  const hierarchyEditable =
    editable && !(reference && ["84", "31"].includes(model?.phase ?? ""));
  const outlineHandlers = {
    onPrepare: useEventCallback(() => run(() => {})),
    onSelect: useEventCallback((key: string) => revealEntry(key)),
    onEdit: useEventCallback((key: string) => editEntry(key)),
    onApply: useEventCallback((plan: HierarchyPlan) => applyHierarchy(plan)),
    onAddItem: useEventCallback((parent?: string) => addItem(parent)),
    onClose: useEventCallback(() => {
      setOutlineOpen(false);
      requestAnimationFrame(() =>
        root.current
          ?.querySelector<HTMLElement>("[data-gaeb-outline-toggle]")
          ?.focus(),
      );
    }),
  };
  const insertFromLibrary = useEventCallback(
    (position: GaebPositionSuggestion) => insertPosition(position),
  );
  const positionSearch = useMemo(
    () =>
      hierarchyEditable &&
      ["80", "83", "85", "86", "87", "89", "52", "93", "96"].includes(
        model?.phase ?? "",
      ) ? (
        <GaebPositionSearch
          locale={locale}
          search={
            searchPositions ??
            ((query) => searchLocalPositions(positionLibraryScope, query))
          }
          onSelect={insertFromLibrary}
        />
      ) : undefined,
    [
      hierarchyEditable,
      model?.phase,
      locale,
      searchPositions,
      positionLibraryScope,
      insertFromLibrary,
    ],
  );

  if (!model)
    return (
      <div className="gaeb-empty" role="alert">
        {errorText(locale, initial.error)}
      </div>
    );
  const entry = model.entries.find((item) => item.key === selected);
  const styleActive = (property: string, value: string) =>
    selectionStyleActive(model, richSelection, property, value);
  const requestFocus = (
    key: string,
    offset = 0,
    end?: number,
    direction?: RichSelection["direction"],
    revealOnly = false,
  ) =>
    setFocus({
      key,
      offset,
      end,
      direction,
      revealOnly,
      sequence: ++focusSequence.current,
    });
  const enter = (entryKey: string, index: number, offset: number) =>
    run(() => {
      change((current) => {
        const entry = current.entries.find((item) => item.key === entryKey)!;
        const group = current.richGroups(entry)[index];
        return current.setRichGroupText(
          entry,
          index,
          group.text.slice(0, offset) + "\n" + group.text.slice(offset),
        );
      });
      requestFocus(`${entryKey}:text:${index}`, offset + 1);
    });
  const format = (property: "font-weight" | "font-style" | "text-decoration") =>
    run(() => {
      const target = selectionRef.current;
      if (!target) return;
      const current = modelRef.current!;
      const value =
        property === "font-weight"
          ? "bold"
          : property === "font-style"
            ? "italic"
            : "underline";
      const reset = property === "text-decoration" ? "none" : "normal";
      const active = selectionStyleActive(current, target, property, value);
      change((doc) =>
        doc.formatRichGroup(
          doc.entries.find((item) => item.key === target.entryKey)!,
          target.index,
          target.start,
          target.end,
          property,
          active ? reset : value,
        ),
      );
      requestFocus(
        `${target.entryKey}:text:${target.index}`,
        target.start,
        target.end,
        target.direction,
      );
    });
  const addParagraph = () =>
    run(() => {
      if (!entry) return;
      change((doc) =>
        doc.addParagraph(doc.entries.find((item) => item.key === entry.key)!),
      );
      const current = modelRef.current!;
      const item = current.entries.find((item) => item.key === entry.key)!;
      const groups = current.richGroups(item),
        index = groups.length - 1;
      requestFocus(
        `${entry.key}:text:${index}`,
        groups[index]?.text.length ?? 0,
      );
    });
  const editEntry = (key: string) =>
    run(() => {
      const current = modelRef.current!;
      const target = current.entries.find((item) => item.key === key);
      if (!target) return;
      setSelected(key);
      const group = current.richGroups(target)[0];
      if (group) requestFocus(`${key}:text:0`, 0, group.text.length);
      else if (target.kind === "item") requestFocus(`${key}:Qty`);
    });
  const revealEntry = (key: string) => {
    setSelected(key);
    const current = modelRef.current!;
    const target = current.entries.find((item) => item.key === key);
    const group = target && current.richGroups(target)[0];
    requestFocus(
      target && (group || target.kind === "item")
        ? `${key}:${group ? "text:0" : "Qty"}`
        : "",
      0,
      0,
      undefined,
      true,
    );
  };
  const clearFocus = () => {
    root.current?.focus({ preventScroll: true });
    setSelected("");
    requestFocus("", 0, 0, undefined, true);
  };
  const applyHierarchy = (plan: HierarchyPlan) =>
    run(() => {
      if (modelRef.current!.source !== plan.base)
        throw new Error("hierarchy-stale");
      let source = plan.source;
      if (plan.title && plan.selected) {
        const next = new GaebDocument(source, fileName);
        const entry = next.entries.find((item) => item.key === plan.selected)!;
        const previous = next.richGroups(entry)[0]?.text ?? "";
        const newline = previous.indexOf("\n");
        source = next.setRichGroupText(
          entry,
          0,
          plan.title + (newline < 0 ? "" : previous.slice(newline)),
        );
      }
      change(() => source);
      const current = modelRef.current!;
      const target = current.entries.find((item) => item.key === plan.selected);
      setSelected(target?.key ?? "");
      if (target && plan.edit) {
        const group = current.richGroups(target)[0];
        if (group) requestFocus(`${target.key}:text:0`, group.text.length);
        else if (target.kind === "item") requestFocus(`${target.key}:Qty`);
      } else revealEntry(target?.key ?? "");
    });
  const insertPosition = (position: GaebPositionSuggestion) =>
    run(() => {
      const current = modelRef.current!;
      const chosen =
        current.entries.find(
          (entry) => entry.key === lastEditedEntry.current,
        ) ?? current.entries.find((entry) => entry.key === selected);
      const parent =
        chosen?.kind === "item" ? current.outlineParent(chosen) : chosen;
      let next = new GaebDocument(
        current.addPosition(parent, position),
        fileName,
      );
      const added = next.items.find(
        (entry) => !current.items.some((old) => old.key === entry.key),
      );
      const siblings = current.outlineChildren(parent);
      const before =
        chosen?.kind === "item"
          ? siblings[
              siblings.findIndex((entry) => entry.key === chosen.key) + 1
            ]
          : undefined;
      if (added && before)
        next = new GaebDocument(
          next.moveEntry(
            added,
            parent && next.entries.find((entry) => entry.key === parent.key),
            next.entries.find((entry) => entry.key === before.key),
          ),
          fileName,
        );
      change(() => next.source);
      if (added) {
        lastEditedEntry.current = added.key;
        setSelected(added.key);
        requestFocus(`${added.key}:Qty`);
      }
    });
  const addItem = (parentKey?: string) =>
    run(() => {
      const current = modelRef.current!;
      const selectedEntry = current.entries.find(
        (item) => item.key === (parentKey ?? selected),
      );
      const owner =
        selectedEntry?.kind === "item"
          ? current.outlineParent(selectedEntry)
          : selectedEntry;
      const previous = new Set(
        current.items.map((item) => item.element.getAttribute("ID")),
      );
      let source = current.addItemInCategory(
        owner,
        t("Leistungen", "Work items"),
      );
      if (selectedEntry?.kind === "item") {
        const siblings = current.outlineChildren(owner);
        const before =
          siblings[
            siblings.findIndex((item) => item.key === selectedEntry.key) + 1
          ];
        if (before) {
          const next = new GaebDocument(source, fileName);
          const added = next.items.find(
            (item) => !previous.has(item.element.getAttribute("ID")),
          )!;
          source = next.moveEntry(
            added,
            owner && next.entries.find((item) => item.key === owner.key),
            next.entries.find((item) => item.key === before.key),
            t("Leistungen", "Work items"),
          );
        }
      }
      change(() => source);
      const added = modelRef.current!.items.find(
        (item) => !previous.has(item.element.getAttribute("ID")),
      );
      if (added) {
        setSelected(added.key);
        requestFocus(
          `${added.key}:${model.phase === "31" ? "Qty" : model.phase === "84" ? "Qty" : "text:0"}`,
        );
      }
    });
  const printDocument = async () => {
    if (printing.current) return;
    printing.current = true;
    try {
      flushDrafts();
      const current = modelRef.current!;
      if (onPrint) await onPrint(current.source, reference?.source);
      else {
        const { downloadGaebPdf } = await import("../core/print");
        await downloadGaebPdf(
          current.source,
          fileName,
          locale,
          reference?.source,
        );
      }
    } catch (failure) {
      setError(errorText(locale, failure));
    } finally {
      printing.current = false;
    }
  };
  return (
    <section
      ref={root}
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing || !(event.ctrlKey || event.metaKey))
          return;
        const target = event.target as HTMLElement;
        const ordinaryInput =
          target.matches("input, textarea") &&
          !target.classList.contains("gaeb-canvas-input");
        if (event.key.toLowerCase() === "p" && !event.altKey) {
          event.preventDefault();
          event.stopPropagation();
          void printDocument();
          return;
        }
        if (
          !ordinaryInput &&
          model.phase === "31" &&
          editable &&
          event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          ["q", "w"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          event.stopPropagation();
          const direction = event.key.toLowerCase() === "q" ? -1 : 1;
          let targetKey: string | undefined;
          run(() =>
            change((doc) => {
              const target =
                doc.items.find((item) => item.key === selected) ?? doc.items[0];
              if (!target) return doc.source;
              const state = doc.takeoff(target);
              if (
                state.headings.some((row) => row.value.id === activeMeasure?.id)
              )
                return doc.source;
              const current =
                state.rows.find((row) => row.value.id === activeMeasure?.id) ??
                state.rows[0];
              if (!current) return doc.source;
              const contextual =
                reference?.items.find(
                  (item) =>
                    item.element.getAttribute("ID") ===
                    target.element.getAttribute("ID"),
                ) ?? reference?.items.find((item) => item.oz === target.oz);
              const unit =
                doc.value(target.element, "QU") ||
                (contextual && reference?.value(contextual.element, "QU")) ||
                "";
              const shapes = measureShapesForUnit(unit, current.value.shape);
              const shape =
                shapes[
                  (shapes.indexOf(current.value.shape) +
                    direction +
                    shapes.length) %
                    shapes.length
                ];
              targetKey = `${target.key}:measure:${current.value.id}:count`;
              return doc.setMeasurement(target, current.value.id, {
                shape,
                ...(current.value.mode === "opening" &&
                !["area", "triangle", "trapezoid", "factor"].includes(shape)
                  ? { mode: "deduct" as const }
                  : {}),
              });
            }),
          );
          if (targetKey) requestFocus(targetKey, 0);
          return;
        }
        if (ordinaryInput) return;
        if (
          model.phase === "31" &&
          ((event.key === "Enter" && !event.altKey) ||
            (event.key === "Backspace" && event.altKey))
        ) {
          event.preventDefault();
          event.stopPropagation();
          const label =
            event.key === "Backspace"
              ? activeMeasure &&
                entry?.kind === "item" &&
                model
                  .takeoff(entry)
                  .headings.some((row) => row.value.id === activeMeasure.id)
                ? t("Zwischenüberschrift löschen", "Delete measurement heading")
                : t("Maßansatz löschen", "Delete measurement")
              : event.shiftKey
                ? t("Maßansatz duplizieren", "Duplicate measurement")
                : t("Maßansatz hinzufügen", "Add measurement");
          root.current
            ?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
            ?.click();
          return;
        }
        if (event.key === "Enter" && !event.altKey && hierarchyEditable) {
          event.preventDefault();
          event.stopPropagation();
          if (event.shiftKey) {
            setOutlineOpen(true);
            requestAnimationFrame(() => outlineCommands.current?.addTitle());
          } else addItem();
        }
        if (event.key === "Backspace" && event.altKey && hierarchyEditable) {
          event.preventDefault();
          event.stopPropagation();
          setOutlineOpen(true);
          requestAnimationFrame(() => outlineCommands.current?.deleteEntry());
        }
      }}
      className="gaeb-editor"
      data-save-state={
        saveBlocked
          ? "invalid"
          : saveFailed
            ? "error"
            : saving || dirty
              ? "saving"
              : "saved"
      }
      data-schema-state={
        saveBlocked && drafts.size
          ? "pending"
          : checking
            ? "pending"
            : validation?.source === model.source
              ? validation.value.valid
                ? "valid"
                : "invalid"
              : "pending"
      }
      aria-label={t("GAEB-Editor", "GAEB editor")}
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (
          event.button !== 0 ||
          !(event.target instanceof Element) ||
          !event.target.matches(
            ".gaeb-editor, .gaeb-document-body, .gaeb-document-workspace, .gaeb-document-scroll, .gaeb-document-paper, .gaeb-canvas-tile, .gaeb-outline, .gaeb-outline-tree, .gaeb-outline-empty, .gaeb-outline-heading, .gaeb-outline-heading-tools, .gaeb-toolbar, .gaeb-actions, .gaeb-document-zoom",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        clearFocus();
      }}
    >
      <GaebRibbon
        locale={locale}
        measurementMode={model.phase === "31"}
        collapsed={view.ribbonCollapsed}
        onCollapsedChange={(value) => updateView({ ribbonCollapsed: value })}
        workflow={toolbarActions}
        history={
          <>
            <EditorIconButton
              showLabel
              disabled={
                !editable ||
                (!history.past.length &&
                  !drafts.size &&
                  !sharedFields?.canUndo("undo")) ||
                (saving && !sharedFields?.canUndo("undo"))
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveHistory("undo")}
              label={t("Rückgängig", "Undo")}
              icon={Undo}
              shortcut="Control+z"
            />
            <EditorIconButton
              showLabel
              disabled={
                !editable ||
                (!history.future.length && !sharedFields?.canUndo("redo")) ||
                (saving && !sharedFields?.canUndo("redo"))
              }
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => moveHistory("redo")}
              label={t("Wiederholen", "Redo")}
              icon={Redo}
              shortcut="Control+Shift+z"
            />
          </>
        }
        formatting={
          <>
            <EditorIconButton
              disabled={!editable || !richSelection}
              onMouseDown={(event: React.MouseEvent<HTMLElement>) =>
                event.preventDefault()
              }
              onClick={() => format("font-weight")}
              label={t("Fett", "Bold")}
              icon={TextBold}
              shortcut="Control+b"
              aria-pressed={styleActive("font-weight", "bold")}
            />
            <EditorIconButton
              disabled={!editable || !richSelection}
              onMouseDown={(event: React.MouseEvent<HTMLElement>) =>
                event.preventDefault()
              }
              onClick={() => format("font-style")}
              label={t("Kursiv", "Italic")}
              icon={TextItalic}
              shortcut="Control+i"
              aria-pressed={styleActive("font-style", "italic")}
            />
            <EditorIconButton
              disabled={!editable || !richSelection}
              onMouseDown={(event: React.MouseEvent<HTMLElement>) =>
                event.preventDefault()
              }
              onClick={() => format("text-decoration")}
              label={t("Unterstreichen", "Underline")}
              icon={TextUnderline}
              shortcut="Control+u"
              aria-pressed={styleActive("text-decoration", "underline")}
            />
          </>
        }
        paragraph={
          <EditorIconButton
            showLabel
            disabled={
              !editable ||
              !entry ||
              model.phase === "31" ||
              (model.phase === "84" && entry.kind === "category")
            }
            onMouseDown={(event: React.MouseEvent<HTMLElement>) =>
              event.preventDefault()
            }
            onClick={addParagraph}
            label={t("Absatz hinzufügen", "Add paragraph")}
            icon={Paragraph}
          />
        }
        position={
          <EditorIconButton
            showLabel
            disabled={!hierarchyEditable}
            onClick={() => addItem()}
            label={t("Position hinzufügen", "Add item")}
            icon={DocumentAdd}
            shortcut="Control+Enter Meta+Enter"
          />
        }
        section={
          <EditorIconButton
            showLabel
            label={t("Titel hinzufügen", "Add section")}
            icon={FolderAdd}
            shortcut="Control+Shift+Enter Meta+Shift+Enter"
            disabled={!hierarchyEditable || isTradePhase(model.phase)}
            onClick={() => {
              setOutlineOpen(true);
              requestAnimationFrame(() => outlineCommands.current?.addTitle());
            }}
          />
        }
        navigation={
          <EditorIconButton
            showLabel
            label={t("Gliederung", "Hierarchy")}
            icon={TreeView}
            data-gaeb-outline-toggle
            aria-expanded={outlineOpen}
            onClick={() => setOutlineOpen((value) => !value)}
          />
        }
        fields={
          <>
            <EditorIconButton
              showLabel
              label={t("Eingabefelder anzeigen", "Show editable fields")}
              icon={View}
              aria-pressed={showFields}
              onClick={() => setShowFields((value) => !value)}
            />
            <EditorIconButton
              showLabel
              label={t("Tastenkürzel", "Keyboard shortcuts")}
              icon={Keyboard}
              onClick={() => setShortcutsOpen(true)}
            />
          </>
        }
        attachments={
          model.attachmentElements().length ? (
            <>
              {model.attachmentElements().map((attachment, index) => (
                <Button
                  key={index}
                  size="sm"
                  kind="ghost"
                  onClick={() => {
                    try {
                      downloadAttachment(model, attachment);
                    } catch (failure) {
                      setError(errorText(locale, failure));
                    }
                  }}
                >
                  {model.value(attachment, "Name") ||
                    `${t("Anlage", "Attachment")} ${index + 1}`}
                </Button>
              ))}
            </>
          ) : undefined
        }
        quick={
          <>
            {(!canEdit || model.signed) && (
              <span className="gaeb-ribbon-note">
                {t("Nur lesen", "Read only")}
              </span>
            )}
            <EditorIconButton
              label={t("Im Dokument suchen", "Search document")}
              icon={Search}
              shortcut="Control+f"
              aria-expanded={searchOpen}
              data-gaeb-search
              onClick={() => {
                setSearchOpen((value) => !value);
                requestAnimationFrame(() => searchInput.current?.focus());
              }}
            />
            <EditorIconButton
              onClick={() => void printDocument()}
              shortcut="Control+p Meta+p"
              label={t("Drucken", "Print")}
              icon={Printer}
            />
          </>
        }
        takeoff={
          model.phase === "52" ? (
            <>
              <EditorIconButton
                showLabel
                icon={AddAlt}
                label={t("Kostenansatz hinzufügen", "Add cost component")}
                disabled={!editable || entry?.kind !== "item"}
                onClick={() =>
                  run(() => {
                    if (entry)
                      change((doc) =>
                        doc.addCostApproach(
                          doc.entries.find((e) => e.key === entry.key)!,
                        ),
                      );
                  })
                }
              />
              <EditorIconButton
                showLabel
                icon={TrashCan}
                label={t(
                  "Letzten Kostenansatz löschen",
                  "Delete last cost component",
                )}
                disabled={
                  !editable ||
                  entry?.kind !== "item" ||
                  !model.costApproaches(entry).length
                }
                onClick={() =>
                  run(() => {
                    if (entry)
                      change((doc) =>
                        doc.removeCostApproach(
                          doc.entries.find((e) => e.key === entry.key)!,
                        ),
                      );
                  })
                }
              />
            </>
          ) : model.phase === "31" ? (
            <>
              <TakeoffTools
                document={model}
                reference={reference}
                entry={
                  entry?.kind === "item"
                    ? entry
                    : (model.items.find(
                        (item) =>
                          !entry ||
                          model.parentCategory(item)?.key === entry.key,
                      ) ?? model.items[0])
                }
                activeId={
                  activeMeasure?.entryKey === selected
                    ? activeMeasure.id
                    : undefined
                }
                editable={editable}
                locale={locale}
                run={run}
                change={change}
                focus={(entryKey, id, key) => {
                  setSelected(entryKey);
                  setActiveMeasure({ entryKey, id });
                  requestFocus(
                    key,
                    0,
                    key.includes(":heading:")
                      ? modelRef.current
                          ?.takeoff(
                            modelRef.current.entries.find(
                              (item) => item.key === entryKey,
                            )!,
                          )
                          .headings.find((row) => row.value.id === id)?.value
                          .title.length
                      : undefined,
                  );
                }}
              />
              {model.date === "2023-01" && (
                <EditorIconButton
                  showLabel
                  disabled={!editable}
                  onClick={() => attachmentInput.current?.click()}
                  label={t("Anlage hinzufügen", "Add attachment")}
                  icon={Attachment}
                />
              )}
            </>
          ) : undefined
        }
        presence={
          <div
            className="gaeb-presence"
            role="group"
            aria-label={t("Gemeinsam im Dokument", "Together in this document")}
          >
            {collaborators.slice(0, 3).map((person) => (
              <span
                key={person.id}
                className="gaeb-presence-person"
                role="img"
                title={person.name}
                aria-label={person.name}
                style={
                  { "--presence-color": person.color } as React.CSSProperties
                }
              >
                {person.name
                  .split(/\s+/)
                  .map((part) => part[0])
                  .slice(0, 2)
                  .join("")}
              </span>
            ))}
            {collaborators.length > 3 && (
              <span
                className="gaeb-presence-person"
                role="img"
                aria-label={t("Weitere Personen", "More participants")}
                title={collaborators
                  .slice(3)
                  .map((person) => person.name)
                  .join(", ")}
              >
                +{collaborators.length - 3}
              </span>
            )}
          </div>
        }
      />
      {searchOpen && (
        <div className="gaeb-search-row" role="search">
          <Input
            ref={searchInput}
            className="gaeb-document-search w-full min-w-0 shadow-none"
            aria-label={t("Im Dokument suchen", "Search document")}
            placeholder={t("Im Dokument suchen", "Search document")}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setSearchOpen(false);
                root.current
                  ?.querySelector<HTMLButtonElement>("[data-gaeb-search]")
                  ?.focus();
              }
            }}
          />
        </div>
      )}
      {(saveBlocked || saveFailed || connectionStatus === "offline") && (
        <div className="gaeb-status" role="status">
          {saveBlocked
            ? t("Speichern wartet auf Korrektur", "Saving waits for correction")
            : saveFailed
              ? t(
                  "Speichern fehlgeschlagen – erneuter Versuch folgt",
                  "Save failed — retrying automatically",
                )
              : t(
                  "Verbindung unterbrochen – Änderungen bleiben hier erhalten",
                  "Connection lost — changes are retained here",
                )}
        </div>
      )}
      {error && (
        <div role="alert" className="gaeb-message gaeb-error">
          {error}
          {dirty && (
            <Button
              size="sm"
              kind="ghost"
              onClick={() => {
                const url = URL.createObjectURL(
                  new Blob([modelRef.current!.source], {
                    type: "application/xml",
                  }),
                );
                const anchor = window.document.createElement("a");
                anchor.href = url;
                anchor.download = fileName;
                anchor.click();
                setTimeout(() => URL.revokeObjectURL(url), 30_000);
              }}
            >
              {t("Arbeitsstand sichern", "Save working copy")}
            </Button>
          )}
        </div>
      )}
      {model.extensionMismatch && (
        <div className="gaeb-message">
          {t(
            "Die Dateiendung passt nicht zur Phase im Dokument. Maßgeblich ist der Header.",
            "The extension differs from the document phase. The header determines the phase.",
          )}
        </div>
      )}
      {model.signed && (
        <div className="gaeb-message">
          {t(
            "Dieses Dokument ist signiert und wird schreibgeschützt geöffnet.",
            "This document is signed and opens read only.",
          )}
        </div>
      )}
      {validation && !validation.value.valid && (
        <details className="gaeb-validation" open={!!error}>
          <summary>
            {t("Prüfmeldungen", "Validation issues")} (
            {validation.value.issues.length})
          </summary>
          <ul>
            {validation.value.issues.map((issue, index) => (
              <li key={index}>
                {issue.line ? `${t("Zeile", "Line")} ${issue.line}: ` : ""}
                {issue.message === "schema-unavailable"
                  ? errorText(locale, new Error(issue.message))
                  : issue.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      {workflowNotice}
      <GaebDocumentSplit
        locale={locale}
        initialWidth={view.outlineWidth}
        onWidthChange={(width) => updateView({ outlineWidth: width })}
        outline={
          outlineOpen ? (
            <GaebOutline
              commandRef={outlineCommands}
              model={model}
              positionSearch={positionSearch}
              reference={reference}
              locale={locale}
              selected={selected}
              editable={hierarchyEditable}
              documentEditable={editable}
              namesEditable={[
                "80",
                "83",
                "85",
                "86",
                "87",
                "89",
                "52",
                "93",
                "96",
              ].includes(model.phase)}
              {...outlineHandlers}
            />
          ) : undefined
        }
      >
        <GaebDocumentCanvas
          document={model}
          showFields={showFields}
          initialZoom={view.zoom}
          onZoomChange={(zoom) => updateView({ zoom })}
          reference={reference}
          documentTitle={documentTitle}
          projectTitle={projectTitle}
          headingLabel={headingLabel}
          locale={locale}
          editable={editable}
          drafts={drafts}
          revision={revision}
          onDraftChange={draftChanged}
          onLocalTextEdit={() => {
            lastAction.current = "text";
          }}
          onChange={change}
          onEntry={setSelected}
          sharedFields={sharedFields}
          onLiveSelection={onLiveSelection}
          onClearFocus={clearFocus}
          onSelection={onSelection}
          onEnter={enter}
          onFormat={format}
          onError={setError}
          focus={focus}
          search={search}
          collaborators={collaborators}
          onActiveField={(key) => {
            if (key) {
              const entry = modelRef.current?.entries.find((entry) =>
                key.startsWith(`${entry.key}:`),
              );
              if (entry?.kind === "item") {
                lastEditedEntry.current = entry.key;
                const measure = measurementField(key, entry.key);
                const headingId = key.startsWith(`${entry.key}:heading:`)
                  ? key.slice(entry.key.length + 9)
                  : undefined;
                if (headingId)
                  setActiveMeasure({ entryKey: entry.key, id: headingId });
                if (measure)
                  setActiveMeasure((current) =>
                    current?.entryKey === entry.key && current.id === measure.id
                      ? current
                      : { entryKey: entry.key, id: measure.id },
                  );
              }
            }
            onActiveField?.(key);
          }}
          restoredDrafts={restoredDrafts}
        />
      </GaebDocumentSplit>
      <Modal
        open={shortcutsOpen}
        passiveModal
        modalHeading={t("Tastenkürzel", "Keyboard shortcuts")}
        closeButtonLabel={t("Schließen", "Close")}
        onRequestClose={() => setShortcutsOpen(false)}
      >
        <table className="w-full text-sm">
          <tbody>
            {[
              [
                model.phase === "31"
                  ? t("Maßansatz hinzufügen", "Add measurement")
                  : t("Neue Position", "New item"),
                "Enter",
              ],
              [
                model.phase === "31"
                  ? t("Maßansatz duplizieren", "Duplicate measurement")
                  : t("Neue Gruppe", "New section"),
                "Shift+Enter",
              ],
              [
                model.phase === "31"
                  ? t("Maßansatz löschen", "Delete measurement")
                  : t("Position oder Gruppe löschen", "Delete item or section"),
                `${macKeyboard() ? "Option" : "Alt"}+Backspace`,
              ],
              [t("Rückgängig", "Undo"), "Z"],
              [t("Wiederholen", "Redo"), "Shift+Z"],
              [t("Drucken / PDF exportieren", "Print / export PDF"), "P"],
            ].map(([label, key]) => (
              <tr key={label}>
                <td className="py-2 pr-4">{label}</td>
                <td>
                  <kbd>
                    {macKeyboard() ? "Cmd" : "Ctrl"}+{key}
                  </kbd>
                </td>
              </tr>
            ))}
            <tr>
              <td className="py-2 pr-4">
                {t("Nächster / vorheriger Absatz", "Next / previous paragraph")}
              </td>
              <td>
                <kbd>Tab / Shift+Tab</kbd>
              </td>
            </tr>
            {model.phase === "31" && (
              <tr>
                <td className="py-2 pr-4">
                  {t(
                    "Berechnungsart zurück / vor",
                    "Previous / next calculation type",
                  )}
                </td>
                <td>
                  <kbd>Ctrl+Q / Ctrl+W</kbd>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Modal>
      <input
        ref={attachmentInput}
        hidden
        type="file"
        accept=".pdf,.png,.jpg,.jpeg,.gif,.bmp"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file) return;
          void (async () => {
            if (
              file.size > MAX_GAEB_ATTACHMENT_BYTES ||
              new TextEncoder().encode(modelRef.current!.source).byteLength +
                Math.ceil(file.size / 3) * 4 >
                MAX_GAEB_BYTES
            )
              throw new Error("attachment-too-large");
            const type = file.name.split(".").at(-1)?.toLowerCase() ?? "";
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 8192)
              binary += String.fromCharCode(
                ...bytes.subarray(offset, offset + 8192),
              );
            flushDrafts();
            change((current) =>
              current.addAttachment(file.name, type, btoa(binary)),
            );
          })().catch((failure) => setError(errorText(locale, failure)));
        }}
      />
    </section>
  );
}
