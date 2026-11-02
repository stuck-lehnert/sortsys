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
    <div
      {...props}
      className={[
        "ss-page-header flex min-w-0 flex-wrap items-start justify-between gap-4 py-2",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="min-w-0 flex-1 basis-48">
        <Heading
          level={1}
          noMargin
          className="break-words text-2xl sm:text-3xl"
        >
          {title}
        </Heading>
        {!!subtitle && (
          <p className="mt-2 text-sm leading-relaxed text-muted">{subtitle}</p>
        )}
      </div>

      {!!actions && (
        <div className="flex max-w-full flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}

export const MyHeader = SSHeader;
