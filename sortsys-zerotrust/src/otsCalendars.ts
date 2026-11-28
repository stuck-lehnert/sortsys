import { InvalidProtectedData } from "./encoding";
import {
  OTS_HTTP_PRIVACY,
  otsRequestSignal,
  readOtsBody,
  type OtsHttpOptions,
} from "./otsHttp";
import {
  applyOtsOperation,
  evaluateOtsProof,
  MAX_OTS_BYTES,
  mergeOtsNodes,
  parseOtsProof,
  parseOtsTree,
  serializeOtsProof,
  type OtsNode,
  type OtsOperation,
} from "./opentimestamps";

export const OTS_CALENDARS = [
  "https://alice.btc.calendar.opentimestamps.org",
  "https://bob.btc.calendar.opentimestamps.org",
  "https://finney.calendar.eternitywall.com",
  "https://ots.btc.catallaxy.com",
  "https://a.pool.opentimestamps.org",
  "https://b.pool.opentimestamps.org",
  "https://a.pool.eternitywall.com",
] as const;

export type OtsCalendarOptions = OtsHttpOptions;

function hex(value: Uint8Array): string {
  return Array.from(value, byte => byte.toString(16).padStart(2, "0")).join("");
}

function operationKey(value: OtsOperation): string {
  return `${value.tag}:${hex(value.argument ?? new Uint8Array())}`;
}

export class OpenTimestampUnavailable extends Error {
  constructor() {
    super("OpenTimestamps calendars unavailable");
    this.name = "OpenTimestampUnavailable";
  }
}

/** Pending URIs are untrusted proof data. Legacy HTTP names are upgraded to
 * an explicit HTTPS allowlist; arbitrary hosts, credentials and paths are never fetched. */
export function otsCalendar(input: string): string | null {
  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.port || url.search || url.hash
      || url.pathname !== "/") {
      return null;
    }
    return OTS_CALENDARS.find(origin => new URL(origin).hostname === url.hostname) ?? null;
  } catch {
    return null;
  }
}

function allowedCalendar(origin: string): boolean {
  return OTS_CALENDARS.some(calendar => calendar === origin);
}

async function request(
  origin: string,
  path: string,
  body: Uint8Array<ArrayBuffer> | undefined,
  options: OtsCalendarOptions,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!allowedCalendar(origin)) {
    throw new InvalidProtectedData();
  }

  const signal = otsRequestSignal(options.timeoutMs, options.signal);
  const response = await (options.fetch ?? fetch)(origin + path, {
    ...OTS_HTTP_PRIVACY,
    method: body ? "POST" : "GET",
    ...(body ? { body } : {}),
    signal,
    headers: {
      Accept: "application/vnd.opentimestamps.v1",
      ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
  });
  signal.throwIfAborted();
  if (!response.ok || !response.body) throw new OpenTimestampUnavailable();

  return readOtsBody(response.body, MAX_OTS_BYTES, signal);
}

/** Only a nonce-blinded commitment leaves the browser. The document and its
 * plaintext, identifier, tenant and signature are absent from the request. */
export async function stampOtsDigest(
  digest: Uint8Array<ArrayBuffer>,
  options: OtsCalendarOptions & { calendars?: readonly string[] } = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (digest.length !== 32) throw new InvalidProtectedData();
  const calendars = options.calendars ?? OTS_CALENDARS.slice(0, 2);
  if (!calendars.length || calendars.length > OTS_CALENDARS.length
    || new Set(calendars).size !== calendars.length
    || calendars.some(calendar => !allowedCalendar(calendar))) {
    throw new InvalidProtectedData();
  }
  options.signal?.throwIfAborted();
  const nonce = crypto.getRandomValues(new Uint8Array(32));
  const append: OtsOperation = { tag: 240, argument: nonce };
  const hash: OtsOperation = { tag: 8 };
  const commitment = await applyOtsOperation(await applyOtsOperation(digest, append), hash);
  const replies = await Promise.allSettled(calendars.map(async calendar => {
    const node = parseOtsTree(await request(calendar, "/digest", commitment, options));
    const check = serializeOtsProof({ hash: 8, digest: commitment, node });
    const claims = await evaluateOtsProof(check, commitment, options.signal);
    const hasExpectedClaim = claims.some(claim => {
      if (claim.kind === "bitcoin") return true;
      return claim.kind === "pending" && otsCalendar(claim.calendar) === calendar;
    });
    if (!hasExpectedClaim) throw new InvalidProtectedData();
    return node;
  }));
  options.signal?.throwIfAborted();
  let combined: OtsNode | undefined;
  for (const reply of replies) {
    if (reply.status !== "fulfilled") continue;
    combined = combined ? mergeOtsNodes(combined, reply.value) : reply.value;
  }
  if (!combined) throw new OpenTimestampUnavailable();
  const committedNode: OtsNode = {
    attestations: [],
    edges: [{ operation: hash, node: combined }],
  };
  return serializeOtsProof({
    hash: 8,
    digest: digest.slice(),
    node: { attestations: [], edges: [{ operation: append, node: committedNode }] },
  });
}

function mergeAtPath(root: OtsNode, path: readonly OtsOperation[], upgrade: OtsNode): void {
  let current = root;
  for (const operation of path) {
    const key = operationKey(operation);
    const edge = current.edges.find(edge => operationKey(edge.operation) === key);
    if (!edge) throw new InvalidProtectedData();
    current = edge.node;
  }
  const combined = mergeOtsNodes(current, upgrade);
  current.attestations = combined.attestations;
  current.edges = combined.edges;
}

export async function upgradeOtsProof(
  data: Uint8Array<ArrayBuffer>,
  expectedDigest: Uint8Array,
  options: OtsCalendarOptions = {},
): Promise<Uint8Array<ArrayBuffer>> {
  const proof = parseOtsProof(data, expectedDigest);
  const claims = await evaluateOtsProof(data, expectedDigest, options.signal);
  const pending = new Map<string, {
    calendar: string;
    commitment: Uint8Array<ArrayBuffer>;
    paths: OtsOperation[][];
  }>();
  for (const claim of claims) {
    if (claim.kind !== "pending") continue;
    const calendar = otsCalendar(claim.calendar);
    if (!calendar) continue;
    const key = `${calendar}/${hex(claim.message)}`;
    const value = pending.get(key) ?? { calendar, commitment: claim.message, paths: [] };
    value.paths.push(claim.path);
    pending.set(key, value);
  }
  // A malformed or adversarial proof cannot force thousands of external calls.
  if (pending.size > 16) throw new InvalidProtectedData();
  const replies = await Promise.allSettled([...pending.values()].map(async value => {
    const body = await request(value.calendar, `/timestamp/${hex(value.commitment)}`, undefined, options);
    return { ...value, node: parseOtsTree(body) };
  }));
  options.signal?.throwIfAborted();
  for (const reply of replies) {
    if (reply.status !== "fulfilled") continue;
    for (const path of reply.value.paths) {
      mergeAtPath(proof.node, path, reply.value.node);
    }
  }
  const result = serializeOtsProof(proof);
  await evaluateOtsProof(result, expectedDigest, options.signal);
  return result;
}

/** The caller must supply a canonical, independently trusted by-height block
 * source. A calendar's assertion or a receipt's own claimed time is insufficient. */
export type OtsBlockSource = (height: number, signal?: AbortSignal) => Promise<{
  height: number;
  header: Uint8Array<ArrayBuffer>;
}>;
export type OtsVerification =
  | { status: "verified"; height: number; unixTime: number }
  | { status: "pending"; calendars: string[] }
  | { status: "unverified" };

export async function verifyOtsBitcoin(
  data: Uint8Array<ArrayBuffer>,
  expectedDigest: Uint8Array,
  source?: OtsBlockSource,
  signal?: AbortSignal,
): Promise<OtsVerification> {
  const claims = await evaluateOtsProof(data, expectedDigest, signal);
  const bitcoin = claims.filter(claim => claim.kind === "bitcoin");
  if (!bitcoin.length) {
    const calendars = [...new Set(claims.filter(claim => claim.kind === "pending").map(claim => claim.calendar))];
    if (calendars.length) return { status: "pending", calendars };
    return { status: "unverified" };
  }
  if (!source) return { status: "unverified" };
  const heights = [...new Set(bitcoin.map(claim => claim.height))].sort((a, b) => a - b).slice(0, 16);
  const verified: { height: number; unixTime: number }[] = [];
  for (const height of heights) {
    signal?.throwIfAborted();
    try {
      const block = await source(height, signal);
      signal?.throwIfAborted();
      const matchesClaim = bitcoin.some(claim => claim.height === height
        && claim.message.every((byte, index) => byte === block.header[index + 36]));
      if (block.height !== height || block.header.length !== 80 || !matchesClaim) continue;
      const unixTime = new DataView(block.header.buffer, block.header.byteOffset, block.header.byteLength).getUint32(68, true);
      verified.push({ height, unixTime });
    } catch {
      signal?.throwIfAborted();
    }
  }
  verified.sort((a, b) => a.unixTime - b.unixTime);
  const earliest = verified[0];
  if (!earliest) return { status: "unverified" };
  return { status: "verified", ...earliest };
}
