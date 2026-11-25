import { lazy, Suspense, type ComponentProps } from "react";
import { Loading } from "@sortsys/react-components";
import { uiText } from "~/lib/i18n";
import type { CommercialDetail, CommercialDocument } from "~/lib/commercial";

const GaebWorkspace = lazy(() => import("./GaebFileModal"));

type Props = Omit<
  ComponentProps<typeof GaebWorkspace>,
  | "projectId"
  | "fileId"
  | "caseId"
  | "documentId"
  | "fileName"
  | "documentTitle"
  | "projectTitle"
  | "documentKind"
> & {
  current: CommercialDetail["case"];
  active: CommercialDocument;
};

export function CommercialDocumentEditor({ current, active, ...editor }: Props) {
  return (
    <Suspense
      fallback={
        <Loading
          className="commercial-editor-loading"
          active
          description={uiText("Editor wird geöffnet …", "Opening editor …")}
        />
      }
    >
      <GaebWorkspace
        {...editor}
        key={active.id}
        caseId={current.id}
        documentId={active.id}
        fileName={active.fileName}
        documentTitle={current.title}
        projectTitle={current.projectTitle ?? undefined}
        documentKind={current.kind}
      />
    </Suspense>
  );
}
