import type { ToolTracking } from "~/type-helpers";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { toolTitle } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { MyLink } from "./MyLink";

export function TrackingToolReference({ tracking }: { tracking: ToolTracking }) {
  const [tool] = useClientStream(
    () => client.streamQuery("tools.get", { id: tracking.toolId }),
    [tracking.toolId],
  );

  if (tool)
    return (
      <MyLink to={`/tools/${tool.id}`}>
        {tool.customId} {toolTitle(tool)}
      </MyLink>
    );

  // The decrypted booking already has a label. Do not wait for a separate
  // master-data read, which may be unavailable to the responsible member.
  if (tracking.toolSummary)
    return (
      <span>
        {tracking.toolSummary.customId} {toolTitle(tracking.toolSummary)}
      </span>
    );

  return uiText("Werkzeug nicht freigegeben", "Tool not shared");
}
