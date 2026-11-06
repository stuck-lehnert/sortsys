import { Navigate } from "react-router";

export default function LegacyOrganizationSettingsRedirect() {
  return <Navigate to="/admin" replace />;
}
