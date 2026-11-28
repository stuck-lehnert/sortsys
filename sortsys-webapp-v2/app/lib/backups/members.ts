import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  digest,
  InvalidProtectedData,
  sign,
  verify,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import { memberCreationFrame } from "../crypto/members";
import { readBusinessRows, type BusinessDatabase } from "../data/database";
import { publicId } from "../data/products";
import { required } from "../data/protectedObjects";
import { timestampMicros } from "../data/timestamps";

/** Keep source identifiers and lifecycle state, with no old credentials or
 * grants. Each person still needs a new invitation before they can sign in. */
export async function reserveBackupMembers(
  client: Client,
  database: BusinessDatabase,
  sourceOwner: string,
  context: string,
  signal: AbortSignal,
) {
  const admin = await administratorContext(client, signal);
  const users = await readBusinessRows(database, "users");
  if (!users.some((user) => publicId(user.values.id) === sourceOwner))
    throw new InvalidProtectedData();
  for (const user of users) {
    admin.live();
    const id = publicId(user.values.id);
    if (id === sourceOwner) continue;
    const value = user.values;
    if (
      typeof value.username !== "string" ||
      !["de", "en"].includes(String(value.ui_locale))
    )
      throw new InvalidProtectedData();
    const source = {
      context,
      locale: value.ui_locale as "de" | "en",
      createdMicros: timestampMicros(String(value.created_at)).toString(),
      modifiedMicros: timestampMicros(String(value.modified_at)).toString(),
      deactivatedMicros:
        value.deactivated_at === null
          ? null
          : timestampMicros(String(value.deactivated_at)).toString(),
      archivedMicros:
        value.archived_at === null
          ? null
          : timestampMicros(String(value.archived_at)).toString(),
    };
    const [previous, error] = await client.query(
      "zerotrust.members.creation",
      { id },
      { strategy: "network-only" },
    );
    admin.live();
    if (previous) {
      const saved = previous.creation;
      const expected = {
        ...saved,
        tenant: admin.account.tenant,
        id,
        username: value.username,
        source,
      };
      if (
        (await digest(memberCreationFrame(saved))) !==
        (await digest(memberCreationFrame(expected)))
      )
        throw new InvalidProtectedData();
      await verify(
        admin.history.authority(saved.generation),
        saved.proof,
        memberCreationFrame(saved),
      );
      continue;
    }
    if (
      error &&
      (!("data" in error) ||
        (error.data as { httpCode?: unknown } | null)?.httpCode !== 404)
    )
      throw error;
    const unsigned = {
      tenant: admin.account.tenant,
      generation: admin.history.current.generation,
      author: `user:${admin.session.user.id}`,
      id,
      username: value.username,
      source,
    };
    const request: MutateInput<"zerotrust.members.create"> = {
      ...unsigned,
      proof: await sign(admin.authority, memberCreationFrame(unsigned)),
    };
    const [, failure] = await client.mutate(
      "zerotrust.members.create",
      request,
    );
    admin.live();
    const saved = await required(
      client.query(
        "zerotrust.members.creation",
        { id },
        { strategy: "network-only" },
      ),
    ).catch((error) => {
      throw failure ?? error;
    });
    if (
      saved.creation.proof !== request.proof ||
      (await digest(memberCreationFrame(saved.creation))) !==
        (await digest(memberCreationFrame(request)))
    )
      throw new InvalidProtectedData();
    await verify(
      admin.history.authority(saved.creation.generation),
      saved.creation.proof,
      memberCreationFrame(saved.creation),
    );
  }
}
