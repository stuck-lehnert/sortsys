import { Card } from "@heroui/react";
import {
  Children,
  isValidElement,
  type HTMLAttributes,
  type ReactNode,
} from "react";

function AttrList({
  children,
  className,
  ...props
}: { children?: ReactNode } & Omit<HTMLAttributes<HTMLDListElement>, "children">) {
  if (!Children.toArray(children).some(isValidElement)) {
    return null;
  }

  return (
    <dl
      {...props}
      className={[
        "" +
          [
            "grid min-w-0 gap-3",
            "[grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr))]",
          ].join(" ") +
          "",
        className,
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {children}
    </dl>
  );
}

AttrList.Attr = function Attribute({ name, value, third }: {
  name: ReactNode;
  value: ReactNode;
  third?: ReactNode;
}) {
  return (
    <Card variant="secondary" className="min-w-0 gap-0.5 p-3">
      <dt className="text-sm leading-5 text-muted">{name}</dt>
      <dd className="flex min-w-0 flex-wrap gap-x-4 gap-y-1 text-sm font-medium">
        <span className="min-w-0 break-words">{value}</span>
        {!!third && <span className="min-w-0 break-words">{third}</span>}
      </dd>
    </Card>
  );
};

export { AttrList };
