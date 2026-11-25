import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { createProtectedDailyReports } from "./dailyReports";
import { dailyCollection } from "./dailyReportData";
import { projectCollection } from "./projectData";
import { personnelCollection, personnelPart } from "./personnelData";
import { fileCollection, fileObject, contentId } from "./projectFileData";
import { createBusinessDatabase } from "./database";
import { projectCompleteRows } from "./projection";
import { prepareDailyReports } from "./migrateDailyReports";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "./testing/keyQueries.mjs";
import { duckDriver } from "./testing/duckDriver.mjs";
import { fixtureTimeout } from "./testing/fixtureTimeout.mjs";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { publicId } from "./products";
import { row } from "./rowCodec.test.mjs";
import { reportFixture } from "./dailyReportData.test.mjs";
import { createBusinessClient } from "./businessClient";

afterEach(() => lockCryptoSession());
async function fixture(
  costs = true,
  reportActions = ["read", "create", "update", "delete"],
) {
  const report = dailyCollection("2"),
    cost = dailyCollection("2", true),
    project = projectCollection("2"),
    person = personnelCollection("6", "master-data");
  const files = fileCollection("2");
  const f = await protectedTenant(
    [report, cost, project, person, files],
    (area) =>
      area.domain === cost.domain && !costs
        ? []
        : area.domain === report.domain
          ? reportActions
          : ["read", "create", "update", "delete"],
  );
  const value = reportFixture();
  await f.seed(report, report.prefix + "3", value);
  await f.seed(cost, cost.prefix + "3", {
    format: "sortsys-daily-costs-v1",
    projectId: "2",
    reportId: "3",
    costs: [{ id: "4", costPerHour: 98765.4321 }],
  });
  await f.seed(project, project.prefix, {
    format: "sortsys-project-v1",
    project: row("projects", { id: "2", title: "Fenstersanierung" }),
    contacts: [],
  });
  const p = row("users", {
    id: "6",
    username: "maria",
    first_name: "Maria",
    contract_type: "internal",
    ui_locale: "de",
  });
  await f.seed(person, person.prefix, personnelPart(p, "master-data"));
  return {
    ...f,
    report,
    cost,
    files,
    value,
    store: createProtectedDailyReports(
      f.client,
      new AbortController().signal,
      duckDriver,
    ),
  };
}
test("editing hours without cost access preserves encrypted costs and sends no business plaintext", async () => {
  const f = await fixture(false);
  try {
    const before = f.objects.get(f.cost.prefix + "3");
    const current = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(current.workHours[0].costPerHour).toBeNull();
    expect(current.costRevision).toBeUndefined();
    await f.store.mutate("projects.dailyReports.update", {
      projectId: "2",
      day: "2026-08-25",
      expectedRevision: current.revision,
      data: {
        summary: "Confidential work note alpha beta gamma",
        workHours: [
          { id: "4", hours: 8.125, userId: null, contractType: "external" },
        ],
      },
    });
    const saved = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(saved.workHours[0].id).toBe("4");
    expect(saved.workHours[0].hours).toBe(8.125);
    expect(f.objects.get(f.cost.prefix + "3")).toEqual(before);
    expect(JSON.stringify(f.calls)).not.toContain(
      "Confidential work note alpha beta gamma",
    );
    expect(
      f.calls
        .filter((call) => isKeyEnvelopeQuery(call.path))
        .every((call) => call.input.domain !== f.cost.domain),
    ).toBe(true);
    await expect(
      f.store.mutate("projects.dailyReports.update", {
        projectId: "2",
        day: "2026-08-25",
        data: { workHours: [{ id: "4", hours: 8, costPerHour: 7 }] },
      }),
    ).rejects.toThrow();
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("hours and costs commit atomically despite a lost reply, and stale revisions never overwrite them", async () => {
  const f = await fixture();
  try {
    const current = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    f.state.loseReply = true;
    await f.store.mutate("projects.dailyReports.update", {
      projectId: "2",
      day: "2026-08-25",
      expectedRevision: current.revision,
      expectedCostRevision: current.costRevision,
      data: {
        workHours: [
          {
            id: "4",
            hours: 8.125,
            userId: null,
            costPerHour: 123.456789,
            contractType: "external",
          },
        ],
      },
    });
    const saved = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(saved.workHours[0]).toMatchObject({
      id: "4",
      hours: 8.125,
      costPerHour: 123.456789,
    });
    const call = f.calls.find(
      (call) => call.path === "zerotrust.objects.batch",
    );
    expect(
      new Set(call.input.objects.map((packet) => packet.domain)).size,
    ).toBe(2);
    f.state.loseReply = false;
    await expect(
      f.store.mutate("projects.dailyReports.update", {
        projectId: "2",
        day: "2026-08-25",
        expectedRevision: current.revision,
        data: { summary: "Stale overwrite" },
      }),
    ).rejects.toThrow();
    expect(
      (
        await f.store.query("projects.dailyReports.get", {
          projectId: "2",
          day: "2026-08-25",
        })
      ).summary,
    ).not.toBe("Stale overwrite");
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("new daily reports, day changes, deletion and date filtering use the protected runtime", async () => {
  const f = await fixture();
  try {
    await f.store.mutate("projects.dailyReports.create", {
      projectId: "2",
      day: "2026-08-26",
      summary: "Gerüst abgebaut",
      workHours: [{ userId: "6", hours: 7.25, costPerHour: 12.3456 }],
    });
    const created = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-26",
    });
    expect(created.workHours[0]).toMatchObject({
      userId: "6",
      contractType: "internal",
      hours: 7.25,
      costPerHour: 12.3456,
    });
    await expect(
      f.store.mutate("projects.dailyReports.create", {
        projectId: "2",
        day: "2026-08-26",
      }),
    ).rejects.toThrow();
    await expect(
      f.store.mutate("projects.dailyReports.update", {
        projectId: "2",
        day: "2026-08-26",
        data: { day: "2026-08-25" },
      }),
    ).rejects.toThrow();
    await f.store.mutate("projects.dailyReports.update", {
      projectId: "2",
      day: "2026-08-26",
      data: { day: "2026-08-27" },
    });
    const list = await f.store.query("projects.dailyReports.list", {
      from: "2026-08-26",
      to: "2026-08-28",
    });
    expect(list.map((row) => row.day.toISOString().slice(0, 10))).toEqual([
      "2026-08-27",
    ]);
    await f.store.mutate("projects.dailyReports.delete", {
      projectId: "2",
      day: "2026-08-27",
    });
    await expect(
      f.store.query("projects.dailyReports.get", {
        projectId: "2",
        day: "2026-08-27",
      }),
    ).rejects.toThrow();
    expect(
      (await f.store.query("projects.dailyReports.list", { projectId: "2" }))
        .length,
    ).toBe(1);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));
test("a different worker gets a new line identity instead of inheriting another worker's hidden costs", async () => {
  const f = await fixture(false);
  try {
    const current = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    await f.store.mutate("projects.dailyReports.update", {
      projectId: "2",
      day: "2026-08-25",
      expectedRevision: current.revision,
      data: { workHours: [{ id: "4", userId: "6", hours: 4.5 }] },
    });
    const next = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(next.workHours[0].id).not.toBe("4");
    const hidden = await f.plain(f.cost, f.cost.prefix + "3");
    expect(hidden.costs).toEqual([{ id: "4", costPerHour: 98765.4321 }]);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("photos use encrypted project metadata, reject foreign files and disappear after removal", async () => {
  const f = await fixture();
  try {
    const original = {
      version: "legacy",
      size: 1,
      parts: [{ id: contentId("2", "7", "legacy", 0), hash: "A".repeat(43) }],
    };
    const file = row("project_files", {
      id: "7",
      project_id: "2",
      file_name: "Baustelle.jpg",
      mime_type: "image/jpeg",
      kind: "image",
      status: "uploaded",
      size_bytes: "1",
      thumbnail_status: "none",
      text_extraction_status: "ready",
    });
    await f.seed(f.files, fileObject("2", "7"), {
      format: "sortsys-project-file-v1",
      file,
      original,
      thumbnail: null,
      office: null,
    });
    await expect(
      f.store.mutate("projects.dailyReports.photos.add", {
        projectId: "2",
        day: "2026-08-25",
        fileId: "8",
      }),
    ).rejects.toThrow();
    await f.store.mutate("projects.dailyReports.photos.add", {
      projectId: "2",
      day: "2026-08-25",
      fileId: "7",
    });
    const report = await f.store.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(report.photos.map((file) => file.id)).toEqual(["7"]);
    expect(report.photos[0].downloadUrl).toStartWith("sortsys-private:");
    await f.store.mutate("projects.dailyReports.photos.remove", {
      projectId: "2",
      day: "2026-08-25",
      fileId: "7",
    });
    expect(
      (
        await f.store.query("projects.dailyReports.get", {
          projectId: "2",
          day: "2026-08-25",
        })
      ).photos,
    ).toEqual([]);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("an independently committed head prevents partial publication of report and costs", async () => {
  const f = await fixture();
  try {
    const before = f.objects.get(f.cost.prefix + "3"),
      peer = {
        ...f.value,
        report: {
          ...f.value.report,
          values: { ...f.value.report.values, summary: "Saved by peer" },
        },
      };
    f.state.beforeCommit = async () => {
      f.state.beforeCommit = async () => {};
      await f.seed(f.report, f.report.prefix + "3", peer);
    };
    await expect(
      f.store.mutate("projects.dailyReports.update", {
        projectId: "2",
        day: "2026-08-25",
        data: {
          workHours: [
            {
              id: "4",
              hours: 6,
              costPerHour: 55.1234,
              contractType: "external",
            },
          ],
        },
      }),
    ).rejects.toThrow();
    expect(f.objects.get(f.cost.prefix + "3")).toEqual(before);
    expect(
      (
        await f.store.query("projects.dailyReports.get", {
          projectId: "2",
          day: "2026-08-25",
        })
      ).summary,
    ).toBe("Saved by peer");
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("a cost-only writer can change the rate without requiring or rewriting hour-editing rights", async () => {
  const f = await fixture(true, ["read"]);
  try {
    const report = f.objects.get(f.report.prefix + "3");
    await f.store.mutate("projects.dailyReports.update", {
      projectId: "2",
      day: "2026-08-25",
      data: {
        workHours: [
          {
            id: "4",
            userId: null,
            hours: 7.375,
            contractType: "external",
            costPerHour: 65.123456,
          },
        ],
      },
    });
    expect(f.objects.get(f.report.prefix + "3")).toEqual(report);
    expect(
      (
        await f.store.query("projects.dailyReports.get", {
          projectId: "2",
          day: "2026-08-25",
        })
      ).workHours[0].costPerHour,
    ).toBe(65.123456);
    await expect(
      f.store.mutate("projects.dailyReports.update", {
        projectId: "2",
        day: "2026-08-25",
        data: { summary: "Forbidden" },
      }),
    ).rejects.toThrow();
    expect(
      f.calls
        .filter((call) => call.path === "zerotrust.objects.batch")[0]
        .input.objects.map((packet) => packet.domain),
    ).toEqual([f.cost.domain]);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("bestands conversion is repeatable and splits costs before writing any encrypted object", async () => {
  const area = dailyCollection("2"),
    money = dailyCollection("2", true),
    f = await protectedTenant([area, money], undefined, { backup: true }),
    source = await createBusinessDatabase(await duckDriver());
  try {
    const value = reportFixture(),
      hours = {
        ...value.hours[0],
        values: { ...value.hours[0].values, cost_per_hour: 37.123456789 },
      };
    await projectCompleteRows(source, [
      row("projects", { id: "2", title: "Fenstersanierung" }),
      value.report,
      hours,
    ]);
    await prepareDailyReports(
      f.client,
      source,
      "user:1",
      new AbortController().signal,
    );
    const report = await f.plain(area, area.prefix + "3"),
      prices = await f.plain(money, money.prefix + "3");
    expect(report.hours[0].values.cost_per_hour).toBeNull();
    expect(prices.costs[0].costPerHour).toBe(37.123456789);
    const mutations = f.calls.filter(
      (call) => call.path === "zerotrust.objects.batch",
    ).length;
    await prepareDailyReports(
      f.client,
      source,
      "user:1",
      new AbortController().signal,
    );
    expect(
      f.calls.filter((call) => call.path === "zerotrust.objects.batch").length,
    ).toBe(mutations);
    expect(JSON.stringify(f.calls)).not.toContain("37.123456789");
    expect(JSON.stringify(f.calls)).not.toContain(
      "Fensterlaibungen hergestellt",
    );
  } finally {
    await source.close();
  }
}, fixtureTimeout(20000));

test("the normal business client routes daily-report reads, edits and live subscriptions through ciphertext storage", async () => {
  const f = await fixture(false),
    business = createBusinessClient(f.client, { productDriver: duckDriver }),
    values = [];
  const subscription = business
    .streamQuery("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    })
    .subscribe(([value, error]) => {
      if (value && !error) values.push(value);
    });
  async function until(predicate) {
    const deadline = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("Report subscription did not update");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    await until(() => values.length > 0);
    const [saved, error] = await business.mutate(
      "projects.dailyReports.update",
      {
        projectId: "2",
        day: "2026-08-25",
        data: { summary: "Subscribed protected report" },
      },
    );
    expect(error).toBeNull();
    expect(saved.success).toBe(true);
    await until(() => values.at(-1).summary === "Subscribed protected report");
    const [value, failure] = await business.query("projects.dailyReports.get", {
      projectId: "2",
      day: "2026-08-25",
    });
    expect(failure).toBeNull();
    expect(value.summary).toBe("Subscribed protected report");
    expect(
      f.calls.some((call) => call.path.startsWith("projects.dailyReports.")),
    ).toBe(false);
    expect(JSON.stringify(f.calls)).not.toContain(
      "Subscribed protected report",
    );
  } finally {
    subscription.unsubscribe();
    business.dispose();
    f.store.close();
  }
}, fixtureTimeout(20000));

test("deleting a daily report needs no update or private-cost grant, including after a lost commit reply", async () => {
  const f = await fixture(false, ["read", "delete"]);
  try {
    const costs = f.objects.get(f.cost.prefix + "3");
    f.state.loseReply = true;
    expect(
      await f.store.mutate("projects.dailyReports.delete", {
        projectId: "2",
        day: "2026-08-25",
        expectedRevision: "1",
      }),
    ).toEqual({ success: true });
    expect(f.objects.get(f.report.prefix + "3").format).toBe(
      "sortsys-object-tombstone-v1",
    );
    expect(f.objects.get(f.cost.prefix + "3")).toEqual(costs);
    expect(
      await f.store.query("projects.dailyReports.list", { projectId: "2" }),
    ).toEqual([]);
    expect(
      f.calls
        .filter((call) => isKeyEnvelopeQuery(call.path))
        .every((call) => call.input.domain !== f.cost.domain),
    ).toBe(true);
  } finally {
    f.store.close();
  }
}, fixtureTimeout(20000));

test("daily report pages filter by day and break ties by numeric project ID", async () => {
  const areas = ["10", "2"].map((id) => dailyCollection(publicId(id)));
  const f = await protectedTenant(areas);
  const store = createProtectedDailyReports(
    f.client,
    new AbortController().signal,
    duckDriver,
  );

  try {
    for (const [projectId, id, day] of [
      ["10", "18", "2026-08-25"],
      ["2", "3", "2026-08-25"],
      ["10", "19", "2026-08-26"],
    ]) {
      const area = dailyCollection(publicId(projectId));
      await f.seed(area, area.prefix + publicId(id), {
        format: "sortsys-daily-report-v1",
        report: row("daily_project_reports", { id, project_id: projectId, day }),
        hours: [],
        photos: [],
      });
    }

    const input = { to: "2026-08-25", limit: 1 };
    const list = async (offset) =>
      (await store.query("projects.dailyReports.list", { ...input, offset })).map(
        ({ projectId }) => projectId,
      );
    expect(await list(0)).toEqual(["2"]);
    expect(await list(1)).toEqual(["a"]);
    expect(await list(2)).toEqual([]);

    const callCount = f.calls.length;
    await expect(
      store.query("projects.dailyReports.list", { limit: 0 }),
    ).rejects.toThrow(InvalidProtectedData);
    await expect(
      store.query("projects.dailyReports.list", { offset: 0.5 }),
    ).rejects.toThrow(InvalidProtectedData);
    expect(f.calls).toHaveLength(callCount);
  } finally {
    store.close();
  }
}, fixtureTimeout(20000));
