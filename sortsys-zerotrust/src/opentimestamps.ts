import { InvalidProtectedData } from "./encoding";
import { ripemd160 } from "@noble/hashes/legacy.js";

// OpenTimestamps v1 wire constants. Protocol reference:
// https://github.com/opentimestamps/javascript-opentimestamps/tree/c07ba8be0dae4e8721a84f32820abf7b2547a6ce/src
const MAGIC = new Uint8Array([
  0, 79, 112, 101, 110, 84, 105, 109, 101, 115, 116, 97, 109, 112, 115, 0, 0,
  80, 114, 111, 111, 102, 0, 191, 137, 226, 232, 132, 232, 146, 148,
]);
const PENDING_ATTESTATION = "83dfe30d2ef90c8e";
const BITCOIN_ATTESTATION = "0588960d73d71901";
export const MAX_OTS_BYTES = 256 * 1024;
const MAX_NODES = 4096;
const MAX_DEPTH = 128;
const MAX_MESSAGE = 4096;
export type OtsAttestation = {
  tag: Uint8Array<ArrayBuffer>;
  payload: Uint8Array<ArrayBuffer>;
};
export type OtsOperation = {
  tag: 2 | 3 | 8 | 240 | 241 | 242 | 243;
  argument?: Uint8Array<ArrayBuffer>;
};
export type OtsNode = {
  attestations: OtsAttestation[];
  edges: { operation: OtsOperation; node: OtsNode }[];
};
export type OtsProof = {
  hash: 2 | 3 | 8;
  digest: Uint8Array<ArrayBuffer>;
  node: OtsNode;
};
type AttestationClaim =
  | { kind: "pending"; calendar: string }
  | { kind: "bitcoin"; height: number }
  | { kind: "unknown"; tag: string };

export type OtsClaim = {
  message: Uint8Array<ArrayBuffer>;
  path: OtsOperation[];
} & AttestationClaim;

export class UnsupportedOpenTimestamp extends Error {
  constructor() {
    super("Unsupported OpenTimestamps hash operation");
    this.name = "UnsupportedOpenTimestamp";
  }
}
const hex = (value: Uint8Array) =>
  Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const equalBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length &&
  left.every((byte, index) => byte === right[index]);

export function otsConcat(...values: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = values.reduce((sum, value) => sum + value.length, 0);
  if (length > MAX_OTS_BYTES) {
    throw new InvalidProtectedData();
  }

  const result = new Uint8Array(length);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.length;
  }
  return result;
}
class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array<ArrayBuffer>) {}
  take(length: number) {
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > this.data.length - this.offset
    ) {
      throw new InvalidProtectedData();
    }

    const result = this.data.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  byte() {
    return this.take(1)[0]!;
  }
  uint() {
    let value = 0;
    let factor = 1;
    for (let index = 0; index < 8; index++) {
      const byte = this.byte();
      value += (byte & 127) * factor;
      if (!Number.isSafeInteger(value)) {
        throw new InvalidProtectedData();
      }

      const hasMoreBytes = (byte & 128) !== 0;
      if (!hasMoreBytes) {
        const hasRedundantFinalByte = index > 0 && byte === 0;
        if (hasRedundantFinalByte) {
          throw new InvalidProtectedData();
        }
        return value;
      }
      factor *= 128;
    }
    throw new InvalidProtectedData();
  }
  variable(limit: number, minimum = 0) {
    const length = this.uint();
    if (length < minimum || length > limit) {
      throw new InvalidProtectedData();
    }
    return this.take(length);
  }
  end() {
    if (this.offset !== this.data.length) {
      throw new InvalidProtectedData();
    }
  }
}
function uint(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidProtectedData();
  }
  const result = [];
  do {
    const part = value % 128;
    value = Math.floor(value / 128);
    const hasMoreBytes = value !== 0;
    result.push(part | (hasMoreBytes ? 128 : 0));
  } while (value !== 0);
  return new Uint8Array(result);
}
const variable = (value: Uint8Array) => otsConcat(uint(value.length), value);
function attestation(value: OtsAttestation): AttestationClaim {
  if (value.tag.length !== 8 || value.payload.length > 8192) {
    throw new InvalidProtectedData();
  }
  const tag = hex(value.tag);
  const reader = new Reader(value.payload);
  if (tag === PENDING_ATTESTATION) {
    const bytes = reader.variable(1000);
    reader.end();
    const calendar = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!/^[A-Za-z0-9\-._/:]*$/.test(calendar)) {
      throw new InvalidProtectedData();
    }
    return { kind: "pending", calendar };
  }
  if (tag === BITCOIN_ATTESTATION) {
    const height = reader.uint();
    reader.end();
    return { kind: "bitcoin", height };
  }
  return { kind: "unknown", tag };
}
function readNode(
  reader: Reader,
  budget: { nodes: number },
  depth = 0,
): OtsNode {
  budget.nodes += 1;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES) {
    throw new InvalidProtectedData();
  }
  const node: OtsNode = { attestations: [], edges: [] };
  for (;;) {
    let tag = reader.byte();
    const hasMoreBranches = tag === 255;
    if (hasMoreBranches) {
      tag = reader.byte();
    }
    if (tag === 0) {
      budget.nodes += 1;
      if (budget.nodes > MAX_NODES) {
        throw new InvalidProtectedData();
      }
      const value = { tag: reader.take(8), payload: reader.variable(8192) };
      attestation(value);
      node.attestations.push(value);
    } else {
      if (![2, 3, 8, 240, 241, 242, 243].includes(tag)) {
        throw new UnsupportedOpenTimestamp();
      }
      const operation: OtsOperation = { tag: tag as OtsOperation["tag"] };
      const hasArgument = tag === 240 || tag === 241;
      if (hasArgument) {
        operation.argument = reader.variable(MAX_MESSAGE, 1);
      }
      node.edges.push({ operation, node: readNode(reader, budget, depth + 1) });
    }
    if (node.attestations.length + node.edges.length > MAX_NODES) {
      throw new InvalidProtectedData();
    }
    if (!hasMoreBranches) {
      return node;
    }
  }
}
export function parseOtsTree(data: Uint8Array<ArrayBuffer>): OtsNode {
  if (!data.length || data.length > MAX_OTS_BYTES) {
    throw new InvalidProtectedData();
  }
  const reader = new Reader(data);
  const node = readNode(reader, { nodes: 0 });
  reader.end();
  return node;
}
export function parseOtsProof(
  data: Uint8Array<ArrayBuffer>,
  expectedDigest?: Uint8Array,
): OtsProof {
  if (!data.length || data.length > MAX_OTS_BYTES) {
    throw new InvalidProtectedData();
  }
  const reader = new Reader(data);
  const matchesFormat = equalBytes(reader.take(MAGIC.length), MAGIC);
  if (!matchesFormat || reader.uint() !== 1) {
    throw new InvalidProtectedData();
  }
  const hash = reader.byte();
  if (![2, 3, 8].includes(hash)) {
    throw new UnsupportedOpenTimestamp();
  }
  const digest = reader.take(hash === 8 ? 32 : 20);
  if (expectedDigest && (hash !== 8 || !equalBytes(expectedDigest, digest))) {
    throw new InvalidProtectedData();
  }
  const node = readNode(reader, { nodes: 0 });
  reader.end();
  return { hash: hash as OtsProof["hash"], digest, node };
}
function operationBytes(operation: OtsOperation) {
  if (![2, 3, 8, 240, 241, 242, 243].includes(operation.tag)) {
    throw new UnsupportedOpenTimestamp();
  }
  if (operation.tag === 240 || operation.tag === 241) {
    if (
      !operation.argument?.length ||
      operation.argument.length > MAX_MESSAGE
    ) {
      throw new InvalidProtectedData();
    }
    return otsConcat(
      new Uint8Array([operation.tag]),
      variable(operation.argument),
    );
  }
  if (operation.argument !== undefined) {
    throw new InvalidProtectedData();
  }
  return new Uint8Array([operation.tag]);
}
function writeNode(
  node: OtsNode,
  budget: { nodes: number },
  depth = 0,
): Uint8Array<ArrayBuffer> {
  budget.nodes += 1;
  const emptyNode = node.attestations.length === 0 && node.edges.length === 0;
  if (depth > MAX_DEPTH || budget.nodes > MAX_NODES || emptyNode) {
    throw new InvalidProtectedData();
  }

  const branches: Uint8Array<ArrayBuffer>[] = [];
  for (const value of node.attestations) {
    budget.nodes += 1;
    if (budget.nodes > MAX_NODES) {
      throw new InvalidProtectedData();
    }
    attestation(value);
    branches.push(
      otsConcat(new Uint8Array([0]), value.tag, variable(value.payload)),
    );
  }
  for (const edge of node.edges) {
    const operation = operationBytes(edge.operation);
    const child = writeNode(edge.node, budget, depth + 1);
    branches.push(otsConcat(operation, child));
  }
  if (branches.length > MAX_NODES) {
    throw new InvalidProtectedData();
  }

  const encodedBranches: Uint8Array<ArrayBuffer>[] = [];
  for (const [index, branch] of branches.entries()) {
    if (index < branches.length - 1) {
      encodedBranches.push(new Uint8Array([255]));
    }
    encodedBranches.push(branch);
  }
  return otsConcat(...encodedBranches);
}

export function serializeOtsTree(node: OtsNode): Uint8Array<ArrayBuffer> {
  return writeNode(node, { nodes: 0 });
}

export function serializeOtsProof(proof: OtsProof): Uint8Array<ArrayBuffer> {
  const expectedDigestLength = proof.hash === 8 ? 32 : 20;
  if (
    ![2, 3, 8].includes(proof.hash) ||
    proof.digest.length !== expectedDigestLength
  ) {
    throw new InvalidProtectedData();
  }
  return otsConcat(
    MAGIC,
    uint(1),
    new Uint8Array([proof.hash]),
    proof.digest,
    serializeOtsTree(proof.node),
  );
}
export async function applyOtsOperation(
  message: Uint8Array<ArrayBuffer>,
  operation: OtsOperation,
): Promise<Uint8Array<ArrayBuffer>> {
  operationBytes(operation);
  if (message.length > MAX_MESSAGE) {
    throw new InvalidProtectedData();
  }
  let result: Uint8Array<ArrayBuffer>;
  switch (operation.tag) {
    case 2:
      result = new Uint8Array(await crypto.subtle.digest("SHA-1", message));
      break;
    case 8:
      result = new Uint8Array(await crypto.subtle.digest("SHA-256", message));
      break;
    case 3:
      result = new Uint8Array(ripemd160(message));
      break;
    case 240:
      result = otsConcat(message, operation.argument!);
      break;
    case 241:
      result = otsConcat(operation.argument!, message);
      break;
    case 242:
      if (!message.length) {
        throw new InvalidProtectedData();
      }
      result = message.slice().reverse();
      break;
    case 243:
      if (!message.length || message.length > MAX_MESSAGE / 2) {
        throw new InvalidProtectedData();
      }
      result = new TextEncoder().encode(hex(message));
      break;
    default:
      throw new UnsupportedOpenTimestamp();
  }
  if (result.length > MAX_MESSAGE) {
    throw new InvalidProtectedData();
  }
  return result;
}
/** This evaluates commitment paths; a Bitcoin claim is not verified until a
 * trusted by-height block source independently confirms its Merkle root. */
export async function evaluateOtsProof(
  data: Uint8Array<ArrayBuffer>,
  expectedDigest?: Uint8Array,
  signal?: AbortSignal,
): Promise<OtsClaim[]> {
  const proof = parseOtsProof(data, expectedDigest);
  const claims: OtsClaim[] = [];
  async function visit(
    node: OtsNode,
    message: Uint8Array<ArrayBuffer>,
    path: OtsOperation[],
  ) {
    signal?.throwIfAborted();
    for (const value of node.attestations) {
      const claim = attestation(value);
      if (claim.kind === "bitcoin" && message.length !== 32) {
        throw new InvalidProtectedData();
      }
      claims.push({ ...claim, message: message.slice(), path: [...path] });
    }
    for (const edge of node.edges) {
      const childMessage = await applyOtsOperation(message, edge.operation);
      await visit(edge.node, childMessage, [...path, edge.operation]);
    }
  }
  await visit(proof.node, proof.digest, []);
  signal?.throwIfAborted();
  return claims;
}

function compareBranchKeys(
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown],
): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

/** Merge an upgraded calendar branch without dropping earlier attestations. */
export function mergeOtsNodes(first: OtsNode, second: OtsNode): OtsNode {
  const left = parseOtsTree(serializeOtsTree(first));
  const right = parseOtsTree(serializeOtsTree(second));

  function merge(left: OtsNode, right: OtsNode, depth: number): OtsNode {
    if (depth > MAX_DEPTH) {
      throw new InvalidProtectedData();
    }

    const attestations = new Map<string, OtsAttestation>();
    for (const value of [...left.attestations, ...right.attestations]) {
      const key = hex(otsConcat(value.tag, variable(value.payload)));
      attestations.set(key, value);
    }

    const edges = new Map<string, OtsNode["edges"][number]>();
    for (const edge of [...left.edges, ...right.edges]) {
      const key = hex(operationBytes(edge.operation));
      const previous = edges.get(key);
      let node = edge.node;
      if (previous) {
        node = merge(previous.node, edge.node, depth + 1);
      }
      edges.set(key, { operation: edge.operation, node });
    }
    return {
      attestations: [...attestations]
        .sort(compareBranchKeys)
        .map(([, value]) => value),
      edges: [...edges].sort(compareBranchKeys).map(([, edge]) => edge),
    };
  }
  const result = merge(left, right, 0);
  serializeOtsTree(result);
  return result;
}
