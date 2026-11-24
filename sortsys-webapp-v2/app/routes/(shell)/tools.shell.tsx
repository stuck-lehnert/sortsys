import { uiText } from "~/lib/i18n";
import { TabbedOutlet } from "~/components/TabbedOutlet";
import { useSessionInfo } from "~/hooks/useSessionInfo";

export default function ToolsShell() {
    const sessionInfo = useSessionInfo();

    const tabs = [
        {
            path: '/tools',
            label: uiText("Werkzeuge"),
            hideIf: !sessionInfo.canDo('view:tools'),
        },
        {
            path: '/tools/trackings',
            label: uiText("Buchungshistorie"),
            hideIf: !sessionInfo.canDo('view:toolTrackings'),
        },
        {
            path: '/tools/transferRequests',
            label: uiText("Umbuchungsanfragen"),
            hideIf: !sessionInfo.canDo('view:toolTrackings'),
        },
    ];


    return <TabbedOutlet scope="tools.content" tabs={tabs} />;
}
