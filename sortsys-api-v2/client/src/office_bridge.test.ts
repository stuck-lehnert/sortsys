import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const bridgeSource = readFileSync(
  new URL("../../rust-api/src/llm/office_bridge.js", import.meta.url),
  "utf8",
);

class Provider {
  constructor(
    public name = "",
    public url = "",
    public key = "",
    public addon = "",
  ) {}

  createInstance(name: string, url: string, key: string, addon: string) {
    return new Provider(name, url, key, addon);
  }
}

function settings(key: string, url = "https://app.example.test/api/v2/internal/onlyoffice/ai") {
  return {
    providers: { sortsys: { name: "sortsys (openai)", url, key, addon: "v1" } },
    models: [{ id: "sortsys-onlyoffice" }],
  };
}

type Settings = ReturnType<typeof settings>;
type ConfiguredSettings = Settings & {
  providers: { sortsys: Settings["providers"]["sortsys"] & { content: string } };
};

function createBridge(initialSettings?: Settings) {
  const sent: ConfiguredSettings[] = [];
  const events = new Map<string, () => void>();
  const plugin = {
    info: { options: { settings: initialSettings } },
    init: () => {},
    onUpdateOptions: () => {},
    attachEditorEvent: (name: string, listener: () => void) => events.set(name, listener),
    sendEvent: (name: string, value: ConfiguredSettings) => {
      expect(name).toBe("ai_onCustomInit");
      sent.push(value);
      // The vendor plugin prefixes IDs on the event object it receives.
      value.models[0]!.id = `external:${value.models[0]!.id}`;
    },
  };

  runInNewContext(bridgeSource, { window: { Asc: { plugin } }, structuredClone });
  plugin.init();

  return { plugin, sent, events };
}

function configuredProvider(value: ConfiguredSettings) {
  return runInNewContext(
    `(function () { ${value.providers.sortsys.content}; return new Provider(); })()`,
    { AI: { Provider } },
  ) as Provider;
}

test("ONLYOFFICE storage reload cannot restore a logged-out session or another user's gateway", () => {
  const current = settings("current-user-delegation");
  const { sent } = createBridge(current);
  const external = configuredProvider(sent[0]!);

  // Storage.load recreates providers using persisted URL/key arguments, even
  // after ai_onCustomInit has registered a freshly configured provider.
  const restored = external.createInstance(
    external.name,
    "https://previous-environment.example.test",
    "logged-out-user-delegation",
    "old-version",
  );

  expect(restored).toMatchObject(current.providers.sortsys);
  expect(restored.createInstance("old", "old", "old", "old"))
    .toMatchObject(current.providers.sortsys);
});

test("editor initialization and AI restarts do not mutate the original settings", () => {
  const current = settings("current-user-delegation");
  const { sent, events } = createBridge(current);
  events.get("ai_onInit")!();
  events.get("ai_onInit")!();

  expect(sent).toHaveLength(3);
  expect(current.models[0]!.id).toBe("sortsys-onlyoffice");
  expect(current.providers.sortsys).not.toHaveProperty("content");
  for (const value of sent) {
    expect(value.models[0]!.id).toBe("external:sortsys-onlyoffice");
  }
});

test("updated editor options replace the delegation and gateway", () => {
  const { plugin, sent } = createBridge(settings("old-delegation"));
  const updated = settings("new-delegation", "https://new.example.test/gateway");
  plugin.info.options.settings = updated;
  plugin.onUpdateOptions();

  expect(configuredProvider(sent[1]!)).toMatchObject(updated.providers.sortsys);
  expect(configuredProvider(sent[0]!).key).toBe("old-delegation");
});

test("provider arguments are escaped as JavaScript string literals", () => {
  const current = settings('quote" backslash\\ newline\n ${globalThis.compromised = true}');
  current.providers.sortsys.name = 'sortsys "quoted"';
  const { sent } = createBridge(current);

  expect(configuredProvider(sent[0]!)).toMatchObject(current.providers.sortsys);
});

test("editors without AI settings do not configure a provider", () => {
  const { sent, events, plugin } = createBridge();
  events.get("ai_onInit")!();
  plugin.onUpdateOptions();

  expect(sent).toHaveLength(0);
});
