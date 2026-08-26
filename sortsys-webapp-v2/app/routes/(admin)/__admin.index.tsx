import { Navigate } from "react-router";

export default function GlobalAdminIndexPage() {
  return <Navigate to="/__admin/tenants" replace />;
}
