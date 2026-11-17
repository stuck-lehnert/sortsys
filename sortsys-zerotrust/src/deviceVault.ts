import { accountVault, accountVaultFrame } from "./vault";
import type { AccountVault } from "./vault";
import { base64, frame } from "./encoding";

type StoredDevice = {
  id: string;
  tenant: string;
  subject: string;
  vault: AccountVault;
  key: CryptoKey;
  nonce: Uint8Array<ArrayBuffer>;
  ciphertext: ArrayBuffer;
};
const DATABASE = "sortsys-device-vault-v1";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("accounts")) {
        request.result.createObjectStore("accounts", { keyPath: "id" });
      }
      if (!request.result.objectStoreNames.contains("protected-accounts")) {
        request.result.createObjectStore("protected-accounts", {
          keyPath: "id",
        });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(new Error("Der lokale Schlüsselspeicher ist nicht verfügbar."));
    request.onblocked = () =>
      reject(new Error("Der lokale Schlüsselspeicher ist belegt."));
  });
}
function id(tenant: string, subject: string): string {
  return base64(frame("sortsys/device-account/v1", [tenant, subject]));
}

async function get(
  tenant: string,
  subject: string,
): Promise<StoredDevice | undefined> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("accounts", "readonly");
      const request = tx.objectStore("accounts").get(id(tenant, subject));
      let result: StoredDevice | undefined;
      request.onsuccess = () => {
        result = request.result as StoredDevice | undefined;
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(
          new Error(
            "Der lokale Schlüsselspeicher konnte nicht gelesen werden.",
          ),
        );
    });
  } finally {
    db.close();
  }
}

export async function hasDeviceVault(
  tenant: string,
  subject: string,
): Promise<boolean> {
  try {
    return Boolean(await get(tenant, subject));
  } catch {
    return false;
  }
}

/** This public marker survives logout. Removing private cached keys must never
 * make a protected account eligible for automatic plaintext legacy sign-in. */
export async function hasProtectedAccount(
  tenant: string,
  subject: string,
): Promise<boolean> {
  let db: IDBDatabase | undefined;
  try {
    db = await open();
    return await new Promise((resolve, reject) => {
      const tx = db!.transaction(
        ["accounts", "protected-accounts"],
        "readonly",
      );
      const first = tx.objectStore("accounts").get(id(tenant, subject));
      const second = tx
        .objectStore("protected-accounts")
        .get(id(tenant, subject));
      tx.oncomplete = () => resolve(Boolean(first.result || second.result));
      tx.onabort = () => reject(new Error());
    });
  } catch {
    return true;
  } finally {
    // Storage failure cannot authorize a downgrade.
    db?.close();
  }
}

export async function rememberDeviceVault(
  dataKey: CryptoKey,
  input: AccountVault,
): Promise<boolean> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw = new Uint8Array(await crypto.subtle.exportKey("raw", dataKey));
    if (raw.length !== 32 || dataKey.algorithm.name !== "AES-GCM") {
      return false;
    }
    const vault = accountVault(input);
    // This key is origin-local and non-extractable. It is never uploaded.
    const key = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: accountVaultFrame(vault) },
      key,
      raw,
    );
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(
          ["accounts", "protected-accounts"],
          "readwrite",
        );
        tx.objectStore("accounts").put({
          id: id(vault.tenant, vault.subject),
          tenant: vault.tenant,
          subject: vault.subject,
          vault,
          key,
          nonce,
          ciphertext,
        } satisfies StoredDevice);
        tx.objectStore("protected-accounts").put({
          id: id(vault.tenant, vault.subject),
        });
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error());
      });
    } finally {
      db.close();
    }
    return true;
  } catch {
    // Private browsing may deny storage. The current session still works;
    // the next page load requires the password instead of plaintext fallback.
    return false;
  } finally {
    raw?.fill(0);
  }
}

export async function restoreDeviceVault(
  tenant: string,
  subject: string,
): Promise<{ dataKey: CryptoKey; vault: AccountVault } | null> {
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    const stored = await get(tenant, subject);
    if (
      !stored ||
      stored.tenant !== tenant ||
      stored.subject !== subject ||
      stored.key.extractable
    )
      return null;
    const vault = accountVault(stored.vault);
    if (vault.tenant !== tenant || vault.subject !== subject) return null;
    raw = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: stored.nonce,
          additionalData: accountVaultFrame(vault),
        },
        stored.key,
        stored.ciphertext,
      ),
    );
    if (raw.length !== 32) return null;
    const dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, [
      "encrypt",
      "decrypt",
    ]);
    return { dataKey, vault };
  } catch {
    return null;
  } finally {
    raw?.fill(0);
  }
}

export async function forgetDeviceVaults(): Promise<void> {
  try {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        tx.objectStore("accounts").clear();
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(new Error());
      });
    } finally {
      db.close();
    }
  } catch {
    throw new Error(
      "Der lokale Schlüsselspeicher konnte nicht gelöscht werden.",
    );
  }
}
