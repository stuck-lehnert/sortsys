import { useEffect, useRef, useState } from "react";
import { useFileResource } from "~/lib/fileResources";

/** Decrypt only thumbnails near the viewport and release their object URLs. */
export function FileResourceImage({ src, ...props }: React.ImgHTMLAttributes<HTMLImageElement>) {
  const ref = useRef<HTMLImageElement>(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    const image = ref.current; if (!image) return;
    if (typeof IntersectionObserver !== "function") { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: "200px" });
    observer.observe(image); return () => observer.disconnect();
  }, [src]);
  const resource = useFileResource(visible ? src : null);
  return <img {...props} ref={ref} src={resource.url ?? undefined} loading="lazy" />;
}
