import { Children, isValidElement, type ReactNode } from "react";

export function controlText(children: ReactNode): string {
  return Children.toArray(children)
    .map((child) => {
      if (typeof child === "string" || typeof child === "number") {
        return String(child);
      }

      if (isValidElement<{ children?: ReactNode }>(child)) {
        return controlText(child.props.children);
      }

      return "";
    })
    .join("");
}
