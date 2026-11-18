import assert from "node:assert/strict";
import { type Client } from "@sortsys/v2-client";
import {
  approvePreparedContent,
  inspectPreparedContent,
  RestoreBookingConflict,
} from "../app/lib/backups/contentRestore";
import { signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { toolUsageCollection } from "../app/lib/data/projectToolUsage";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { toolCollection } from "../app/lib/data/toolData";
import { enrollToolResponsibleMember } from "./test-native-tool-recovery";
import { exerciseToolResponsibilityBrowser } from "./test-tool-responsibility-browser";

type Login = { tenant: string; username: string; password: string };
const fresh = { strategy: "network-only" } as const;

export async function rejectRestoreWithoutBookingParents(
  tenant: string,
  owner: Client,
  peer: Client,
  operator: Client,
  existingProjectId: string,
) {
  async function createTool() {
    return required(
      owner.mutate("tools.create", {
        customId: await required(
          owner.query("tools.suggestNextCustomId", undefined),
        ),
        brand: "Montagegerät für Abhängigkeitsprüfung",
        category: "Montage",
        usageCostPerDay: 17.5,
      }),
    );
  }
  const first = await createTool();
  const backup = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: crypto.randomUUID(),
    }),
  );
  const later = await required(
    owner.mutate("projects.create", { title: "Projekt nach der Sicherung" }),
  );
  async function checkRejected(toolId: string, projectId: string) {
    const booking = await required(
      owner.mutate("tools.track", { id: toolId, data: { projectId } }),
    );
    try {
      const prepared = await required(
        peer.mutate("zerotrust.content.prepare", {
          snapshotOperation: backup.id,
          operation: crypto.randomUUID(),
        }),
      );
      const signal = new AbortController().signal;
      const proposed = await approvePreparedContent(peer, prepared, signal);
      await assert.rejects(
        () => inspectPreparedContent(peer, proposed, signal),
        RestoreBookingConflict,
      );
      const live = await required(
        peer.query("tools.get", { id: toolId }, fresh),
      );
      assert.equal(live.activeTrackingId, booking.trackingId);
    } finally {
      await required(owner.mutate("tools.untrack", { id: toolId }));
    }
  }
  await checkRejected(first.id, later.id);
  const lateTool = await createTool();
  await checkRejected(lateTool.id, existingProjectId);
}

export async function prepareToolBookingRestore(
  owner: Client,
  peer: Client,
  member: Client,
  projectId: string,
  login: Login,
) {
  const memberLogin = {
    tenant: login.tenant,
    username: "restore.tool.worker",
    password: "Isolated-tool-worker-password-2026!",
  };
  const person = await required(
    owner.mutate("users.create", {
      username: memberLogin.username,
      firstName: "Werkzeug",
      lastName: "Verantwortung",
    }),
  );
  await enrollToolResponsibleMember(
    owner,
    member,
    {
      id: person.id,
      username: memberLogin.username,
    },
    login,
    memberLogin.password,
  );
  await signIn(owner, login);
  const originalBrand = "Montagegerät im Sicherungsstand";
  const currentBrand = "Montagegerät nach der Sicherung";
  const originalLabel = "Zurückgegebene Buchung vor der Sicherung";
  const currentLabel = "Aktuelle Buchung nach der Sicherung";
  const tool = await required(
    owner.mutate("tools.create", {
      customId: await required(
        owner.query("tools.suggestNextCustomId", undefined),
      ),
      brand: originalBrand,
      category: "Montage",
      usageCostPerDay: 31.25,
    }),
  );

  function book(comment: string, expectedTrackingId: string | null = null) {
    return owner.mutate("tools.trackMany", {
      operationId: publicId(newProductRowId()),
      tools: [{ id: tool.id, expectedTrackingId }],
      data: { responsibleUserId: person.id, projectId, comment },
    });
  }
  const originalBooking = (await required(book(originalLabel))).trackings[0]!;
  async function asMember<T>(
    check: (business: ReturnType<typeof createBusinessClient>, transport: Client) => Promise<T>,
  ): Promise<T> {
    await signIn(member, memberLogin);
    const business = createBusinessClient(member, { productDriver: duckDriver });
    try {
      return await check(business, member);
    } finally {
      business.dispose();
      await signIn(owner, login);
    }
  }
  return async function replaceAfterBackup() {
    await required(owner.mutate("tools.untrack", { id: tool.id }));
    await required(
      owner.mutate("tools.update", {
        id: tool.id,
        data: {
          brand: currentBrand,
          usageCostPerDay: 42.5,
        },
      }),
    );
    const current = (await required(book(currentLabel))).trackings[0]!;
    const selected = { toolId: tool.id, projectId };
    const before = await required(
      owner.query("tools.trackings.list", selected, fresh),
    );
    assert.equal(
      before.find(({ id }) => id === current.trackingId)?.toolUsageCostPerDay,
      42.5,
    );

    return {
      asMember,
      memberId: person.id,
      async check() {
        const restored = await required(
          peer.query("tools.get", { id: tool.id }, fresh),
        );
        assert.equal(restored.brand, originalBrand);
        assert.equal(restored.usageCostPerDay, 31.25);
        assert.equal(restored.available, false);
        assert.equal(restored.activeTrackingId, current.trackingId);
        const bookings = await required(
          peer.query("tools.trackings.list", selected, fresh),
        );
        assert.deepEqual(bookings, before);
        assert.ok(
          bookings.find(({ id }) => id === originalBooking.trackingId)?.endedAt,
        );
        const costs = await required(
          peer.query("projects.costs.get", { projectId }, fresh),
        );
        const projectBooking = costs.toolTrackings.find(
          ({ id }) => id === current.trackingId,
        );
        assert.equal(projectBooking?.responsibleUserId, person.id);
        assert.equal(projectBooking?.toolUsageCostPerDay, 42.5);
        assert.equal(projectBooking?.endedAt, null);
      },
      async checkMemberAndReturn() {
        await asMember(async (business, transport) => {
          const bookings = await required(
            business.query("tools.trackings.list", {}, fresh),
          );
          assert.deepEqual(
            bookings.map(({ id }) => id),
            [current.trackingId],
          );
          assert.equal(bookings[0]?.toolUsageCostPerDay, null);
          assert.equal(bookings[0]?.toolSummary?.id, tool.id);
          const expense = toolCollection(
            "tool-tracking",
            current.trackingId,
            "procurement",
          );
          const projectCost = toolUsageCollection(projectId, "procurement");
          for (const id of [
            expense.prefix,
            projectCost.prefix + current.trackingId,
          ]) {
            const [packet, error] = await transport.query(
              "zerotrust.objects.get",
              { id },
              fresh,
            );
            assert.equal(packet, null);
            assert.equal(error?.data?.httpCode, 403);
          }
        });
        const [stale, error] = await book(
          currentLabel,
          originalBooking.trackingId,
        );
        assert.equal(stale, null);
        assert.ok(error);
        const returnTool = () =>
          required(peer.mutate("tools.untrack", { id: tool.id }));
        if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
          await exerciseToolResponsibilityBrowser(
            {
              tenant: login.tenant,
              member: memberLogin,
              toolBrand: currentBrand,
              toolId: tool.id,
              activeLabel: currentBrand,
              closedLabel: originalBrand,
              bookingDomain: toolCollection(
                "tool-tracking",
                current.trackingId,
                "master-data",
              ).domain,
              artifactName: "restored-tool-booking",
            },
            returnTool,
          );
        } else await returnTool();
        const returned = await required(
          owner.query("tools.get", { id: tool.id }, fresh),
        );
        assert.equal(returned.activeTrackingId, null);
        assert.equal(returned.available, true);
        const costs = await required(
          owner.query("projects.costs.get", { projectId }, fresh),
        );
        assert.ok(
          costs.toolTrackings.find(({ id }) => id === current.trackingId)
            ?.endedAt,
        );
      },
    };
  };
}
