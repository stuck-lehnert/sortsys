export type AvailableNumber = {
  number: string;
  object: string;
  nextNumber: string;
};

/** Select an unused formatted number. The caller must still compare the
 * configuration and counter heads and atomically publish the claim and next
 * counter. This function makes no writes or assumptions about the store. */
export async function findAvailableNumber(options: {
  start: bigint;
  next: bigint;
  max: bigint;
  maxChecks?: number;
  format(counter: string): string;
  address(number: string): Promise<string>;
  occupied(candidate: { number: string; object: string }): Promise<boolean>;
}): Promise<AvailableNumber | null> {
  const first = options.next < options.start ? options.start : options.next;
  const maxChecks = options.maxChecks ?? Infinity;

  for (
    let counter = first, checked = 0;
    counter <= options.max && checked < maxChecks;
    counter++, checked++
  ) {
    const number = options.format(String(counter));
    const object = await options.address(number);

    if (!(await options.occupied({ number, object }))) {
      return { number, object, nextNumber: String(counter + 1n) };
    }
  }

  return null;
}
