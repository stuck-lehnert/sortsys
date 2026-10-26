import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import { Heading, TextArea } from "@sortsys/react-components";
import { useNavigate, useParams } from "react-router";
import {
  Fragment,
  useCallback,
  useEffect,
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

function prepareProposalInput(value: unknown, field = ''): unknown {
  if (field === 'effectiveAt' && typeof value === 'string' && value.toLowerCase() === 'now') {
    return new Date().toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(entry => prepareProposalInput(entry));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([nestedField, nestedValue]) => [
        nestedField,
        prepareProposalInput(nestedValue, nestedField),
      ]),
    );
  }

  return value;
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
    return <span>{t('proposal.existingEntry')}</span>;
  }

  const formatted = formatProposalValue(locale, localeTag, t, field, value);
  if (formatted !== null) return <span>{formatted}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) return <span>{t('common.none')}</span>;

    return <ol className="assistant-proposal-value-list">
      {value.map((entry, index) => <li key={index}>
        <ProposalValue
          field={field}
          operationPath={operationPath}
          rootInput={rootInput}
          value={entry}
        />
      </li>)}
    </ol>;
  }

  if (isRecord(value)) return <ProposalFields
    input={value}
    nested
    operationPath={operationPath}
    rootInput={rootInput}
  />;

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

  return <dl className={'assistant-proposal-fields' + (nested ? ' is-nested' : '')}>
    {Object.entries(input).map(([field, value]) => <div key={field}>
      <dt>{proposalFieldLabel(locale, field)}</dt>
      <dd>
        <ProposalValue
          field={field}
          operationPath={operationPath}
          rootInput={rootInput}
          value={value}
        />
      </dd>
    </div>)}
  </dl>;
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
  const executionResults = (proposal.executionResults ?? []) as unknown as ProposalExecutionResult[];
  const links = operations
    .map((operation, index) => executionLink(operation, executionResults[index], t))
    .filter((link): link is ProposalLink => link !== null);

  return <article className="assistant-proposal is-accepted">
    <Heading level={4} noMargin>{proposal.title}</Heading>
    <p>{proposal.summary}</p>

    <ol>
      {operations.map((operation, index) => <li
        key={operation.path + '-' + index}
        className="assistant-proposal-operation"
      >
        <strong>{proposalOperationLabel(locale, operation.path) ?? t('proposal.change')}</strong>
        <span>{operation.description}</span>

        <div className="assistant-proposal-input">
          <span className="assistant-proposal-input-label">{t('proposal.appliedData')}</span>
          <ProposalFields input={operation.input} operationPath={operation.path} />
        </div>
      </li>)}
    </ol>

    <div className="assistant-proposal-complete">
      <Icons.Accept size={20} />
      <div>
        <strong>{t('proposal.accepted')}</strong>
        {links.map((link, index) => <MyLink key={link.href + index} to={link.href}>
          {link.label}
        </MyLink>)}
      </div>
    </div>
  </article>;
}

function DeclinedProposal({ proposal }: { proposal: Proposal }) {
  const { locale, t } = useI18n();
  const operations = proposal.operations as unknown as ProposedOperation[];

  return <article className="assistant-proposal is-declined">
    <Heading level={4} noMargin>{proposal.title}</Heading>
    <p>{proposal.summary}</p>

    <ol>
      {operations.map((operation, index) => <li
        key={operation.path + '-' + index}
        className="assistant-proposal-operation"
      >
        <strong>{proposalOperationLabel(locale, operation.path) ?? t('proposal.change')}</strong>
        <span>{operation.description}</span>

        <div className="assistant-proposal-input">
          <span className="assistant-proposal-input-label">{t('proposal.proposedData')}</span>
          <ProposalFields input={operation.input} operationPath={operation.path} />
        </div>
      </li>)}
    </ol>

    <div className="assistant-proposal-declined">
      <Icons.Deny size={20} />
      <strong>{t('proposal.declined')}</strong>
    </div>
  </article>;
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
  const [revisionComments, setRevisionComments] = useState<Record<string, string>>({});
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
  }, [selectedId]);

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
    const [data, err] = await client.query(
      'llm.chats.get',
      { chatId },
      { strategy: 'network-first' },
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
    void navigate('/llm');
    setDetail(null);
    setContent('');
    setError(null);
  }

  async function sendMessage(message = content) {
    const normalizedMessage = message.trim();

    if (!normalizedMessage || isSending) {
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
    if (!comment) return;

    setPending(proposal.id);
    const [, reviewError] = await client.mutate('llm.proposals.review', {
      proposalId: proposal.id,
      decision: 'requestRevision',
      comment,
    });

    if (reviewError) {
      setPending(null);
      setError(reviewError.message);
      return;
    }

    await sendMessage(uiText(
      'Überarbeite den Vorschlag „' + proposal.title + '“. Kommentar: ' + comment,
      'Revise the proposal “' + proposal.title + '”. Comment: ' + comment,
    ));
    setRevisionComments(previous => ({ ...previous, [proposal.id]: '' }));
  }

  async function accept(proposal: Proposal) {
    if (!selectedId || isSending || pending) {
      return;
    }

    const chatId = selectedId;
    const isCurrentSession = chatRequests.sessionGuard();
    const operations = proposal.operations as unknown as ProposedOperation[];
    const executionResults: ProposalExecutionResult[] = [];

    setPending(proposal.id);
    setError(null);

    // Every operation uses the current user's client and therefore the current
    // bearer token and ordinary mutation permission checks.
    for (const operation of operations) {
      const executableInput = prepareProposalInput(operation.input) as Record<string, unknown>;
      const [output, operationError] = await client.mutateDynamic(operation.path, executableInput);

      if (!isCurrentSession()) {
        return;
      }

      if (operationError) {
        setPending(null);
        setError(operation.description + ': ' + operationError.message);
        return;
      }

      executionResults.push({
        path: operation.path,
        output: output as ProposalExecutionResult['output'],
      });
    }

    setPending(null);

    await chatRequests.start(chatId, null, async () => {
      const [, reviewError] = await client.mutate('llm.proposals.review', {
        proposalId: proposal.id,
        decision: 'accept',
        comment: null,
        executionResults,
        continueConversation: true,
      });

      if (reviewError) {
        throw reviewError;
      }

      const [updated, loadError] = await client.query(
        'llm.chats.get',
        { chatId },
        { strategy: 'network-only' },
      );

      if (loadError) {
        throw loadError;
      }

      if (!updated) {
        throw new Error(uiText('Chat nicht gefunden.', 'Chat not found.'));
      }

      void client.invalidate('llm.chats.list');

      return updated;
    });
  }

  function renderPendingProposal(proposal: Proposal) {
    const operations = proposal.operations as unknown as ProposedOperation[];

    return <article key={proposal.id} className="assistant-proposal">
      <Heading level={4} noMargin>{proposal.title}</Heading>
      <p>{proposal.summary}</p>

      <ol>
        {operations.map((operation, index) => (
          <li key={operation.path + '-' + index} className="assistant-proposal-operation">
            <strong>{proposalOperationLabel(locale, operation.path) ?? t('proposal.change')}</strong>
            <span>{operation.description}</span>

            <div className="assistant-proposal-input">
              <span className="assistant-proposal-input-label">{t('proposal.plannedData')}</span>
              <ProposalFields input={operation.input} operationPath={operation.path} />
            </div>
          </li>
        ))}
      </ol>

      <TextArea
        id={'revision-' + proposal.id}
        labelText={t('proposal.revision')}
        rows={2}
        value={revisionComments[proposal.id] ?? ''}
        onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
          const value = event.currentTarget.value;
          setRevisionComments(previous => ({
            ...previous,
            [proposal.id]: value,
          }));
        }}
      />

      <div className="assistant-proposal-actions">
        <MyButton
          loading={pending === proposal.id}
          disabled={isSending || pending !== null}
          onClick={() => void accept(proposal)}
        >
          {t('proposal.accept')}
        </MyButton>
        <MyButton
          kind="secondary"
          disabled={isSending || pending !== null || !revisionComments[proposal.id]?.trim()}
          onClick={() => void requestRevision(proposal)}
        >
          {t('proposal.revise')}
        </MyButton>
        <MyButton
          kind="ghost"
          disabled={isSending || pending !== null}
          onClick={() => void decline(proposal)}
        >
          {t('proposal.decline')}
        </MyButton>
      </div>
    </article>;
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
      ? t('llm.missingRole')
      : !status.tenantEnabled
        ? t('llm.tenantDisabled')
        : t('llm.providerMissing');

    return <MyCallout icon={Icons.Info} color="blue">{reason}</MyCallout>;
  }

  return <>
    {!!statusErr && <MyCallout icon={Icons.Deny} color="red">{statusErr.message}</MyCallout>}
    {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}

    <div className="assistant-shell">
      <section className={'assistant-chat' + (!hasMessages ? ' is-empty' : '')}>
        <div className="assistant-chat-toolbar">
          <MyButton
            kind="ghost"
            size="sm"
            renderIcon={Icons.Chat}
            onClick={() => void navigate('/llm/chats')}
          >
            {t('llm.chats')}
          </MyButton>
          {!!selectedId && <MyButton
            kind="ghost"
            size="sm"
            renderIcon={Icons.Create}
            disabled={isSending}
            onClick={beginNewChat}
          >
            {t('llm.newChat')}
          </MyButton>}
        </div>
        <div ref={transcriptRef} className="assistant-transcript" aria-live="polite">
          <div className="assistant-messages">
            {!hasMessages && <div className="assistant-welcome">
              <Heading level={2} noMargin>{t('llm.welcome')}</Heading>
            </div>}

            {detail?.messages.map(message => <Fragment key={message.id}>
              {(message.role === 'user' || message.content.trim()) && <article className={'assistant-message assistant-message--' + message.role}>
                {message.role === 'user'
                  ? <p>{message.content}</p>
                  : <AssistantMarkdown
                      content={message.content}
                      onOpenFile={setPreviewTarget}
                    />}
              </article>}
              {visibleProposals
                .filter(proposal => proposal.assistantMessageId === message.id)
                .map(renderProposal)}
            </Fragment>)}

            {!!submittedMessage && !submittedMessageIsPersisted && <article className="assistant-message assistant-message--user">
              <p>{submittedMessage.content}</p>
            </article>}

            {isSending && <article className="assistant-message assistant-message--assistant assistant-message--thinking">
              <span className="assistant-thinking" role="status">
                <span className="assistant-thinking-bars" aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className="assistant-thinking-label">{t('llm.responding')}</span>
              </span>
            </article>}

            {unattachedProposals.map(renderProposal)}
          </div>
        </div>

        <form
          className="assistant-composer"
          onSubmit={event => {
            event.preventDefault();
            void sendMessage();
          }}
        >
          <div className="assistant-composer-box">
            <textarea
              autoFocus
              aria-label={t('llm.message')}
              rows={1}
              value={content}
              placeholder={t('llm.placeholder')}
              disabled={isSending}
              onChange={event => setContent(event.currentTarget.value)}
              onKeyDown={handleComposerKeyDown}
            />
            <button
              type="submit"
              className="assistant-send"
              disabled={!content.trim() || isSending}
              aria-label={t('llm.send')}
            >
              <Icons.Magic size={20} />
            </button>
          </div>
          <span className="assistant-composer-hint">{t('llm.composerHint')}</span>
        </form>
      </section>
    </div>

    {previewTarget && (
      <ProjectFilePreviewModal
        key={`${previewTarget.projectId}:${previewTarget.fileId}`}
        target={previewTarget}
        onClose={closeFilePreview}
      />
    )}
  </>;
}
