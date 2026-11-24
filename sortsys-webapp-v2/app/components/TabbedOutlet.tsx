import { Tab, TabList, Tabs } from "@sortsys/react-components";
import type { ReactNode } from "react";
import { Outlet, useLocation, useNavigate } from "react-router";
import { ScopedErrorBoundary } from "./ScopedErrorBoundary";

type RouteTab = {
  path: string;
  label: string;
  hideIf?: boolean;
  matchChildren?: boolean;
};

export function TabbedOutlet({
  scope,
  tabs,
  children,
}: {
  scope: string;
  tabs: readonly RouteTab[];
  children?: ReactNode;
}) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visibleTabs = tabs.filter((tab) => !tab.hideIf);
  const selectedTab = visibleTabs.find(
    (tab) =>
      tab.path === pathname ||
      (tab.matchChildren && pathname.startsWith(`${tab.path}/`)),
  );

  function selectTab(key: string | number) {
    const tab = visibleTabs.find((item) => item.path === key);
    if (tab && tab.path !== pathname) void navigate(tab.path);
  }

  return (
    <>
      <Tabs selectedKey={selectedTab?.path ?? ""} onSelectionChange={selectTab}>
        <TabList>
          {visibleTabs.map((tab) => (
            <Tab key={tab.path} id={tab.path}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
      </Tabs>

      <ScopedErrorBoundary scope={scope} resetKey={pathname}>
        {children ?? <Outlet />}
      </ScopedErrorBoundary>
    </>
  );
}
