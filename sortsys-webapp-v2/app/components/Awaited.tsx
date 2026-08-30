import { useEffect, useState } from "react";

export function Awaited({ promise, deps }: {
    promise: Promise<React.ReactNode> | (() => Promise<React.ReactNode>);
    deps?: any[];
}) {
    const [node, setNode] = useState<React.ReactNode>();

    useEffect(() => {
        let cancelled = false;
        setNode(undefined);

        void (async () => {
            try {
                const result = typeof promise === 'function'
                    ? await promise()
                    : await promise;

                if (!cancelled) setNode(result ?? '\u200b');
            } catch {
                if (!cancelled) setNode('—');
            }
        })();

        return () => {
            cancelled = true;
        };
    }, deps ?? [promise]);

    return node;
}
