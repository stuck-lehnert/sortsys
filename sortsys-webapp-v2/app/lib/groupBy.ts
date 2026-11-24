export function groupBy<Value, Key>(
  values: Iterable<Value>,
  keyFor: (value: Value) => Key,
): Map<Key, Value[]> {
  const groups = new Map<Key, Value[]>();

  for (const value of values) {
    const key = keyFor(value);
    const group = groups.get(key);
    if (group) group.push(value);
    else groups.set(key, [value]);
  }

  return groups;
}
