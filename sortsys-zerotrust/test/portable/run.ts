import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { exerciseFramework } from "./client";

const dependency = fileURLToPath(import.meta.resolve("@sortsys/zerotrust"));
const localPackages = fileURLToPath(new URL("./node_modules/", import.meta.url));
if (!dependency.startsWith(localPackages)) {
  throw new Error("Consumer resolved a workspace source instead of the installed package");
}
await writeFile(new URL("./browser-vector.json", import.meta.url), JSON.stringify(await exerciseFramework()));
