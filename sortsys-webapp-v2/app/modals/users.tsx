import { useSessionInfo } from "~/hooks/useSessionInfo";
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
import OrganizationInvitations from "~/components/OrganizationInvitations";
import { parseFloatCustom } from "~/lib/utils";
import { newProductRowId, publicId } from "~/lib/data/products";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";

type CreateUserModalOptions = {
  initialQuery?: string;
  onCreated?: (user: User) => void | Promise<void>;
};

function splitUserQuery(query: string | undefined) {
  const parts = `${query ?? ""}`.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0]!, lastName: parts.slice(1).join(" ") };
}

function usernameFromQuery(query: string | undefined) {
  return `${query ?? ""}`.toLowerCase().replaceAll(/[^a-z0-9_.-]+/g, "");
}

function parseVacationDays(value: unknown) {
  const text = `${value ?? ""}`.trim();
  if (!text) return null;

  const days = Number(text);
  if (!Number.isInteger(days) || days < 0 || days > 366) {
    throw new Error(
      uiText(
        "Urlaubstage müssen eine ganze Zahl zwischen 0 und 366 sein.",
        "Leave days must be an integer between 0 and 366.",
      ),
    );
  }

  return days;
}

export function showCreateUserModal(
  modals: MyModalsInterface,
  options: CreateUserModalOptions = {},
) {
  const operationId = publicId(newProductRowId());
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals);

      return (
        <>
          <MyForm.Input
            required
            name="username"
            labelText={uiText("Anmeldename")}
            rules={[
              MyForm.Input.rules.pattern(
                /^[a-z0-9A-Z_-]+(?:\.[a-z0-9A-Z_-]+)*$/,
              ),
            ]}
          />

          <MyDivider />

          <MyForm.Input
            required
            name="firstName"
            labelText={uiText("Vorname")}
          />
          <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

          {!!options.initialQuery && (
            <NotifyLoaded
              onLoad={() =>
                context.setValues({
                  username: usernameFromQuery(options.initialQuery),
                  ...splitUserQuery(options.initialQuery),
                })
              }
            />
          )}

          <MyDivider />

          <MyForm.Input name="email" labelText={uiText("E-Mail")} />
          <MyForm.Input name="phone" labelText={uiText("Telefon")} />

          <MyForm.MultiSelect
            name="supervisor"
            labelText={uiText("Vorgesetzter")}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [users, err] = await client.query(
                "users.list",
                { search: query },
                { strategy: "cache-first" },
              );
              if (err) throw err;
              return users ?? [];
            }}
            renderItem={({ item }) => userFullName(item)}
            renderTile={(item) => <SmallUserTile data={item} noLink />}
            createAction={createEntityAction.user}
          />

          <MyDivider />

          <MyForm.Select
            name="contractType"
            labelText={uiText("Vertrag")}
            getOptions={() => [
              { id: "internal", text: uiText("Intern") },
              { id: "external", text: uiText("Extern") },
              { id: "subcontractor", text: uiText("Subunternehmer") },
            ]}
            buildOption={({ id, text }) => ({ value: id, text })}
          />

          <MyForm.Input
            name="costPerHour"
            labelText={uiText("Kosten pro Stunde (EUR)")}
            type="number"
            rules={[MyForm.Input.rules.num]}
          />

          <MyForm.Input
            name="vacationDaysPerYear"
            labelText={uiText("Urlaubstage pro Jahr", "Leave days per year")}
            type="number"
            min={0}
            max={366}
            rules={[MyForm.Input.rules.int]}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      values.username = values.username.toLowerCase();

      if (!values.costPerHour) values.costPerHour = null;
      else {
        values.costPerHour = parseFloatCustom(values.costPerHour);
        if (isNaN(values.costPerHour)) return;
      }

      values.vacationDaysPerYear = parseVacationDays(
        values.vacationDaysPerYear,
      );
      values.supervisorUserId = values.supervisor?.at(0)?.id ?? null;
      delete values.supervisor;

      const [data, err] = await client.mutate("users.create", {
        ...values,
        operationId,
      } as any);

      if (err) throw err;
      if (!data) return;

      if (options.onCreated) {
        const [created, loadErr] = await client.query(
          "users.get",
          { id: data.id },
          { strategy: "network-first" },
        );
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
  let mayEditMaster = () => false,
    mayEditCosts = () => false,
    mayEditEmployment = () => false,
    mayEditSupervision = () => false;
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals),
        session = useSessionInfo(),
        scope = `personnel:${user.id}`;
      mayEditMaster = () => session.canAccess(scope, "master-data", "update");
      mayEditCosts = () => session.canAccess(scope, "calculation", "update");
      mayEditEmployment = () => session.canAccess(scope, "scope", "update");
      mayEditSupervision = () => session.isAdmin();
      const readCosts = session.canAccess(scope, "calculation", "read"),
        readEmployment = session.canAccess(scope, "scope", "read");

      return (
        <>
          <MyForm.Input
            required
            disabled={!session.isAdmin() || !mayEditMaster()}
            name="username"
            labelText={uiText("Anmeldename")}
            rules={[
              MyForm.Input.rules.pattern(
                /^[a-z0-9A-Z_-]+(?:\.[a-z0-9A-Z_-]+)*$/,
              ),
            ]}
          />

          <MyDivider />

          <MyForm.Input
            required
            disabled={!mayEditMaster()}
            name="firstName"
            labelText={uiText("Vorname")}
          />
          <MyForm.Input
            disabled={!mayEditMaster()}
            name="lastName"
            labelText={uiText("Nachname")}
          />

          <MyDivider />

          <MyForm.Input
            disabled={!mayEditMaster()}
            name="email"
            labelText={uiText("E-Mail")}
          />
          <MyForm.Input
            disabled={!mayEditMaster()}
            name="phone"
            labelText={uiText("Telefon")}
          />

          {readEmployment && (
            <MyForm.MultiSelect
              disabled={!mayEditEmployment() || !mayEditSupervision()}
              name="supervisor"
              labelText={uiText("Vorgesetzter")}
              maxSelectedItems={1}
              getOptions={async ({ query }) => {
                const [users, err] = await client.query(
                  "users.list",
                  { search: query },
                  { strategy: "cache-first" },
                );
                if (err) throw err;
                return (users ?? []).filter(
                  (candidate) => candidate.id !== user.id,
                );
              }}
              renderItem={({ item }) => userFullName(item)}
              renderTile={(item) => <SmallUserTile data={item} noLink />}
              createAction={createEntityAction.user}
            />
          )}

          <MyDivider />

          <MyForm.Select
            disabled={!mayEditMaster() || !mayEditSupervision()}
            name="contractType"
            labelText={uiText("Vertrag")}
            getOptions={() => [
              { id: "internal", text: uiText("Intern") },
              { id: "external", text: uiText("Extern") },
              { id: "subcontractor", text: uiText("Subunternehmer") },
            ]}
            buildOption={({ id, text }) => ({ value: id, text })}
          />

          {readCosts && (
            <MyForm.Input
              disabled={!mayEditCosts()}
              name="costPerHour"
              labelText={uiText("Kosten pro Stunde (EUR)")}
              type="number"
              rules={[MyForm.Input.rules.num]}
            />
          )}

          {readEmployment && (
            <MyForm.Input
              disabled={!mayEditEmployment()}
              name="vacationDaysPerYear"
              labelText={uiText("Urlaubstage pro Jahr", "Leave days per year")}
              type="number"
              min={0}
              max={366}
              rules={[MyForm.Input.rules.int]}
            />
          )}

          <NotifyLoaded
            onLoad={() => {
              context.setValues({ ...user, supervisor: [] });

              const supervisorUserId =
                readEmployment && "supervisorUserId" in user
                  ? user.supervisorUserId
                  : null;
              if (!supervisorUserId) return;
              client
                .query(
                  "users.get",
                  { id: supervisorUserId },
                  { strategy: "cache-first" },
                )
                .then(([data]) => {
                  if (!data) return;
                  context.setValues({ supervisor: [data] });
                });
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide, navigate }) => {
      const values = context.getValues();

      if (!mayEditMaster())
        for (const field of [
          "username",
          "firstName",
          "lastName",
          "email",
          "phone",
          "contractType",
        ])
          delete values[field];
      else if (values.username) values.username = values.username.toLowerCase();
      if (!mayEditCosts()) delete values.costPerHour;
      else if (!values.costPerHour) values.costPerHour = null;
      else {
        values.costPerHour = parseFloatCustom(values.costPerHour);
        if (isNaN(values.costPerHour)) return;
      }
      if (mayEditEmployment()) {
        values.vacationDaysPerYear = parseVacationDays(
          values.vacationDaysPerYear,
        );
        if (mayEditSupervision())
          values.supervisorUserId = values.supervisor?.at(0)?.id ?? null;
        else delete values.supervisorUserId;
      } else {
        delete values.vacationDaysPerYear;
        delete values.supervisorUserId;
      }
      if (!mayEditSupervision()) delete values.contractType;
      delete values.supervisor;

      const [data, err] = await client.mutate("users.update", {
        id: user.id,
        data: values as any,
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

export function showSetUserSupervisorModal(
  modals: MyModalsInterface,
  user: User,
  supervisor?: User | null,
) {
  let permitted = false;
  modals.showForm({
    content: ({ context }) => {
      const createEntityAction = useCreateEntityAction(modals),
        session = useSessionInfo();
      permitted = session.isAdmin();

      return (
        <>
          <MyForm.MultiSelect
            disabled={!permitted}
            required
            name="supervisor"
            labelText={uiText("Vorgesetzter")}
            maxSelectedItems={1}
            getOptions={async ({ query }) => {
              const [users, err] = await client.query(
                "users.list",
                { search: query },
                { strategy: "cache-first" },
              );
              if (err) throw err;
              return (users ?? []).filter(
                (candidate) => candidate.id !== user.id,
              );
            }}
            renderItem={({ item }) => userFullName(item)}
            renderTile={(item) => <SmallUserTile data={item} noLink />}
            createAction={createEntityAction.user}
          />

          <NotifyLoaded
            onLoad={() => {
              if (supervisor) {
                context.setValues({ supervisor: [supervisor] });
                return;
              }

              const supervisorUserId = (user as any).supervisorUserId;
              if (!supervisorUserId) return;
              client
                .query(
                  "users.get",
                  { id: supervisorUserId },
                  { strategy: "cache-first" },
                )
                .then(([data]) => {
                  if (!data) return;
                  context.setValues({ supervisor: [data] });
                });
            }}
          />
        </>
      );
    },
    onSubmit: async ({ context, hide }) => {
      if (!permitted)
        throw new Error(
          uiText(
            "Die Vorgesetztenzuordnung kann nur in der Verwaltung geändert werden.",
            "Supervisor assignments require administration access.",
          ),
        );
      const values = context.getValues();
      const supervisorUserId = values.supervisor?.at(0)?.id;
      if (!supervisorUserId) return;

      const [data, err] = await client.mutate("users.update", {
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

export function showDeactivateUserModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: () => (
      <>
        <p className="light">
          {uiText(
            "Durch die Deaktivierung verliert der betreffende Benutzer mit sofortiger Wirkung die Fähigkeit, sich am System anzumelden.",
          )}
        </p>

        {/*<p>
        Alternativ kann auch ein Zeitpunkt in der Zukunft gewählt werden, an dem der Benutzer deaktiviert werden soll.
      </p>*/}
      </>
    ),
    onSubmit: async ({ hide }) => {
      const [data, err] = await client.mutate("users.deactivate", {
        id: user.id,
      });
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

export function showDeleteUserModal(modals: MyModalsInterface, user: User) {
  modals.showForm({
    content: () => (
      <>
        <p>
          {uiText(
            "Das Konto wird dauerhaft gesperrt und das Personalprofil entfernt. Vorhandene Berichte und unterschriebene Vorgänge bleiben erhalten.",
            "The account will be permanently closed and its personnel profile removed. Existing reports and signed records remain available.",
          )}
        </p>
        <MyForm.Checkbox
          required
          name="_understood"
          labelText={uiText(
            "Dieses Konto kann anschließend nicht wieder aktiviert werden.",
            "This account cannot be reactivated afterwards.",
          )}
        />
      </>
    ),
    onSubmit: async ({ hide, pathname, navigate }) => {
      const [result, error] = await client.mutate("users.delete", {
        id: user.id,
      });
      if (error) throw error;
      if (!result) return;
      if (pathname === `/users/${user.id}`) navigate("/users");
      hide();
    },
    modalProps: () => ({
      danger: true,
      noFullscreen: true,
      modalHeading: uiText("Benutzer löschen", "Delete user"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Löschen", "Delete"),
    }),
  });
}

export function showChangeOwnPasswordModal(
  modals: MyModalsInterface,
  user: User,
) {
  modals.showForm({
    content: ({ context }) => (
      <>
        <MyForm.Input
          required
          type="password"
          name="password"
          labelText={uiText("Passwort")}
          autoComplete="new-password"
          rules={[
            MyForm.Input.rules.min(10),
            (value) => {
              const entropy = (str: string) => {
                return [...new Set(str.split(""))]
                  .map((chr) => str.split(chr).length - 1)
                  .reduce((sum, frequency) => {
                    let p = frequency / str.length;
                    return sum + p * Math.log2(1 / p);
                  }, 0);
              };

              if (entropy(value) < 2.8)
                return uiText("Passwort zu schwach!", "Password is too weak!");
              return null;
            },
          ]}
        />

        <MyForm.Input
          required
          type="password"
          name="confirmPassword"
          labelText={uiText("Passwort bestätigen")}
          autoComplete="new-password"
          rules={[
            (value) => {
              if (context.field("password")?.getValue() === value) return null;
              return uiText(
                "Passwörter stimmen nicht überein",
                "Passwords do not match",
              );
            },
          ]}
        />
      </>
    ),
    onSubmit: async ({ context, hide }) => {
      const { password } = context.getValues();
      if (!password) return;

      const [data, err] = await client.mutate("auth.setPassword", {
        username: user.username,
        password,
      });

      if (err) throw err;
      if (!data) return;

      hide();
    },
    modalProps: () => ({
      modalHeading: uiText("Passwort ändern", "Change password"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Passwort ändern", "Change password"),
    }),
  });
}

export function showUserAccessModal(modals: MyModalsInterface, user: User) {
  return modals.showDefault({
    content: () => <OrganizationInvitations memberId={user.id} />,
    onPrimaryAction: ({ hide }) => hide(),
    modalProps: () => ({
      modalHeading: uiText("Berechtigungen verwalten", "Manage permissions"),
      modalLabel: userFullName(user),
      primaryButtonText: uiText("Schließen", "Close"),
    }),
  });
}
