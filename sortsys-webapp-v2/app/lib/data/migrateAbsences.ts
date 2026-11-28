import type { Client } from "@sortsys/v2-client";
import {
  attestMigrationOrigin,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import {
  absenceCollection,
  absenceDecisionArea,
  absenceRequestArea,
  absenceState,
  attestLegacyAbsence,
  verifyLegacyAbsence,
  type AbsenceDecision,
  type AbsenceRequest,
} from "./absenceData";
import { commitProtectedWrites } from "./atomicWrites";
import { readBusinessRows, type BusinessDatabase, type DuckDriver } from "./database";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { acquireDataRuntime } from "./runtime/session";

type SourceAuthority = {
  tenant: string;
  generation: string;
  key: CryptoKey;
  publicKey(generation: string): CryptoKey;
  live(): void;
};
const body = (value: AbsenceRequest | AbsenceDecision) =>
  JSON.stringify({ ...value, legacy: null });

/** A migrated decision retains its original actor and timestamp. Only the
 * tenant authority may attest this exception to the normal signer binding. */
export async function copyAbsenceRecords(
  client: Client,
  rows: BusinessRow[],
  users: string[],
  authority: SourceAuthority,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  const pairs = users.map((user) => ({
    user,
    request: absenceRequestArea(user),
    decision: absenceDecisionArea(user),
  }));
  const people = new Set(users),
    ids = new Set<string>();
  for (const row of rows) {
    if (
      row.table !== "user_vacations" ||
      !people.has(publicId(row.values.user_id)) ||
      ids.has(publicId(row.values.id))
    )
      throw new InvalidProtectedData();
    ids.add(publicId(row.values.id));
    for (const column of ["requested_by_user_id", "decided_by_user_id"])
      if (
        row.values[column] !== null &&
        !people.has(publicId(row.values[column]))
      )
        throw new InvalidProtectedData();
  }
  const lease = acquireDataRuntime(client, signal, driver),
    { runtime } = lease;
  const live = () => {
    lease.live();
    authority.live();
  };
  async function checked(value: AbsenceRequest | AbsenceDecision) {
    if (!value.legacy) throw new InvalidProtectedData();
    await verifyLegacyAbsence(value, authority.tenant, authority.publicKey);
    live();
  }
  try {
    for (const pair of pairs) {
      const selected = [pair.request, pair.decision],
        expected = rows.filter(
          (row) => publicId(row.values.user_id) === pair.user,
        );
      // Refuse extra objects before resuming. A changed destination is never
      // repaired by overwriting or by manufacturing a replacement source.
      await runtime.read(selected, async (view) => {
        for (const request of view.documents(pair.request))
          if (
            !expected.some(
              (row) =>
                pair.request.area.prefix + publicId(row.values.id) ===
                request.id,
            )
          )
            throw new InvalidProtectedData();
        for (const decision of view.documents(pair.decision))
          if (
            !expected.some(
              (row) =>
                row.values.status !== "requested" &&
                pair.decision.area.prefix + publicId(row.values.id) ===
                  decision.id,
            )
          )
            throw new InvalidProtectedData();
      });
      for (const original of expected) {
        live();
        const id = publicId(original.values.id),
          requestId = pair.request.area.prefix + id,
          decisionId = pair.decision.area.prefix + id;
        const source: AbsenceRequest = {
          format: "sortsys-absence-request-v1",
          legacy: null,
          row: decodeBusinessRow({
            ...original,
            values: {
              ...original.values,
              status: "requested",
              denial_reason: null,
              decided_by_user_id: null,
              decided_at: null,
            },
          }),
        };
        if (
          !["requested", "approved", "denied"].includes(
            original.values.status as string,
          ) ||
          (original.values.status === "requested" &&
            (original.values.denial_reason !== null ||
              original.values.decided_by_user_id !== null ||
              original.values.decided_at !== null))
        )
          throw new InvalidProtectedData();
        const migrated = await attestLegacyAbsence(
          source,
          authority.tenant,
          authority.generation,
          authority.key,
        );
        live();
        if (migrated.format !== source.format) throw new InvalidProtectedData();
        const prepared = await runtime.prepare(selected, async (tx) => {
          const existing = tx
            .documents(pair.request)
            .find((doc) => doc.id === requestId);
          if (existing) {
            await checked(existing.value);
            if (body(existing.value) !== body(migrated))
              throw new InvalidProtectedData();
          } else tx.create(pair.request, requestId, migrated);
          return existing?.signature;
        });
        let decision: Awaited<ReturnType<typeof runtime.prepare>> | undefined;
        try {
          const signature =
            prepared.value ??
            prepared.groups
              .flatMap((group) => group.packets)
              .find((packet) => packet.envelope.object === requestId)?.envelope
              .signature;
          if (!signature) throw new InvalidProtectedData();
          if (original.values.status !== "requested") {
            const value = await attestLegacyAbsence(
              {
                format: "sortsys-absence-decision-v1",
                legacy: null,
                userId: pair.user,
                id,
                requestSignature: signature,
                status: original.values.status as "approved" | "denied",
                denialReason: original.values.denial_reason as string | null,
                decidedByUserId:
                  original.values.decided_by_user_id === null
                    ? null
                    : publicId(original.values.decided_by_user_id),
                decidedAt: original.values.decided_at as string | null,
                modifiedAt: original.values.modified_at as string,
              },
              authority.tenant,
              authority.generation,
              authority.key,
            );
            live();
            if (value.format !== "sortsys-absence-decision-v1")
              throw new InvalidProtectedData();
            decision = await runtime.prepare(selected, async (tx) => {
              const existing = tx
                .documents(pair.decision)
                .find((doc) => doc.id === decisionId);
              if (existing) {
                await checked(existing.value);
                if (body(existing.value) !== body(value))
                  throw new InvalidProtectedData();
              } else tx.create(pair.decision, decisionId, value);
            });
          }
          const groups = [...prepared.groups, ...(decision?.groups ?? [])];
          for (const group of groups)
            for (const packet of group.packets)
              packet.migrationOrigin = await attestMigrationOrigin(
                packet.envelope,
                authority.generation,
                authority.key,
              );
          if (groups.length)
            await commitProtectedWrites(client, groups, signal, [
              ...prepared.guards,
              ...(decision?.guards ?? []),
            ]);
          live();
        } finally {
          prepared.close();
          decision?.close();
        }
      }
      await runtime.read(selected, async (view) => {
        const requests = view.documents(pair.request),
          decisions = view.documents(pair.decision);
        if (
          requests.length !== expected.length ||
          decisions.length !==
            expected.filter((row) => row.values.status !== "requested").length
        )
          throw new InvalidProtectedData();
        for (const request of requests) {
          await checked(request.value);
          const decision = decisions.find(
            (doc) => doc.value.id === publicId(request.value.row.values.id),
          );
          if (decision) await checked(decision.value);
          const actual = absenceState(
              request.value,
              request.signature!,
              decision?.value,
            ),
            original = expected.find(
              (row) => row.values.id === actual.values.id,
            );
          if (JSON.stringify(actual) !== JSON.stringify(original))
            throw new InvalidProtectedData();
        }
      });
    }
  } finally {
    lease.close();
  }
}

export async function prepareAbsences(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  const context = await administratorContext(client, signal);
  if (subject !== `user:${context.session.user.id}`)
    throw new InvalidProtectedData();
  const rows = await readBusinessRows(source, "user_vacations"),
    users = (await readBusinessRows(source, "users")).map((row) =>
      publicId(row.values.id),
    );
  await prepareOwnerCollections(
    client,
    subject,
    users.flatMap((user) => [
      absenceCollection(user),
      absenceCollection(user, true),
    ]),
    signal,
  );
  context.live();
  await copyAbsenceRecords(
    client,
    rows,
    users,
    {
      tenant: context.account.tenant,
      generation: context.history.current.generation,
      key: context.authority,
      publicKey: context.history.authority,
      live: context.live,
    },
    signal,
    driver,
  );
}
