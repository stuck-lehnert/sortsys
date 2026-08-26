import { useEffect, useRef, useState } from "react";

export function Awaited({ promise, deps }: {
    promise: Promise<React.ReactNode> | (() => Promise<React.ReactNode>);
    deps?: any[];
}) {
    const [hasData, setHasData] = useState(false);
    const nodeRef = useRef<React.ReactNode | null>(null);

    useEffect(() => {
        (async () => {
            if (typeof promise === 'function'){
                nodeRef.current = await promise() ?? null;
            } else {
                nodeRef.current = await promise ?? null;
            }

            setHasData(true);
        })();
    }, deps ?? []);

    if (!hasData) return;

    return nodeRef.current ?? '\u200b';
}
