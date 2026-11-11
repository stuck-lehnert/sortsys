import { useEffect, useState, useSyncExternalStore } from "react";
import { gaebDocuments, projectFiles } from "./client";
import { parseCommercialDocumentUrl } from "./data/commercialDocumentUrl";
import { parsePrivateFileUrl } from "./data/projectFileData";
import { downloadBlob } from "./utils";

export async function fetchFileResource(url: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
  options.signal?.throwIfAborted();
  if (url.startsWith("sortsys-private-gaeb:")) {
    const document = parseCommercialDocumentUrl(url), blob = await gaebDocuments.blob(document.caseId, document.id, document.version, options.signal);
    return new Response(blob, { headers: { "Content-Type": blob.type, "Cache-Control": "no-store" } });
  }
  if (!url.startsWith("sortsys-private:")) return fetch(url, { ...options, credentials: "omit" });
  const file = parsePrivateFileUrl(url), blob = await projectFiles.blob(file.projectId, file.fileId, file.revision, file.thumbnail, options.signal);
  options.signal?.throwIfAborted();
  return new Response(blob, { headers: { "Content-Type": blob.type || "application/octet-stream", "Cache-Control": "no-store" } });
}
export function useFileResourceContext(source: string | null | undefined) {
  const context = useSyncExternalStore(projectFiles.listenContext, projectFiles.context, projectFiles.context);
  return source?.startsWith("sortsys-private:") ? context : null;
}
export function useFileResource(source: string | null | undefined) {
  const context = useFileResourceContext(source);
  const [state, setState] = useState<{ source: string; context: AbortSignal; url: string | null; error: boolean } | null>(null);
  const privateFile = source?.startsWith("sortsys-private:") ?? false;
  useEffect(() => {
    if (!source || !context) return;
    const controller = new AbortController(); let lease: { url: string; dispose(): void } | undefined;
    const dispose = () => { controller.abort(); const previous = lease; lease = undefined; previous?.dispose(); };
    context.addEventListener("abort", dispose, { once: true });
    if (context.aborted) dispose();
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      const file = parsePrivateFileUrl(source);
      return projectFiles.url(file.projectId, file.fileId, file.revision, file.thumbnail, controller.signal);
    }).then(value => {
      if (controller.signal.aborted) { value.dispose(); return; }
      lease = value; setState({ source, context, url: value.url, error: false });
    }).catch(() => { if (!controller.signal.aborted) setState({ source, context, url: null, error: true }); });
    return () => { context.removeEventListener("abort", dispose); dispose(); };
  }, [source, context]);
  const current = state && state.source === source && state.context === context && !context?.aborted ? state : null;
  return { url: !privateFile ? source ?? null : current?.url ?? null,
    error: privateFile && !!current?.error,
    loading: privateFile && (!current || !current.url && !current.error) };
}
export async function downloadFileResource(url: string, name: string) {
  const context = url.startsWith("sortsys-private:") || url.startsWith("sortsys-private-gaeb:") ? projectFiles.context() : null;
  const response = await fetchFileResource(url);
  if (!response.ok) throw new Error("File download failed");
  const blob = await response.blob();
  context?.throwIfAborted();
  if (context && context !== projectFiles.context()) throw new DOMException("Aborted", "AbortError");
  downloadBlob(blob, name);
}
