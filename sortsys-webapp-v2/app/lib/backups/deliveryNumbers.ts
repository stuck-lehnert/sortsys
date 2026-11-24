import type { Client, MutateInput } from "@sortsys/v2-client";
import { arrayBatches } from "@sortsys/zerotrust";
import { frame, InvalidProtectedData, sign } from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import { readInitializationSource } from "../crypto/initializationSource";
import { publicId } from "../data/products";
import { required } from "../data/protectedObjects";
import type { BusinessRow } from "../data/rowCodec";

type Adoption = MutateInput<"zerotrust.deliveryNotes.adopt">;
export function deliveryAdoptionFrame(
  tenant: string,
  subject: string,
  input: Omit<Adoption, "proof">,
) {
  return frame("sortsys/delivery-adopt/v1", [
    tenant,
    subject,
    input.context,
    input.generation,
    input.policyVersion,
    String(input.allocations.length),
    ...input.allocations.flatMap((value) => [
      value.id,
      value.projectId,
      value.number,
    ]),
  ]);
}

export async function adoptDeliveryNumbers(
  client: Client,
  rows: readonly BusinessRow[],
  signal: AbortSignal,
) {
  if (rows.length === 0) return;
  const admin = await administratorContext(client, signal);
  const state = await readInitializationSource(client, signal);
  if (!state?.source || state.completion) throw new InvalidProtectedData();
  const status = await required(
    client.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  if (status.generation !== admin.history.current.generation)
    throw new InvalidProtectedData();
  for (const page of arrayBatches(rows, 64)) {
    const allocations = page.map((row) => {
      if (
        row.table !== "product_delivery_notes" ||
        typeof row.values.auto_id !== "string" ||
        !/^[1-9]\d*$/.test(row.values.auto_id)
      )
        throw new InvalidProtectedData();
      return {
        id: publicId(row.values.id),
        projectId: publicId(row.values.project_id),
        number: row.values.auto_id,
      };
    });
    const unsigned = {
      context: state.context,
      generation: status.generation,
      policyVersion: status.policyVersion,
      allocations,
    };
    const message = deliveryAdoptionFrame(
      admin.account.tenant,
      `user:${admin.session.user.id}`,
      unsigned,
    );
    const request: MutateInput<"zerotrust.deliveryNotes.adopt"> = {
      ...unsigned,
      proof: await sign(admin.authority, message),
    };
    admin.live();
    let error: unknown;
    try {
      await required(
        client.mutate("zerotrust.deliveryNotes.adopt", request, { signal }),
      );
      continue;
    } catch (failure) {
      error = failure;
    }
    // The same signed batch resolves an acknowledgement lost after commit.
    admin.live();
    await required(
      client.mutate("zerotrust.deliveryNotes.adopt", request, { signal }),
    ).catch((failure) => {
      throw error ?? failure;
    });
  }
}
