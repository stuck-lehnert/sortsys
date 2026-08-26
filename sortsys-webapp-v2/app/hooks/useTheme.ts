import { useEffect, useState } from "react";

const mediaQuery = typeof window === 'object'
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : {
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  };

export function useTheme() {
  const [isDark, setIsDark] = useState(mediaQuery.matches);

  useEffect(() => {
    const listener = () => setIsDark(mediaQuery.matches);
    mediaQuery.addEventListener('change', listener);
    return () => mediaQuery.removeEventListener('change', listener);
  }, []);

  return isDark ? "dark" : "light";
}
