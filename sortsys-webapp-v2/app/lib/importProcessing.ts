import { llmActivity } from "./llmActivity";

/** Own preparation, live MCP, client checks and encrypted persistence together.
 * Finishing model transport alone must not dismiss the progress dialog. */
export function processImport<T>(operation: (signal: AbortSignal, progress: (stage: string) => void) => Promise<T>): Promise<T> {
  return llmActivity.run("document-import", "import", operation);
}
