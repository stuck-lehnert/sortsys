export type Font = {
  size: number;
  family: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
};
export type Collaborator = {
  id: string;
  name: string;
  color: string;
  field?: string | null;
  start?: number;
  end?: number;
  direction?: "forward" | "backward" | "none";
  anchor?: unknown;
  head?: unknown;
};
export type TextCommand = {
  kind: "text";
  x: number;
  y: number;
  text: string;
  font: Font;
  field?: string;
  from?: number;
  to?: number;
};
export type DrawCommand =
  | TextCommand
  | {
      kind: "image";
      x: number;
      y: number;
      width: number;
      height: number;
      resource: import("./images").EmbeddedCanvasImage;
    }
  | { kind: "rule"; x: number; y: number; width: number }
  | { kind: "box"; x: number; y: number; width: number; height: number };
export type HitRegion = {
  textX?: number;
  key: string;
  x: number;
  y: number;
  width: number;
  height: number;
  from: number;
  to: number;
  font: Font;
  text: string;
};
export type EditorField = {
  key: string;
  label: string;
  value: string;
  multiline: boolean;
  editable: boolean;
  entryKey?: string;
  richIndex?: number;
  commit: (value: string) => void;
  enter?: (offset: number) => string | undefined;
};
export type CanvasPage = {
  top?: number;
  /** Original document coordinates keep rasterization independent of tile cuts. */
  painting?: { commands: DrawCommand[]; regions: HitRegion[] };
  commands: DrawCommand[];
  regions: HitRegion[];
  fields: string[];
  height?: number;
};
export type CanvasDocument = {
  pages: CanvasPage[];
  fields: Map<string, EditorField>;
};
export const PAGE_WIDTH = 794;
export const PAGE_HEIGHT = 1123;
export const MARGIN = 64;
export const BODY_WIDTH = PAGE_WIDTH - MARGIN * 2;
export const BODY_BOTTOM = PAGE_HEIGHT - 70;
export const BODY_TOP = 64;
