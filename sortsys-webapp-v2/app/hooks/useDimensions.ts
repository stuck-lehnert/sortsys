import { useEffect, useState } from "react";

function getWidth() {
  if (typeof window === 'undefined') return 0;
  return window.innerWidth;
}

function getHeight() {
  if (typeof window === 'undefined') return 0;
  return window.innerHeight;
}

export function useDimensions() {
  const [width, setWidth] = useState(getWidth());
  const [height, setHeight] = useState(getHeight());

  useEffect(() => {
    const handleResize = () => {
      setWidth(window.innerWidth);
      setHeight(window.innerHeight);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return { width, height };
}
