import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { dashboardPin, type DashboardPin } from "./personalHistoryData";

type Storage = Pick<globalThis.Storage, "getItem" | "removeItem">;
/** The old key contains confidential paths/titles. Delete exactly that account's
 * old copy only after a checked encrypted write; never persist a new clear copy. */
export async function importLegacyDashboardPins(
  storage: Storage,
  tenant: string,
  userId: string,
  write: (entries: DashboardPin[]) => Promise<void>,
  live: () => void,
): Promise<void> {
  const key = `webapp::dashboard.pinnedVisits:${tenant}:${userId}`,
    source = storage.getItem(key);
  if (source === null) return;
  if (source.length > 32 * 1024) throw new InvalidProtectedData();
  const parsed: unknown = JSON.parse(source);
  if (!Array.isArray(parsed) || parsed.length > 12)
    throw new InvalidProtectedData();
  const entries = parsed.map((input) => {
    const value = dashboardPin(input);
    return { ...value, visitedAt: new Date(value.visitedAt) };
  });
  live();
  await write(entries);
  live();
  if (storage.getItem(key) === source) storage.removeItem(key);
}
