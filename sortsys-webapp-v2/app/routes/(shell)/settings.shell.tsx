import { Tabs as HeroTabs } from "@heroui/react";
import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate } from "react-router";
import { MyHeader } from "~/components/MyHeader";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { useI18n } from "~/lib/i18n";

export default function SettingsShell() {
  const { t } = useI18n();
  const path = useLocation().pathname;
  const navigate = useNavigate();
  const tabs = [
    { path: "/settings", label: t("settings.password") },
    { path: "/settings/passkeys", label: t("settings.passkeys") },
    { path: "/settings/language", label: t("settings.language") },
  ];
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.path === path),
  );

  return (
    <div className="settings-page mx-auto w-full max-w-4xl space-y-6">
      <MyHeader title={t("settings.title")} />

      <Tabs
        selectedIndex={selectedIndex}
        onChange={({ selectedIndex }: { selectedIndex: number }) => {
          const tab = tabs[selectedIndex];
          if (!tab || tab.path === path) return;

          navigate(tab.path);
        }}
      >
        <TabList>
          {tabs.map((tab) => (
            <Tab key={tab.path}>{tab.label}</Tab>
          ))}
        </TabList>
        <HeroTabs.Panel
          key={selectedIndex}
          id={String(selectedIndex)}
          className="pt-6"
        >
          <ScopedErrorBoundary scope="settings.content" resetKey={path}>
            <Outlet />
          </ScopedErrorBoundary>
        </HeroTabs.Panel>
      </Tabs>
    </div>
  );
}
