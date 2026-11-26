import type { Plugin } from "vite";

export function loadScriptClientTypes(
  contractPath: string,
  clientPath: string,
): Promise<string>;

export function scriptClientTypesPlugin(): Plugin;
