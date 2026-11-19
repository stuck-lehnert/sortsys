import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import {
  chatDate,
  chatDecision,
  chatOperation,
  chatProposal,
  chatText,
  proposalPrefix,
  type ChatProposal,
} from "./chatData";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

export type LegacyChatProposal = {
  format: "sortsys-chat-legacy-proposal-v1";
  source: BusinessRow;
  review: Pick<
    ChatProposal,
    "status" | "executionResults" | "reviewComment" | "reviewedAt"
  > | null;
};

export function legacyChatDate(input: unknown): string {
  return chatDate(
    timestampFromMicros(timestampMicros(timestampInstant(input))),
  );
}

function sourceProposal(
  input: unknown,
  object: string,
): { source: BusinessRow; proposal: ChatProposal } {
  const source = decodeBusinessRow(input);
  if (source.table !== "llm_change_proposals") throw new InvalidProtectedData();
  const values = source.values;
  const id = publicId(values.id);
  const chatId = publicId(values.chat_id);
  if (object !== proposalPrefix(chatId) + id) throw new InvalidProtectedData();
  let assistantMessageId: string | null = null;
  if (values.assistant_message_id !== null)
    assistantMessageId = publicId(values.assistant_message_id);
  const operations = JSON.parse(values.operations as string);
  if (
    !Array.isArray(operations) ||
    !operations.length ||
    operations.length > 10
  )
    throw new InvalidProtectedData();
  const status = values.status;
  if (
    status !== "pending" &&
    status !== "accepted" &&
    status !== "declined" &&
    status !== "revision_requested"
  ) {
    throw new InvalidProtectedData();
  }
  const proposal: ChatProposal = {
    format: "sortsys-chat-proposal-v1",
    chatId,
    id,
    assistantMessageId,
    title: chatText(values.title, 160),
    summary: chatText(values.summary, 2000),
    operations: operations.map(chatOperation),
    executionResults: null,
    status,
    reviewComment:
      values.review_comment === null
        ? null
        : chatText(values.review_comment, 2000, true),
    createdAt: legacyChatDate(values.created_at),
    reviewedAt:
      values.reviewed_at === null ? null : legacyChatDate(values.reviewed_at),
  };
  // The original decision and its optional result remain separate facts. An old
  // accepted proposal is not evidence that its business operations ran again.
  if (values.execution_results !== null) {
    const checked = chatDecision(
      {
        status: proposal.status,
        executionResults: JSON.parse(values.execution_results as string),
        reviewComment: proposal.reviewComment,
        reviewedAt: proposal.reviewedAt,
      },
      proposal.operations,
      proposal.createdAt,
    );
    proposal.executionResults = checked.executionResults;
  }
  return { source, proposal };
}

export function legacyProposalPayload(
  input: unknown,
  object: string,
): LegacyChatProposal {
  const value = record(input, ["format", "source", "review"]);
  if (value.format !== "sortsys-chat-legacy-proposal-v1")
    throw new InvalidProtectedData();
  const { source, proposal } = sourceProposal(value.source, object);
  if (value.review === null)
    return { format: value.format, source, review: null };
  const review = record(value.review, [
    "status",
    "executionResults",
    "reviewComment",
    "reviewedAt",
  ]);
  if (proposal.status !== "pending" && proposal.status !== "revision_requested")
    throw new InvalidProtectedData();
  if (review.status === "pending") throw new InvalidProtectedData();
  const checked = chatDecision(review, proposal.operations, proposal.createdAt);
  if (proposal.reviewedAt && checked.reviewedAt! < proposal.reviewedAt)
    throw new InvalidProtectedData();
  return {
    format: value.format,
    source,
    review: {
      status: checked.status,
      executionResults: checked.executionResults,
      reviewComment: checked.reviewComment,
      reviewedAt: checked.reviewedAt,
    },
  };
}

export function readLegacyProposal(
  input: unknown,
  object: string,
): ChatProposal {
  const value = legacyProposalPayload(input, object);
  const { proposal } = sourceProposal(value.source, object);
  if (value.review) Object.assign(proposal, value.review);
  return proposal;
}

export function readChatProposal(input: unknown, object: string): ChatProposal {
  if (isLegacyProposal(input)) return readLegacyProposal(input, object);
  return chatProposal(input, object);
}

export function isLegacyProposal(input: unknown): input is LegacyChatProposal {
  return (
    !!input &&
    typeof input === "object" &&
    "format" in input &&
    input.format === "sortsys-chat-legacy-proposal-v1"
  );
}

/** A new decision can only replace the review, never the archived source.
 * Current decisions still need complete, matching execution results. */
export function prepareLegacyReview(
  input: ChatProposal,
  previous: unknown,
  object: string,
): LegacyChatProposal {
  const legacy = legacyProposalPayload(previous, object);
  const before = readLegacyProposal(legacy, object);
  const fixed = (value: ChatProposal) => ({
    format: value.format,
    chatId: value.chatId,
    id: value.id,
    assistantMessageId: value.assistantMessageId,
    title: value.title,
    summary: value.summary,
    operations: value.operations,
    createdAt: value.createdAt,
  });
  if (JSON.stringify(fixed(input)) !== JSON.stringify(fixed(before)))
    throw new InvalidProtectedData();
  if (before.status !== "pending" && before.status !== "revision_requested")
    throw new InvalidProtectedData();
  if (
    before.reviewedAt &&
    input.reviewedAt &&
    input.reviewedAt < before.reviewedAt
  )
    throw new InvalidProtectedData();
  return legacyProposalPayload(
    {
      ...legacy,
      review: {
        status: input.status,
        executionResults: input.executionResults,
        reviewComment: input.reviewComment,
        reviewedAt: input.reviewedAt,
      },
    },
    object,
  );
}
