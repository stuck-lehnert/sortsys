import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { required } from "../../app/lib/data/protectedObjects";
import { gaebWorkflowXml } from "../test-live-gaeb-workflows";

export async function adoptGaebOrder(
  client: Client,
  projectId: string,
  title: string,
) {
  const contract = await required(
    client.mutate("commercial.cases.adoptContract", {
      projectId,
      title,
      sourcePhase: "86",
      sourceXml: gaebWorkflowXml("86"),
      sourceFileName: "Auftrag.x86",
      offerXml: gaebWorkflowXml("84"),
      referenceXml: null,
      netAmount: "1776.00",
    }),
  );
  const workflow = await required(client.query("commercial.cases.get", contract));
  const order = workflow.documents.find(({ purpose }) => purpose === "order");
  assert.ok(order);
  return { caseId: contract.id, order };
}
