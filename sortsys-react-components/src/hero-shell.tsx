import { Accordion, Button, Drawer, Separator } from "@heroui/react";
import React, {
  forwardRef,
  useEffect,
  useState,
  type ComponentProps,
} from "react";

function classes(...values: Array<string | false | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Content({ className, ...props }: ComponentProps<"main">) {
  return (
    <main
      {...props}
      id={props.id ?? "main-content"}
      tabIndex={-1}
      className={classes(
        "ss-content min-h-dvh min-w-0 bg-background px-4 pb-8 pt-20 outline-none sm:px-6",
        className,
      )}
    />
  );
}

export function SkipToContent({
  href = "#main-content",
  children = "Zum Inhalt",
  className,
  ...props
}: ComponentProps<"a">) {
  return (
    <a
      {...props}
      href={href}
      className={classes(
        "sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4",
        "z-[100] rounded-lg bg-accent px-4 py-3 text-accent-foreground",
        className,
      )}
    >
      {children}
    </a>
  );
}

export function Header({ className, ...props }: ComponentProps<"header">) {
  return (
    <header
      {...props}
      className={classes(
        "ss-header fixed inset-x-0 top-0 z-30 flex h-16 items-center gap-3",
        "border-b border-separator bg-surface px-4 sm:px-6",
        className,
      )}
    />
  );
}

export function HeaderGlobalBar({
  className,
  ...props
}: ComponentProps<"div">) {
  return (
    <div
      {...props}
      className={classes("ml-auto flex items-center gap-2", className)}
    />
  );
}

export function HeaderGlobalAction({ className, ...props }: any) {
  return (
    <Button
      {...props}
      type={props.type ?? "button"}
      variant="ghost"
      isIconOnly
      className={classes("min-h-11 min-w-11 shrink-0", className)}
    />
  );
}

export function HeaderMenuButton({ isActive, children, ...props }: any) {
  return (
    <HeaderGlobalAction {...props} aria-expanded={Boolean(isActive)}>
      {children ?? (
        <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M3 5h14M3 10h14M3 15h14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      )}
    </HeaderGlobalAction>
  );
}

export function HeaderName({
  as: As = "a",
  prefix,
  className,
  children,
  ...props
}: any) {
  return (
    <As
      {...props}
      className={classes(
        "min-w-0 truncate rounded-md text-lg font-semibold text-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-focus",
        className,
      )}
    >
      {prefix && <span className="mr-1 font-normal text-muted">{prefix}</span>}
      {children}
    </As>
  );
}

export function SideNav({
  expanded = false,
  isSmall = false,
  onOverlayClick,
  closeButtonLabel,
  className,
  children,
  "aria-label": label,
  "aria-hidden": _hidden,
  inert: _inert,
  ...props
}: any) {
  if (isSmall) {
    return (
      <Drawer.Backdrop
        isOpen={expanded}
        onOpenChange={(open) => {
          if (!open) {
            onOverlayClick?.();
          }
        }}
      >
        <Drawer.Content
          placement="left"
          className="w-72 max-w-[calc(100vw-3rem)]"
        >
          <Drawer.Dialog
            {...props}
            aria-label={label}
            className="rounded-none p-0"
          >
            <Drawer.Header className="flex flex-row justify-end px-3 py-2">
              <Drawer.CloseTrigger aria-label={closeButtonLabel} />
            </Drawer.Header>
            <Drawer.Body className="px-3 pb-4">{children}</Drawer.Body>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    );
  }

  return (
    <aside
      {...props}
      aria-label={label}
      className={classes(
        "ss-side-nav fixed bottom-0 left-0 top-16 w-64 overflow-y-auto",
        "border-r border-separator bg-surface p-3",
        className,
      )}
    >
      {children}
    </aside>
  );
}

export function SideNavItems({ className, ...props }: ComponentProps<"nav">) {
  return (
    <nav {...props} className={classes("flex flex-col gap-1", className)} />
  );
}

export function SideNavDivider(props: ComponentProps<typeof Separator>) {
  return <Separator {...props} className={classes("my-2", props.className)} />;
}

export const SideNavLink = forwardRef<any, any>(function SideNavLink(
  { as: As, className, renderIcon: Icon, children, isActive, ...props },
  ref,
) {
  const contents = (
    <>
      {Icon && <Icon size={18} className="shrink-0" aria-hidden="true" />}
      <span className="min-w-0 text-left leading-snug">{children}</span>
    </>
  );
  const layout =
    "flex min-h-11 w-full items-center justify-start gap-2.5 rounded-full px-3 py-1.5";

  if (As) {
    return (
      <As
        {...props}
        ref={ref}
        aria-current={isActive ? "page" : undefined}
        className={classes(
          layout,
          "text-sm font-medium no-underline transition-colors hover:bg-default",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
          isActive
            ? "bg-accent-soft text-accent-soft-foreground"
            : "text-foreground",
          className,
        )}
      >
        {contents}
      </As>
    );
  }

  return (
    <Button
      {...props}
      ref={ref}
      type={props.type ?? "button"}
      variant="ghost"
      className={classes(layout, "h-auto whitespace-normal text-sm", className)}
    >
      {contents}
    </Button>
  );
});

export const SideNavItem = SideNavLink;

export function SideNavMenu({
  title,
  renderIcon: Icon,
  children,
  className,
  defaultExpanded = false,
  ...props
}: any) {
  const [expanded, setExpanded] = useState(
    new Set(defaultExpanded ? ["group"] : []),
  );

  useEffect(() => {
    if (defaultExpanded) {
      setExpanded(new Set(["group"]));
    }
  }, [defaultExpanded]);

  return (
    <Accordion
      {...props}
      expandedKeys={expanded}
      onExpandedChange={setExpanded}
      hideSeparator
      className={classes("bg-transparent p-0", className)}
    >
      <Accordion.Item id="group">
        <Accordion.Heading level={2}>
          <Accordion.Trigger
            className={[
              "min-h-11 gap-2.5 rounded-full px-3 py-1.5 text-sm",
              "hover:bg-default",
            ].join(" ")}
          >
            {Icon && <Icon size={18} className="shrink-0" aria-hidden="true" />}
            <span className="min-w-0 flex-1 text-left">{title}</span>
            <Accordion.Indicator />
          </Accordion.Trigger>
        </Accordion.Heading>
        <Accordion.Panel>
          <Accordion.Body className="flex flex-col gap-1 p-0 pb-2 pl-3">
            {children}
          </Accordion.Body>
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  );
}

export function SideNavMenuItem(props: any) {
  return <SideNavLink {...props} />;
}
