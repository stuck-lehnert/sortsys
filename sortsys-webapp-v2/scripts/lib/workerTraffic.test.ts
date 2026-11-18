import assert from "node:assert/strict";
import { test } from "bun:test";
import { serve } from "bun";
import { chromium } from "playwright";
import { observeWorkerTraffic } from "./workerTraffic";

test("captures the first real SharedWorker text and binary WebSocket frames", async () => {
  const text = "PRIVATE_WORKER_CANARY_äöü";
  const binary = [0, 255, 129, 42];
  const received: Buffer[] = [];
  const sockets: string[] = [];
  const frames: { bytes: Buffer; targetType: string }[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/socket") {
        if (server.upgrade(request)) return;
        return new Response(null, { status: 400 });
      }
      if (url.pathname === "/worker.js") {
        return new Response(
          `onconnect = event => {
            const port = event.ports[0];
            const socket = new WebSocket(${JSON.stringify(`ws://${url.host}/socket`)});
            socket.onopen = () => {
              socket.send(${JSON.stringify(text)});
              socket.send(new Uint8Array(${JSON.stringify(binary)}));
            };
            let replies = 0;
            socket.onmessage = () => {
              if (++replies === 2) port.postMessage('complete');
            };
          };`,
          { headers: { "content-type": "text/javascript" } },
        );
      }
      return new Response(
        `<script>
          const worker = new SharedWorker('/worker.js');
          worker.port.onmessage = () => document.title = 'complete';
        </script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
    websocket: {
      message(socket, bytes) {
        received.push(Buffer.from(bytes));
        socket.send(bytes);
      },
    },
  });
  const browser = await chromium.launch({
    args: ["--remote-debugging-port=0", "--enable-automation"],
  });
  const observer = await observeWorkerTraffic(browser, {
    socket: (url) => sockets.push(url),
    frame: (bytes, targetType) => frames.push({ bytes, targetType }),
  });
  try {
    const page = await browser.newPage();
    await page.goto(server.url.href);
    await page.waitForFunction(() => document.title === "complete");
    assert.deepEqual(received, [Buffer.from(text), Buffer.from(binary)]);
    assert.deepEqual(frames, [
      { bytes: Buffer.from(text), targetType: "shared_worker" },
      { bytes: Buffer.from(binary), targetType: "shared_worker" },
    ]);
    assert.deepEqual(sockets, [`ws://${server.url.host}/socket`]);
    assert.deepEqual(observer.errors, []);
  } finally {
    await observer.close();
    await browser.close();
    await server.stop(true);
  }
});
