import type { ComponentType, HTMLAttributes } from "react";
import { InlineNotification } from "./index.js";

type IconLike = ComponentType<{
  size?: number;
  className?: string;
  color?: string;
}>;

function resolveKind(color: string) {
  const normalized = color.toLowerCase();

  if (normalized === "green" || normalized === "teal" || normalized === "lime") {
    return "success";
  }

  if (normalized === "red" || normalized === "pink" || normalized === "deeporange") {
    return "danger";
  }

  if (normalized === "amber" || normalized === "yellow" || normalized === "orange") {
    return "warning";
  }

  return "info";
}

export function SSCallout(_props: HTMLAttributes<HTMLDivElement> & {
  color: string;
  icon: IconLike;
}) {
  const { icon: Icon, className, children, color, ...props } = _props;

  return (
    <InlineNotification
      {...props}
      className={className}
      kind={resolveKind(color)}
      renderIcon={Icon}
    >
      {children}
    </InlineNotification>
  );
}

export const MyCallout = SSCallout;
