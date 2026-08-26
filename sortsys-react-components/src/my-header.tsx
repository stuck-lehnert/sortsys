import type { HTMLAttributes, ReactNode } from "react";
import { Heading } from "./index.js";

export function SSHeader({
  title,
  subtitle,
  actions,
  ...props
}: {
  title: ReactNode;
  subtitle?: ReactNode | false;
  actions?: ReactNode | false;
} & HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`ss-page-header ${props.className ?? ""}`}>
      <div className="ss-page-header__main">
        <Heading level={3} noMargin className="ss-page-header__title">{title}</Heading>
        {!!subtitle && <Heading level={6} noMargin className="ss-page-header__subtitle">{subtitle}</Heading>}
      </div>

      <div className="ss-page-header__actions">{actions}</div>
    </div>
  );
}

export const MyHeader = SSHeader;
