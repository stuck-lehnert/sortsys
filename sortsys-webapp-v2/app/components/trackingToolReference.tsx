import type { ToolTracking } from "~/type-helpers";
import { client } from "~/lib/client";
import { toolTitle } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { MyLink } from "./MyLink";

/** A booking retains its encrypted tool label even without current master-data
 * permission. Only a readable current tool receives a details link. */
export async function trackingToolReference(tracking: ToolTracking) {
  const [tool] = await client.query(
    "tools.get",
    { id: tracking.toolId },
    { strategy: "cache-first" },
  );
  if (tool)
    return (
      <MyLink to={`/tools/${tool.id}`}>
        {tool.customId} {toolTitle(tool)}
      </MyLink>
    );
  if (tracking.toolSummary)
    return (
      <span>
        {tracking.toolSummary.customId} {toolTitle(tracking.toolSummary)}
      </span>
    );
  return uiText("Werkzeug nicht freigegeben", "Tool not shared");
}
