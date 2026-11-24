import { uiText } from "~/lib/i18n";
import { TabbedOutlet } from "~/components/TabbedOutlet";
import { useSessionInfo } from "~/hooks/useSessionInfo";

export default function ProjectsShell() {
  const sessionInfo = useSessionInfo();

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

  return <TabbedOutlet scope="projects.content" tabs={tabs} />;
}
