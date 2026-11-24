/** Runs tasks in order. Each caller sees its own error; later tasks still run. */
export function createSerialQueue(check?: () => void) {
  let tail = Promise.resolve();

  return {
    run<T>(work: () => Promise<T>): Promise<T> {
      const result = tail.then(
        check
          ? async () => {
              check();
              const value = await work();
              check();
              return value;
            }
          : work,
      );
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
    // Wait for tasks already submitted, without propagating their errors.
    drained: () => tail,
  };
}
