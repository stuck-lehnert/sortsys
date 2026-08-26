import type { ComponentProps } from "react";
import { Link } from "react-router";

export function MyLink({ viewTransition, ...props }: ComponentProps<typeof Link>) {
    viewTransition ??= false;

    return <Link {...props} viewTransition={viewTransition} className={`ss-link ${props.className ?? ''}`} onClick={(e) => {
        e.stopPropagation();
        props.onClick?.(e);
    }} />
}
