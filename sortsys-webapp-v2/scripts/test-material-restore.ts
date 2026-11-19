import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { required } from "../app/lib/data/protectedObjects";

export const savedProductName =
  "Vertrauliche Dichtmanschetten im Sicherungsstand";
export const savedDeliveryComment = "Lieferung für den Prüfbereich 76431";
export const savedRegieSummary = "Nacharbeiten im Prüfbereich 98432";

export async function prepareMaterialRestore(owner: Client, projectId: string) {
  const product = await required(
    owner.mutate("products.create", {
      name: savedProductName,
      customId: 76431,
      baseUnit: "Stk",
    }),
  );
  const removedProduct = await required(
    owner.mutate("products.create", {
      name: "Ausgelaufene Dichtleiste im Regiebericht",
      customId: 98432,
      baseUnit: "m",
    }),
  );
  const delivery = await required(
    owner.mutate("deliveryNotes.create", {
      projectId,
      requestId: crypto.randomUUID(),
      comment: savedDeliveryComment,
      records: [{ productId: product.id, quantity: 15 }],
    }),
  );
  const regie = await required(
    owner.mutate("regieReports.create", {
      projectId,
      day: "2026-11-16",
      summary: savedRegieSummary,
      products: [{ productId: removedProduct.id, quantity: 4.25 }],
    }),
  );
  await required(owner.mutate("products.delete", { id: removedProduct.id }));

  return {
    deliveryId: delivery.id,
    productId: product.id,
    async replace() {
      await required(
        owner.mutate("products.update", {
          id: product.id,
          data: { name: "Aktuelle Dichtmanschetten nach der Sicherung" },
        }),
      );
      await required(owner.mutate("deliveryNotes.delete", { id: delivery.id }));
      await required(owner.mutate("regieReports.delete", { id: regie.id }));
    },
    async check(peer: Client) {
      const note = await required(
        peer.query(
          "deliveryNotes.get",
          { id: delivery.id },
          { strategy: "network-only" },
        ),
      );
      assert.equal(note.projectId, projectId);
      assert.equal(note.comment, savedDeliveryComment);
      assert.deepEqual(
        note.records.map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
        [{ productId: product.id, quantity: 15 }],
      );
      const report = await required(
        peer.query(
          "regieReports.get",
          { id: regie.id },
          { strategy: "network-only" },
        ),
      );
      assert.equal(report.projectId, projectId);
      assert.equal(report.summary, savedRegieSummary);
      assert.deepEqual(
        report.products.map(({ productId, quantity }) => ({
          productId,
          quantity,
        })),
        [{ productId: removedProduct.id, quantity: 4.25 }],
      );
      const restoredProduct = await required(
        peer.query(
          "products.get",
          { id: product.id },
          { strategy: "network-only" },
        ),
      );
      assert.equal(restoredProduct.name, savedProductName);
    },
  };
}
