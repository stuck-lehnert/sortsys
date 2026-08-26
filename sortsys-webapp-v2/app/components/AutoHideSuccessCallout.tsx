import { useEffect, useState, type ReactNode } from "react";
import { MyCallout } from "~/components/MyCallout";
import { Icons } from "~/lib/icons";

export function AutoHideSuccessCallout(props: {
  children: ReactNode;
  resetKey?: unknown;
  durationMs?: number;
  onHidden?: () => void;
}) {
  const durationMs = props.durationMs ?? 5_000;
  const [hidden, setHidden] = useState(false);
  const [removed, setRemoved] = useState(false);

  useEffect(() => {
    setHidden(false);
    setRemoved(false);

    const hideTimer = window.setTimeout(() => setHidden(true), durationMs);
    const removeTimer = window.setTimeout(() => {
      setRemoved(true);
      props.onHidden?.();
    }, durationMs + 320);

    return () => {
      window.clearTimeout(hideTimer);
      window.clearTimeout(removeTimer);
    };
  }, [durationMs, props.resetKey]);

  if (removed) return null;

  return <div className="auto-hide-callout" data-hidden={hidden ? 'true' : undefined}>
    <div className="auto-hide-callout-inner">
      <MyCallout icon={Icons.Accept} color="green">{props.children}</MyCallout>
    </div>
  </div>;
}
