import { uiText } from "~/lib/i18n";
import {
  Content,
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderName,
  Loading,
  Tab,
  TabList,
  Tabs,
} from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { useForceUpdate } from "~/hooks/useForceUpdate";
import { adminClient, logoutGlobalAdmin, restoreAdminSession } from "~/lib/adminClient";
import { Icons } from "~/lib/icons";
import { nowrap } from "~/lib/primitives";

const tabs = [
  { path: "/__admin/tenants", label: uiText("Mandanten") },
  { path: "/__admin/databases", label: uiText("Datenbanken") },
  { path: "/__admin/errors", label: uiText("Fehler") },
  { path: "/__admin/llm", label: uiText("LLM") },
];

export default function GlobalAdminLayout() {
  const forceUpdate = useForceUpdate();
  const [restored, setRestored] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

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

  const selectedIndex = Math.max(
    0,
    tabs.findIndex(tab => location.pathname.startsWith(tab.path)),
  );

  return (
    <>
      <Header aria-label={uiText("sortsys Global Admin")}>
        <HeaderName as={Link} to="/__admin/tenants" prefix="" className={nowrap()}>{uiText("sortsys Admin")}</HeaderName>

        <HeaderGlobalBar>
          <HeaderGlobalAction
            aria-label={uiText("Abmelden")}
            onClick={() => {
              logoutGlobalAdmin().catch(() => {});
            }}
          >
            <Icons.Logout />
          </HeaderGlobalAction>
        </HeaderGlobalBar>
      </Header>

      <Content className="global-admin-container">
        <Tabs
          selectedIndex={selectedIndex}
          onChange={({ selectedIndex }: { selectedIndex: number }) => {
            const tab = tabs[selectedIndex];
            if (!tab || location.pathname.startsWith(tab.path)) return;

            navigate(tab.path);
          }}
        >
          <TabList>
            {tabs.map(tab => <Tab key={tab.path}>{tab.label}</Tab>)}
          </TabList>
        </Tabs>

        <ScopedErrorBoundary scope="global-admin.content" resetKey={location.pathname}>
          <Outlet />
        </ScopedErrorBoundary>
      </Content>
    </>
  );
}
