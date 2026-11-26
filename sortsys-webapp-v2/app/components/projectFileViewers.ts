import { lazy } from "react";

export const PlanViewer = lazy(async () => {
  const { PlanViewer } = await import("@sortsys/dwgviewer");
  return { default: PlanViewer };
});

export const ProtectedOfficeEditor = lazy(async () => {
  const { ProtectedOfficeEditor } = await import("./ProtectedOfficeEditor");
  return { default: ProtectedOfficeEditor };
});
