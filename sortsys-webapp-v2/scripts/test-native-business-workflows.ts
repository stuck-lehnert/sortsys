import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { publicId, newProductRowId } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";

type RequestHook = (
  url: URL,
  next: () => Promise<Response>,
) => Promise<Response>;
type ReplyFault = "lose" | "pretend";

/** Faults affect the actual atomic publication, after normal encryption and
 * staging. All ordinary reads and writes still reach the native API routers. */
function publicationFaults(install: (hook: RequestHook | null) => void) {
  let fault: ReplyFault | null = null;
  let affected = 0;
  install(async (url, next) => {
    const publication =
      url.pathname.endsWith("/zerotrust.objects.commit") ||
      url.pathname.endsWith("/zerotrust.objects.batch");
    if (!publication || !fault) return next();
    affected++;
    if (fault === "pretend") {
      return Response.json([{ result: { data: { json: { success: true } } } }]);
    }
    fault = null;
    const response = await next();
    assert.equal(response.ok, true);
    throw new TypeError("Lost successful publication reply");
  });
  return {
    async during<T>(kind: ReplyFault, work: () => Promise<T>) {
      fault = kind;
      affected = 0;
      try {
        const result = await work();
        assert.ok(affected > 0, "The fault must reach an actual publication");
        return result;
      } finally {
        fault = null;
      }
    },
    close() {
      install(null);
    },
  };
}

export async function exerciseNativeBusinessWorkflows(
  owner: Client,
  peer: Client,
  install: (hook: RequestHook | null) => void,
) {
  const summary = "Vertrauliche Fassadenarbeit im nativen Fachablauf 749283";
  const note = "Vertraulicher Baustellenwechsel 928471";
  const project = await required(
    owner.mutate("projects.create", {
      title: "Baustelle für Bericht und Einsatzplanung",
    }),
  );
  const target = await required(
    peer.mutate("projects.create", {
      title: "Zielbaustelle der Einsatzplanung",
    }),
  );
  const faults = publicationFaults(install);
  try {
    const day = "2026-10-22";
    await faults.during("lose", () =>
      required(
        owner.mutate("projects.dailyReports.create", {
          projectId: project.id,
          day,
          summary,
          workHours: [
            {
              userId: null,
              hours: 7.375,
              costPerHour: 73.87654321,
              contractType: "external",
            },
          ],
        }),
      ),
    );
    const first = await required(
      owner.query("projects.dailyReports.get", { projectId: project.id, day }),
    );
    const remote = await required(
      peer.query("projects.dailyReports.get", { projectId: project.id, day }),
    );
    assert.equal(remote.id, first.id);
    assert.equal(remote.summary, summary);
    await required(
      peer.mutate("projects.dailyReports.update", {
        projectId: project.id,
        day,
        expectedRevision: remote.revision,
        data: {
          workHours: [
            {
              id: remote.workHours[0]!.id,
              userId: null,
              hours: 8.125,
              contractType: "external",
            },
          ],
        },
      }),
    );
    assert.ok(
      (
        await owner.mutate("projects.dailyReports.update", {
          projectId: project.id,
          day,
          expectedRevision: first.revision,
          data: { summary: "Stale report" },
        })
      )[1],
    );
    await owner.invalidate("projects.dailyReports.get");
    const changed = await required(
      owner.query("projects.dailyReports.get", { projectId: project.id, day }),
    );
    assert.equal(changed.workHours[0]!.hours, 8.125);
    assert.equal(changed.workHours[0]!.costPerHour, 73.87654321);
    await faults.during("pretend", async () => {
      assert.ok(
        (
          await owner.mutate("projects.dailyReports.update", {
            projectId: project.id,
            day,
            data: { summary: "Unconfirmed report" },
          })
        )[1],
      );
    });
    await peer.invalidate("projects.dailyReports.get");
    assert.equal(
      (
        await required(
          peer.query("projects.dailyReports.get", {
            projectId: project.id,
            day,
          }),
        )
      ).summary,
      summary,
    );

    const regie = await faults.during("lose", () =>
      required(
        owner.mutate("regieReports.create", {
          projectId: project.id,
          day,
          summary,
          specialRecords: [
            {
              name: "Zusätzliche Abdichtung 749283",
              unit: "m",
              amount: 2.375,
              comment: "Fensterlaibung",
            },
          ],
          workHours: [{ day, hours: 3.125, userId: null }],
        }),
      ),
    );
    const initialRegie = await required(
      peer.query("regieReports.get", { id: regie.id }),
    );
    await required(
      peer.mutate("regieReports.update", {
        id: regie.id,
        expectedRevision: initialRegie.revision,
        expectedHoursRevision: initialRegie.hoursRevision,
        data: {
          workHours: [
            {
              id: initialRegie.workHours[0]!.id,
              day,
              hours: 4.375,
              userId: null,
            },
          ],
        },
      }),
    );
    assert.ok(
      (
        await owner.mutate("regieReports.update", {
          id: regie.id,
          expectedHoursRevision: initialRegie.hoursRevision,
          data: {
            workHours: [
              {
                id: initialRegie.workHours[0]!.id,
                day,
                hours: 1,
                userId: null,
              },
            ],
          },
        })
      )[1],
    );
    const changedRegie = await required(
      owner.query("regieReports.get", { id: regie.id }),
    );
    assert.equal(changedRegie.workHours[0]!.hours, 4.375);
    assert.equal(changedRegie.specialRecords[0]!.amount, 2.375);

    const people = await required(
      owner.query("users.list", { deactivated: false }),
    );
    assert.ok(people.length > 0);
    const operationId = publicId(newProductRowId());
    const deployment = {
      operationId,
      projectId: project.id,
      userId: people[0]!.id,
      from: new Date("2026-10-22T06:00:00Z"),
      to: new Date("2026-10-22T14:00:00Z"),
      note,
    };
    await faults.during("lose", () =>
      required(owner.mutate("projects.deployments.create", deployment)),
    );
    await required(owner.mutate("projects.deployments.create", deployment));
    const range = {
      from: new Date("2026-10-22T00:00:00Z"),
      to: new Date("2026-10-23T00:00:00Z"),
    };
    const find = async (client: Client) => {
      await client.invalidate("projects.deployments.list");
      const rows = await required(
        client.query("projects.deployments.list", range),
      );
      const matches = rows.filter((row) => row.id === operationId);
      assert.equal(matches.length, 1);
      return matches[0]!;
    };
    const initialDeployment = await find(peer);
    await required(
      peer.mutate("projects.deployments.update", {
        id: operationId,
        expectedRevision: initialDeployment.revision,
        data: { projectId: target.id },
      }),
    );
    const moved = await find(owner);
    assert.equal(moved.projectId, target.id);
    await required(
      owner.mutate("projects.deployments.update", {
        id: operationId,
        expectedRevision: moved.revision,
        data: { projectId: project.id },
      }),
    );
    const returned = await find(peer);
    assert.equal(returned.projectId, project.id);
    assert.notEqual(returned.revision, initialDeployment.revision);
    assert.ok(
      (
        await peer.mutate("projects.deployments.update", {
          id: operationId,
          expectedRevision: initialDeployment.revision,
          data: { note: "Stale deployment" },
        })
      )[1],
    );
    await faults.during("pretend", async () => {
      assert.ok(
        (
          await peer.mutate("projects.deployments.delete", {
            id: operationId,
            expectedRevision: returned.revision,
          })
        )[1],
      );
    });
    assert.equal((await find(owner)).note, note);
    await faults.during("lose", () =>
      required(
        peer.mutate("projects.deployments.delete", {
          id: operationId,
          expectedRevision: returned.revision,
        }),
      ),
    );
    await owner.invalidate("projects.deployments.list");
    const remaining = await required(
      owner.query("projects.deployments.list", range),
    );
    assert.equal(
      remaining.some((row) => row.id === operationId),
      false,
    );
    console.log(
      "Native daily reports, regie reports and planning passed across two APIs: exact quantities, stable line IDs, stale forms, atomic moves, repeated creation and false/lost publication replies.",
    );
    return [summary, note, "Zusätzliche Abdichtung 749283"];
  } finally {
    faults.close();
  }
}
