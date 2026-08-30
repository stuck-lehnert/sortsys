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
        <Heading level={1} noMargin className="ss-page-header__title">{title}</Heading>
        {!!subtitle && <p className="ss-page-header__subtitle">{subtitle}</p>}
      </div>

      {!!actions && <div className="ss-page-header__actions">{actions}</div>}
    </div>
  );
}

export const MyHeader = SSHeader;
