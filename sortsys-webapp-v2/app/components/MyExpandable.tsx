import { Accordion } from "@heroui/react";
import { useId, type CSSProperties, type ReactNode } from "react";

export function MyExpandable({
  title,
  children,
  className,
  style,
  initiallyExpanded = false,
}: {
  title: ReactNode;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
  initiallyExpanded?: boolean;
}) {
  const id = useId();

  return (
    <Accordion
      hideSeparator
      className={["p-0", className].filter(Boolean).join(" ")}
      style={style}
      defaultExpandedKeys={initiallyExpanded ? [id] : []}
    >
      <Accordion.Item id={id}>
        <Accordion.Heading level={3}>
          <Accordion.Trigger
            className={[
              "min-h-11 cursor-pointer rounded-xl border border-separator",
              "bg-default px-3 py-2 text-base font-semibold hover:bg-default-hover",
            ].join(" ")}
          >
            <span className="min-w-0 text-left">{title}</span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel className="my-expandable--content pb-1">
          <Accordion.Body className="min-w-0 space-y-3 px-1 pb-2 pt-2">
            {children}
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}
