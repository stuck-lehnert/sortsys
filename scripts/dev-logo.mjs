// Install the development company logo through the regular upload/conversion API.
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '../sortsys-api-v2/client/dist/index.js';
import { waitForApi } from './dev-readiness.mjs';

const client = createClient(process.env.DEV_LOGO_API_URL, 'dev-company-logo', {
  fetch: (url, options) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) }),
});

function dataOrThrow([data, error]) {
  if (error) throw error;
  if (!data) throw new Error('Development company logo: missing API response.');
  return data;
}

function storageRequest(signedUrl, options = {}) {
  const url = new URL(signedUrl);
  const publicBase = new URL(process.env.DEV_LOGO_S3_PUBLIC_BASE_URL);
  const internalBase = new URL(process.env.DEV_LOGO_S3_INTERNAL_BASE_URL);
  const headers = new Headers(options.headers);
  // The API signs browser-facing URLs. Reach MinIO over the container network
  // while preserving the signed Host header and the complete path/query.
  if (url.origin === publicBase.origin) {
    headers.set('Host', url.host);
    url.protocol = internalBase.protocol;
    url.host = internalBase.host;
  }
  return fetch(url, { ...options, headers, signal: AbortSignal.timeout(10_000) });
}

console.log('Checking development API readiness before company logo setup');
await waitForApi(client);
await client.login({
  tenant: process.env.DEV_TEST_TENANT_NAME,
  username: 'john.doe',
  password: '123456',
});
try {
  let logo = dataOrThrow(await client.query('settings.tenantLogo.get', undefined, { strategy: 'network-only' }));
  if (logo.status !== 'ready' || logo.fileName !== 'sortsys.webp') {
    const bytes = await readFile(new URL('../sortsys-webapp-v2/public/logo-black.png', import.meta.url));
    const upload = dataOrThrow(await client.mutate('settings.tenantLogo.createUpload', {
      fileName: 'sortsys.png', mimeType: 'image/png', sizeBytes: bytes.length,
    }));
    const response = await storageRequest(upload.uploadUrl, {
      method: upload.uploadMethod, headers: upload.uploadHeaders, body: bytes,
    });
    if (!response.ok) throw new Error(`Development company logo upload failed (${response.status}).`);
    dataOrThrow(await client.mutate('settings.tenantLogo.completeUpload', {
      generationId: upload.generationId, etag: response.headers.get('etag'),
    }));
    const deadline = Date.now() + 180_000;
    do {
      await delay(1000);
      logo = dataOrThrow(await client.query('settings.tenantLogo.get', undefined, { strategy: 'network-only' }));
      if (logo.status === 'failed') throw new Error(`Development company logo conversion failed: ${logo.error}`);
    } while (logo.status !== 'ready' && Date.now() < deadline);
  }
  if (logo.status !== 'ready' || !logo.downloadUrl) throw new Error('Development company logo did not become ready.');
  const download = await storageRequest(logo.downloadUrl);
  if (!download.ok) throw new Error(`Development company logo download failed (${download.status}).`);
  const result = Buffer.from(await download.arrayBuffer());
  if (result.toString('ascii', 0, 4) !== 'RIFF' || result.toString('ascii', 8, 12) !== 'WEBP') {
    throw new Error('Development company logo is not a valid WebP file.');
  }
  console.log('Development company logo is ready (sortsys.webp).');
} finally {
  await client.logout();
}
