import { uiText } from "~/lib/i18n";
import { Tile } from "@sortsys/react-components";
import { useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";

export function meta() {
  return [
    { title: uiText("Vorgesetzte") },
  ];
}

function supervisorId(user: User) {
  return (user as any).supervisorUserId as string | null | undefined;
}

function sortUsers(users: User[]) {
  return [...users].sort((a, b) => userFullName(a).localeCompare(userFullName(b), 'de'));
}

export default function UserSupervisorsPage() {
  const [users] = useClientStream(() => client.streamQuery('users.list', {}), []);
  const [defaultSupervisor] = useClientStream<{ userId: string | null } | null, any>(() => {
    return client.streamQuery('users.supervisors.getDefault', undefined, { strategy: 'cache-first' });
  }, []);
  const [expandedUserIds, setExpandedUserIds] = useState<Set<string>>(() => new Set());

  const graph = useMemo(() => {
    const allUsers = sortUsers((users ?? []) as User[]);
    const byId = new Map(allUsers.map(user => [user.id, user]));
    const childrenBySupervisorId = new Map<string, User[]>();

    for (const user of allUsers) {
      const id = supervisorId(user);
      if (!id || !byId.has(id)) continue;
      const children = childrenBySupervisorId.get(id) ?? [];
      children.push(user);
      childrenBySupervisorId.set(id, children);
    }

    for (const [id, children] of childrenBySupervisorId) {
      childrenBySupervisorId.set(id, sortUsers(children));
    }

    const roots = allUsers.filter(user => {
      const id = supervisorId(user);
      return !id || !byId.has(id);
    });

    const reachableUserIds = new Set<string>();
    const markReachable = (user: User) => {
      if (reachableUserIds.has(user.id)) return;
      reachableUserIds.add(user.id);
      for (const child of childrenBySupervisorId.get(user.id) ?? []) markReachable(child);
    };
    roots.forEach(markReachable);

    return {
      allUsers,
      childrenBySupervisorId,
      roots,
      cycleRoots: allUsers.filter(user => !reachableUserIds.has(user.id)),
      expandableUserIds: allUsers
        .filter(user => (childrenBySupervisorId.get(user.id) ?? []).length > 0)
        .map(user => user.id),
    };
  }, [users]);

  const defaultSupervisorUser = useMemo(() => {
    return graph.allUsers.find(user => user.id === defaultSupervisor?.userId) ?? null;
  }, [graph.allUsers, defaultSupervisor?.userId]);

  const expandAll = () => setExpandedUserIds(new Set(graph.expandableUserIds));

  const toggleExpanded = (userId: string) => {
    setExpandedUserIds(current => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const renderNode = (user: User, path: Set<string>) => {
    const isCycle = path.has(user.id);
    const children = graph.childrenBySupervisorId.get(user.id) ?? [];
    const isExpanded = expandedUserIds.has(user.id);
    const nextPath = new Set(path);
    nextPath.add(user.id);

    return <div key={user.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
      <div style={{ width: 18, borderTop: path.size ? '1px solid var(--ss-border)' : undefined, marginTop: 22 }} />
      <div style={{ flex: 1, minWidth: 220 }}>
        <SmallUserTile data={user} />
        {isCycle && <div className="light" style={{ marginTop: 6 }}>{uiText("Zyklus erkannt")}</div>}
        {!isCycle && !!children.length && <MyButton
          kind="ghost"
          size="sm"
          renderIcon={isExpanded ? Icons.AccordionExpanded : Icons.AccordionClosed}
          onClick={() => toggleExpanded(user.id)}
        >{isExpanded ? uiText('Untergebene ausblenden', 'Hide direct reports') : uiText(`Untergebene anzeigen (${children.length})`, `Show direct reports (${children.length})`)}</MyButton>}
        {!isCycle && isExpanded && !!children.length && <div style={{ marginTop: 10, marginLeft: 18, display: 'grid', gap: 10 }}>
          {children.map(child => renderNode(child, nextPath))}
        </div>}
      </div>
    </div>;
  };

  return <>
    <div className="flex gap-2 w-full overlflow-x-auto">
      <MyButton kind="ghost" size="sm" onClick={expandAll}>{uiText("Alle aufklappen")}</MyButton>
    </div>

    {!!defaultSupervisorUser && <div className="light" style={{ marginTop: 8 }}>{uiText("Standard-Vorgesetzter:")}{userFullName(defaultSupervisorUser)}
    </div>}

    <div style={{ height: '1px' }} />

    {!users ? null : !graph.allUsers.length ? (
      <Tile>{uiText("Keine Benutzer vorhanden.")}</Tile>
    ) : (
      <div style={{ display: 'grid', gap: 16 }}>
        {graph.roots.map(root => <Tile key={root.id}>
          {renderNode(root, new Set())}
        </Tile>)}

        {!!graph.cycleRoots.length && <Tile>
          <h4>{uiText("Zyklen oder verwaiste Einträge")}</h4>
          <div style={{ display: 'grid', gap: 10 }}>
            {graph.cycleRoots.map(user => renderNode(user, new Set()))}
          </div>
        </Tile>}
      </div>
    )}
  </>;
}
