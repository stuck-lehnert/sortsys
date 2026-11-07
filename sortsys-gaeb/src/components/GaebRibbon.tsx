import { useState, type ReactNode } from "react";
import { Tabs, TabList, Tab, TabPanel } from "react-aria-components";
import ChevronUp from "@carbon/icons-react/es/ChevronUp";
import ChevronDown from "@carbon/icons-react/es/ChevronDown";
import { EditorIconButton } from "./EditorIconButton";
import { text, type GaebLocale } from "../messages";

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="gaeb-ribbon-group" role="group" aria-label={label}>
      <div className="gaeb-ribbon-group-controls">{children}</div>
    </div>
  );
}

export function GaebRibbon(props: {
  locale: GaebLocale;
  collapsed: boolean;
  onCollapsedChange: (collapsed: boolean) => void;
  workflow?: ReactNode;
  history: ReactNode;
  formatting: ReactNode;
  position: ReactNode;
  section: ReactNode;
  paragraph: ReactNode;
  takeoff?: ReactNode;
  measurementMode?: boolean;
  attachments?: ReactNode;
  navigation: ReactNode;
  fields: ReactNode;
  quick: ReactNode;
  presence: ReactNode;
}) {
  const [selected, setSelected] = useState<string>("home");
  const collapsed = props.collapsed;
  const setCollapsed = props.onCollapsedChange;
  const t = (de: string, en: string) => text(props.locale, de, en);
  return (
    <header className="gaeb-toolbar gaeb-office-ribbon">
      <Tabs
        selectedKey={selected}
        onSelectionChange={(key) => {
          setSelected(String(key));
          setCollapsed(false);
        }}
      >
        <div className="gaeb-ribbon-top">
          <TabList
            aria-label={t("Menüband", "Ribbon")}
            className="gaeb-ribbon-tabs"
          >
            {[
              ["home", t("Start", "Home")],
              ["insert", t("Einfügen", "Insert")],
              ["view", t("Ansicht", "View")],
            ].map(([id, label]) => (
              <Tab
                key={id}
                id={id}
                className="gaeb-ribbon-tab"
                onPress={() => setCollapsed(false)}
              >
                {label}
              </Tab>
            ))}
          </TabList>
          <div className="gaeb-ribbon-quick">
            {props.presence}
            {props.quick}
            <EditorIconButton
              label={
                collapsed
                  ? t("Menüband ausklappen", "Expand ribbon")
                  : t("Menüband einklappen", "Collapse ribbon")
              }
              icon={collapsed ? ChevronDown : ChevronUp}
              aria-expanded={!collapsed}
              onClick={() => setCollapsed(!collapsed)}
            />
          </div>
        </div>
        <div className="gaeb-ribbon-content" hidden={collapsed}>
          <TabPanel id="home" className="gaeb-ribbon-panel">
            {props.workflow && (
              <Group label={t("Vorgang", "Workflow")}>{props.workflow}</Group>
            )}
            <Group label={t("Bearbeiten", "Editing")}>{props.history}</Group>
            {props.measurementMode && props.takeoff && (
              <Group label={t("Aufmaß", "Measurement")}>{props.takeoff}</Group>
            )}
            {!props.measurementMode && (
              <>
                <Group label={t("Schrift", "Font")}>{props.formatting}</Group>
                <Group label={t("Absatz", "Paragraph")}>
                  {props.paragraph}
                </Group>
                <Group label={t("Positionen", "Items")}>
                  {props.position}
                  {props.navigation}
                </Group>
                {props.takeoff && (
                  <Group label={t("Aufmaß", "Measurement")}>
                    {props.takeoff}
                  </Group>
                )}
              </>
            )}
          </TabPanel>
          <TabPanel id="insert" className="gaeb-ribbon-panel">
            {!props.measurementMode && (
              <>
                <Group label={t("Gliederung", "Outline")}>
                  {props.position}
                  {props.section}
                </Group>
                <Group label={t("Text", "Text")}>{props.paragraph}</Group>
              </>
            )}
            {props.takeoff && (
              <Group
                label={t("Aufmaß und Anlagen", "Measurement and attachments")}
              >
                {props.takeoff}
              </Group>
            )}
            {props.attachments && (
              <Group label={t("Anlagen", "Attachments")}>
                {props.attachments}
              </Group>
            )}
          </TabPanel>
          <TabPanel id="view" className="gaeb-ribbon-panel">
            <Group label={t("Navigation", "Navigation")}>
              {props.navigation}
            </Group>
            <Group label={t("Darstellung", "Display")}>{props.fields}</Group>
          </TabPanel>
        </div>
      </Tabs>
    </header>
  );
}
