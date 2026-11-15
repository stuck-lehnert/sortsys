/** A missing key or unverified policy is a connection failure. It must never
 * turn an otherwise valid packet into a permanently skipped log entry. */
export class MessageProofUnavailable extends Error {
  constructor(cause: unknown) {
    super("Protected message proof unavailable", { cause });
    this.name = "MessageProofUnavailable";
  }
}

export class StaleMessageProof extends Error {
  constructor() {
    super("Protected message context needs refresh");
    this.name = "StaleMessageProof";
  }
}

export async function requiredMessageProof<T>(
  load: () => Promise<T>,
): Promise<T> {
  try {
    return await load();
  } catch (error) {
    throw new MessageProofUnavailable(error);
  }
}
