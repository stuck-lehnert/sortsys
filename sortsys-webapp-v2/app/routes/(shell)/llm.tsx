import { Card } from "@heroui/react";
import { Loading } from "@sortsys/react-components";
import { Button as UIAction } from "@sortsys/react-components";
import { TextArea as UITextArea } from "@heroui/react";
import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import { Heading, Modal, TextArea } from "@sortsys/react-components";
import { useNavigate, useParams } from "react-router";
import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";
import { AssistantMarkdown } from "~/components/AssistantMarkdown";
import ProjectFilePreviewModal from "~/components/ProjectFilePreviewModal";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyLink } from "~/components/MyLink";
import {
  ProposalEntityReference,
  proposalEntityKind,
} from "~/components/ProposalEntityReference";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { createChatRequests } from "~/lib/chatRequests";
import { prepareProposalInput } from "~/lib/llmProposalInput";
import type { ProjectFileTarget } from "~/lib/projectFileLinks";
import { Icons } from "~/lib/icons";
import {
  proposalFieldLabel,
  proposalOperationLabel,
  proposalValueLabel,
} from "~/lib/llmProposalI18n";
import { uiText, useI18n, type Locale, type TranslationKey } from "~/lib/i18n";

export function meta() {
  return [
    { title: uiText("LLM") },
  ];
}

type ChatDetail = QueryResult<'llm.chats.get'>;
type Proposal = ChatDetail['proposals'][number];
type ProposedOperation = {
  path: string;
  input: Record<string, unknown>;
  description: string;
};

type ProposalExecutionResult = NonNullable<
  MutateInput<'llm.proposals.review'>['executionResults']
>[number];

type ProposalLink = {
  href: string;
  label: string;
};

type Translate = (key: TranslationKey) => string;

const chatRequests = createChatRequests<ChatDetail>();
client.listenAuthState(() => chatRequests.clear());

const DATE_FIELDS = new Set([
  'day',
  'effectiveAt',
  'effectiveTimestamp',
  'from',
  'orderReceivedAt',
  'timestamp',
  'to',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatProposalValue(
  locale: Locale,
  localeTag: string,
  t: Translate,
  field: string,
  value: unknown,
): string | null {
  if (value === null || value === undefined) return t('common.notSet');
  if (typeof value === 'boolean') return value ? t('common.yes') : t('common.no');

  if (value instanceof Date) {
    return new Intl.DateTimeFormat(localeTag, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(value);
  }

  if (typeof value === 'number') {
    if (field === 'relativeFactor') {
      return new Intl.NumberFormat(localeTag, {
        style: 'percent',
        maximumFractionDigits: 2,
      }).format(value);
    }

    if (field === 'constant') {
      return new Intl.NumberFormat(localeTag, {
        style: 'currency',
        currency: 'EUR',
      }).format(value);
    }

    return new Intl.NumberFormat(localeTag).format(value);
  }

  if (typeof value === 'string') {
    if (field === 'effectiveAt' && value.toLowerCase() === 'now') {
      return t('proposal.immediately');
    }

    const translated = proposalValueLabel(locale, value);
    if (translated) return translated;

    if (DATE_FIELDS.has(field)) {
      const parsed = new Date(value);

      if (!Number.isNaN(parsed.valueOf())) {
        return new Intl.DateTimeFormat(localeTag, {
          dateStyle: 'medium',
          ...(value.includes('T') ? { timeStyle: 'short' as const } : {}),
        }).format(parsed);
      }
    }

    return value;
  }

  return null;
}

function ProposalValue({
  field,
  operationPath,
  rootInput,
  value,
}: {
  field: string;
  operationPath: string;
  rootInput: Record<string, unknown>;
  value: unknown;
}) {
  const { locale, localeTag, t } = useI18n();
  const kind = typeof value === 'string'
    ? proposalEntityKind(field, operationPath, rootInput)
    : null;

  if (kind && typeof value === 'string') {
    return <ProposalEntityReference id={value} kind={kind} />;
  }

  if (typeof value === 'string' && (field === 'id' || field.endsWith('Id'))) {
    return <span>{t("proposal.existingEntry")}</span>;
  }

  const formatted = formatProposalValue(locale, localeTag, t, field, value);
  if (formatted !== null) return <span>{formatted}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>{t("common.none")}</span>;

    return (
      <ol className="assistant-proposal-value-list list-disc space-y-2 pl-4 text-sm">
        {value.map((entry, index) => (
          <li key={index}>
            <ProposalValue
              field={field}
              operationPath={operationPath}
              rootInput={rootInput}
              value={entry}
            />
          </li>
        ))}
      </ol>
    );
  }

  if (isRecord(value)) return (
      <ProposalFields
        input={value}
        nested
        operationPath={operationPath}
        rootInput={rootInput}
      />
    );

  return <span>{String(value)}</span>;
}

function ProposalFields({
  input,
  nested = false,
  operationPath,
  rootInput = input,
}: {
  input: Record<string, unknown>;
  nested?: boolean;
  operationPath: string;
  rootInput?: Record<string, unknown>;
}) {
  const { locale } = useI18n();

  return (
    <dl
      className={[
        "assistant-proposal-fields min-w-0 text-sm",
        "[&>div]:grid [&>div]:gap-x-4 [&>div]:gap-y-1 [&>div]:py-2",
        "sm:[&>div]:grid-cols-[minmax(8rem,0.4fr)_minmax(0,1fr)]",
        "[&>div+div]:border-t [&>div+div]:border-separator",
        "[&_dt]:text-xs [&_dt]:font-medium [&_dt]:text-muted",
        "[&_dd]:min-w-0 [&_dd]:break-words",
        nested ? "is-nested" : "rounded-lg bg-surface px-3",
      ].join(" ")}
    >
      {Object.entries(input).map(([field, value]) => (
        <div key={field}>
          <dt>{proposalFieldLabel(locale, field)}</dt>
          <dd>
            <ProposalValue
              field={field}
              operationPath={operationPath}
              rootInput={rootInput}
              value={value}
            />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function executionLink(
  operation: ProposedOperation,
  result: ProposalExecutionResult | undefined,
  t: Translate,
): ProposalLink | null {
  const output = isRecord(result?.output) ? result.output : {};
  const outputId = typeof output.id === 'string' ? output.id : null;
  const inputId = typeof operation.input.id === 'string' ? operation.input.id : null;
  const id = outputId ?? inputId;

  if (operation.path.startsWith('projects.costs.entries.')) {
    const projectId = operation.input.projectId;
    return typeof projectId === 'string'
      ? { href: `/projects/${projectId}/costs`, label: t("proposal.openProjectCosts") }
      : null;
  }

  if (operation.path.startsWith('projects.dailyReports.')) {
    const projectId = operation.input.projectId;
    return typeof projectId === 'string'
      ? { href: `/projects/${projectId}/dailyReports`, label: t("proposal.openDailyReports") }
      : null;
  }

  if (operation.path.startsWith('projects.deployments.')) {
    return { href: '/deployments', label: t("proposal.openDeployments") };
  }

  if (operation.path === 'tools.inventories.create') {
    const toolId = operation.input.toolId;

    return typeof toolId === 'string'
      ? { href: `/tools/${toolId}`, label: t("proposal.openTool") }
      : { href: '/inventories', label: t("proposal.openInventory") };
  }

  if (operation.path === 'users.vacations.create') {
    return { href: '/vacations', label: t("proposal.openVacations") };
  }

  if (operation.path.startsWith('products.priceRecords.')) {
    const productId = operation.input.productId;

    return typeof productId === 'string'
      ? { href: `/products/${productId}`, label: t("proposal.openProduct") }
      : null;
  }

  const routes: Record<string, { prefix: string; label: TranslationKey }> = {
    contacts: { prefix: '/contacts', label: "proposal.openContact" },
    customers: { prefix: '/customers', label: "proposal.openCustomer" },
    deliveryNotes: { prefix: '/products/deliveryNotes', label: "proposal.openDeliveryNote" },
    products: { prefix: '/products', label: "proposal.openProduct" },
    projects: { prefix: '/projects', label: "proposal.openProject" },
    regieReports: { prefix: '/regieReports', label: "proposal.openRegieReport" },
    tools: { prefix: '/tools', label: "proposal.openTool" },
  };
  const resource = operation.path.split('.')[0];
  const route = routes[resource];

  return route && id ? { href: `${route.prefix}/${id}`, label: t(route.label) } : null;
}

function AcceptedProposal({ proposal }: { proposal: Proposal }) {
  const { locale, t } = useI18n();
  const operations = proposal.operations as unknown as ProposedOperation[];
  const executionResults = (proposal.executionResults ??
    []) as unknown as ProposalExecutionResult[];
  const links = operations
    .map((operation, index) =>
      executionLink(operation, executionResults[index], t),
    )
    .filter((link): link is ProposalLink => link !== null);

  return (
    <Card
      variant="secondary"
      role="article"
      className="assistant-proposal min-w-0 gap-4 is-accepted"
    >
      <Heading level={4} noMargin>
        {proposal.title}
      </Heading>
      <p>{proposal.summary}</p>

      <ol>
        {operations.map((operation, index) => (
          <li
            key={operation.path + "-" + index}
            className={[
              "assistant-proposal-operation flex flex-col gap-2 rounded-lg",
              "bg-surface p-3 text-sm",
            ].join(" ")}
          >
            <strong>
              {proposalOperationLabel(locale, operation.path) ??
                t("proposal.change")}
            </strong>
            <span>{operation.description}</span>

            <div className="assistant-proposal-input min-w-0 space-y-2">
              <span className="assistant-proposal-input-label block text-xs font-medium text-muted">
                {t("proposal.appliedData")}
              </span>
              <ProposalFields
                input={operation.input}
                operationPath={operation.path}
              />
            </div>
          </li>
        ))}
      </ol>

      <div
        className={[
          "assistant-proposal-complete flex items-start gap-2 text-success",
          "[&_div]:flex [&_div]:flex-col [&_div]:gap-2",
        ].join(" ")}
      >
        <Icons.Accept size={20} aria-hidden="true" />
        <div>
          <strong className="text-foreground">{t("proposal.accepted")}</strong>
          {links.map((link, index) => (
            <MyLink
              key={link.href + index}
              to={link.href}
              style={{
                color:
                  "color-mix(in oklab, var(--accent) 35%, var(--foreground))",
              }}
            >
              {link.label}
            </MyLink>
          ))}
        </div>
      </div>
    </Card>
  );
}

function DeclinedProposal({ proposal }: { proposal: Proposal }) {
  const { locale, t } = useI18n();
  const operations = proposal.operations as unknown as ProposedOperation[];

  return (
    <Card
      variant="secondary"
      role="article"
      className="assistant-proposal min-w-0 gap-4 is-declined"
    >
      <Heading level={4} noMargin>
        {proposal.title}
      </Heading>
      <p>{proposal.summary}</p>

      <ol>
        {operations.map((operation, index) => (
          <li
            key={operation.path + "-" + index}
            className={[
              "assistant-proposal-operation flex flex-col gap-2 rounded-lg",
              "bg-surface p-3 text-sm",
            ].join(" ")}
          >
            <strong>
              {proposalOperationLabel(locale, operation.path) ??
                t("proposal.change")}
            </strong>
            <span>{operation.description}</span>

            <div className="assistant-proposal-input min-w-0 space-y-2">
              <span className="assistant-proposal-input-label block text-xs font-medium text-muted">
                {t("proposal.proposedData")}
              </span>
              <ProposalFields
                input={operation.input}
                operationPath={operation.path}
              />
            </div>
          </li>
        ))}
      </ol>

      <div className="assistant-proposal-declined flex items-center gap-2 text-muted">
        <Icons.Deny size={20} aria-hidden="true" />
        <strong>{t("proposal.declined")}</strong>
      </div>
    </Card>
  );
}

export default function LlmPage() {
  const { locale, t } = useI18n();
  const navigate = useNavigate();
  const { chatId } = useParams();
  const selectedId = chatId ?? null;
  const [status, statusErr] = useClientStream(
    () => client.streamQuery('llm.status', undefined, { strategy: 'network-first' }),
    [],
  );
  const [detail, setDetail] = useState<ChatDetail | null>(null);
  const [content, setContent] = useState('');
  const [isStartingNewChat, setIsStartingNewChat] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<ProjectFileTarget | null>(null);
  const closeFilePreview = useCallback(() => {
    setPreviewTarget(null);
  }, []);

  useEffect(() => {
    setPreviewTarget(null);
  }, [selectedId]);

  useEffect(() => {
    return client.listenAuthState(closeFilePreview);
  }, [closeFilePreview]);

  const request = useSyncExternalStore(
    chatRequests.subscribe,
    () => chatRequests.get(selectedId),
    () => null,
  );
  const submittedMessage = request?.pending ? request.submission : null;
  const [revisionComments, setRevisionComments] = useState<
    Record<string, string>
  >({});
  const acceptLabelId = useId();
  const revisionBusyRef = useRef<string | null>(null);
  const [revisionProposalId, setRevisionProposalId] = useState<string | null>(
    null,
  );
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef(selectedId);
  const detailChatIdRef = useRef<string | null>(null);
  const mountedRef = useRef(false);

  selectedIdRef.current = selectedId;

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setPending(null);
    revisionBusyRef.current = null;
    setRevisionProposalId(null);
    setRevisionError(null);
    setRevisionComments({});

    if (!selectedId) {
      setIsStartingNewChat(false);
    }
  }, [selectedId]);

  useEffect(
    () =>
      client.listenAuthState(() => {
        revisionBusyRef.current = null;
        setRevisionProposalId(null);
        setRevisionError(null);
        setRevisionComments({});
      }),
    [],
  );

  useEffect(() => {
    // Keep loaded history visible when a request starts in the current chat.
    if (detailChatIdRef.current !== selectedId || !request?.pending) {
      setDetail(request?.data ?? null);
      detailChatIdRef.current = selectedId;
    }

    setError(request?.error ?? null);

    if (!selectedId) {
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const currentChatId = selectedId;

    async function refresh() {
      const [data, err] = await client.query(
        'llm.chats.get',
        { chatId: currentChatId },
        { strategy: 'network-only' },
      );

      if (cancelled) {
        return;
      }

      if (err) {
        setError(err.message);
      } else {
        setDetail(data);
      }

      // Recover persisted messages and proposals while the provider is working.
      if (request?.pending) {
        timer = setTimeout(() => void refresh(), 2000);
      }
    }

    void refresh();

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedId, request]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (!transcript) return;

    transcript.scrollTo({
      top: transcript.scrollHeight,
      behavior: 'smooth',
    });
  }, [detail?.messages.length, submittedMessage, pending]);

  const visibleProposals = useMemo(
    () => detail?.proposals.filter(proposal => (
      proposal.status === 'pending'
      || proposal.status === 'accepted'
      || proposal.status === 'declined'
    )) ?? [],
    [detail],
  );
  const revisionProposal = visibleProposals.find(
    (proposal) =>
      proposal.id === revisionProposalId && proposal.status === "pending",
  );
  const unattachedProposals = useMemo(
    () => visibleProposals.filter(proposal => proposal.assistantMessageId === null),
    [visibleProposals],
  );
  const submittedMessageIsPersisted = !!submittedMessage && !!detail?.messages.some(message => (
    message.role === 'user'
    && message.content === submittedMessage.content
    && !submittedMessage.existingMessageIds.includes(message.id)
  ));
  const hasMessages = !!detail?.messages.length || !!submittedMessage;
  const isSending = pending === 'send' || !!request?.pending;

  async function loadChat(chatId: string) {
    // A fast review can finish while the initial query is still deduplicated.
    await client.invalidate("llm.chats.get");

    const [data, err] = await client.query(
      "llm.chats.get",
      { chatId },
      { strategy: "network-first" },
    );

    if (!mountedRef.current || selectedIdRef.current !== chatId) {
      return;
    }

    if (err) {
      setError(err.message);
      return;
    }

    setDetail(data);
  }

  function beginNewChat() {
    // Keep the composer inactive until the new-chat route commits.
    setIsStartingNewChat(true);
    void navigate('/llm');
    setDetail(null);
    setContent('');
    setError(null);
  }

  async function sendMessage(message = content) {
    const normalizedMessage = message.trim();

    if (!normalizedMessage || isSending || isStartingNewChat) {
      return;
    }

    setPending('send');
    setError(null);
    setContent('');

    const submission = {
      content: normalizedMessage,
      existingMessageIds: detail?.messages.map(existingMessage => existingMessage.id) ?? [],
    };
    const isCurrentSession = chatRequests.sessionGuard();
    const originChatId = selectedId;
    let targetChatId = selectedId;

    if (!targetChatId) {
      const [chat, createError] = await client.mutate('llm.chats.create', {});

      if (!isCurrentSession()) {
        return;
      }

      if (createError) {
        if (mountedRef.current && selectedIdRef.current === originChatId) {
          setPending(null);
          setContent(normalizedMessage);
          setError(createError.message);
        }

        return;
      }

      targetChatId = chat.id;
    }

    const chatId = targetChatId;
    void chatRequests.start(chatId, submission, async () => {
      const [updated, sendError] = await client.mutate('llm.messages.send', {
        chatId,
        content: normalizedMessage,
        locale,
      });

      void client.invalidate('llm.chats.list');

      if (sendError) {
        throw sendError;
      }

      return updated;
    });

    if (mountedRef.current && selectedIdRef.current === originChatId) {
      setPending(null);

      if (!originChatId) {
        void navigate(`/llm/${chatId}`, { replace: true });
      }
    }

    void client.invalidate('llm.chats.list');
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;

    event.preventDefault();
    void sendMessage();
  }

  async function decline(proposal: Proposal) {
    setPending(proposal.id);
    const [, reviewError] = await client.mutate('llm.proposals.review', {
      proposalId: proposal.id,
      decision: 'decline',
      comment: null,
    });
    setPending(null);

    if (reviewError) {
      setError(reviewError.message);
      return;
    }

    if (selectedId) await loadChat(selectedId);
  }

  async function requestRevision(proposal: Proposal) {
    const comment = revisionComments[proposal.id]?.trim();
    if (
      !comment ||
      !selectedId ||
      isSending ||
      pending !== null ||
      revisionBusyRef.current !== null
    ) {
      return;
    }

    revisionBusyRef.current = proposal.id;

    const chatId = selectedId;
    const isCurrentSession = chatRequests.sessionGuard();

    setPending(proposal.id);
    setRevisionError(null);

    const [, reviewError] = await client.mutate("llm.proposals.review", {
      proposalId: proposal.id,
      decision: "requestRevision",
      comment,
    });

    if (
      !isCurrentSession() ||
      !mountedRef.current ||
      selectedIdRef.current !== chatId
    ) {
      return;
    }

    revisionBusyRef.current = null;

    if (reviewError) {
      setPending(null);
      setRevisionError(reviewError.message);
      return;
    }

    setRevisionProposalId(null);
    setRevisionComments((previous) => ({ ...previous, [proposal.id]: "" }));

    await sendMessage(
      uiText(
        "Überarbeite den Vorschlag „" +
          proposal.title +
          "“. Kommentar: " +
          comment,
        "Revise the proposal “" + proposal.title + "”. Comment: " + comment,
      ),
    );
  }

  function closeRevision() {
    if (pending !== null || revisionBusyRef.current !== null) {
      return;
    }

    setRevisionProposalId(null);
    setRevisionError(null);
  }

  async function accept(proposal: Proposal) {
    if (!selectedId || isSending || pending) {
      return;
    }

    const chatId = selectedId;
    const isCurrentSession = chatRequests.sessionGuard();
    const operations = proposal.operations as unknown as ProposedOperation[];
    const executionResults: ProposalExecutionResult[] = [];
    let executableInputs: Record<string, unknown>[];

    try {
      executableInputs = operations.map(
        (operation) =>
          prepareProposalInput(operation.input) as Record<string, unknown>,
      );
    } catch {
      setError(
        uiText(
          "Der Vorschlag enthält ein ungültiges Datum.",
          "The proposal contains an invalid date.",
        ),
      );
      return;
    }

    setPending(proposal.id);
    setError(null);

    // Every operation uses the current user's client and therefore the current
    // bearer token and ordinary mutation permission checks.
    for (const [index, operation] of operations.entries()) {
      const [output, operationError] = await client.mutateDynamic(
        operation.path,
        executableInputs[index],
      );

      if (!isCurrentSession()) {
        return;
      }

      if (operationError) {
        setPending(null);
        setError(operation.description + ": " + operationError.message);
        return;
      }

      executionResults.push({
        path: operation.path,
        output: output as ProposalExecutionResult["output"],
      });
    }

    setPending(null);

    await chatRequests.start(chatId, null, async () => {
      const [, reviewError] = await client.mutate("llm.proposals.review", {
        proposalId: proposal.id,
        decision: "accept",
        comment: null,
        executionResults,
        continueConversation: true,
      });

      if (reviewError) {
        throw reviewError;
      }

      await client.invalidate("llm.chats.get");

      const [updated, loadError] = await client.query(
        "llm.chats.get",
        { chatId },
        { strategy: "network-only" },
      );

      if (loadError) {
        throw loadError;
      }

      if (!updated) {
        throw new Error(uiText("Chat nicht gefunden.", "Chat not found."));
      }

      void client.invalidate("llm.chats.list");

      return updated;
    });
  }

  function renderPendingProposal(proposal: Proposal) {
    const operations = proposal.operations as unknown as ProposedOperation[];

    return (
      <Card
        variant="secondary"
        role="article"
        key={proposal.id}
        className="assistant-proposal min-w-0 gap-4"
      >
        <Heading level={4} noMargin>
          {proposal.title}
        </Heading>
        <p>{proposal.summary}</p>

        <ol>
          {operations.map((operation, index) => (
            <li
              key={operation.path + "-" + index}
              className={[
                "assistant-proposal-operation flex flex-col gap-2 rounded-lg",
                "bg-surface p-3 text-sm",
              ].join(" ")}
            >
              <strong>
                {proposalOperationLabel(locale, operation.path) ??
                  t("proposal.change")}
              </strong>
              <span>{operation.description}</span>

              <div className="assistant-proposal-input min-w-0 space-y-2">
                <span className="assistant-proposal-input-label block text-xs font-medium text-muted">
                  {t("proposal.plannedData")}
                </span>
                <ProposalFields
                  input={operation.input}
                  operationPath={operation.path}
                />
              </div>
            </li>
          ))}
        </ol>

        <div className="assistant-proposal-actions flex flex-wrap gap-2">
          <MyButton
            className="bg-success text-success-foreground hover:bg-success/90"
            aria-labelledby={acceptLabelId}
            loading={pending === proposal.id}
            disabled={isSending || pending !== null}
            onClick={() => void accept(proposal)}
          >
            {t("proposal.accept")}
          </MyButton>
          <MyButton
            kind="secondary"
            disabled={isSending || pending !== null}
            onClick={() => {
              setRevisionError(null);
              setRevisionProposalId(proposal.id);
            }}
          >
            {t("proposal.revise")}
          </MyButton>
          <MyButton
            kind="danger"
            className="bg-red-700 text-white hover:bg-red-800"
            disabled={isSending || pending !== null}
            onClick={() => void decline(proposal)}
          >
            {t("proposal.decline")}
          </MyButton>
        </div>
      </Card>
    );
  }

  function renderProposal(proposal: Proposal) {
    if (proposal.status === 'accepted') {
      return <AcceptedProposal key={proposal.id} proposal={proposal} />;
    }
    if (proposal.status === 'declined') {
      return <DeclinedProposal key={proposal.id} proposal={proposal} />;
    }

    return renderPendingProposal(proposal);
  }

  if (status && !status.available) {
    const reason = !status.hasRole
      ? t("llm.missingRole")
      : !status.tenantEnabled
        ? t("llm.tenantDisabled")
        : t("llm.providerMissing");

    return (
      <MyCallout icon={Icons.Info} color="blue">
        {reason}
      </MyCallout>
    );
  }

  return (
    <>
      <section
        aria-label={t("llm.chats")}
        className="llm-page mx-auto flex h-[calc(100dvh-7rem)] min-h-0 w-full flex-col gap-3"
      >
        <header className="flex min-h-10 shrink-0 items-center justify-end gap-2">
          {!!selectedId && (
            <h1 className="sr-only">
              {detail?.chat.title ?? t("llm.newChat")}
            </h1>
          )}
          <MyButton
            kind="ghost"
            size="sm"
            renderIcon={Icons.Chat}
            onClick={() => void navigate("/llm/chats")}
          >
            {t("llm.previousChats")}
          </MyButton>
          {!!selectedId && (
            <MyButton
              kind="ghost"
              size="sm"
              renderIcon={Icons.Create}
              disabled={isSending || isStartingNewChat}
              onClick={beginNewChat}
            >
              {t("llm.newChat")}
            </MyButton>
          )}
        </header>

        {!!statusErr && (
          <MyCallout icon={Icons.Deny} color="red">
            {statusErr.message}
          </MyCallout>
        )}
        {!!error && (
          <MyCallout icon={Icons.Deny} color="red">
            {error}
          </MyCallout>
        )}

        <div
          ref={transcriptRef}
          role="log"
          aria-label={t("llm.chats")}
          aria-live="polite"
          aria-relevant="additions text"
          tabIndex={0}
          className={[
            "min-h-0 flex-1 overflow-y-auto rounded-lg",
            "[scrollbar-gutter:stable] focus-visible:outline-2",
            "focus-visible:outline-offset-2 focus-visible:outline-focus",
          ].join(" ")}
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 p-1 sm:p-3">
            {!status && !statusErr ? (
              <div className="flex flex-1 items-center justify-center">
                <Loading active description={t("common.loading")} />
              </div>
            ) : !hasMessages ? (
              <div
                className={[
                  "flex flex-1 flex-col items-center justify-center",
                  "gap-4 p-4 text-center",
                ].join(" ")}
              >
                <Icons.Magic
                  size={32}
                  className="text-accent"
                  aria-hidden="true"
                />
                <Heading level={selectedId ? 2 : 1} noMargin>
                  {t("llm.welcome")}
                </Heading>
              </div>
            ) : null}

            {detail?.messages.map((message) => (
              <Fragment key={message.id}>
                {(message.role === "user" || message.content.trim()) && (
                  <article
                    className={
                      message.role === "user"
                        ? "ml-auto min-w-0 max-w-[90%]"
                        : "min-w-0 w-full"
                    }
                  >
                    {message.role === "user" ? (
                      <Card
                        variant="secondary"
                        className={[
                          "gap-0 whitespace-pre-wrap break-words px-4 py-3",
                          "text-sm leading-relaxed",
                        ].join(" ")}
                      >
                        {message.content}
                      </Card>
                    ) : (
                      <AssistantMarkdown
                        content={message.content}
                        onOpenFile={setPreviewTarget}
                      />
                    )}
                  </article>
                )}
                {visibleProposals
                  .filter(
                    (proposal) => proposal.assistantMessageId === message.id,
                  )
                  .map(renderProposal)}
              </Fragment>
            ))}

            {!!submittedMessage && !submittedMessageIsPersisted && (
              <article className="ml-auto min-w-0 max-w-[90%]">
                <Card
                  variant="secondary"
                  className={[
                    "gap-0 whitespace-pre-wrap break-words px-4 py-3",
                    "text-sm leading-relaxed",
                  ].join(" ")}
                >
                  {submittedMessage.content}
                </Card>
              </article>
            )}

            {isSending && (
              <Loading active small description={t("llm.responding")} />
            )}

            {unattachedProposals.map(renderProposal)}
          </div>
        </div>

        <form
          className="mx-auto w-full max-w-3xl shrink-0 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <div className="flex items-end gap-2">
            <UITextArea
              autoFocus
              variant="secondary"
              className="max-h-48 min-h-14 min-w-0 flex-1 resize-none"
              aria-label={t("llm.message")}
              placeholder={t("llm.placeholder")}
              value={content}
              disabled={isSending || isStartingNewChat || !status?.available}
              rows={2}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                setContent(event.currentTarget.value);
              }}
              onKeyDown={handleComposerKeyDown}
            />
            <UIAction
              type="submit"
              className="shrink-0 rounded-full"
              aria-label={t("llm.send")}
              title={t("llm.send")}
              disabled={
                isSending ||
                isStartingNewChat ||
                !status?.available ||
                !content.trim()
              }
            >
              <Icons.Magic size={18} aria-hidden="true" />
              <span className="sr-only sm:not-sr-only">{t("llm.send")}</span>
            </UIAction>
          </div>
          <p className="px-1 text-xs leading-relaxed text-muted">
            {t("llm.composerHint")}
          </p>
        </form>
      </section>

      {/* Pending announcements keep their name after the proposal is replaced. */}
      <span id={acceptLabelId} className="sr-only">
        {t("proposal.accept")}
      </span>

      <Modal
        open={Boolean(revisionProposal)}
        modalHeading={t("proposal.revise")}
        primaryButtonText={t("proposal.revise")}
        secondaryButtonText={uiText("Abbrechen", "Cancel")}
        closeButtonLabel={uiText("Schließen", "Close")}
        primaryButtonDisabled={
          !revisionProposal ||
          !revisionComments[revisionProposal.id]?.trim() ||
          isSending ||
          pending !== null
        }
        secondaryButtonDisabled={pending !== null}
        onRequestClose={closeRevision}
        onRequestSubmit={() => {
          if (revisionProposal) {
            void requestRevision(revisionProposal);
          }
        }}
      >
        {revisionProposal && (
          <div className="space-y-3">
            <p className="text-sm font-medium">{revisionProposal.title}</p>
            <TextArea
              id={"revision-" + revisionProposal.id}
              labelText={t("proposal.revision")}
              rows={3}
              disabled={pending !== null}
              value={revisionComments[revisionProposal.id] ?? ""}
              onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
                const value = event.currentTarget.value;
                setRevisionComments((previous) => ({
                  ...previous,
                  [revisionProposal.id]: value,
                }));
              }}
            />
            {pending === revisionProposal.id && (
              <Loading
                active
                small
                description={uiText(
                  "Überarbeitung wird angefordert.",
                  "Requesting revision.",
                )}
              />
            )}
            {revisionError && (
              <MyCallout icon={Icons.Deny} color="red">
                {revisionError}
              </MyCallout>
            )}
          </div>
        )}
      </Modal>

      {previewTarget && (
        <ProjectFilePreviewModal
          key={`${previewTarget.projectId}:${previewTarget.fileId}`}
          target={previewTarget}
          onClose={closeFilePreview}
        />
      )}
    </>
  );
}
