import { describe, expect, test } from "bun:test";
import { createChatRequests } from "./chatRequests";

const submission = { content: "Show the project", existingMessageIds: ["old"] };

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, resolve, reject };
}

describe("chat activity across navigation", () => {
  test("retains pending activity after leaving and notifies a returning subscriber", async () => {
    const requests = createChatRequests();
    const response = deferred();
    let notifications = 0;
    const leave = requests.subscribe(() => notifications++);
    const completion = requests.start(
      "chat-a",
      submission,
      () => response.promise,
    );

    expect(requests.get("chat-a")).toEqual({
      submission,
      pending: true,
      data: null,
      error: null,
    });
    expect(notifications).toBe(1);

    leave();
    const pendingSnapshot = requests.get("chat-a");

    expect(requests.get("chat-a")).toBe(pendingSnapshot);
    expect(requests.get("chat-b")).toBeNull();

    const updates = [];
    const returnToChat = requests.subscribe(() =>
      updates.push(requests.get("chat-a")),
    );
    const answer = { messages: ["answer"], proposals: [] };
    response.resolve(answer);
    await completion;

    expect(updates).toEqual([
      { submission, pending: false, data: answer, error: null },
    ]);
    expect(requests.get("chat-a").data).toBe(answer);
    expect(notifications).toBe(1);

    returnToChat();
  });

  test("keeps independent chats separate and suppresses duplicate sends", async () => {
    const requests = createChatRequests();
    const first = deferred();
    const second = deferred();
    const firstCompletion = requests.start(
      "chat-a",
      submission,
      () => first.promise,
    );
    const secondCompletion = requests.start(
      "chat-b",
      submission,
      () => second.promise,
    );
    let duplicateSent = false;

    await requests.start("chat-a", submission, async () => {
      duplicateSent = true;
      return "duplicate";
    });
    second.resolve("second answer");
    await secondCompletion;

    expect(duplicateSent).toBe(false);
    expect(requests.get("chat-a").pending).toBe(true);
    expect(requests.get("chat-b").data).toBe("second answer");

    first.resolve("first answer");
    await firstCompletion;

    expect(requests.get("chat-a").data).toBe("first answer");
  });

  test("preserves an error after leaving and allows a subsequent retry", async () => {
    const requests = createChatRequests();
    const response = deferred();
    const completion = requests.start(
      "chat-a",
      submission,
      () => response.promise,
    );
    response.reject(new Error("Provider unavailable"));
    await completion;

    expect(requests.get("chat-a")).toEqual({
      submission,
      pending: false,
      data: null,
      error: "Provider unavailable",
    });

    await requests.start("chat-a", submission, async () => "recovered");

    expect(requests.get("chat-a").data).toBe("recovered");
    expect(requests.get("chat-a").error).toBeNull();
  });

  test("discards old session results even when the next session reuses a chat ID", async () => {
    const requests = createChatRequests();
    const response = deferred();
    const completion = requests.start(
      "chat-a",
      submission,
      () => response.promise,
    );
    const isOriginalSession = requests.sessionGuard();
    requests.clear();

    expect(requests.get("chat-a")).toBeNull();
    expect(isOriginalSession()).toBe(false);
    expect(requests.sessionGuard()()).toBe(true);

    await requests.start(
      "chat-a",
      submission,
      async () => "new session answer",
    );
    response.resolve("private old session answer");
    await completion;

    expect(requests.get("chat-a").data).toBe("new session answer");
  });

  test("tracks a proposal continuation without inventing a submitted user message", async () => {
    const requests = createChatRequests();
    const response = deferred();
    const completion = requests.start("chat-a", null, () => response.promise);

    expect(requests.get("chat-a").pending).toBe(true);
    expect(requests.get("chat-a").submission).toBeNull();

    response.resolve("continued answer");
    await completion;

    expect(requests.get("chat-a").pending).toBe(false);
    expect(requests.get("chat-a").data).toBe("continued answer");
  });

  test("clears completed conversations and notifies mounted views on auth changes", async () => {
    const requests = createChatRequests();
    await requests.start("chat-a", submission, async () => "answer");
    let snapshot;
    requests.subscribe(() => {
      snapshot = requests.get("chat-a");
    });

    requests.clear();

    expect(snapshot).toBeNull();
    expect(requests.get(null)).toBeNull();
  });
});
