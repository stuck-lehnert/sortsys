import { useMemo, type ComponentProps } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  projectFileLinkTarget,
  type ProjectFileTarget,
} from "~/lib/projectFileLinks";

type FileLinkHandler = (target: ProjectFileTarget) => void;

export function AssistantFileLink({
  children,
  href,
  title,
  onOpenFile,
}: ComponentProps<"a"> & { onOpenFile: FileLinkHandler }) {
  return (
    <a
      href={href}
      title={title}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        const target = projectFileLinkTarget(href, window.location.href, event);

        if (!target) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        onOpenFile(target);
      }}
    >
      {children}
    </a>
  );
}

export function AssistantMarkdown({
  content,
  onOpenFile,
}: {
  content: string;
  onOpenFile: FileLinkHandler;
}) {
  // Preserve the source link's DOM identity while its preview is open.
  const components = useMemo<Components>(
    () => ({
      a: ({ children, href, title }) => (
        <AssistantFileLink href={href} title={title} onOpenFile={onOpenFile}>
          {children}
        </AssistantFileLink>
      ),
    }),
    [onOpenFile],
  );

  return (
    <div className="assistant-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        disallowedElements={["img"]}
        components={components}
      >
        {content}
      </Markdown>
    </div>
  );
}
