import { Navigate } from "react-router";

export default function GlobalAdminNotFoundPage() {
  return <Navigate to="/__admin/tenants" replace />;
}
