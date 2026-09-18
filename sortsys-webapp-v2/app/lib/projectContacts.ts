export type ProjectContactSelection = {
  contactId: string;
  label?: string | null;
};

export function projectContactsEqual(
  left: readonly ProjectContactSelection[],
  right: readonly ProjectContactSelection[],
) {
  // Order is irrelevant. As on the server, duplicate IDs use the final label.
  const normalized = (contacts: readonly ProjectContactSelection[]) => new Map(
    contacts.map(contact => [contact.contactId, contact.label?.trim() || null]),
  );
  const first = normalized(left);
  const second = normalized(right);

  return first.size === second.size && [...first].every(
    ([id, label]) => second.has(id) && second.get(id) === label,
  );
}

