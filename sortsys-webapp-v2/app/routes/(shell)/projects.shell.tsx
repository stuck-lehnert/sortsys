import { uiText } from "~/lib/i18n";
import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useSessionInfo } from "~/hooks/useSessionInfo";

export default function ProjectsShell() {
  const sessionInfo = useSessionInfo();

  const path = useLocation().pathname;
  const navigate = useNavigate();

  const tabs = [
    {
      path: '/projects',
      label: uiText("Projekte"),
      hideIf: false,
    },
    {
      path: '/projects/costs',
      label: uiText("Kostenübersicht"),
      hideIf: !sessionInfo.canDo('view:projects')
        || !sessionInfo.canDo('view:deliveryNotes')
        || !sessionInfo.canDo('view:dailyProjectReports'),
    },
  ];

  const _tabs = tabs.filter(({ hideIf }) => !hideIf);
  const selectedIndex = _tabs.findIndex(({ path: _path }) => path === _path);

  return <>
    <Tabs
      selectedIndex={selectedIndex}
      onChange={({ selectedIndex }: any) => {
        const { path: _path } = _tabs[selectedIndex];
        if (_path === path) return;
        navigate(_path);
      }}
    >
      <TabList>
        {_tabs.map(({ path, label }) => <Tab key={path}>{label}</Tab>)}
      </TabList>
    </Tabs>

    <Outlet />
  </>;
}
