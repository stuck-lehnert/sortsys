import { expect, test } from "bun:test";
import { summarizeChatCosts, visibleChatCosts } from "./chatCosts";
import { projectCostRequests } from "./projectCosts";

test("the result limit does not change totals and hidden costs never contribute", () => {
  const readable = new Set(
    ["1", "2"].flatMap((id) => projectCostRequests(id).all.map(({ area }) => area.domain)),
  );
  const access = { canRead: ({ domain }) => readable.has(domain) };
  const row = {
    costs: 100,
    offersTotal: 220,
    invoicesTotal: 200,
    hasInvoices: true,
    gainOrLoss: 100,
  };
  const rows = [
    { ...row, projectId: "1", title: "Ausbau Nordflügel" },
    { ...row, projectId: "2", title: "Ausbau Innenhof" },
    { ...row, projectId: "3", title: "Ausbau Südflügel", invoicesTotal: 90_000 },
    { ...row, projectId: "2", title: "Ausbau Westflügel", costs: null },
  ];
  const summary = summarizeChatCosts(visibleChatCosts(rows, access), "Ausb", 1);

  expect(summary.projectCount).toBe(2);
  expect(summary.recordsTruncated).toBe(true);
  expect(summary.records.map(({ projectId }) => projectId)).toEqual(["1"]);
  expect(summary.totals).toEqual({
    costs: 200,
    offersTotal: 440,
    invoicesTotal: 400,
    invoiceBalance: 200,
  });
});
