import { Card } from "@heroui/react";
import { Heading } from "@sortsys/react-components";
import type { ReactNode } from "react";

export function AuthLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <main
      id="main-content"
      className="flex min-h-dvh items-center justify-center bg-background p-4 sm:p-8"
    >
      <Card className="w-full max-w-md gap-6 p-6 sm:p-8">
        <Heading level={1} noMargin>
          {title}
        </Heading>
        {children}
      </Card>
    </main>
  );
}
