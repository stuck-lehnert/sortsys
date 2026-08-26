import { useEffect } from "react";

export function NotifyLoaded({ onLoad }: { onLoad: () => void }) {
  useEffect(() => {
    onLoad();
  }, []);

  return null;
}
