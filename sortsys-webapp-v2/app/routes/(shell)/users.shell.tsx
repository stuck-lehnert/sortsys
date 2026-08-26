import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate } from "react-router";

export default function UsersShell() {
  const path = useLocation().pathname;
  const navigate = useNavigate();

  const tabs = [
    { path: '/users', label: 'Benutzer' },
    { path: '/users/supervisors', label: 'Vorgesetzte' },
  ];

  const selectedIndex = tabs.findIndex(({ path: tabPath }) => path === tabPath);

  return <>
    <Tabs
      selectedIndex={selectedIndex}
      onChange={({ selectedIndex }: any) => {
        const { path: tabPath } = tabs[selectedIndex];
        if (tabPath === path) return;
        navigate(tabPath);
      }}
    >
      <TabList>
        {tabs.map(({ path, label }) => <Tab key={path}>{label}</Tab>)}
      </TabList>
    </Tabs>

    <Outlet />
  </>;
}
