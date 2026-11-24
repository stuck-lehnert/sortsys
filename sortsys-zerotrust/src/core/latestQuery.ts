/** Run at most one read at a time. Refreshing discards a superseded result
 * and schedules a fresh read. Closing discards results and queued reads, but
 * does not cancel a read that already started. */
export function latestQuery<T>(
  read: () => Promise<T>,
  receive: (value: T) => void,
  failed: (error: unknown) => void,
) {
  let active = true;
  let revision = 0;
  let running = false;
  let scheduled = false;

  async function run() {
    running = true;
    try {
      while (active) {
        const version = revision;

        try {
          const value = await read();
          if (active && version === revision) receive(value);
        } catch (error) {
          if (active && version === revision) failed(error);
        }

        if (version === revision) return;
      }
    } finally {
      running = false;
    }
  }

  return {
    refresh() {
      if (!active) return;
      revision++;

      if (running || scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (active) void run();
      });
    },
    close() {
      active = false;
    },
  };
}
