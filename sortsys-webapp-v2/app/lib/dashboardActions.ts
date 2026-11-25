export type ActionHistoryItem = {
  actionId: string;
  usedAt: Date;
};

export function pickQuickActions<Action extends { id: string }>(
  actions: readonly Action[],
  history: readonly ActionHistoryItem[] | null,
): Action[] {
  const available = new Map(actions.map((action) => [action.id, action]));
  const stats = new Map<string, { count: number; lastUsedAt: number }>();

  for (const { actionId, usedAt } of history ?? []) {
    if (!available.has(actionId)) continue;

    const previous = stats.get(actionId);
    stats.set(actionId, {
      count: (previous?.count ?? 0) + 1,
      lastUsedAt: Math.max(previous?.lastUsedAt ?? 0, usedAt.getTime()),
    });
  }

  const ranked = [...stats.entries()]
    .sort(
      (a, b) => b[1].count - a[1].count || b[1].lastUsedAt - a[1].lastUsedAt,
    )
    .slice(0, 6)
    .map(([id]) => available.get(id)!);

  if (ranked.length >= 4) return ranked;

  const fallback = actions.filter((action) => !stats.has(action.id));
  return [...ranked, ...fallback].slice(0, 6);
}
