import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  useImperativeHandle,
} from "react";
import {
  Tree,
  TreeItem,
  TreeItemContent,
  useDragAndDrop,
  DropIndicator,
  type DropTarget,
} from "react-aria-components";
import { Dropdown } from "@heroui/react";
import { Button, MenuItem, TextInput } from "@sortsys/react-components";
import ChevronRight from "@carbon/icons-react/es/ChevronRight";
import Folder from "@carbon/icons-react/es/Folder";
import FolderOpen from "@carbon/icons-react/es/FolderOpen";
import FolderAdd from "@carbon/icons-react/es/FolderAdd";
import Document from "@carbon/icons-react/es/Document";
import DocumentAdd from "@carbon/icons-react/es/DocumentAdd";
import OverflowMenuVertical from "@carbon/icons-react/es/OverflowMenuVertical";
import CollapseAll from "@carbon/icons-react/es/CollapseAll";
import Close from "@carbon/icons-react/es/Close";
import { isTradePhase } from "../core/types";
import { GaebDocument, type GaebEntry } from "../core/document";
import { errorText, text, type GaebLocale } from "../messages";
import { EditorIconButton } from "./EditorIconButton";

export type HierarchyPlan = {
  base: string;
  source: string;
  selected?: string;
  edit?: boolean;
  title?: string;
};
type Panel = { entry: string };
type Inline = {
  kind: "new" | "rename";
  parent: string;
  entry?: string;
  base: string;
};
const ENTRY_DRAG_TYPE = "application/x-sortsys-gaeb-entry";
const NEW_ENTRY = "__gaeb_new_section__";
type Props = {
  id?: string;
  commandRef?: React.Ref<{ addTitle: () => void; deleteEntry: () => void }>;
  positionSearch?: React.ReactNode;
  model: GaebDocument;
  reference?: GaebDocument;
  locale: GaebLocale;
  selected: string;
  editable: boolean;
  documentEditable: boolean;
  namesEditable: boolean;
  onPrepare: () => boolean;
  onSelect: (key: string) => void;
  onEdit: (key: string) => void;
  onApply: (plan: HierarchyPlan) => boolean;
  onAddItem: (parent?: string) => void;
  onClose: () => void;
};
export const GaebOutline = memo(function GaebOutline({
  id,
  commandRef,
  positionSearch,
  model,
  reference,
  locale,
  selected,
  editable,
  documentEditable,
  namesEditable,
  onPrepare,
  onSelect,
  onEdit,
  onApply,
  onAddItem,
  onClose,
}: Props) {
  const t = (de: string, en: string) => text(locale, de, en);
  const filler = t("Leistungen", "Work items");
  const [panel, setPanel] = useState<Panel>();
  const [inline, setInline] = useState<Inline>();
  const [name, setName] = useState("");
  const [inlineError, setInlineError] = useState("");
  const [menuKey, setMenuKey] = useState<string>();
  const [expanded, setExpanded] = useState(
    new Set(
      model.outlineEntries
        .filter((e) => e.kind === "category")
        .map((e) => e.key),
    ),
  );
  const knownCategories = useRef(new Set(expanded));
  const nameInput = useRef<HTMLInputElement>(null);
  const endingInline = useRef(false);
  const formElement = useRef<HTMLFormElement>(null);
  const tree = useRef<HTMLDivElement>(null);
  const dragged = useRef<string | undefined>(undefined);
  const hover = useRef<
    { key: string; timer: ReturnType<typeof setTimeout> } | undefined
  >(undefined);
  const [rootDrop, setRootDrop] = useState(false);
  const [dragMessage, setDragMessage] = useState("");
  const [dragError, setDragError] = useState("");
  const stopHover = () => {
    if (hover.current) clearTimeout(hover.current.timer);
    hover.current = undefined;
  };
  useEffect(() => () => stopHover(), []);
  const current = model.outlineEntries.find((e) => e.key === selected);
  const categories = model.outlineEntries.filter((e) => e.kind === "category");
  const title = (item: GaebEntry) =>
    item.title ||
    reference?.entries.find(
      (e) => e.element.getAttribute("ID") === item.element.getAttribute("ID"),
    )?.title ||
    reference?.entries.find((e) => e.kind === item.kind && e.oz === item.oz)
      ?.title ||
    t(
      item.kind === "category" ? "Unbenannter Titel" : "Neue Position",
      item.kind === "category" ? "Untitled section" : "New item",
    );
  const path = (item?: GaebEntry) =>
    item
      ? `${item.oz} · ${title(item)}`
      : t("Gesamtes Dokument", "Entire document");
  const ownerOf = (item?: GaebEntry) =>
    item?.kind === "category" ? item : item && model.outlineParent(item);
  const focusTree = (key?: string) =>
    requestAnimationFrame(() => {
      const row = [
        ...(tree.current?.querySelectorAll<HTMLElement>("[data-gaeb-entry]") ??
          []),
      ].find((node) => node.dataset.gaebEntry === (key ?? selected));
      (
        row ??
        tree.current?.querySelector<HTMLElement>("[data-gaeb-entry]") ??
        tree.current
          ?.closest("nav")
          ?.querySelector<HTMLElement>(".gaeb-outline-root")
      )?.focus();
    });
  const start = (value: Panel) => {
    if (!editable || !onPrepare()) return;
    setInline(undefined);
    setPanel(value);
    setMenuKey(undefined);
  };
  const addTitle = (item = current) => {
    if (!editable || isTradePhase(model.phase) || !onPrepare()) return;
    const owner = ownerOf(item);
    setPanel(undefined);
    setMenuKey(undefined);
    setInlineError("");
    setName("");
    endingInline.current = false;
    setInline({ kind: "new", parent: owner?.key ?? "", base: model.source });
    if (owner)
      setExpanded((previous) => {
        const next = new Set(previous);
        let entry: GaebEntry | undefined = owner;
        while (entry) {
          next.add(entry.key);
          entry = model.outlineParent(entry);
        }
        return next;
      });
  };
  useImperativeHandle(commandRef, () => ({
    addTitle: () => addTitle(),
    deleteEntry: () => {
      if (current) start({ entry: current.key });
    },
  }));
  const rename = (item: GaebEntry) => {
    if (!editable || !namesEditable || !onPrepare()) return;
    setPanel(undefined);
    setMenuKey(undefined);
    setInlineError("");
    setName((model.richGroups(item)[0]?.text ?? title(item)).split("\n")[0]!);
    endingInline.current = false;
    setInline({
      kind: "rename",
      parent: model.outlineParent(item)?.key ?? "",
      entry: item.key,
      base: model.source,
    });
    onSelect(item.key);
  };
  const newSection = useMemo(() => {
    if (inline?.kind !== "new") return null;
    try {
      const owner = model.outlineEntries.find((e) => e.key === inline.parent);
      if (inline.parent && !owner) throw new Error("hierarchy-stale");
      const source = model.addEmptyCategory(
        owner,
        t("Neuer Titel", "New section"),
        filler,
      );
      const next = new GaebDocument(source, model.fileName);
      const entry = next.outlineEntries
        .filter(
          (e) =>
            e.kind === "category" &&
            next.outlineParent(e)?.key === owner?.key &&
            !model.outlineEntries.some((old) => old.key === e.key) &&
            !next.outlineChildren(e).length,
        )
        .at(-1)!;
      if (!entry) throw new Error("hierarchy-layout");
      return { source, key: entry.key, error: "" };
    } catch (error) {
      return { error: errorText(locale, error) };
    }
  }, [model, inline?.kind, inline?.parent, locale]);
  const cancelInline = (focus = true) => {
    endingInline.current = true;
    setInline(undefined);
    setInlineError("");
    if (focus) focusTree(inline?.entry || inline?.parent);
  };
  const commitInline = (focus = true) => {
    if (!inline || endingInline.current) return;
    if (!name.trim()) {
      cancelInline(focus);
      return;
    }
    endingInline.current = true;
    try {
      let source = model.source;
      let key = inline.entry;
      if (inline.kind === "new") {
        if (newSection?.error) {
          endingInline.current = false;
          setInlineError(newSection.error);
          return;
        }
        if (
          !newSection ||
          newSection.error ||
          typeof newSection.source !== "string"
        )
          throw new Error("hierarchy-layout");
        source = newSection.source;
        key = newSection.key;
      } else if (inline.base !== model.source)
        throw new Error("hierarchy-stale");
      if (!key) throw new Error("hierarchy-stale");
      if (
        onApply({
          base: model.source,
          source,
          selected: key,
          title: name.trim(),
        })
      ) {
        setInline(undefined);
        setInlineError("");
        if (focus) focusTree(key);
      } else endingInline.current = false;
    } catch (error) {
      endingInline.current = false;
      setInlineError(errorText(locale, error));
      if (error instanceof Error && error.message === "hierarchy-stale")
        setInline({ ...inline, base: model.source });
    }
  };
  useEffect(() => {
    if (!inline) return;
    const frame = requestAnimationFrame(() => {
      nameInput.current?.focus();
      nameInput.current?.select();
    });
    return () => cancelAnimationFrame(frame);
  }, [inline?.kind, inline?.entry, inline?.parent]);
  useEffect(() => {
    const added = categories.filter((e) => !knownCategories.current.has(e.key));
    knownCategories.current = new Set(categories.map((e) => e.key));
    setExpanded((previous) => {
      const next = new Set([...previous, ...added.map((e) => e.key)]);
      let entry = current && model.outlineParent(current);
      while (entry) {
        next.add(entry.key);
        entry = model.outlineParent(entry);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [model, selected]);
  useEffect(() => {
    if (!panel) return;
    const frame = requestAnimationFrame(() =>
      formElement.current
        ?.querySelector<HTMLElement>('[data-slot="select-trigger"], button')
        ?.focus(),
    );
    return () => cancelAnimationFrame(frame);
  }, [panel?.entry]);
  useEffect(() => {
    if (panel && panel.entry !== selected) setPanel(undefined);
  }, [selected]);
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const node = tree.current,
        row = node?.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!node || !row) return;
      const outer = node.getBoundingClientRect(),
        inner = row.getBoundingClientRect();
      if (inner.top < outer.top) node.scrollTop += inner.top - outer.top;
      else if (inner.bottom > outer.bottom)
        node.scrollTop += inner.bottom - outer.bottom;
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, expanded, inline?.kind]);
  const moving = model.outlineEntries.find((e) => e.key === panel?.entry);
  const contained = moving
    ? model.items.filter((e) => moving.element.contains(e.element)).length
    : 0;
  const preview = useMemo(() => {
    if (!panel || !moving) return null;
    try {
      const source = model.removeEntry(moving, filler);
      const key = model.outlineParent(moving)?.key;
      const next = new GaebDocument(source, model.fileName);
      return {
        source,
        selected: key,
        oz: next.outlineEntries.find((e) => e.key === key)?.oz,
        error: "",
      };
    } catch (error) {
      return { error: errorText(locale, error) };
    }
  }, [model, panel, locale]);
  const apply = () => {
    if (
      preview &&
      !preview.error &&
      typeof preview.source === "string" &&
      onApply({
        base: model.source,
        source: preview.source,
        selected: preview.selected,
      })
    ) {
      setPanel(undefined);
      focusTree(preview.selected);
    }
  };
  const reorder = (direction: -1 | 1) => {
    if (!current || !onPrepare()) return;
    try {
      onApply({
        base: model.source,
        source: model.reorderEntry(current, direction),
        selected: current.key,
      });
    } catch (error) {
      setDragError(errorText(locale, error));
    }
  };
  const indent = (out = false) => {
    if (!current || !onPrepare()) return;
    const owner = model.outlineParent(current),
      peers = model
        .outlineChildren(owner)
        .filter((e) => e.kind === current.kind);
    const parent = out
      ? owner && model.outlineParent(owner)
      : peers[peers.findIndex((e) => e.key === current.key) - 1];
    if ((out && !owner) || (!out && !parent)) return;
    try {
      const next = out
        ? model.outlineChildren(parent)[
            model
              .outlineChildren(parent)
              .findIndex((e) => e.key === owner?.key) + 1
          ]
        : undefined;
      onApply({
        base: model.source,
        source: model.moveEntry(current, parent, next, filler),
        selected: current.key,
      });
      focusTree(current.key);
    } catch (error) {
      setDragError(errorText(locale, error));
    }
  };
  const dropLocation = (key: string, target: DropTarget) => {
    const source = model.outlineEntries.find((item) => item.key === key);
    if (!editable || !source) return null;
    if (target.type === "root")
      return { source, parent: undefined, before: undefined };
    const entry = model.outlineEntries.find(
      (item) => item.key === String(target.key),
    );
    if (!entry || entry.key === key) return null;
    const parent =
      target.dropPosition === "on" ? entry : model.outlineParent(entry);
    if (
      parent &&
      (parent.kind !== "category" || source.element.contains(parent.element))
    )
      return null;
    if (target.dropPosition === "on")
      return { source, parent, before: undefined };
    const peers = model.outlineChildren(parent);
    return {
      source,
      parent,
      before:
        target.dropPosition === "before"
          ? entry
          : peers[peers.findIndex((item) => item.key === entry.key) + 1],
    };
  };
  const drop = (key: string, target: DropTarget) => {
    const location = dropLocation(key, target);
    if (!location || !onPrepare()) return;
    try {
      const source = model.moveEntry(
        location.source,
        location.parent,
        location.before,
        filler,
      );
      if (source === model.source) return;
      const next = new GaebDocument(source, model.fileName);
      const moved = next.outlineEntries.find((item) => item.key === key)!;
      if (onApply({ base: model.source, source, selected: key })) {
        setPanel(undefined);
        setDragMessage(
          `${t("Verschoben", "Moved")}: ${location.source.oz} → ${moved.oz}`,
        );
        setDragError("");
      }
    } catch (error) {
      setDragError(errorText(locale, error));
    }
  };
  const { dragAndDropHooks } = useDragAndDrop({
    isDisabled: !editable || !!panel || !!inline,
    acceptedDragTypes: [ENTRY_DRAG_TYPE],
    getAllowedDropOperations: () => ["move"],
    getItems: (keys) => {
      if (!editable || panel || inline || !onPrepare()) return [];
      const key = String([...keys][0]);
      const entry = model.outlineEntries.find((item) => item.key === key);
      if (!entry) return [];
      dragged.current = key;
      setDragError("");
      setDragMessage("");
      return [
        { [ENTRY_DRAG_TYPE]: key, "text/plain": path(entry).slice(0, 180) },
      ];
    },
    getDropOperation: (target, types) =>
      dragged.current &&
      types.has(ENTRY_DRAG_TYPE) &&
      dropLocation(dragged.current, target)
        ? "move"
        : "cancel",
    onMove: (event) => drop(String([...event.keys][0]), event.target),
    onRootDrop: () => {
      if (dragged.current) drop(dragged.current, { type: "root" });
    },
    onDropActivate: (event) => {
      if (event.target.type === "item") {
        const key = String(event.target.key);
        setExpanded((previous) => new Set([...previous, key]));
      }
    },
    onDragEnd: () => {
      dragged.current = undefined;
      setRootDrop(false);
      stopHover();
    },
    renderDropIndicator: (target) =>
      target.type === "item" ? (
        <DropIndicator target={target} className="gaeb-tree-drop-indicator" />
      ) : (
        <></>
      ),
    renderDragPreview: (items) => (
      <div className="gaeb-tree-drag-preview">
        <Document size={16} aria-hidden />
        <span>{String(items[0]?.["text/plain"] ?? "")}</span>
      </div>
    ),
  });

  const inlineName = () => (
    <form
      className="gaeb-tree-name"
      aria-label={
        inline?.kind === "new"
          ? t("Titel anlegen", "Create section")
          : t("Umbenennen", "Rename")
      }
      onSubmit={(event) => {
        event.preventDefault();
        event.stopPropagation();
        commitInline();
      }}
    >
      <TextInput
        ref={nameInput}
        aria-label={t("Titelbezeichnung", "Section name")}
        value={name}
        placeholder={t("Neuer Titel", "New section")}
        invalid={!!inlineError || !!newSection?.error}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
          setName(event.target.value);
          setInlineError("");
        }}
        onKeyDown={(event: React.KeyboardEvent) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commitInline();
          } else if (event.key === "Escape") {
            event.preventDefault();
            cancelInline();
          }
        }}
        onBlur={() => commitInline(false)}
      />
    </form>
  );
  const entryMenu = (item: GaebEntry) => (
    <Dropdown
      isOpen={menuKey === item.key}
      onOpenChange={(open) => setMenuKey(open ? item.key : undefined)}
    >
      <Button
        kind="ghost"
        size="sm"
        className="gaeb-tree-menu"
        aria-label={`${t("Aktionen für", "Actions for")} ${item.oz} ${title(item)}`}
        onClick={() => {
          if (onPrepare()) onSelect(item.key);
        }}
      >
        <OverflowMenuVertical size={16} aria-hidden />
      </Button>
      <Dropdown.Popover placement="bottom end">
        <Dropdown.Menu aria-label={t("Eintrag bearbeiten", "Edit entry")}>
          {editable && (
            <MenuItem
              label={t("Neue Position", "New item")}
              onClick={() => onAddItem(item.key)}
            />
          )}
          {editable && !isTradePhase(model.phase) && (
            <MenuItem
              label={t("Neuer Titel", "New section")}
              onClick={() => addTitle(item)}
            />
          )}
          {editable && namesEditable && (
            <MenuItem
              label={t("Umbenennen", "Rename")}
              onClick={() => rename(item)}
            />
          )}
          <MenuItem
            label={
              documentEditable
                ? t("Im Dokument bearbeiten", "Edit in document")
                : t("Im Dokument ansehen", "View in document")
            }
            onClick={() => onEdit(item.key)}
          />
          {editable && (
            <MenuItem
              label={t("Löschen", "Delete entry")}
              onClick={() => start({ entry: item.key })}
            />
          )}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
  const render = (owner?: GaebEntry): React.ReactNode => [
    ...model.outlineChildren(owner).map((item) => (
      <TreeItem
        key={item.key}
        id={item.key}
        data-gaeb-entry={item.key}
        textValue={path(item)}
        onAction={() => {
          if (item.kind === "item") onEdit(item.key);
        }}
      >
        <TreeItemContent>
          {({ hasChildItems, isExpanded, level }) => (
            <div
              className="gaeb-tree-row"
              style={{ paddingInlineStart: (level - 1) * 14 }}
              onClick={(event) => {
                if (
                  item.kind !== "category" ||
                  event.detail !== 1 ||
                  (event.target instanceof Element &&
                    event.target.closest("button, input, form"))
                )
                  return;
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (next.has(item.key)) next.delete(item.key);
                  else next.add(item.key);
                  return next;
                });
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                if (onPrepare()) {
                  onSelect(item.key);
                  setMenuKey(item.key);
                }
              }}
            >
              {editable && (
                <Button
                  slot="drag"
                  kind="ghost"
                  size="sm"
                  disabled={!!panel || !!inline}
                  className="gaeb-tree-drag-handle"
                  aria-label={`${t("Eintrag verschieben", "Move entry")} ${item.oz}`}
                >
                  <span className="sr-only">
                    {t("Eintrag verschieben", "Move entry")}
                  </span>
                </Button>
              )}
              {hasChildItems ? (
                <Button
                  slot="chevron"
                  kind="ghost"
                  size="sm"
                  className="gaeb-tree-chevron"
                  aria-label={
                    isExpanded
                      ? t("Titel einklappen", "Collapse section")
                      : t("Titel ausklappen", "Expand section")
                  }
                >
                  <ChevronRight
                    size={16}
                    aria-hidden
                    style={{
                      transform: isExpanded ? "rotate(90deg)" : undefined,
                    }}
                  />
                </Button>
              ) : (
                <span className="gaeb-tree-chevron" />
              )}
              {item.kind === "category" ? (
                isExpanded ? (
                  <FolderOpen size={16} aria-hidden />
                ) : (
                  <Folder size={16} aria-hidden />
                )
              ) : (
                <Document size={16} aria-hidden />
              )}
              <span className="gaeb-tree-oz">{item.oz}</span>
              {inline?.kind === "rename" && inline.entry === item.key ? (
                inlineName()
              ) : (
                <span className="gaeb-tree-label" title={title(item)}>
                  {title(item)}
                </span>
              )}
              {!inline && entryMenu(item)}
            </div>
          )}
        </TreeItemContent>
        {item.kind === "category" && render(item)}
      </TreeItem>
    )),
    ...(inline?.kind === "new" && inline.parent === (owner?.key ?? "")
      ? [
          <TreeItem
            key={NEW_ENTRY}
            id={NEW_ENTRY}
            textValue={t("Neuer Titel", "New section")}
          >
            <TreeItemContent>
              {({ level }) => (
                <div
                  className="gaeb-tree-row gaeb-tree-new"
                  style={{ paddingInlineStart: (level - 1) * 14 }}
                >
                  {editable && <span className="gaeb-tree-drag-handle" />}
                  <span className="gaeb-tree-chevron" />
                  <Folder size={16} aria-hidden />
                  {inlineName()}
                </div>
              )}
            </TreeItemContent>
          </TreeItem>,
        ]
      : []),
  ];
  return (
    <nav
      id={id}
      className="gaeb-outline"
      aria-label={t("Dokumentgliederung", "Document outline")}
      data-editing={!!panel || undefined}
      onDragOverCapture={(event) => {
        if (!dragged.current || !(event.target instanceof Element)) return;
        const key = event.target
          .closest("[data-gaeb-entry]")
          ?.getAttribute("data-gaeb-entry");
        const entry = model.outlineEntries.find((e) => e.key === key);
        if (!entry || entry.kind !== "category" || expanded.has(entry.key)) {
          stopHover();
          return;
        }
        if (hover.current?.key === key) return;
        stopHover();
        hover.current = {
          key: entry.key,
          timer: setTimeout(
            () => setExpanded((previous) => new Set([...previous, entry.key])),
            500,
          ),
        };
      }}
      onKeyDownCapture={(event) => {
        if (panel && event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          setPanel(undefined);
          focusTree();
          return;
        }
        if (
          dragged.current ||
          !(event.target instanceof Element) ||
          event.target.closest(".gaeb-tree-name") ||
          !event.target.closest(".gaeb-outline-tree")
        )
          return;
        if (
          event.key === "Enter" &&
          current?.kind === "category" &&
          event.target.matches("[data-gaeb-entry]")
        ) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded((previous) => {
            const next = new Set(previous);
            if (next.has(current.key)) next.delete(current.key);
            else next.add(current.key);
            return next;
          });
        } else if (event.key === "F2" && current && editable && namesEditable) {
          event.preventDefault();
          event.stopPropagation();
          rename(current);
        } else if (event.key === "Delete" && current && editable) {
          event.preventDefault();
          event.stopPropagation();
          start({ entry: current.key });
        } else if (
          event.altKey &&
          ["ArrowUp", "ArrowDown"].includes(event.key) &&
          current &&
          editable
        ) {
          event.preventDefault();
          event.stopPropagation();
          reorder(event.key === "ArrowUp" ? -1 : 1);
        } else if (
          event.altKey &&
          (event.ctrlKey || event.metaKey) &&
          ["ArrowLeft", "ArrowRight"].includes(event.key) &&
          current?.kind === "category" &&
          editable
        ) {
          event.preventDefault();
          event.stopPropagation();
          indent(event.key === "ArrowLeft");
        }
      }}
    >
      <div className="gaeb-outline-heading">
        <strong>{t("Gliederung", "Outline")}</strong>
        <div className="gaeb-outline-heading-tools">
          {editable && (
            <>
              <EditorIconButton
                label={t("Neue Position", "New item")}
                icon={DocumentAdd}
                onClick={() => onAddItem()}
                disabled={!!inline}
              />
              <EditorIconButton
                label={t("Neuer Titel", "New section")}
                icon={FolderAdd}
                onClick={() => addTitle()}
                disabled={
                  !!inline || !namesEditable || isTradePhase(model.phase)
                }
              />
            </>
          )}
          <EditorIconButton
            label={t("Alle Titel einklappen", "Collapse all sections")}
            icon={CollapseAll}
            disabled={!!inline}
            onClick={() => setExpanded(new Set())}
          />
          <EditorIconButton
            label={t("Gliederung ausblenden", "Hide outline")}
            icon={Close}
            onClick={onClose}
          />
        </div>
      </div>
      {positionSearch}
      <div
        className="gaeb-outline-root-drop"
        data-drop-target={rootDrop || undefined}
        onDragOver={(event) => {
          if (
            dragged.current &&
            dropLocation(dragged.current, { type: "root" })
          ) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setRootDrop(true);
          }
        }}
        onDragLeave={() => setRootDrop(false)}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setRootDrop(false);
          if (dragged.current) drop(dragged.current, { type: "root" });
        }}
      >
        <Button
          kind="ghost"
          size="sm"
          className="gaeb-outline-root"
          aria-pressed={!selected}
          onClick={() => {
            if (onPrepare()) {
              onSelect("");
              setPanel(undefined);
            }
          }}
        >
          <Document size={16} aria-hidden />
          {t("Gesamtes Dokument", "Entire document")}
        </Button>
      </div>
      <Tree
        ref={tree}
        aria-label={t("Positionen und Titel", "Items and sections")}
        className="gaeb-outline-tree"
        data-can-drag={(editable && !panel && !inline) || undefined}
        dragAndDropHooks={dragAndDropHooks}
        selectionMode="single"
        selectionBehavior="replace"
        selectedKeys={
          inline?.kind === "new"
            ? new Set([NEW_ENTRY])
            : selected
              ? new Set([selected])
              : new Set()
        }
        expandedKeys={expanded}
        onExpandedChange={(keys) => setExpanded(new Set([...keys].map(String)))}
        onSelectionChange={(keys) => {
          const key = String([...keys][0] ?? "");
          if (key && key !== NEW_ENTRY && onPrepare()) onSelect(key);
        }}
        renderEmptyState={() => (
          <p className="gaeb-outline-empty">
            {t(
              "Noch keine Positionen oder Titel.",
              "No items or sections yet.",
            )}
          </p>
        )}
      >
        {render()}
      </Tree>
      {(inlineError || newSection?.error) && (
        <p className="gaeb-outline-error" role="alert">
          {inlineError || newSection?.error}
        </p>
      )}
      {panel && (
        <form
          ref={formElement}
          className="gaeb-outline-form"
          aria-label={t("Eintrag löschen", "Delete entry")}
          onSubmit={(event) => {
            event.preventDefault();
            apply();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setPanel(undefined);
              focusTree();
            }
          }}
        >
          <strong>{t("Eintrag löschen?", "Delete entry?")}</strong>
          {moving && (
            <p>
              {path(moving)}
              {moving.kind === "category" && (
                <>
                  <br />
                  {contained}{" "}
                  {t(
                    "enthaltene Positionen werden mit gelöscht.",
                    "contained items will also be deleted.",
                  )}
                </>
              )}
            </p>
          )}
          {preview?.error && <p role="alert">{preview.error}</p>}
          <div className="gaeb-outline-form-actions">
            <Button
              type="button"
              kind="ghost"
              size="sm"
              onClick={() => {
                setPanel(undefined);
                focusTree();
              }}
            >
              {t("Abbrechen", "Cancel")}
            </Button>
            <Button
              type="submit"
              size="sm"
              kind="danger"
              disabled={
                !preview ||
                !!preview.error ||
                !("source" in preview) ||
                preview.source === model.source
              }
            >
              {t("Löschen", "Delete")}
            </Button>
          </div>
        </form>
      )}
      {(dragMessage || dragError) && (
        <div className="gaeb-outline-drag-status">
          {dragMessage && <p role="status">{dragMessage}</p>}
          {dragError && <p role="alert">{dragError}</p>}
        </div>
      )}
    </nav>
  );
});
