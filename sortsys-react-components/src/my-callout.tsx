import type { ComponentType, HTMLAttributes, ReactNode } from "react";
import { InlineNotification } from "./index.js";
import { resolveCalloutKind } from "./my-callout-kind.js";

type IconLike = ComponentType<{
  size?: number;
  className?: string;
  color?: string;
}>;

export function SSCallout(_props: HTMLAttributes<HTMLDivElement> & {
  color?: string;
  icon?: IconLike;
  kind?: string;
  title?: ReactNode;
  subtitle?: ReactNode;
}) {
  const { icon: Icon, className, children, color, kind, title, subtitle, ...props } = _props;

  return (
    <InlineNotification
      {...props}
      className={className}
      kind={resolveCalloutKind(kind, color)}
      title={title}
      subtitle={subtitle}
      renderIcon={Icon}
    >
      {children}
    </InlineNotification>
  );
}

export const MyCallout = SSCallout;
