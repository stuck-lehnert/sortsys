import { finishOpaqueLogin, finishOpaqueRegistration, startOpaqueLogin, startOpaqueRegistration } from "./opaque";
import type { OpaqueLoginResult, OpaqueLoginStart, OpaqueRegistrationResult, OpaqueRegistrationStart } from "./opaque";

export type OpaqueWorkerInputs = {
  registrationStart: { password: string };
  registrationFinish: { password: string; tenant: string; username: string; state: OpaqueRegistrationStart; response: string };
  loginStart: { password: string };
  loginFinish: { password: string; tenant: string; username: string; state: OpaqueLoginStart; response: string };
};
export type OpaqueWorkerOutputs = {
  registrationStart: OpaqueRegistrationStart;
  registrationFinish: OpaqueRegistrationResult;
  loginStart: OpaqueLoginStart;
  loginFinish: OpaqueLoginResult;
};
type Input = { [K in keyof OpaqueWorkerInputs]: { id: number; method: K; input: OpaqueWorkerInputs[K] } }[keyof OpaqueWorkerInputs];
type Reply = { id: number; result?: unknown; failed?: true };
export type OpaqueWorkerScope = { addEventListener: (type: "message", listener: (event: MessageEvent<Input>) => void) => void; postMessage: (message: Reply) => void };

/** Dedicated entry: import this function in a Worker, not in the UI thread. */
export function attachOpaqueWorker(scope: OpaqueWorkerScope): void {
  scope.addEventListener("message", event => {
    void (async () => {
      const { id, method, input } = event.data;
      if (!Number.isSafeInteger(id) || id < 1) return;
      try {
        if (typeof input?.password !== "string" || !input.password.length || input.password.length > 2000) throw new Error();
        let result: unknown;
        switch (method) {
          case "registrationStart": result = await startOpaqueRegistration(input.password); break;
          case "registrationFinish": result = await finishOpaqueRegistration(input.password, input.tenant, input.username, input.state, input.response); break;
          case "loginStart": result = await startOpaqueLogin(input.password); break;
          case "loginFinish": result = await finishOpaqueLogin(input.password, input.tenant, input.username, input.state, input.response); break;
          default: throw new Error();
        }
        scope.postMessage({ id, result });
      } catch {
        // Errors may originate in password parsers; never echo their arguments.
        scope.postMessage({ id, failed: true });
      }
    })();
  });
}

export class OpaqueWorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void; timeout: ReturnType<typeof setTimeout> }>();
  #id = 0;
  #closed = false;
  constructor(worker: Worker) {
    this.#worker = worker;
    worker.addEventListener("message", (event: MessageEvent<Reply>) => {
      const reply = event.data;
      const waiting = this.#pending.get(reply?.id);
      if (!waiting) return;
      this.#pending.delete(reply.id); clearTimeout(waiting.timeout);
      if (reply.failed) waiting.reject(new Error("Anmeldung oder Passwortprüfung fehlgeschlagen."));
      else waiting.resolve(reply.result);
    });
    worker.addEventListener("error", () => this.close());
  }

  call<K extends keyof OpaqueWorkerInputs>(method: K, input: OpaqueWorkerInputs[K]): Promise<OpaqueWorkerOutputs[K]> {
    if (this.#closed) return Promise.reject(new Error("Die Passwortprüfung wurde beendet."));
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => this.close(), 60000);
      this.#pending.set(id, { resolve: value => resolve(value as OpaqueWorkerOutputs[K]), reject, timeout });
      this.#worker.postMessage({ id, method, input });
    });
  }

  close(): void {
    this.#closed = true;
    this.#worker.terminate();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout); pending.reject(new Error("Die Passwortprüfung wurde beendet."));
    }
    this.#pending.clear();
  }
}
