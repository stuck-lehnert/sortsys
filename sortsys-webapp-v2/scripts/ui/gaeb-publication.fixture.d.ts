import type { Root } from "react-dom/client";

export function mountPublicationModal(): void;
export function mountPartialPublicationModal(options?: { description?: string }): Promise<void>;
export function mountSignedPublicationModal(): Promise<void>;
export function mountFinancialPublicationModal(options?: {
  referenced?: boolean;
  image?: "missing" | "readable";
  unfinished?: boolean;
  quantityWriter?: boolean;
}): Promise<void>;
export function mountPublicationEditor(root: Root): void;
export function frozenPublicationScenario(): Promise<{
  hadOverlay: boolean;
  exactNative: boolean;
  canUndo: boolean;
  requests: number;
}>;
