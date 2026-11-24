type ResourceScope<T> = {
  signal(): AbortSignal;
  assertActive(): void;
  expired(): Error;
  open(signal: AbortSignal): T | Promise<T>;
  activate?(resource: T): void;
  close(resource: T): void | Promise<void>;
};

/** A lazy resource must not outlive the scope in which it was opened.
 * Reset detaches the current open immediately and closes even a late result. */
export function createScopedResource<T>(scope: ResourceScope<T>) {
  type Slot = {
    signal: AbortSignal;
    value: Promise<T>;
    ready?: { resource: T };
  };
  let current: Slot | undefined;

  function dispose(resource: T) {
    try {
      void Promise.resolve(scope.close(resource)).catch(() => undefined);
    } catch {
      // The resource was already detached; a close failure must not reattach it.
    }
  }

  function clear(slot: Slot | undefined) {
    if (!slot || current !== slot) return;

    current = undefined;
    if (slot.ready) dispose(slot.ready.resource);
  }

  function assertCurrent(slot: Slot) {
    scope.assertActive();
    slot.signal.throwIfAborted();

    if (current !== slot || scope.signal() !== slot.signal) {
      throw scope.expired();
    }
  }

  async function open(slot: Slot) {
    assertCurrent(slot);
    const resource = await scope.open(slot.signal);
    try {
      assertCurrent(slot);
      if (scope.activate) {
        scope.activate(resource);
        assertCurrent(slot);
      }
      slot.ready = { resource };
      return resource;
    } catch (error) {
      dispose(resource);
      throw error;
    }
  }

  async function get() {
    scope.assertActive();
    const signal = scope.signal();
    signal.throwIfAborted();

    if (!current) {
      const slot: Slot = {
        signal,
        value: Promise.resolve().then(() => open(slot)),
      };
      current = slot;
    }

    const slot = current;
    try {
      assertCurrent(slot);
      const resource = await slot.value;
      assertCurrent(slot);
      return resource;
    } catch (error) {
      clear(slot);
      throw error;
    }
  }

  function peek() {
    const slot = current;
    if (!slot?.ready) return undefined;

    try {
      assertCurrent(slot);
      return slot.ready.resource;
    } catch {
      clear(slot);
      return undefined;
    }
  }

  return {
    get,
    peek,
    getIfOpen: () => (current ? get() : null),
    reset: () => clear(current),
  };
}
