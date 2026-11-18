import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser } from "playwright";

type PendingCommand = {
  sessionId?: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

/**
 * Page WebSocket events omit SharedWorkers. A separate DevTools connection
 * pauses new workers until Network.enable completes, including their first
 * socket URL and frame. The test browser must enable automation and port 0.
 */
export async function observeWorkerTraffic(
  browser: Browser,
  observe: {
    socket: (url: string) => void;
    frame: (bytes: Buffer, targetType: string) => void;
  },
) {
  const discovery = await browser.newBrowserCDPSession();
  let directory: string | undefined;
  try {
    const commandLine = await discovery.send("Browser.getBrowserCommandLine");
    directory = commandLine.arguments
      .find((argument) => argument.startsWith("--user-data-dir="))
      ?.slice("--user-data-dir=".length);
  } finally {
    await discovery.detach();
  }
  if (!directory) throw new Error("Test browser has no disposable profile");
  const [port, path] = (
    await readFile(join(directory, "DevToolsActivePort"), "utf8")
  )
    .trim()
    .split("\n");
  if (!/^[0-9]+$/.test(port) || !path?.startsWith("/devtools/browser/")) {
    throw new Error("Invalid test browser DevTools endpoint");
  }
  const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`);
  const commands = new Map<number, PendingCommand>();
  const workerSessions = new Map<string, string>();
  const errors: string[] = [];
  let sequence = 0;
  let closed = false;

  async function send<T = unknown>(
    method: string,
    params = {},
    sessionId?: string,
  ) {
    const id = ++sequence;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return (await new Promise<unknown>((resolve, reject) => {
        commands.set(id, { resolve, reject, sessionId });
        timer = setTimeout(
          () =>
            reject(new Error(`Worker observer command timed out: ${method}`)),
          5000,
        );
        socket.send(JSON.stringify({ id, method, params, sessionId }));
      })) as T;
    } finally {
      clearTimeout(timer);
      commands.delete(id);
    }
  }

  async function reportWorkerFailure(targetId: string, error: unknown) {
    if (closed) return;
    // A context can close a paused worker before Network.enable finishes.
    // Confirm its disappearance through the browser, rather than hiding a
    // failed observer for a target which could still transmit data.
    const targets = await send<{ targetInfos: { targetId: string }[] }>(
      "Target.getTargets",
    );
    if (targets.targetInfos.some((target) => target.targetId === targetId)) {
      errors.push(`Worker traffic observer failed: ${String(error)}`);
    }
  }

  socket.addEventListener("message", (event) => {
    try {
      const packet = JSON.parse(String(event.data));
      if (typeof packet.id === "number") {
        const command = commands.get(packet.id);
        if (packet.error) {
          command?.reject(new Error(packet.error.message));
        } else {
          command?.resolve(packet.result);
        }
        return;
      }
      const { method, params, sessionId } = packet;
      if (method === "Target.attachedToTarget") {
        workerSessions.set(params.sessionId, params.targetInfo.type);
        void (async () => {
          try {
            await send("Network.enable", {}, params.sessionId);
          } catch (error) {
            await reportWorkerFailure(params.targetInfo.targetId, error);
          } finally {
            if (!closed && workerSessions.has(params.sessionId)) {
              await send(
                "Runtime.runIfWaitingForDebugger",
                {},
                params.sessionId,
              ).catch((error) =>
                reportWorkerFailure(params.targetInfo.targetId, error),
              );
            }
          }
        })().catch((error) => {
          if (!closed)
            errors.push(`Worker state could not be checked: ${String(error)}`);
        });
      } else if (method === "Target.detachedFromTarget") {
        workerSessions.delete(params.sessionId);
        for (const command of commands.values()) {
          if (command.sessionId === params.sessionId) {
            command.reject(new Error("Inspected worker closed"));
          }
        }
      } else if (workerSessions.has(sessionId)) {
        if (method === "Network.webSocketCreated") {
          observe.socket(params.url);
        } else if (method === "Network.webSocketFrameSent") {
          const { opcode, payloadData } = params.response;
          const encoding = opcode === 1 ? "utf8" : "base64";
          observe.frame(
            Buffer.from(payloadData, encoding),
            workerSessions.get(sessionId)!,
          );
        }
      }
    } catch (error) {
      errors.push(`Worker traffic could not be inspected: ${String(error)}`);
    }
  });
  socket.addEventListener("close", () => {
    if (!closed) errors.push("Worker traffic connection closed unexpectedly");
    for (const command of commands.values()) {
      command.reject(new Error("Worker traffic observer closed"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener(
      "error",
      () => reject(new Error("Test browser DevTools connection failed")),
      { once: true },
    );
  });
  await send("Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
    filter: [
      { type: "shared_worker" },
      { type: "worker" },
      { type: "service_worker" },
      { exclude: true },
    ],
  });

  return {
    errors,
    async close() {
      if (closed) return;
      closed = true;
      try {
        await send("Target.setAutoAttach", {
          autoAttach: false,
          waitForDebuggerOnStart: false,
          flatten: true,
        });
      } finally {
        socket.close();
      }
    },
  };
}
