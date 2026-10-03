import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../sortsys-api-v2/client/dist/index.js';
import { waitForApi } from './dev-readiness.mjs';

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function close(server) {
  server.closeAllConnections();
  if (server.listening) await new Promise(resolve => server.close(resolve));
}

test('waits through connection refusal until the actual API ping responds', async () => {
  const reservation = createServer();
  const port = await listen(reservation);
  await close(reservation);
  let refusals = 0;
  const server = createServer((request, response) => {
    expect(request.url).toStartWith('/ping?');
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ result: { data: { json: 'pong' } } }]));
  });
  const client = createClient(`http://127.0.0.1:${port}`, 'dev-readiness-cold', {
    fetch: async (url, options) => {
      try {
        return await fetch(url, { ...options, signal: AbortSignal.timeout(100) });
      } catch (error) {
        refusals++;
        throw error;
      }
    },
  });
  try {
    await Promise.all([
      waitForApi(client, { timeoutMs: 2000, intervalMs: 10 }),
      delay(60).then(() => listen(server, port)),
    ]);
    expect(refusals).toBeGreaterThan(0);
  } finally {
    await close(server);
  }
});

test('an accepting HTTP port is not ready until it returns pong', async () => {
  let ready = false;
  let attempts = 0;
  const server = createServer((_request, response) => {
    attempts++;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify([{ result: { data: { json: ready ? 'pong' : 'starting' } } }]));
  });
  const port = await listen(server);
  const client = createClient(`http://127.0.0.1:${port}`, 'dev-readiness-starting');
  try {
    await Promise.all([
      waitForApi(client, { timeoutMs: 2000, intervalMs: 10 }),
      delay(60).then(() => { ready = true; }),
    ]);
    expect(attempts).toBeGreaterThan(1);
  } finally {
    await close(server);
  }
});

test('times out with a clear error when the API remains unavailable', async () => {
  const server = createServer((_request, response) => {
    response.writeHead(503).end();
  });
  const port = await listen(server);
  const client = createClient(`http://127.0.0.1:${port}`, 'dev-readiness-failure');
  try {
    await expect(waitForApi(client, { timeoutMs: 40, intervalMs: 5 }))
      .rejects.toThrow('Development API did not become ready: RPC request failed with HTTP 503');
  } finally {
    await close(server);
  }
});
