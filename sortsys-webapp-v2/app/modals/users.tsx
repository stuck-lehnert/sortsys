import { uiText } from "~/lib/i18n";
import { Heading } from "@sortsys/react-components";
import { useState } from "react";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { MyButton } from "~/components/MyButton";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { nowrap } from "~/lib/primitives";
import { ALL_FINE_GRAINED_ROLES, ROLE_AREAS, ROLE_LEVELS, ROLE_PRESETS } from "~/lib/roleModel";
import { parseFloatCustom } from "~/lib/utils";
import { SmallUserTile } from "~/lib/tiles";
import type { Role, User } from "~/type-helpers";

type CreateUserModalOptions = {
  initialQuery?: string;
  onCreated?: (user: User) => void | Promise<void>;
};

function splitUserQuery(query: string | undefined) {
  const parts = `${query ?? ''}`.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? '', lastName: '' };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(' ') };
}

function usernameFromQuery(query: string | undefined) {
  return `${query ?? ''}`.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, '');
}

export function showCreateUserModal(modals: MyModalsInterface, options: CreateUserModalOptions = {}) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input required name="username" labelText={uiText("Anmeldename")}
        rules={[MyForm.Input.rules.pattern(/^[a-z0-9A-Z_\.\-]+$/)]} />

      <MyDivider />

      <MyForm.Input required name="firstName" labelText={uiText("Vorname")} />
      <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

      {!!options.initialQuery && <NotifyLoaded onLoad={() => context.setValues({
        username: usernameFromQuery(options.initialQuery),
        ...splitUserQuery(options.initialQuery),
      })} />}

      <MyDivider />

      <MyForm.Input name="email" labelText={uiText("E-Mail")} />
      <MyForm.Input name="phone" labelText={uiText("Telefon")} />

      <MyForm.MultiSelect
        name="supervisor"
        labelText={uiText("Vorgesetzter")}
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [users, err] = await client.query('users.list', {}, { strategy: 'cache-first' });
          if (err) throw err;
          const needle = query.trim().toLowerCase();
          return (users ?? []).filter(user => {
            if (!needle) return true;
            return userFullName(user).toLowerCase().includes(needle);
          });
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />

      <MyDivider />

      <MyForm.Select name="contractType" labelText={uiText("Vertrag")}
        getOptions={() => [
          { id: 'internal', text: uiText("Intern") },
          { id: 'external', text: uiText("Extern") },
          { id: 'subcontractor', text: uiText("Subunternehmer") },
        ]}
        buildOption={({ id, text }) => ({ value: id, text })}
      />

      <MyForm.Input name="costPerHour" labelText={uiText("Kosten pro Stunde (EUR)")}
        type="number"
        rules={[MyForm.Input.rules.num]} />
    </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      values.username = values.username.toLowerCase();

      if (!values.costPerHour) values.costPerHour = null;
      else {
        values.costPerHour = parseFloatCustom(values.costPerHour);
        if (isNaN(values.costPerHour)) return;
      }
      values.supervisorUserId = values.supervisor?.at(0)?.id ?? null;
      delete values.supervisor;

      const [data, err] = await client.mutate('users.create', values as any);

      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query('users.get', { id: data.id }, { strategy: 'network-first' });
        if (loadErr) throw loadErr;
        if (created) await options.onCreated(created);
        hide();
        return;
      }

      navigate(`/users/${data.id}`);
      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Benutzer erstellen"),
      primaryButtonText: uiText("Erstellen"),
    }),
  });
}

export function showModifyUserModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.Input required name="username" labelText={uiText("Anmeldename")}
        rules={[MyForm.Input.rules.pattern(/^[a-z0-9A-Z_\.\-]+$/)]} />

      <MyDivider />

      <MyForm.Input required name="firstName" labelText={uiText("Vorname")} />
      <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

      <MyDivider />

      <MyForm.Input name="email" labelText={uiText("E-Mail")} />
      <MyForm.Input name="phone" labelText={uiText("Telefon")} />

      <MyForm.MultiSelect
        name="supervisor"
        labelText={uiText("Vorgesetzter")}
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [users, err] = await client.query('users.list', {}, { strategy: 'cache-first' });
          if (err) throw err;
          const needle = query.trim().toLowerCase();
          return (users ?? []).filter(candidate => {
            if (candidate.id === user.id) return false;
            if (!needle) return true;
            return userFullName(candidate).toLowerCase().includes(needle);
          });
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />

      <MyDivider />

      <MyForm.Select name="contractType" labelText={uiText("Vertrag")}
        getOptions={() => [
          { id: 'internal', text: uiText("Intern") },
          { id: 'external', text: uiText("Extern") },
          { id: 'subcontractor', text: uiText("Subunternehmer") },
        ]}
        buildOption={({ id, text }) => ({ value: id, text })}
      />

      <MyForm.Input name="costPerHour" labelText={uiText("Kosten pro Stunde (EUR)")}
        type="number"
        rules={[MyForm.Input.rules.num]} />

      <NotifyLoaded onLoad={() => {
        context.setValues({ ...user, supervisor: [] });

        const supervisorUserId = (user as any).supervisorUserId;
        if (!supervisorUserId) return;
        client.query('users.get', { id: supervisorUserId }, { strategy: 'cache-first' }).then(([data]) => {
          if (!data) return;
          context.setValues({ supervisor: [data] });
        });
      }} />
    </>;
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      values.username = values.username.toLowerCase();

      if (!values.costPerHour) values.costPerHour = null;
      else {
        values.costPerHour = parseFloatCustom(values.costPerHour);
        if (isNaN(values.costPerHour)) return;
      }
      values.supervisorUserId = values.supervisor?.at(0)?.id ?? null;
      delete values.supervisor;

      const [data, err] = await client.mutate('users.update', {
        id: user.id,
        data: values as any
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Benutzer bearbeiten"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showSetUserSupervisorModal(modals: MyModalsInterface, user: User, supervisor?: User | null) {
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return <>
      <MyForm.MultiSelect
        required
        name="supervisor"
        labelText={uiText("Vorgesetzter")}
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const [users, err] = await client.query('users.list', {}, { strategy: 'cache-first' });
          if (err) throw err;
          const needle = query.trim().toLowerCase();
          return (users ?? []).filter(candidate => {
            if (candidate.id === user.id) return false;
            if (!needle) return true;
            return userFullName(candidate).toLowerCase().includes(needle);
          });
        }}
        renderItem={({ item }) => userFullName(item)}
        renderTile={item => <SmallUserTile data={item} noLink />}
        createAction={createEntityAction.user}
      />

      <NotifyLoaded onLoad={() => {
        if (supervisor) {
          context.setValues({ supervisor: [supervisor] });
          return;
        }

        const supervisorUserId = (user as any).supervisorUserId;
        if (!supervisorUserId) return;
        client.query('users.get', { id: supervisorUserId }, { strategy: 'cache-first' }).then(([data]) => {
          if (!data) return;
          context.setValues({ supervisor: [data] });
        });
      }} />
    </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const supervisorUserId = values.supervisor?.at(0)?.id;
      if (!supervisorUserId) return;

      const [data, err] = await client.mutate('users.update', {
        id: user.id,
        data: { supervisorUserId } as any,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Vorgesetzten setzen"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}

export function showDeleteUserModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Alle mit diesem Benutzer in Verbindung stehenden Daten werden damit ebenfalls gelöscht.")}{" "}<b>{uiText("Diese Aktion kann nicht rückgängig gemacht werden.")}</b>
      </p>
      <MyForm.Checkbox
        required name="_understood"
        labelText={uiText("Ich habe verstanden, dass diese Aktion nicht rückgängig gemacht werden kann.")}
      />
    </>,
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [data, err] = await client.mutate('users.delete', { id: user.id });
      if (err) throw err;
      if (!data) return;

      if (pathname === `/users/${user.id}`) navigate('/users');
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Benutzer löschen"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Löschen"),
    }),
  });
}

export function showDeactivateUserModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: () => <>
      <p className="light">{uiText("Durch die Deaktivierung verliert der betreffende Benutzer mit sofortiger Wirkung die Fähigkeit, sich am System anzumelden.")}</p>

      {/*<p>
        Alternativ kann auch ein Zeitpunkt in der Zukunft gewählt werden, an dem der Benutzer deaktiviert werden soll.
      </p>*/}
    </>,
    onSubmit: async ({ hide }) => {
      const [data, err] = await client.mutate('users.deactivate', { id: user.id });
      if (err) throw err;
      if (!data) return;
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Benutzer deaktivieren"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Deaktivieren"),
    }),
  });
}

export function showSetUserPasswordModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: ({ context }) => <>
      <MyForm.Input required
        type="password" name="password" labelText={uiText("Passwort")}
        autoComplete="new-password"
        rules={[
          MyForm.Input.rules.min(10),
          (value) => {
            const entropy = (str: string) => {
              return [...new Set(str.split(''))]
                .map(chr => str.split(chr).length - 1)
                .reduce((sum, frequency) => {
                  let p = frequency / str.length;
                  return sum + p * Math.log2(1 / p);
                }, 0);
            };

            if (entropy(value) < 2.8) return uiText('Passwort zu schwach!', 'Password is too weak!');
            return null;
          },
        ]}
      />

      <MyForm.Input required
        type="password" name="confirmPassword" labelText={uiText("Passwort bestätigen")}
        autoComplete="new-password"
        rules={[
          value => {
            if (context.field('password')?.getValue() === value) return null;
            return uiText('Passwörter stimmen nicht überein', 'Passwords do not match');
          },
        ]}
      />
    </>,
    onSubmit: async ({ context, hide }) => {
      const { password } = context.getValues();
      if (!password) return;

      const [data, err] = await client.mutate('auth.setPassword', {
        username: user.username,
        password,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Passwort setzen"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Passwort setzen"),
    }),
  })
}

export function showSetUserRolesModal(modals: MyModalsInterface, user: User) {
  function expandRolesForUi(roles: readonly Role[]) {
    const expanded = new Set<Role>(roles);
    roles.forEach(role => {
      if (!role.startsWith('manage:')) return;
      const viewRole = `view:${role.substring('manage:'.length)}` as Role;
      if (ALL_FINE_GRAINED_ROLES.includes(viewRole)) expanded.add(viewRole);
    });
    return expanded;
  }

  function roleLabel(role: Role) {
    if (role === ':admin') return 'Administrator';
    if (role === ':llm') return 'LLM';

    for (const area of ROLE_AREAS) {
      for (const level of ROLE_LEVELS) {
        if (area.roles[level.id] === role) return `${area.label}: ${level.label}`;
      }
    }

    return role;
  }

  function selectedRolesFromValues(values: Record<string, any>) {
    const selected = new Set<Role>();
    ALL_FINE_GRAINED_ROLES.forEach(role => {
      if (values[role]) selected.add(role);
    });

    ROLE_AREAS.forEach(area => {
      const viewRole = area.roles.view;
      const manageRole = area.roles.manage;
      if (viewRole && manageRole && selected.has(manageRole)) selected.add(viewRole);
    });

    return selected;
  }

  function roleDiff(before: Set<Role> | null, after: Set<Role>) {
    if (!before) return { added: [] as Role[], removed: [] as Role[] };
    return {
      added: [...after].filter(role => !before.has(role)),
      removed: [...before].filter(role => !after.has(role)),
    };
  }

  function summarizeRoles(roles: Iterable<Role>) {
    return [...roles].map(role => roleLabel(role)).sort((a, b) => a.localeCompare(b, 'de'));
  }

  function setRoleValues(context: any, roles: readonly Role[]) {
    const expandedRoles = expandRolesForUi(roles);
    context.setValues(Object.fromEntries(
      ALL_FINE_GRAINED_ROLES.map(role => [role, expandedRoles.has(role)]),
    ));
  }

  modals.showForm({
    content: ({ context }) => {
      const [initialRoles, setInitialRoles] = useState<Set<Role> | null>(null);
      const [roleSearch, setRoleSearch] = useState('');
      const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
      const [, setVersion] = useState(0);
      const refresh = () => setVersion(version => version + 1);

      const applyRoles = (roles: readonly Role[]) => {
        setRoleValues(context, roles);
        refresh();
      };

      const currentRoles = selectedRolesFromValues(context.getValues());
      const diff = roleDiff(initialRoles, currentRoles);
      const normalizedSearch = roleSearch.trim().toLowerCase();
      const visibleAreas = ROLE_AREAS.filter(area => {
        if (!normalizedSearch) return true;
        const haystack = [
          area.label,
          area.description,
          ...Object.values(area.roles).map(role => role ? `${role} ${roleLabel(role)}` : ''),
        ].join(' ').toLowerCase();
        return haystack.includes(normalizedSearch);
      });

      return <>
        <Heading level={3}>{uiText("Vorlagen")}</Heading>
        <div className="role-preset-grid">
          {ROLE_PRESETS.map(preset => {
            const presetRoles = expandRolesForUi(preset.roles);
            const isFulfilled = currentRoles.has(':admin') || [...presetRoles].every(role => currentRoles.has(role));
            return <button
              key={preset.id}
              type="button"
              className={`role-preset-card${isFulfilled ? ' role-preset-card--fulfilled' : ''}`}
              onClick={() => applyRoles(preset.roles)}
            >
              <b>{preset.label}</b>
              <span>{preset.description}</span>
            </button>;
          })}
        </div>

        <MyDivider />

        <div className="role-tools-grid">
          <div>
            <label className="ss-label" htmlFor="role-search-input">{uiText("Rechte suchen")}</label>
            <input
              id="role-search-input"
              className="ss-input"
              value={roleSearch}
              onChange={event => setRoleSearch(event.target.value)}
              placeholder={uiText("z.B. Projekte, löschen, Urlaub")}
            />
          </div>

          <MyForm.MultiSelect
            name="_copyUser"
            labelText={uiText("Rechte von Benutzer kopieren")}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [users, err] = await client.query('users.list', { search: query }, { strategy: 'cache-first' });
              if (err) throw err;
              return (users ?? []).filter(candidate => candidate.id !== user.id);
            }}
            renderItem={({ item }) => userFullName(item)}
            renderTile={item => <SmallUserTile data={item} noLink />}
            onValueChange={selected => {
              const source = selected.at(0);
              if (!source) return;
              client.query('users.roles.get', { userId: source.id }, { strategy: 'network-first' }).then(([roles, err]) => {
                if (err || !roles) return;
                setCopiedFrom(userFullName(source));
                applyRoles(roles);
              });
            }}
          />
        </div>

        {!!copiedFrom && <p className="light">{uiText("Kopiert von: ")}{copiedFrom}</p>}

        <div className="role-admin-row">
          <div>
            <MyForm.Checkbox name=":admin" labelText={uiText("Administrator: alle Rechte, inklusive Rollen und Organisation")} onValueChange={refresh} />
            <MyForm.Checkbox name=":llm" labelText={uiText("LLM verwenden")} onValueChange={refresh} />
          </div>
          <MyButton
            kind="ghost"
            renderIcon={Icons.Reset}
            onClick={() => applyRoles([])}
          >{uiText("Alle Rechte entfernen")}</MyButton>
        </div>

        <div className="role-diff-panel">
          <b>{uiText("Änderungen vor dem Speichern")}</b>
          {!initialRoles
            ? <span className="light">{uiText("Rechte werden geladen ...")}</span>
            : (!diff.added.length && !diff.removed.length)
              ? <span className="light">{uiText("Keine Änderungen.")}</span>
              : <div className="role-diff-columns">
                <div><b>{uiText("Neu")}</b><span>{diff.added.length ? summarizeRoles(diff.added).join(', ') : '-'}</span></div>
                <div><b>{uiText("Entfernt")}</b><span>{diff.removed.length ? summarizeRoles(diff.removed).join(', ') : '-'}</span></div>
              </div>}
        </div>

        <MyDivider />

        <div className="role-area-grid">
          {visibleAreas.map(area => <section key={area.key} className="role-area-card">
            <div>
              <h3 className={nowrap()}>{area.label}</h3>
              <p className="light">{area.description}</p>
            </div>

            <div className="role-area-levels">
              {ROLE_LEVELS.map(level => {
                const role = area.roles[level.id];
                if (!role) return null;
                return <MyForm.Checkbox
                  key={role}
                  name={role}
                  labelText={<span title={level.description}>{level.label}</span>}
                  onValueChange={refresh}
                />;
              })}
            </div>
          </section>)}
        </div>

        {!visibleAreas.length && <p className="light">{uiText("Keine Rechte passen zur Suche.")}</p>}

        <NotifyLoaded onLoad={async () => {
          const [roles, err] = await client.query('users.roles.get', { userId: user.id });
          if (err || !roles) return;
          const expanded = expandRolesForUi(roles);
          setInitialRoles(expanded);
          setRoleValues(context, roles);
          refresh();
        }} />
      </>;
    },
    onSubmit: async ({ context, hide }) => {
      const values = context.getValues();
      const selectedRoles = selectedRolesFromValues(values);
      const assignments = Object.fromEntries(
        ALL_FINE_GRAINED_ROLES.map(role => [role, selectedRoles.has(role)]),
      );

      const [data, err] = await client.mutate('users.roles.set', {
        userId: user.id,
        assignments: assignments as any,
      } as any);

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Rollen setzen"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Speichern"),
    }),
  });
}
