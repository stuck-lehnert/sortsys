import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function exerciseToolResponsibilityBrowser<T>(
  fixture: {
    tenant: string;
    member: { username: string; password: string };
    activeLabel: string;
    closedLabel?: string;
    toolBrand: string;
    toolId: string;
    bookingDomain: string;
    artifactName?: string;
  },
  returnTool: () => Promise<T>,
): Promise<T> {
  assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
  assert.equal(process.env.SORTSYS_NATIVE_BROWSER, "1");
  const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
  assert.ok(root);
  const scenario = fixture.artifactName ?? "late-tools";
  assert.match(scenario, /^[a-z0-9-]+$/);
  const path = join(
    root,
    `tool-responsibility-${scenario}-browser-fixture.json`,
  );
  await writeFile(path, JSON.stringify(fixture), { mode: 0o600 });
  const log = join(root, `browser-tool-responsibility-${scenario}.log`);
  const output = await open(log, "w");
  try {
    const child = spawn(
      "node",
      ["scripts/e2e/toolResponsibility.browser.mjs", path],
      { env: process.env, stdio: ["ignore", output.fd, output.fd, "ipc"] },
    );
    let returned: Promise<T> | undefined;
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.on("message", (message) => {
        if (message !== "booking-visible" || returned) {
          reject(new Error("Unexpected tool browser test message"));
          child.kill("SIGTERM");
          return;
        }
        returned = returnTool();
        void returned.then(
          () => {
            if (child.connected) child.send("booking-returned");
          },
          (error) => {
            reject(error);
            child.kill("SIGTERM");
          },
        );
      });
      child.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Tool browser test failed; inspect ${log}`));
      });
    });
    assert.ok(returned, "The browser must observe the booking before return");
    return await returned;
  } finally {
    await output.close();
  }
}
