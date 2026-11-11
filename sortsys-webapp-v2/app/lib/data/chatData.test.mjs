import { expect, test } from "bun:test";
import { chatDate, chatHead, chatMessage, chatProposal, headId, messagePrefix, nextChatDate, proposalPrefix } from "./chatData";

const at = "2026-11-09T10:20:30.123456Z";
const head = { format: "sortsys-chat-v1", id: "1", title: "Projektfrage", automaticTitle: false, createdAt: at, updatedAt: at, deleted: false };
const proposal = { format: "sortsys-chat-proposal-v1", chatId: "1", id: "3", assistantMessageId: "2", title: "Projekt ergänzen", summary: "Ein historischer Vorschlag",
  operations: [{ path: "projects.create", input: { name: "Anbau", metadata: [null, true, 12.5] }, description: "Projekt anlegen" }],
  executionResults: null, status: "pending", reviewComment: null, createdAt: at, reviewedAt: null };

test("chat dates preserve migrated microseconds, reject invalid calendar values and remain ordered across clock skew", () => {
  expect(chatDate(at)).toBe(at);
  expect(chatDate("2026-11-09T10:20:30.123Z")).toBe("2026-11-09T10:20:30.123000Z");
  for (const value of ["2026-02-30T10:20:30.123Z", "2026-11-09", "2026-11-09T10:20:30.123+01:00", "2026-11-09T10:20:30.1Z"]) expect(() => chatDate(value)).toThrow();
  expect(nextChatDate("2099-12-31T23:59:59.999999Z")).toBe("2100-01-01T00:00:00.000000Z");
  expect(nextChatDate("2099-11-09T10:20:30.123456Z")).toBe("2099-11-09T10:20:30.123457Z");
  expect(nextChatDate("2099-11-09T10:20:30.123Z")).toBe("2099-11-09T10:20:30.123001Z");
});

test("chat records bind their object identity and reject unknown fields and invalid values", () => {
  expect(chatHead(head, headId("1"))).toEqual(head);
  expect(() => chatHead(head, headId("2"))).toThrow();
  expect(() => chatHead({ ...head, extra: true }, headId("1"))).toThrow();
  expect(() => chatHead({ ...head, updatedAt: "2026-11-09T10:20:30.123455Z" }, headId("1"))).toThrow();
  const message = { format: "sortsys-chat-message-v1", chatId: "1", id: "2", role: "user", content: "Anfrage", createdAt: at };
  expect(chatMessage(message, messagePrefix("1") + "2").content).toBe("Anfrage");
  for (const change of [{ role: "system" }, { content: "" }, { content: "a\0b" }, { content: "ä".repeat(10001) }, { chatId: "2" }]) expect(() => chatMessage({ ...message, ...change }, messagePrefix("1") + "2")).toThrow();
});

test("historical operations remain readable without granting permission to execute them", () => {
  expect(chatProposal(proposal, proposalPrefix("1") + "3").operations[0].path).toBe("projects.create");
  const accepted = { ...proposal, status: "accepted", reviewedAt: at, executionResults: [{ path: "projects.create", output: { id: "4", created: true } }] };
  expect(chatProposal(accepted, proposalPrefix("1") + "3").executionResults).toEqual(accepted.executionResults);
  for (const change of [{ executionResults: [] }, { status: "accepted" }, { reviewedAt: at }, { operations: [] },
    { operations: [{ ...proposal.operations[0], input: JSON.parse('{"__proto__":{"admin":true}}') }] },
    { operations: [{ ...proposal.operations[0], input: { value: NaN } }] },
    { operations: [{ ...proposal.operations[0], path: "auth;logout" }] }]) expect(() => chatProposal({ ...proposal, ...change }, proposalPrefix("1") + "3")).toThrow();
  expect(() => chatProposal({ ...accepted, executionResults: [{ path: "products.create", output: { id: "4" } }] }, proposalPrefix("1") + "3")).toThrow();
});
