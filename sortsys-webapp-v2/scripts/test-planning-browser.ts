import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@sortsys/v2-client";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import type { PlanningScenario } from "./test-native-planning-recipients";
import type { RecoveredSiteClosure } from "./test-native-planning-recovery";

/** Prepare only through normal client encryption. The browser then edits and
 * deletes its fixture through the actual production forms and both API peers. */
export async function exercisePlanningBrowser(
  owner: Client,
  draft: Pick<OwnerDraft, "username" | "password" | "userId">,
  scenario: PlanningScenario,
  closure: RecoveredSiteClosure,
) {
  assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
  assert.equal(process.env.SORTSYS_NATIVE_BROWSER, "1");
  const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
  assert.ok(root);
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  const note = "Nur eigener Einsatz im Browser 628194";
  const changedNote = "Eigener Einsatz live bearbeitet 628194";
  const hiddenNote = "Fremder Einsatz im selben Projekt 749281";
  const from = new Date("2026-11-18T08:00:00Z");
  const to = new Date("2026-11-18T16:00:00Z");
  try {
    const own = await required(
      business.mutate("projects.deployments.create", {
        projectId: scenario.project.id,
        userId: scenario.member.id,
        from,
        to,
        note,
      }),
    );
    await required(
      business.mutate("projects.deployments.create", {
        projectId: scenario.project.id,
        userId: draft.userId,
        from,
        to,
        note: hiddenNote,
      }),
    );
    const fixture = join(root, "planning-browser-fixture.json");
    await writeFile(
      fixture,
      JSON.stringify({
        ...scenario,
        owner: { username: draft.username, password: draft.password },
        assignmentId: own.id,
        note,
        changedNote,
        hiddenNote,
        renamedTitle: "Live umbenannte Baustelle 794612",
        closure,
      }),
      { mode: 0o600 },
    );
    const log = join(root, "browser-own-planning.log");
    const output = await open(log, "w");
    try {
      const child = spawn(
        "node",
        ["scripts/e2e/planning.browser.mjs", fixture],
        {
          env: process.env,
          stdio: ["ignore", output.fd, output.fd],
        },
      );
      await new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code === 0) resolve();
          else
            reject(
              new Error(`Own planning browser test failed; inspect ${log}`),
            );
        });
      });
    } finally {
      await output.close();
    }
    const remaining = await required(
      business.query("projects.deployments.list", {
        projectId: scenario.project.id,
        from,
        to,
      }),
    );
    assert.equal(
      remaining.some((assignment) => assignment.id === own.id),
      false,
    );
    const closures = await required(
      business.query("projects.unavailability.list", {
        projectId: scenario.project.id,
        from: closure.from,
        to: closure.to,
      }),
    );
    assert.equal(closures.some((period) => period.id === closure.id), false);
    console.log(
      "Own planning browser: production SPA, private visibility, disabled editing and cross-instance update/deletion verified",
    );
  } finally {
    business.dispose();
  }
}
