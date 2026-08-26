import type { ComponentProps } from "react";
import { Button } from "./index.js";

export function SSButton(_props: ComponentProps<typeof Button> & {
  loading?: boolean;
}) {
  const { loading, disabled, ...props } = _props;

  return <Button {...props} disabled={disabled || loading} />;
}

export const MyButton = SSButton;
