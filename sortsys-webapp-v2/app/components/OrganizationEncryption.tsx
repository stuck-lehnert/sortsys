import { Link } from "react-router";
import { uiText } from "~/lib/i18n";
import OrganizationInvitations from "./OrganizationInvitations";
import { SigningRequestApproval } from "./SigningRenewal";

export default function OrganizationEncryption() {
  return (
    <div className="max-w-3xl space-y-5">
      <h2 className="text-xl font-semibold">
        {uiText("Wiederherstellung", "Recovery")}
      </h2>
      <p>
        {uiText(
          "Der Notfallzugang wurde bei der Einrichtung gesichert. Für die normale Anmeldung wird nur das Anmeldepasswort benötigt.",
          "Emergency access was backed up during setup. Normal sign-in only requires the account password.",
        )}
      </p>
      <Link to="/auth/recovery">
        {uiText(
          "Organisation mit Wiederherstellungsphrase wiederherstellen",
          "Recover organization using the recovery phrase",
        )}
      </Link>
      <SigningRequestApproval />
      <OrganizationInvitations />
    </div>
  );
}
