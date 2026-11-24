import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  frame,
  InvalidProtectedData,
  record,
  sign,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { captureAccountScope } from "../crypto/session";
import { addressId, partialAddressRecord } from "./addressBook";
import {
  commitProtectedWrites,
  type PreparedWrites,
  type PublicationOptions,
  ProtectedWriteConflict,
} from "./atomicWrites";
import { createBusinessDatabase, type DuckDriver } from "./database";
import { deliveryChanges } from "./deliveryChanges";
import {
  deliveryFormRevision,
  deliveryObject,
  isDeliveryFormRevision,
} from "./deliveryIdentity";
import {
  deliveryCollection,
  type DeliveryPayload,
  deliveryPayload,
  type DeliveryPrices,
  deliveryPrices,
} from "./deliveryNoteData";
import {
  allocateDeliveryNote,
  deliveryAllocation,
  deliveryRequestContext,
  deliveryRequestFingerprint,
} from "./deliveryRegistry";
import {
  newProductRowId,
  PRODUCT_COLLECTION,
  productPayload,
  publicId,
} from "./products";
import { projectCollection, projectPayload } from "./projectData";
import { projectFacetRows } from "./projection";
import { protectedCollections, required } from "./protectedObjects";
import { businessSchema } from "./schema";
import type { BusinessRow } from "./rowCodec";
import { existingAggregateRows } from "./aggregateRows";
type Receipt = {
  format: "sortsys-delivery-create-v1";
  author: string;
  requestId: string;
  requestHash: string;
  id: string;
  number: string;
};
function receipt(input: unknown): Receipt {
  const data = record(input, [
    "format",
    "author",
    "requestId",
    "requestHash",
    "id",
    "number",
  ]);
  if (
    data.format !== "sortsys-delivery-create-v1" ||
    typeof data.author !== "string" ||
    !data.author.startsWith("user:") ||
    typeof data.requestId !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(data.requestId) ||
    typeof data.number !== "string" ||
    !/^[1-9]\d{0,18}$/.test(data.number)
  ) {
    throw new InvalidProtectedData();
  }
  addressId(data.author.slice(5));
  addressId(data.id);
  sized(data.requestHash as string, 32);
  return data as Receipt;
}
const row = (table: string, values: Record<string, unknown>): BusinessRow => ({
  format: "sortsys-row-v2",
  schema: businessSchema.fingerprint,
  table,
  values,
});

function deliveryMoveBatch(
  client: Client,
  context: Awaited<ReturnType<typeof deliveryRequestContext>>,
  fromProject: string,
  target: { id: string; projectId: string; placement: string },
): NonNullable<PublicationOptions["customBatch"]> {
  const { id, projectId: toProject, placement } = target;
  return {
    changedDomains: [
      deliveryCollection(fromProject).domain,
      deliveryCollection(fromProject, true).domain,
    ],
    async send(objects, heads, signal) {
      const { account, subject } = context;
      const proof = await sign(account.identity.signingKey.privateKey, frame(
        "sortsys/delivery-move/v1",
        [
          account.tenant, subject, id, fromProject, toProject, placement,
          ...objects.map(({ envelope }) => envelope.signature),
          ...heads.flatMap(({ domain, sequence }) => [domain, sequence]),
        ],
      ));
      context.live();
      signal.throwIfAborted();
      return client.mutate("zerotrust.deliveryNotes.move", {
        movement: { id, fromProject, toProject, placement, proof }, objects, heads,
      }, { signal });
    },
  };
}

export async function writeDeliveryNote(
  client: Client,
  path: string,
  input: unknown,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  if (path !== "deliveryNotes.create" && path !== "deliveryNotes.update") {
    throw new InvalidProtectedData();
  }

  const { account, live } = captureAccountScope(signal);
  const creating = path === "deliveryNotes.create",
    outer = partialAddressRecord(
      input,
      creating
        ? [
            "requestId",
            "projectId",
            "effectiveTimestamp",
            "comment",
            "records",
            "specialRecords",
          ]
        : ["id", "data", "expectedRevision", "expectedPriceRevision"],
    );
  const { requestId: submitted, ...createInput } = outer;
  const changes = deliveryChanges(
      creating ? createInput : outer.data,
      creating,
    ),
    requestId = creating ? (submitted ?? crypto.randomUUID()) : null;
  if (
    creating &&
    (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(requestId))
  ) {
    throw new InvalidProtectedData();
  }
  if (!creating) {
    addressId(outer.id);
  }
  for (const field of ["expectedRevision", "expectedPriceRevision"] as const) {
    if (
      outer[field] !== undefined &&
      !isDeliveryFormRevision(outer[field], field === "expectedPriceRevision")
    ) {
      throw new InvalidProtectedData();
    }
  }
  const located = creating
    ? null
    : deliveryAllocation(
        await required(
          client.query(
            "zerotrust.deliveryNotes.locate",
            {
              id: outer.id as string,
            },
            { strategy: "network-only" },
          ),
        ),
      );
  live();
  const sourceProjectId = located?.projectId ?? changes.projectId!;
  const projectId = changes.projectId ?? sourceProjectId;
  const moving = projectId !== sourceProjectId;
  if (moving && outer.expectedRevision === undefined) {
    throw new ProtectedWriteConflict();
  }
  const context = await deliveryRequestContext(client, signal),
    open = await protectedCollections(client, signal);
  live();
  const area = deliveryCollection(sourceProjectId),
    quantities = open(area),
    stores = [quantities],
    groups: PreparedWrites[] = [],
    guards: PreparedWrites["head"][] = [];
  const author = context.subject,
    receiptArea = {
      ...area,
      prefix: `delivery-create:${projectId}:${author.slice(5)}:`,
    },
    receipts = creating ? open(receiptArea) : null;
  if (receipts) {
    stores.push(receipts);
  }
  const requestHash = creating
    ? await deliveryRequestFingerprint(
        account.dataKey,
        account.tenant,
        author,
        { requestId, ...changes },
      )
    : null;
  live();
  const receiptObject = receiptArea.prefix + requestId;
  async function confirmedReceipt(): Promise<{
    id: string;
  } | null> {
    if (!receipts) {
      return null;
    }
    const saved = (await receipts.read(receiptObject)).find(
      (item) => item.envelope.object === receiptObject,
    );
    live();
    if (!saved) {
      return null;
    }
    const value = receipt(saved.value);
    if (
      saved.envelope.author !== author ||
      value.author !== author ||
      value.requestId !== requestId ||
      value.requestHash !== requestHash
    ) {
      throw new InvalidProtectedData();
    }
    const allocation = deliveryAllocation(
      await required(
        client.query(
          "zerotrust.deliveryNotes.locate",
          { id: value.id },
          {
            strategy: "network-only",
          },
        ),
      ),
    );
    live();
    if (
      allocation.number !== value.number ||
      (allocation.projectId !== projectId && allocation.placement === undefined)
    ) {
      throw new InvalidProtectedData();
    }
    return { id: value.id };
  }
  try {
    if (creating) {
      const done = await confirmedReceipt();
      if (done) {
        return done;
      }
    }
    if (creating && !quantities.can("create")) {
      throw new InvalidProtectedData();
    }
    const allocation = creating
      ? await allocateDeliveryNote(
          client,
          projectId,
          requestId as string,
          signal,
        )
      : located!;
    live();
    const id = allocation.id,
      object = deliveryObject(allocation),
      current = (await quantities.read(object)).find(
        (item) => item.envelope.object === object,
      );
    live();
    if ((creating && current) || (!creating && !current)) {
      throw new InvalidProtectedData();
    }
    if (
      outer.expectedRevision !== undefined &&
      outer.expectedRevision !== deliveryFormRevision(
        current?.envelope.revision ?? "0",
        allocation.placement,
      )
    ) {
      throw new ProtectedWriteConflict();
    }
    const previous = current
      ? deliveryPayload(current.value, object, sourceProjectId)
      : null;
    if (creating || moving) {
      const projectArea = projectCollection(projectId),
        project = open(projectArea);
      stores.push(project);
      const found = (await project.read()).find(
        (item) => item.envelope.object === projectArea.prefix,
      );
      live();
      if (
        !found ||
        !projectPayload(found.value, found.envelope.object, projectId).project
      ) {
        throw new InvalidProtectedData();
      }
      guards.push({ domain: projectArea.domain, sequence: project.snapshot() });
    }
    const oldRecords = existingAggregateRows(
        previous?.records ?? [],
        changes.records ?? [],
      ),
      oldSpecials = existingAggregateRows(
        previous?.specialRecords ?? [],
        changes.specialRecords ?? [],
      );
    const recordChanges = (changes.records ?? []).map((change) => {
      const old = change.id ? oldRecords.get(change.id) : undefined;
      const sameProduct = old?.values.product_id === addressId(change.productId);
      const unit = change.unit ??
        (sameProduct ? (old?.values.unit as string) : null);
      return {
        change,
        old,
        unit,
        checkProduct: !sameProduct || !unit || unit !== old?.values.unit,
      };
    });
    const products = new Map<string, BusinessRow["values"]>();
    const requiredProducts = [...new Set(
      recordChanges
        .filter(({ checkProduct }) => checkProduct)
        .map(({ change }) => PRODUCT_COLLECTION.prefix + change.productId),
    )];
    if (requiredProducts.length) {
      const catalog = open(PRODUCT_COLLECTION);
      stores.push(catalog);
      const head = await catalog.inspect();
      for (const { envelope, value } of await catalog.selected(requiredProducts)) {
        const product = productPayload(value, envelope.object);
        products.set(envelope.object, product.product.values);
      }
      await catalog.inspect(head);
      live();
      guards.push({ domain: PRODUCT_COLLECTION.domain, sequence: head });
    }

    const rawId = addressId(id),
      now = new Date().toISOString();
    const records: BusinessRow[] =
      changes.records === undefined ? previous!.records : [];
    for (const { change, old, unit, checkProduct } of recordChanges) {
      let chosen = unit;
      if (checkProduct) {
        const p = products.get(PRODUCT_COLLECTION.prefix + change.productId);
        if (!p) throw new InvalidProtectedData();
        chosen ??= p.base_unit as string;
        const other = JSON.parse(p.other_units as string) as Record<
          string,
          number
        >;
        if (chosen !== p.base_unit && !Object.hasOwn(other, chosen)) {
          throw new InvalidProtectedData();
        }
      }
      records.push(
        row("product_delivery_records", {
          id: old?.values.id ?? newProductRowId(),
          note_id: rawId,
          product_id: addressId(change.productId),
          quantity: change.quantity,
          unit: chosen,
          comment:
            change.comment === undefined
              ? (old?.values.comment ?? null)
              : change.comment,
        }),
      );
    }
    const specialRecords: BusinessRow[] =
      changes.specialRecords === undefined ? previous!.specialRecords : [];
    const priceChanges = new Map<string, number | null>();
    for (const change of changes.specialRecords ?? []) {
      const old = change.id ? oldSpecials.get(change.id) : undefined,
        specialId = (old?.values.id as string | undefined) ?? newProductRowId();
      specialRecords.push(
        row("product_delivery_special_records", {
          id: specialId,
          note_id: rawId,
          name: change.name,
          unit: change.unit,
          amount: change.amount,
          price_per_unit: null,
          comment:
            change.comment === undefined
              ? (old?.values.comment ?? null)
              : change.comment,
        }),
      );
      if (
        change.pricePerUnit !== undefined &&
        (!creating || change.pricePerUnit !== null)
      ) {
        priceChanges.set(publicId(specialId), change.pricePerUnit);
      }
    }
    const newPlacement = moving
      ? { id, projectId, placement: crypto.randomUUID().replaceAll("-", "") }
      : null;
    const target = newPlacement ?? allocation;
    const targetObject = deliveryObject(target);
    const targetArea = deliveryCollection(projectId);
    const destination = moving ? open(targetArea) : quantities;
    if (moving) {
      stores.push(destination);
      guards.push({ domain: area.domain, sequence: quantities.snapshot() });
      await destination.inspect();
    }
    const value = deliveryPayload(
      {
        format: "sortsys-delivery-note-v1",
        note: row(
          "product_delivery_notes",
          previous
            ? {
                ...previous.note.values,
                project_id: addressId(projectId),
                ...(changes.comment !== undefined
                  ? { comment: changes.comment }
                  : {}),
                ...(changes.effectiveTimestamp !== undefined
                  ? { effective_timestamp: changes.effectiveTimestamp }
                  : {}),
              }
            : {
                id: rawId,
                auto_id: allocation.number,
                project_id: addressId(projectId),
                created_by_user_id: addressId(author.slice(5)),
                comment: changes.comment ?? null,
                effective_timestamp: changes.effectiveTimestamp ?? now,
                created_at: now,
              },
        ),
        records,
        specialRecords,
      } satisfies DeliveryPayload,
      targetObject,
      projectId,
    );
    const check = await createBusinessDatabase(await driver?.());
    try {
      const rows = [value.note, ...value.records, ...value.specialRecords];
      for (let offset = 0; offset < rows.length; offset += 10000) {
        await projectFacetRows(
          check,
          rows.slice(offset, offset + 10000),
          new Set(["projects", "users", "products"]),
        );
      }
      live();
    } finally {
      await check.close();
    }
    const quantityChanged =
      creating || JSON.stringify(value) !== JSON.stringify(previous);
    if (quantityChanged && !creating && !quantities.can("update")) {
      throw new InvalidProtectedData();
    }
    const quantityPackets: MutateInput<"zerotrust.objects.save">[] = [];
    if (quantityChanged) {
      quantityPackets.push(
        await destination.packet(
          targetObject, value, moving ? undefined : current?.envelope,
        ),
      );
    }
    if (creating) {
      quantityPackets.push(
        await receipts!.packet(
          receiptObject,
          receipt({
            format: "sortsys-delivery-create-v1",
            author,
            requestId,
            requestHash,
            id,
            number: allocation.number,
          }),
        ),
      );
    }
    if (quantityPackets.length) {
      groups.push({
        packets: quantityPackets,
        head: { domain: targetArea.domain, sequence: destination.snapshot() },
        close() {},
        async verify() {
          const saved = await destination.read(targetObject);
          live();
          if (
            quantityChanged &&
            saved.find((item) => item.envelope.object === targetObject)?.envelope
              .signature !== quantityPackets[0]!.envelope.signature
          ) {
            return false;
          }
          return !creating || !!(await confirmedReceipt());
        },
      });
    }
    if (priceChanges.size || moving) {
      const pricesArea = deliveryCollection(sourceProjectId, true),
        prices = open(pricesArea);
      stores.push(prices);
      const priceObject = deliveryObject(allocation, true),
        old = (await prices.read(priceObject)).find(
          (item) => item.envelope.object === priceObject,
        );
      live();
      if (
        outer.expectedPriceRevision !== undefined &&
        outer.expectedPriceRevision !== deliveryFormRevision(
          old?.envelope.revision ?? "0",
          allocation.placement,
        )
      ) {
        throw new ProtectedWriteConflict();
      }
      const previousPrices = old
        ? deliveryPrices(old.value, priceObject, sourceProjectId)
        : {
            format: "sortsys-delivery-prices-v1" as const,
            projectId: sourceProjectId,
            noteId: id,
            prices: [],
          };
      const map = new Map(
        previousPrices.prices.map((r) => [r.id, r.pricePerUnit]),
      );
      for (const [key, price] of priceChanges) {
        map.set(key, price);
      }
      if (moving) {
        const active = new Set(specialRecords.map((item) => publicId(item.values.id)));
        for (const key of map.keys()) {
          if (!active.has(key)) map.delete(key);
        }
      }
      const targetPriceObject = deliveryObject(target, true);
      const next = deliveryPrices(
        {
          ...previousPrices,
          projectId,
          prices: [...map].map(([id, pricePerUnit]) => ({ id, pricePerUnit })),
        } satisfies DeliveryPrices,
        targetPriceObject,
        projectId,
      );
      if (moving || JSON.stringify(next) !== JSON.stringify(previousPrices)) {
        const targetPriceArea = deliveryCollection(projectId, true);
        const priceDestination = moving ? open(targetPriceArea) : prices;
        if (moving) {
          stores.push(priceDestination);
          guards.push({ domain: pricesArea.domain, sequence: prices.snapshot() });
          await priceDestination.inspect();
        }
        const packet = await priceDestination.packet(
          targetPriceObject, next, moving ? undefined : old?.envelope,
        );
        live();
        groups.push({
          packets: [packet],
          head: { domain: targetPriceArea.domain, sequence: priceDestination.snapshot() },
          close() {},
          async verify() {
            return (
              (await priceDestination.read(targetPriceObject)).find(
                (item) => item.envelope.object === targetPriceObject,
              )?.envelope.signature === packet.envelope.signature
            );
          },
        });
      }
    }
    if (!groups.length) {
      return { success: true as const };
    }
    if (!quantityPackets.length) {
      guards.push({ domain: area.domain, sequence: quantities.snapshot() });
    }
    try {
      const customBatch = newPlacement
        ? deliveryMoveBatch(client, context, sourceProjectId, newPlacement)
        : undefined;
      await commitProtectedWrites(client, groups, signal, guards, { customBatch });
      live();
    } catch (error) {
      if (creating) {
        const done = await confirmedReceipt();
        if (done) {
          return done;
        }
      }
      throw error;
    }
    return creating ? { id } : { success: true as const };
  } finally {
    for (const store of stores) {
      store.close();
    }
  }
}
