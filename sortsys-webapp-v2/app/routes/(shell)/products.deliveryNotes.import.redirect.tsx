import { Navigate } from "react-router";

export default function LegacyDocumentImportRedirect() {
  return <Navigate to="/import" replace />;
}
