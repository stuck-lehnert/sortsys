import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate } from "react-router";
import { useSessionInfo } from "~/hooks/useSessionInfo";



export default function ToolsShell() {
    const sessionInfo = useSessionInfo();

    const path = useLocation().pathname;
    const navigate = useNavigate();

    const tabs = [
        {
            path: '/tools',
            label: 'Werkzeuge',
            hideIf: !sessionInfo.canDo('view:tools'),
        },
        {
            path: '/tools/trackings',
            label: 'Buchungshistorie',
            hideIf: !sessionInfo.canDo('view:toolTrackings'),
        },
        {
            path: '/tools/transferRequests',
            label: 'Umbuchungsanfragen',
            hideIf: !sessionInfo.canDo('view:toolTrackings'),
        },
    ];


    const _tabs = tabs.filter(({hideIf}) => !hideIf);
    const selectedIndex = _tabs.findIndex(({ path: _path }) => path === _path);

    return <>
        <Tabs
            selectedIndex={selectedIndex}
            onChange={({ selectedIndex }: any) => {
                const {path: _path} = _tabs[selectedIndex];
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
