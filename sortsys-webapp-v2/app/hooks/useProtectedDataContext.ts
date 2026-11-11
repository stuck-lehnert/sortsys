import { useSyncExternalStore } from "react";
import { projectFiles } from "~/lib/client";

/** The account/access lifetime is shared by every protected business adapter,
 * including the file adapter. Bind retained component state to that lifetime. */
export function useProtectedDataContext(): AbortSignal {
  return useSyncExternalStore(projectFiles.listenContext, projectFiles.context, projectFiles.context);
}
