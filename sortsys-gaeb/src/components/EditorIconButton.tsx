import type { ComponentType, ReactNode } from "react";
import { Button } from "@sortsys/react-components";

// Keep the full action name for assistive technology, while
// balancing the visible Office-style caption across at most two lines.
function ribbonCaption(label: string): string {
  const words = label.trim().split(/\s+/);
  if (words.length < 2) return label;
  let split = 1;
  const longest = (at: number) =>
    Math.max(
      words.slice(0, at).join(" ").length,
      words.slice(at).join(" ").length,
    );
  for (let i = 2; i < words.length; i++) {
    if (longest(i) < longest(split)) split = i;
  }
  return `${words.slice(0, split).join(" ")}\n${words.slice(split).join(" ")}`;
}

export function EditorIconButton({
  label,
  icon: Icon,
  shortcut,
  showLabel = false,
  ...props
}: {
  label: string;
  icon: ComponentType<{ size?: number; "aria-hidden"?: boolean }>;
  shortcut?: string;
  showLabel?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onMouseDown?: (event: React.MouseEvent<HTMLElement>) => void;
  "aria-pressed"?: boolean;
  "aria-expanded"?: boolean;
  "data-gaeb-search"?: boolean;
  "data-gaeb-outline-toggle"?: boolean;
  children?: ReactNode;
}) {
  return (
    <Button
      {...props}
      size="sm"
      kind="ghost"
      className={`gaeb-icon-button${showLabel ? " gaeb-ribbon-tool" : ""}`}
      aria-label={label}
      aria-keyshortcuts={shortcut}
    >
      <Icon size={18} aria-hidden />
      {showLabel && <span>{ribbonCaption(label)}</span>}
    </Button>
  );
}
