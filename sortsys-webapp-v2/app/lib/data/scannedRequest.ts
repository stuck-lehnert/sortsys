import {
  accountRequestFingerprint,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { assistantId } from "./privateLlm";

/** The write receipt can be found again after reopening the scan. The stored
 * request identifier does not expose the personal scan ID or its contents. */
export async function scannedRequestId(
  purpose: "sortsys/delivery-scan-request/v1" | "sortsys/price-scan-request/v1",
  scanId: string,
  normalizedInput: unknown,
): Promise<string> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const requestId = await accountRequestFingerprint(
    account.dataKey,
    purpose,
    account.tenant,
    account.vault.subject,
    [assistantId(scanId), normalizedInput],
  );
  if (account !== unlockedAccount()) throw new InvalidProtectedData();
  return requestId;
}
