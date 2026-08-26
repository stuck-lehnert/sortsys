import { Heading, Tile } from "@sortsys/react-components";
import type { CSSProperties, ReactNode } from "react";
import React, { useRef, useState } from "react";
import { Icons } from "~/lib/icons";
import { MyDivider } from "./MyDivider";
import { nowrap } from "~/lib/primitives";
import { NotifyLoaded } from "./NotifyLoaded";

export function MyExpandable(_props: {
    title: ReactNode;
    className?: string;
    children?: ReactNode;
    style?: CSSProperties;
    initiallyExpanded?: boolean;
}) {
    const { title, children, initiallyExpanded, ...props } = _props;

    const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    
    const [height, setHeight] = useState<string | number>(initiallyExpanded ? 'auto' : 0);
    const contentDivRef = useRef<HTMLDivElement | null>(null);

    const _children = React.Children.toArray(children);
    if (!_children) return;

    const _expanded = !!height;

    props.style ??= {};
    props.style.backgroundColor ??= 'transparent';

    const transitionDurationMS = 200;

    return <Tile {...props}>
        <div className="flex gap-2 items-center" onClick={() => {
            if (timeoutRef.current) clearTimeout(timeoutRef.current);

            if (_expanded) {
                setHeight(contentDivRef.current?.scrollHeight ?? 0);
                timeoutRef.current = setTimeout(() => setHeight(0), 1);
            } else {
                setHeight(contentDivRef.current?.scrollHeight ?? 0);
                timeoutRef.current = setTimeout(() => setHeight('auto'), transitionDurationMS);
            }
        }} style={{
            userSelect: 'none',
            cursor: 'pointer',
        }}>
            {_expanded ? <Icons.AccordionExpanded /> : <Icons.AccordionClosed />}
            <Heading level={4} noMargin className={nowrap()}>{title}</Heading>
        </div>
        
        <div ref={contentDivRef} className="my-expandable--content" style={{
            height: height,
            overflowY: 'hidden',
            transitionDuration: `${transitionDurationMS}ms`,
            paddingBottom: '1px',
        }}>
            <MyDivider margin="0.7rem" />

            {children}
        </div>
    </Tile>;
}


// export function MyExpandable(_props: {
//     title: ReactNode;
//     className?: string;
//     children?: ReactNode;
//     style?: CSSProperties;
//     initiallyExpanded?: boolean;
// }) {
//     const { title, children, initiallyExpanded, ...props } = _props;

//     const [expanded, setExpanded] = useState(!!initiallyExpanded || false);
//     const contentDivRef = useRef<HTMLDivElement | null>(null);

//     const _children = React.Children.toArray(children);
//     if (!_children) return;

//     props.style ??= {};
//     props.style.backgroundColor ??= 'transparent';

//     return <Tile {...props}>
//         <div className="flex gap-2 items-center" onClick={() => setExpanded(ex => !ex)} style={{
//             userSelect: 'none',
//             cursor: 'pointer',
//         }}>
//             {expanded ? <Icons.AccordionExpanded /> : <Icons.AccordionClosed />}
//             <h4 className={nowrap()}>{title}</h4>
//         </div>
        
//         <div ref={contentDivRef} style={{
//             height: expanded ? 'calc-size(auto, size)' : 0,
//             overflowY: 'hidden',
//             transitionDuration: '200ms',
//             paddingBottom: '1px',
//         }}>
//             <MyDivider margin="0.7rem" />

//             {children}
//         </div>
//     </Tile>;
// }
