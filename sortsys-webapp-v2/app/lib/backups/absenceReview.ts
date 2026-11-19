import { RpcClientError, type Client } from "@sortsys/v2-client";
import {
  absenceDomain,
  absenceRecord,
  InvalidProtectedData,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import {
  ABSENCE_DECISION_MODEL,
  ABSENCE_REQUEST_MODEL,
  absenceCollection,
  assertAbsenceDecisionSource,
  verifyLegacyAbsence,
} from "../data/absenceData";
import {
  required,
  type Collection,
  type OpenedObject,
} from "../data/protectedObjects";
import { openDataDocument } from "../data/runtime/model";
import { readContentAreas, type ContentReadView } from "./readContentAreas";

export class RestoreAbsenceConflict extends Error {}

/** Keep signatures and counts after checking the contents in the browser. */
export async function inspectRestoredAbsences(
  client: Client,
  view: ContentReadView,
  tenant: string,
  signal: AbortSignal,
) {
  const areas = view.areas((domain) => {
    const part = absenceDomain(domain);
    if (!part) return null;
    return absenceCollection(part.user, part.facet === "personnel");
  });
  const unchecked = new Set<string>();
  for (const area of areas) {
    const { user, facet } = absenceDomain(area.domain)!;
    if (!view.readable(absenceCollection(user, facet === "master-data"))) {
      unchecked.add(user);
    }
  }
  const signatures = new Map<string, string | null>();
  let requests = 0;
  let decisions = 0;
  let withdrawn = 0;

  async function checkedRequest(area: Collection, object: OpenedObject) {
    if (object.envelope.revision !== "1") throw new InvalidProtectedData();
    const { value } = openDataDocument(ABSENCE_REQUEST_MODEL, area, object);
    await verifyLegacyAbsence(value, tenant, view.authority);
    return object.envelope.signature;
  }

  async function originalSignature(area: Collection, object: string) {
    // The timestamp index retains the accepted ciphertext even when every
    // external timestamp calendar is offline or the request was withdrawn.
    const evidence = await required(
      client.query(
        "zerotrust.timestamps.get",
        { scope: area.scope, object, revision: "1" },
        { strategy: "network-only" },
      ),
    );
    signal.throwIfAborted();
    const collection = view.openCiphertext(area);
    try {
      return await checkedRequest(
        area,
        await collection.openHistorical(evidence.artifact, object),
      );
    } finally {
      collection.close();
    }
  }

  try {
    await readContentAreas(
      view,
      areas.filter(({ facet }) => facet === "master-data"),
      async (area, object) => {
        const { envelope } = object;
        if (signatures.has(envelope.object)) throw new InvalidProtectedData();
        if (envelope.format === TOMBSTONE_FORMAT) {
          if (
            envelope.revision !== "2" ||
            absenceRecord(envelope)?.kind !== "request"
          ) {
            throw new InvalidProtectedData();
          }
          signatures.set(envelope.object, null);
          withdrawn++;
        } else {
          signatures.set(envelope.object, await checkedRequest(area, object));
          requests++;
        }
      },
      { includeTombstones: true },
    );

    await readContentAreas(
      view,
      areas.filter(({ facet }) => facet === "personnel"),
      async (area, object) => {
        const { envelope } = object;
        const binding = absenceRecord(envelope);
        if (envelope.revision !== "1" || binding?.kind !== "decision") {
          throw new InvalidProtectedData();
        }
        const { value } = openDataDocument(ABSENCE_DECISION_MODEL, area, object);
        await verifyLegacyAbsence(value, tenant, view.authority);
        const source = absenceCollection(binding.user);
        if (!view.readable(source)) return;
        let signature = signatures.get(binding.requestObject);
        if (signature === undefined) throw new InvalidProtectedData();
        if (signature === null) {
          signature = await originalSignature(source, binding.requestObject);
        }
        assertAbsenceDecisionSource(value, {
          userId: binding.user,
          id: binding.request,
          signature,
        });
        decisions++;
      },
      { includeTombstones: true },
    );
    return { requests, decisions, withdrawn, unchecked: unchecked.size };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof InvalidProtectedData ||
      (error instanceof RpcClientError && error.code === "NOT_FOUND")
    ) {
      throw new RestoreAbsenceConflict("Invalid absence or decision", {
        cause: error,
      });
    }
    throw error;
  }
}
