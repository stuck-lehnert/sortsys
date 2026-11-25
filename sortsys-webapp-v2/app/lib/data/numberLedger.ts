import {
  base64,
  bytes,
  immutableObject,
  immutablePrefix,
  InvalidProtectedData,
  randomSecret,
  record,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { arrayBatches, findAvailableNumber } from "@sortsys/zerotrust";
import { ProtectedWriteConflict } from "./atomicWrites";
import type { Collection } from "./protectedObjects";
import { defineDataModel } from "./runtime/model";
import type { DataRequest, DataRuntime, DataView } from "./runtime/runtime";

export const MAX_NUMBER = 9223372036854775807n;

export function nextLedgerNumber(input: unknown): string {
  if (
    typeof input !== "string" ||
    !/^[1-9]\d{0,18}$/.test(input) ||
    BigInt(input) > MAX_NUMBER + 1n
  ) throw new InvalidProtectedData();
  return input;
}

export type NumberNamespace<Name extends string> = {
  format: `sortsys-${Name}-namespace-v1`;
  secret: string;
};

type NumberCounter<Name extends string> = {
  format: `sortsys-${Name}-counter-v1`;
  scope: string;
  nextNumber: string;
};

/** The counter is mutable; claims and the address key are immutable. A claim's
 * public address must not disclose the number, including after key rotation. */
export function defineNumberLedger<Claim extends { number: string }>() {
  return function <Name extends string>({
    name,
    area,
    counterScope,
    decodeClaim,
  }: {
    name: Name;
    area: Collection;
    counterScope(input: unknown): string;
    decodeClaim(input: unknown): Claim;
  }) {
    const { facet, scope } = area;
    const namespaceName = `${name}-namespace`;
    const claimName = `${name}-number`;
    const namespaceFormat = `sortsys-${name}-namespace-v1` as const;
    const counterFormat = `sortsys-${name}-counter-v1` as const;

    function requireArea(actual: Collection) {
      if (actual.domain !== area.domain || actual.scope !== scope || actual.facet !== facet)
        throw new InvalidProtectedData();
    }

    function request<T>(model: DataRequest<T>["model"], id: string): DataRequest<T> {
      return { model, area: { ...area, prefix: id }, ids: [id] };
    }

    const namespaceId = immutableObject(scope, facet, namespaceName, "root");
    const namespaceRequest = request(defineDataModel<NumberNamespace<Name>>({
      name: namespaceName,
      decode(input, object, actual) {
        requireArea(actual);
        const value = record(input, ["format", "secret"]);
        if (object !== namespaceId || value.format !== namespaceFormat)
          throw new InvalidProtectedData();
        if (typeof value.secret !== "string") throw new InvalidProtectedData();
        sized(value.secret, 32).fill(0);
        return { format: namespaceFormat, secret: value.secret };
      },
      sources: () => [],
      tables: [],
    }), namespaceId);

    const counterId = (key: string) => `${area.prefix}counter:${key}`;
    const counterModel = defineDataModel<NumberCounter<Name>>({
      name: `${name}-counter`,
      decode(input, object, actual) {
        requireArea(actual);
        const value = record(input, ["format", "scope", "nextNumber"]);
        const key = counterScope(value.scope);
        if (value.format !== counterFormat || object !== counterId(key))
          throw new InvalidProtectedData();
        return { format: counterFormat, scope: key, nextNumber: nextLedgerNumber(value.nextNumber) };
      },
      sources: () => [],
      tables: [],
    });
    const counterRequest = (key: string) => request(counterModel, counterId(counterScope(key)));

    const prefix = immutablePrefix(scope, facet, claimName);
    function requireClaimAddress(object: string) {
      if (!object.startsWith(prefix) || !/^[\w-]{43}$/.test(object.slice(prefix.length)))
        throw new InvalidProtectedData();
    }

    const claimModel = defineDataModel<Claim>({
      name: `${claimName}-claim`,
      decode(input, object, actual) {
        requireArea(actual);
        requireClaimAddress(object);
        return decodeClaim(input);
      },
      sources: () => [],
      tables: [],
    });

    function claimRequest(object: string) {
      requireClaimAddress(object);
      return request(claimModel, object);
    }

    async function claimAddress(secret: NumberNamespace<Name>) {
      const raw = sized(secret.secret, 32);
      try {
        const key = await crypto.subtle.importKey(
          "raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        return async (number: string) => {
          const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(number)));
          return immutableObject(scope, facet, claimName, base64(digest));
        };
      } finally {
        raw.fill(0);
      }
    }

    return {
      counterRequest,
      claimRequest,
      async claimObject(secret: NumberNamespace<Name>, number: string) {
        return (await claimAddress(secret))(number);
      },
      open(runtime: DataRuntime, live: () => void) {
        async function namespace() {
          const current = await runtime.read([namespaceRequest], (view) =>
            view.documents(namespaceRequest)[0],
          );
          live();
          return current ?? initializeNamespace();
        }

        async function initializeNamespace() {
          const raw = randomSecret();
          const secret = base64(raw);
          raw.fill(0);
          await runtime.transaction([namespaceRequest], (tx) => {
            if (!tx.documents(namespaceRequest).length) {
              tx.create(namespaceRequest, namespaceId, { format: namespaceFormat, secret });
            }
          }, { retries: 3 });

          live();
          return runtime.read([namespaceRequest], (view) => {
            const values = view.documents(namespaceRequest);
            if (values.length !== 1) throw new InvalidProtectedData();
            return values[0]!;
          });
        }

        return {
          namespace,
          async restore(options: {
            scope: string;
            nextNumber: string | null;
            claims: readonly Claim[];
            sameClaim(current: Claim, archived: Claim): boolean;
          }) {
            const next = options.nextNumber === null ? null : nextLedgerNumber(options.nextNumber);
            const scope = counterScope(options.scope);
            const counter = counterRequest(scope);

            if (options.claims.length) {
              const salt = await namespace();
              const address = await claimAddress(salt.value);

              for (const batch of arrayBatches(options.claims, 32)) {
                const page = await Promise.all(
                  batch.map(async (claim) => ({
                    claim,
                    request: claimRequest(await address(claim.number)),
                  })),
                );

                await runtime.transaction(page.map(({ request }) => request), (tx) => {
                  for (const { claim, request } of page) {
                    const current = tx.documents(request)[0];
                    if (!current) tx.create(request, request.area.prefix, claim);
                    else if (!options.sameClaim(current.value, claim)) throw new InvalidProtectedData();
                  }
                }, { retries: 3 });
              }
            }

            if (next !== null) {
              await runtime.transaction([counter], (tx) => {
                const current = tx.documents(counter)[0];
                if (!current) {
                  tx.create(counter, counter.area.prefix, { format: counterFormat, scope, nextNumber: next });
                } else if (BigInt(current.value.nextNumber) < BigInt(next)) {
                  tx.edit(counter, current.id, (value) => { value.nextNumber = next; });
                }
              }, { retries: 3 });
            }
          },
          async plan<Settings>(options: {
            configuration: DataRequest<Settings>;
            fixedScope?: string;
            settings(value: Settings): {
              scope: string;
              startNumber: string;
              format(counter: string): string;
            };
            claim(number: string): Claim;
            exhausted(): Error;
            unconfigured?(): Error;
            writeDenied?(): Error;
            maxChecks?: number;
          }) {
            const { configuration } = options;
            const fixedCounter = options.fixedScope === undefined
              ? undefined
              : counterRequest(options.fixedScope);
            const initial = fixedCounter
              ? [configuration, namespaceRequest, fixedCounter]
              : [configuration, namespaceRequest];

            function readCounter(view: DataView, request: ReturnType<typeof counterRequest>) {
              const current = view.documents(request)[0];
              if (current && options.writeDenied && !view.can(request, "update")) {
                throw options.writeDenied();
              }
              return current;
            }

            const { currentNamespace, document, currentCounter } = await runtime.read(
              initial,
              (view) => {
                // A claim needs create permission even if its namespace exists.
                if (options.writeDenied && !view.can(namespaceRequest, "create")) {
                  throw options.writeDenied();
                }
                const values = view.documents(configuration);
                if (!values.length && options.unconfigured) throw options.unconfigured();
                if (values.length !== 1 || !values[0]!.signature) {
                  throw new InvalidProtectedData();
                }
                return {
                  currentNamespace: view.documents(namespaceRequest)[0],
                  document: values[0]!,
                  currentCounter: fixedCounter && readCounter(view, fixedCounter),
                };
              },
            );
            live();

            const settings = options.settings(document.value);
            if (fixedCounter && options.fixedScope !== settings.scope) {
              throw new InvalidProtectedData();
            }
            const counter = fixedCounter ?? counterRequest(settings.scope);
            const previous = fixedCounter
              ? currentCounter
              : await runtime.read([counter], (view) => readCounter(view, counter));
            live();
            const salt = currentNamespace ?? await initializeNamespace();
            const start = BigInt(settings.startNumber);

            const candidate = await findAvailableNumber({
              start,
              next: previous ? BigInt(previous.value.nextNumber) : start,
              max: MAX_NUMBER,
              maxChecks: options.maxChecks,
              format: settings.format,
              address: await claimAddress(salt.value),
              async occupied({ number, object }) {
                live();
                const request = claimRequest(object);
                const current = await runtime.read([request], (view) => view.documents(request)[0]);
                if (current && current.value.number !== number) throw new InvalidProtectedData();
                return current !== undefined;
              },
            });
            if (!candidate) throw options.exhausted();

            const { number, object: claim, nextNumber } = candidate;
            const request = claimRequest(claim);
            const nextCounter: NumberCounter<Name> = {
              format: counterFormat,
              scope: settings.scope,
              nextNumber,
            };

            return {
              number,
              claim,
              prepare: () => runtime.prepare([configuration, namespaceRequest, counter, request], (tx) => {
                tx.expect(configuration, document.id, { signature: document.signature });
                tx.expect(namespaceRequest, salt.id, { signature: salt.signature });
                if (tx.documents(request).length) throw new ProtectedWriteConflict();

                if (previous) {
                  tx.expect(counter, previous.id, { signature: previous.signature });
                  tx.edit(counter, previous.id, (payload) => Object.assign(payload, nextCounter));
                } else {
                  if (tx.documents(counter).length) throw new ProtectedWriteConflict();
                  tx.create(counter, counter.area.prefix, nextCounter);
                }
                tx.create(request, claim, options.claim(number));
              }),
            };
          },
        };
      },
    };
  };
}
