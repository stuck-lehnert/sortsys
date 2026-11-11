import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
export type JsonValue = QueryResult<"llm.chats.get">["proposals"][number]["operations"];

export function jsonValue(input: unknown, depth = 0): JsonValue {
  if (depth > 64) throw new InvalidProtectedData();
  if (input === null || typeof input === "boolean") return input;
  if (typeof input === "string" && !input.includes("\0")) return input;
  if (typeof input === "number" && Number.isFinite(input)) return input;
  if (Array.isArray(input) && input.length <= 10000) return input.map(value => jsonValue(value, depth + 1));
  if (input && typeof input === "object" && Object.getPrototypeOf(input) === Object.prototype) {
    const entries = Object.entries(input);
    if (entries.length > 10000 || entries.some(([key]) => key.includes("\0") || ["__proto__", "constructor", "prototype"].includes(key))) throw new InvalidProtectedData();
    return Object.fromEntries(entries.map(([key, value]) => [key, jsonValue(value, depth + 1)]));
  }
  throw new InvalidProtectedData();
}
