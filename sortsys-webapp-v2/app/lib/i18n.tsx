import { EN_UI_TEXT } from "./uiText.en";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type Locale = 'de' | 'en';

let renderedLocale: Locale = 'de';

export function uiText(source: string, english?: string): string {
  const normalized = source.trim().replace(/\s+/g, ' ');
  const translated = renderedLocale === 'en' ? english ?? EN_UI_TEXT[normalized] ?? normalized : normalized;
  const leadingSpace = source.startsWith(' ') ? ' ' : '';
  const trailingSpace = source.endsWith(' ') ? ' ' : '';

  return leadingSpace + translated + trailingSpace;
}

export function hasEnglishUiText(source: string): boolean {
  return Object.hasOwn(EN_UI_TEXT, source);
}

const de = {
  'language.de': 'Deutsch',
  'language.en': 'Englisch',
  'language.label': 'Sprache',
  'language.saved': 'Die Sprache wurde gespeichert.',
  'settings.title': 'Einstellungen',
  'settings.password': 'Passwort',
  'settings.passkeys': 'Passkeys',
  'settings.language': 'Sprache',
  'common.save': 'Speichern',
  'common.loading': 'Lädt …',
  'common.unavailable': 'Nicht verfügbar',
  'common.none': 'Keine',
  'common.notSet': 'Nicht gesetzt',
  'common.yes': 'Ja',
  'common.no': 'Nein',
  'shell.closeMenu': 'Menü schließen',
  'shell.openMenu': 'Menü öffnen',
  'shell.search': 'Befehle und Suche',
  'shell.mainNavigation': 'Hauptnavigation',
  'shell.dashboard': 'Dashboard',
  'shell.captureWork': 'Arbeit erfassen',
  'shell.createMasterData': 'Stammdaten anlegen',
  'shell.projectWork': 'Projektarbeit',
  'shell.projects': 'Projekte',
  'shell.deployments': 'Einsatzplanung',
  'shell.vacations': 'Urlaub',
  'shell.materialTools': 'Material & Werkzeuge',
  'shell.tools': 'Werkzeuge',
  'shell.inventory': 'Inventur',
  'shell.productsDeliveryNotes': 'Produkte & Lieferscheine',
  'shell.usersContacts': 'Benutzer & Kontakte',
  'shell.customers': 'Kunden',
  'shell.contacts': 'Kontakte',
  'shell.users': 'Benutzer',
  'shell.administration': 'Verwaltung',
  'shell.clientScripts': 'Client-Skripte',
  'shell.organization': 'Organisation',
  'shell.settings': 'Einstellungen',
  'shell.help': 'Hilfe & Begriffe',
  'shell.logout': 'Abmelden',
  'llm.chats': 'Chats',
  'llm.newChat': 'Neuer Chat',
  'llm.noChats': 'Noch keine Chats',
  'llm.welcome': 'Wobei kann ich helfen?',
  'llm.you': 'Du',
  'llm.responding': 'Antwort wird erstellt',
  'llm.message': 'Nachricht',
  'llm.placeholder': 'Nachricht an LLM',
  'llm.send': 'Nachricht senden',
  'llm.composerHint': 'Enter zum Senden · Shift + Enter für eine neue Zeile',
  'llm.missingRole': 'Dir fehlt die Rolle :llm.',
  'llm.tenantDisabled': 'LLM ist für diesen Mandanten nicht aktiviert.',
  'llm.providerMissing': 'Der Global Admin hat noch keinen Provider eingerichtet.',
  'proposal.change': 'Änderung',
  'proposal.plannedData': 'Geplante Daten',
  'proposal.proposedData': 'Vorgeschlagene Daten',
  'proposal.appliedData': 'Übernommene Daten',
  'proposal.revision': 'Änderungswunsch',
  'proposal.accept': 'Annehmen',
  'proposal.revise': 'Überarbeiten',
  'proposal.decline': 'Ablehnen',
  'proposal.accepted': 'Änderung übernommen',
  'proposal.declined': 'Änderung abgelehnt',
  'proposal.existingEntry': 'Bestehender Eintrag',
  'proposal.immediately': 'Ab sofort',
  'proposal.openProjectCosts': 'Projektkosten öffnen',
  'proposal.openDailyReports': 'Tagesberichte öffnen',
  'proposal.openDeployments': 'Einsatzplanung öffnen',
  'proposal.openTool': 'Werkzeug öffnen',
  'proposal.openInventory': 'Inventur öffnen',
  'proposal.openVacations': 'Abwesenheiten öffnen',
  'proposal.openProduct': 'Produkt öffnen',
  'proposal.openContact': 'Kontakt öffnen',
  'proposal.openCustomer': 'Kunde öffnen',
  'proposal.openDeliveryNote': 'Lieferschein öffnen',
  'proposal.openProject': 'Projekt öffnen',
  'proposal.openRegieReport': 'Regiebericht öffnen',
} as const;

const en: Record<keyof typeof de, string> = {
  'language.de': 'German',
  'language.en': 'English',
  'language.label': 'Language',
  'language.saved': 'Language saved.',
  'settings.title': 'Settings',
  'settings.password': 'Password',
  'settings.passkeys': 'Passkeys',
  'settings.language': 'Language',
  'common.save': 'Save',
  'common.loading': 'Loading …',
  'common.unavailable': 'Unavailable',
  'common.none': 'None',
  'common.notSet': 'Not set',
  'common.yes': 'Yes',
  'common.no': 'No',
  'shell.closeMenu': 'Close menu',
  'shell.openMenu': 'Open menu',
  'shell.search': 'Commands and search',
  'shell.mainNavigation': 'Main navigation',
  'shell.dashboard': 'Dashboard',
  'shell.captureWork': 'Record work',
  'shell.createMasterData': 'Create master data',
  'shell.projectWork': 'Project work',
  'shell.projects': 'Projects',
  'shell.deployments': 'Resource planning',
  'shell.vacations': 'Leave',
  'shell.materialTools': 'Materials & tools',
  'shell.tools': 'Tools',
  'shell.inventory': 'Inventory',
  'shell.productsDeliveryNotes': 'Products & delivery notes',
  'shell.usersContacts': 'Users & contacts',
  'shell.customers': 'Customers',
  'shell.contacts': 'Contacts',
  'shell.users': 'Users',
  'shell.administration': 'Administration',
  'shell.clientScripts': 'Client scripts',
  'shell.organization': 'Organization',
  'shell.settings': 'Settings',
  'shell.help': 'Help & terms',
  'shell.logout': 'Log out',
  'llm.chats': 'Chats',
  'llm.newChat': 'New chat',
  'llm.noChats': 'No chats yet',
  'llm.welcome': 'How can I help?',
  'llm.you': 'You',
  'llm.responding': 'Preparing a response',
  'llm.message': 'Message',
  'llm.placeholder': 'Message LLM',
  'llm.send': 'Send message',
  'llm.composerHint': 'Enter to send · Shift + Enter for a new line',
  'llm.missingRole': 'You do not have the :llm role.',
  'llm.tenantDisabled': 'LLM is not enabled for this tenant.',
  'llm.providerMissing': 'The global admin has not configured a provider yet.',
  'proposal.change': 'Change',
  'proposal.plannedData': 'Planned data',
  'proposal.proposedData': 'Proposed data',
  'proposal.appliedData': 'Applied data',
  'proposal.revision': 'Requested changes',
  'proposal.accept': 'Accept',
  'proposal.revise': 'Revise',
  'proposal.decline': 'Decline',
  'proposal.accepted': 'Change applied',
  'proposal.declined': 'Change declined',
  'proposal.existingEntry': 'Existing record',
  'proposal.immediately': 'Immediately',
  'proposal.openProjectCosts': 'Open project costs',
  'proposal.openDailyReports': 'Open daily reports',
  'proposal.openDeployments': 'Open resource planning',
  'proposal.openTool': 'Open tool',
  'proposal.openInventory': 'Open inventory',
  'proposal.openVacations': 'Open leave',
  'proposal.openProduct': 'Open product',
  'proposal.openContact': 'Open contact',
  'proposal.openCustomer': 'Open customer',
  'proposal.openDeliveryNote': 'Open delivery note',
  'proposal.openProject': 'Open project',
  'proposal.openRegieReport': 'Open time-and-material report',
};

export type TranslationKey = keyof typeof de;

const catalogs: Record<Locale, Record<TranslationKey, string>> = { de, en };

type I18nContextValue = {
  locale: Locale;
  localeTag: string;
  setLocale: (locale: Locale) => void;
  t: (key: TranslationKey) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function resolveInitialLocale(value: string | null | undefined): Locale {
  return value === 'en' ? 'en' : 'de';
}

export function currentLocaleTag(): string {
  return localeTag(renderedLocale);
}

export function currentLocale(): Locale {
  return renderedLocale;
}

export function localeTag(locale: Locale): string {
  return locale === 'en' ? 'en-GB' : 'de-DE';
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, updateLocale] = useState<Locale>('de');

  useEffect(() => {
    if (typeof document === 'object') document.documentElement.lang = locale;
    if (typeof window === 'object') window.localStorage.removeItem('sortsys:locale');
  }, [locale]);

  const setLocale = useCallback((nextLocale: Locale) => {
    renderedLocale = nextLocale;
    updateLocale(nextLocale);
  }, []);

  const t = useCallback(
    (key: TranslationKey) => catalogs[locale][key],
    [locale],
  );
  const value = useMemo<I18nContextValue>(() => ({
    locale,
    localeTag: localeTag(locale),
    setLocale,
    t,
  }), [locale, setLocale, t]);

  renderedLocale = locale;

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error('useI18n must be used inside I18nProvider');

  return context;
}
