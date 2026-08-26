import { useEffect } from "react";

export function useTitle(getTitle: () => string | false | null | undefined | void, deps: any[] = []) {
  useEffect(() => {
    const prevTitle = document.title;
    const newTitle = getTitle();
    if (newTitle) {
      document.title = newTitle;
      // return () => { document.title = prevTitle; };
    }
  }, deps);
}
