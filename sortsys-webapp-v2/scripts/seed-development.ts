import { resolve } from "node:path";
import { seedDevelopmentTenant } from "./development/seed";

if (process.env.SORTSYS_DEVELOPMENT_SEED !== "1") {
  throw new Error(
    "Der Musterbestand wird ausschließlich durch scripts/dev eingerichtet",
  );
}
const endpoint = new URL(
  process.env.SORTSYS_DEV_API_URL ?? "http://127.0.0.1:3000/",
);
const local =
  ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
  /^[a-zA-Z0-9_-]+-api$/.test(endpoint.hostname);
if (
  !local ||
  endpoint.protocol !== "http:" ||
  endpoint.username ||
  endpoint.password ||
  endpoint.pathname !== "/" ||
  endpoint.search ||
  endpoint.hash
) {
  throw new Error(
    "Der Entwicklungsbestand benötigt eine lokale API oder einen Entwicklungscontainer",
  );
}
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
await seedDevelopmentTenant({
  endpoint: endpoint.href,
  directory: resolve(
    process.env.SORTSYS_DEV_SEED_DIRECTORY ?? "../.dev-data/zerotrust/seed",
  ),
  operatorPassword: process.env.SORTSYS_DEV_ADMIN_PASSWORD ?? "123456",
  signal: controller.signal,
  log: console.log,
});
console.log(
  "Musterbestand bereit: john.doe@test (Admin), frank.doe@test (normaler Benutzer), Passwort jeweils 123456",
);
