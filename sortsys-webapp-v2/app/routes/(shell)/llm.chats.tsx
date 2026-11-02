import { useNavigate } from "react-router";
import { LlmChatHistory } from "~/components/LlmChatHistory";
import { MyCallout } from "~/components/MyCallout";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { uiText, useI18n } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

export function meta() {
  return [{ title: uiText("Chats", "Chats") }];
}

export default function LlmChatsPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [status, statusError] = useClientStream(
    () =>
      client.streamQuery("llm.status", undefined, {
        strategy: "network-first",
      }),
    [],
  );

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
    <section
      aria-label={t("llm.chats")}
      className="mx-auto flex h-[calc(100dvh-7rem)] w-full max-w-3xl flex-col gap-3 p-3"
    >
      <h1 className="sr-only">{t("llm.chats")}</h1>
      {!!statusError && (
        <MyCallout icon={Icons.Deny} color="red">
          {statusError.message}
        </MyCallout>
      )}
      <div className="min-h-0 flex-1">
        <LlmChatHistory
          onNewChat={() => void navigate("/llm")}
          newChatDisabled={!status?.available}
        />
      </div>
    </section>
  );
}
