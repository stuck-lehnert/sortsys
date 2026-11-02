import { Input, TextField } from "@heroui/react";
import { LoadMore, Loading } from "@sortsys/react-components";
import type { QueryResult } from "@sortsys/v2-client";
import { useEffect, useId, useState } from "react";
import { Link } from "react-router";
import { useRowWindow } from "~/hooks/useRowWindow";
import { client } from "~/lib/client";
import { useI18n } from "~/lib/i18n";
import { Icons } from "~/lib/icons";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type ChatSummary = QueryResult<"llm.chats.list">[number];
type HistoryState = {
  chats: ChatSummary[] | null;
  error: { message: string } | null;
};

function useChatHistory() {
  const [state, setState] = useState<HistoryState>({
    chats: null,
    error: null,
  });

  useEffect(() => {
    let generation = 0;
    let disposed = false;
    let subscription: { unsubscribe(): void } | undefined;

    function subscribe() {
      const currentGeneration = ++generation;
      subscription?.unsubscribe();
      setState({ chats: null, error: null });

      if (!client.loggedIn()) {
        return;
      }

      subscription = client
        .streamQuery("llm.chats.list", undefined, { strategy: "network-first" })
        .subscribe(([chats, error]) => {
          if (disposed || currentGeneration !== generation) {
            return;
          }

          setState((previous) => ({
            chats: chats ?? (error ? previous.chats : null),
            error,
          }));
        });
    }

    const stopListening = client.listenAuthState(subscribe);
    subscribe();

    return () => {
      disposed = true;
      generation += 1;
      subscription?.unsubscribe();
      stopListening();
    };
  }, []);

  function reload() {
    setState((previous) => ({ ...previous, error: null }));
    void client.invalidate("llm.chats.list");
  }

  return { ...state, reload };
}

export function LlmChatHistory({
  selectedId = null,
  onNewChat,
  newChatDisabled = false,
}: {
  selectedId?: string | null;
  onNewChat: () => void;
  newChatDisabled?: boolean;
}) {
  const { localeTag, t } = useI18n();
  const { chats, error, reload } = useChatHistory();
  const [search, setSearch] = useState({ value: "", revision: 0 });
  const listId = useId();
  const query = search.value.trim().toLocaleLowerCase(localeTag);
  const matches = (chats ?? []).filter((chat) =>
    chat.title.toLocaleLowerCase(localeTag).includes(query),
  );
  const { visibleCount, showMore } = useRowWindow(
    matches.map((chat) => chat.id),
    25,
    `${search.revision}:${query}`,
  );

  return (
    <nav
      aria-label={t("llm.chats")}
      className="flex h-full min-h-0 flex-col gap-3"
    >
      <MyButton
        kind="secondary"
        size="sm"
        renderIcon={Icons.Create}
        disabled={newChatDisabled}
        onClick={onNewChat}
        className="w-full shrink-0"
      >
        {t("llm.newChat")}
      </MyButton>

      <TextField
        aria-label={t("llm.searchChats")}
        variant="secondary"
        value={search.value}
        onChange={(value) => {
          setSearch((previous) => ({
            value,
            revision: previous.revision + 1,
          }));
        }}
        className="min-w-0 shrink-0"
      >
        <Input type="search" placeholder={t("llm.searchChats")} />
      </TextField>

      <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
        {!!error && (
          <div className="space-y-2">
            <MyCallout icon={Icons.Deny} color="red">
              {error.message}
            </MyCallout>
            <MyButton kind="secondary" size="sm" onClick={reload}>
              {t("llm.reloadChats")}
            </MyButton>
          </div>
        )}

        {!chats && !error && (
          <Loading active small description={t("common.loading")} />
        )}

        {matches.length > 0 && (
          <ul id={listId} className="space-y-1">
            {matches.slice(0, visibleCount).map((chat) => (
              <li key={chat.id}>
                <Link
                  to={`/llm/${encodeURIComponent(chat.id)}`}
                  aria-current={chat.id === selectedId ? "page" : undefined}
                  title={chat.title}
                  style={{
                    // Keep blue links readable at the shared 70% hover opacity.
                    color:
                      "color-mix(in srgb, var(--accent) 35%, var(--foreground))",
                  }}
                  className={[
                    "block min-h-11 min-w-0 rounded-xl px-3 py-2 text-accent",
                    "hover:bg-default focus-visible:outline-2",
                    "focus-visible:outline-offset-2 focus-visible:outline-focus",
                    chat.id === selectedId ? "bg-accent-soft" : "",
                  ].join(" ")}
                >
                  <span className="block truncate text-sm font-medium">
                    {chat.title}
                  </span>
                  <time
                    dateTime={chat.updatedAt.toISOString()}
                    className="block text-xs"
                  >
                    {chat.updatedAt.toLocaleDateString(localeTag, {
                      dateStyle: "medium",
                    })}
                  </time>
                </Link>
              </li>
            ))}
          </ul>
        )}

        {matches.length > 25 && (
          <LoadMore
            visibleItems={visibleCount}
            totalItems={matches.length}
            onLoadMore={showMore}
            controls={listId}
            className="gap-2 [&>p]:text-xs"
          />
        )}

        {!!chats && !error && matches.length === 0 && (
          <p role="status" className="px-3 py-2 text-sm text-muted">
            {chats.length === 0 ? t("llm.noChats") : t("llm.noMatchingChats")}
          </p>
        )}
      </div>
    </nav>
  );
}
