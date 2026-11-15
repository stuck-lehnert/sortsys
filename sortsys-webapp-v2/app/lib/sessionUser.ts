import type { QueryResult } from "@sortsys/v2-client";

type Account = QueryResult<"auth.sessionInfo">["user"];
type Profile = QueryResult<"users.get">;
export type SessionUser = Account &
  Pick<Profile, "salutation" | "firstName" | "lastName" | "phone" | "email"> & {
    contractType: Profile["contractType"] | null;
  };

/** Authentication supplies technical identity only. A missing or unreadable
 * private profile has no implied contact details or employment classification. */
export function sessionUser(
  account: Account,
  profile: Profile | null = null,
): SessionUser {
  const user: SessionUser = {
    id: account.id,
    username: account.username,
    locale: account.locale,
    firstName: account.username,
    lastName: null,
    salutation: null,
    phone: null,
    email: null,
    contractType: null,
  };
  if (
    !profile ||
    profile.id !== account.id ||
    profile.username !== account.username
  )
    return user;
  return {
    ...user,
    firstName: profile.firstName,
    lastName: profile.lastName,
    salutation: profile.salutation,
    phone: profile.phone,
    email: profile.email,
    contractType: profile.contractType,
  };
}
