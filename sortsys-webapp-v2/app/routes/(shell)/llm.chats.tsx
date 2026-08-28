import type { QueryResult } from "@sortsys/v2-client";
import { Heading } from "@sortsys/react-components";
import { Link, useNavigate } from "react-router";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { uiText, useI18n } from "~/lib/i18n";

type Chat = QueryResult<'llm.chats.list'>[number];

export function meta() {
  return [
    { title: uiText("LLM") },
  ];
}

function formatUpdatedAt(value: Date, localeTag: string) {
  return value.toLocaleString(localeTag, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export default function LlmChatsPage() {
  const { localeTag, t } = useI18n();
  const navigate = useNavigate();
  const [status, statusError] = useClientStream(
    () => client.streamQuery('llm.status', undefined, { strategy: 'network-first' }),
    [],
  );
  const [chats, chatsError] = useClientStream(
    () => client.streamQuery('llm.chats.list', undefined, { strategy: 'network-first' }),
    [],
  );

  if (status && !status.available) {
    const reason = !status.hasRole
      ? t('llm.missingRole')
      : !status.tenantEnabled
        ? t('llm.tenantDisabled')
        : t('llm.providerMissing');

    return <MyCallout icon={Icons.Info} color="blue">{reason}</MyCallout>;
  }

  return <section className="assistant-chat-list-page">
    <div className="assistant-chat-list-content">
      <header className="assistant-chat-list-header">
        <Heading level={2} noMargin>{t('llm.chats')}</Heading>
        <MyButton
          size="sm"
          renderIcon={Icons.Create}
          onClick={() => void navigate('/llm')}
        >
          {t('llm.newChat')}
        </MyButton>
      </header>

      {!!statusError && <MyCallout icon={Icons.Deny} color="red">
        {statusError.message}
      </MyCallout>}
      {!!chatsError && <MyCallout icon={Icons.Deny} color="red">
        {chatsError.message}
      </MyCallout>}

      <div className="assistant-chat-list">
        {(chats ?? []).map((chat: Chat) => <Link
          key={chat.id}
          to={`/llm/${chat.id}`}
          className="assistant-chat-list-row"
        >
          <strong>{chat.title}</strong>
          <time dateTime={chat.updatedAt.toISOString()}>
            {formatUpdatedAt(chat.updatedAt, localeTag)}
          </time>
        </Link>)}

        {!!chats && chats.length === 0 && <p className="assistant-chat-list-empty">
          {t('llm.noChats')}
        </p>}
      </div>
    </div>
  </section>;
}
