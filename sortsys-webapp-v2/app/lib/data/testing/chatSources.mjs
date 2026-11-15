import { row } from "./businessRow.mjs";

export const CHAT_PRIVATE_TITLE = "Fenstersanierung 613947";
export const CHAT_PRIVATE_MESSAGE =
  "Fensterflächen aufnehmen.\nLaibungen getrennt kalkulieren: ÄÖÜß 472915.";
const createdAt = "2026-11-01T10:20:30.123456Z";
const reviewedAt = "2026-11-01T10:21:30.654321Z";

export function legacyChatSources() {
  const operation = {
    path: "products.create",
    input: {
      customId: 583192,
      name: "Historisches Putzprofil 583192",
      description: "Laibungsanschluss",
      baseUnit: "m",
    },
    description: "Putzprofil im Katalog anlegen",
  };
  const proposal = (id, status, changes = {}) =>
    row("llm_change_proposals", {
      id,
      chat_id: "10",
      assistant_message_id: "21",
      title: "Katalog ergänzen",
      summary: "Profil für die Fenstersanierung",
      operations: JSON.stringify([operation]),
      execution_results: null,
      status,
      review_comment: null,
      created_at: createdAt,
      reviewed_at: reviewedAt,
      ...changes,
    });
  return {
    chats: [
      row("llm_chats", {
        id: "10",
        user_id: "1",
        title: CHAT_PRIVATE_TITLE,
        created_at: createdAt,
        updated_at: reviewedAt,
      }),
      row("llm_chats", {
        id: "11",
        user_id: "2",
        title: "Privater Verlauf eines anderen Kontos",
        created_at: createdAt,
        updated_at: reviewedAt,
      }),
    ],
    messages: [
      row("llm_messages", {
        id: "20",
        chat_id: "10",
        role: "user",
        content: CHAT_PRIVATE_MESSAGE,
        created_at: createdAt,
      }),
      row("llm_messages", {
        id: "21",
        chat_id: "10",
        role: "assistant",
        content: "Die Leistungen werden getrennt geführt.",
        created_at: reviewedAt,
      }),
      row("llm_messages", {
        id: "22",
        chat_id: "11",
        role: "user",
        content: "Nur im zweiten Konto 729361",
        created_at: createdAt,
      }),
    ],
    proposals: [
      proposal("30", "accepted", { assistant_message_id: null }),
      proposal("31", "accepted", {
        execution_results: JSON.stringify([
          { path: operation.path, output: { id: "99" } },
        ]),
      }),
      proposal("32", "declined", { review_comment: "Nicht übernehmen" }),
      proposal("33", "revision_requested", {
        review_comment: "Andere Einheit verwenden",
      }),
      proposal("34", "pending", {
        assistant_message_id: null,
        reviewed_at: null,
      }),
    ],
  };
}
