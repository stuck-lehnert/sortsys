export function applicationServer(
  directory: string,
  endpoint: string,
  options?: { port?: number },
): Promise<{ origin: string; close(): Promise<void> }>;
