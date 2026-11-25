import type { ReactNode } from "react";
import { SessionInfoProvider } from "~/hooks/useSessionInfo";
import { MyModalsProvider } from "~/hooks/useMyModals";
import { CryptoUnlocked } from "./CryptoUnlocked";

export default function ApplicationFrame({
  authVersion,
  requireCrypto,
  children,
}: {
  authVersion: number;
  requireCrypto: boolean;
  children: ReactNode;
}) {
  const content = <MyModalsProvider>{children}</MyModalsProvider>;
  if (!requireCrypto) return content;

  return (
    <SessionInfoProvider key={authVersion}>
      <CryptoUnlocked>{content}</CryptoUnlocked>
    </SessionInfoProvider>
  );
}
