import { Content, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderName, Loading } from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation } from "react-router";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import { adminClient, logoutGlobalAdmin, restoreAdminSession } from "~/lib/adminClient";
import { Icons } from "~/lib/icons";
import { nowrap } from "~/lib/primitives";

export default function GlobalAdminLayout() {
  const forceUpdate = useForceUpdate();
  const [restored, setRestored] = useState(false);
  const location = useLocation();

  useEffect(() => {
    restoreAdminSession().finally(() => setRestored(true));
  }, []);

  useEffect(() => adminClient.listenAuthState(forceUpdate), []);

  if (!restored) {
    return <Loading active withOverlay />;
  }

  if (!adminClient.loggedIn()) {
    return <Navigate to="/__admin/login" replace />;
  }

  return <>
    <Header aria-label="sortsys Global Admin">
      <HeaderName as={Link} to="/__admin/tenants" prefix="" className={nowrap()}>
        sortsys Global Admin
      </HeaderName>

      <HeaderGlobalBar>
        <HeaderGlobalAction aria-label="Abmelden" onClick={() => {
          logoutGlobalAdmin().catch(() => {});
        }}>
          <Icons.Logout />
        </HeaderGlobalAction>
      </HeaderGlobalBar>
    </Header>

    <Content className="main-container">
      <div className="flex gap-2 mb-3">
        <Link to="/__admin/tenants" className={location.pathname.startsWith('/__admin/tenants') ? 'font-bold' : ''}>Mandanten</Link>
        <Link to="/__admin/databases" className={location.pathname.startsWith('/__admin/databases') ? 'font-bold' : ''}>Datenbankverwaltung</Link>
        <Link to="/__admin/errors" className={location.pathname.startsWith('/__admin/errors') ? 'font-bold' : ''}>Fehler</Link>
      </div>

      <Outlet />
    </Content>
  </>;
}
