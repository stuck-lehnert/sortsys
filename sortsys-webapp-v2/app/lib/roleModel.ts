import { uiText } from "~/lib/i18n";
import type { Role } from "~/type-helpers";

export type RoleAccessLevel = 'view' | 'manage' | 'delete';

export type RoleArea = {
  key: string;
  label: string;
  description: string;
  roles: Partial<Record<RoleAccessLevel, Role>>;
};

export type RolePreset = {
  id: string;
  label: string;
  description: string;
  roles: Role[];
};

export const ROLE_LEVELS: Array<{ id: RoleAccessLevel; label: string; description: string }> = [
  {
    id: 'view',
    label: uiText("Lesen"),
    description: uiText("sehen, suchen, öffnen. Keine Änderungen."),
  },
  {
    id: 'manage',
    label: uiText("Bearbeiten"),
    description: uiText("anlegen und ändern. Lesen ist enthalten."),
  },
  {
    id: 'delete',
    label: uiText("Löschen"),
    description: uiText("löschen oder endgültig entfernen. Separat vergeben."),
  },
];

export const ROLE_AREAS: RoleArea[] = [
  {
    key: 'projects',
    label: uiText("Projekte"),
    description: uiText("Projektstammdaten, Status, Verantwortliche und Kostenbasis."),
    roles: { view: 'view:projects', manage: 'manage:projects', delete: 'delete:projects' },
  },
  {
    key: 'projectDeployments',
    label: uiText("Einsatzplanung"),
    description: uiText("Benutzer auf Projekte und Zeiträume planen."),
    roles: { view: 'view:projectDeployments', manage: 'manage:projectDeployments', delete: 'delete:projectDeployments' },
  },
  {
    key: 'dailyProjectReports',
    label: uiText("Bautagesberichte"),
    description: uiText("Tagesweise Baustellen-Dokumentation mit Wetter und Arbeitszeiten."),
    roles: { view: 'view:dailyProjectReports', manage: 'manage:dailyProjectReports', delete: 'delete:dailyProjectReports' },
  },
  {
    key: 'regieReports',
    label: uiText("Regieberichte"),
    description: uiText("Regieleistungen mit Arbeitszeit, Material und Sonderpositionen."),
    roles: { view: 'view:regieReports', manage: 'manage:regieReports', delete: 'delete:regieReports' },
  },
  {
    key: 'deliveryNotes',
    label: uiText("Lieferscheine"),
    description: uiText("Materiallieferungen auf Projekte erfassen und prüfen."),
    roles: { view: 'view:deliveryNotes', manage: 'manage:deliveryNotes', delete: 'delete:deliveryNotes' },
  },
  {
    key: 'tools',
    label: uiText("Werkzeuge"),
    description: uiText("Werkzeugstamm, Verfügbarkeit und Stammdaten."),
    roles: { view: 'view:tools', manage: 'manage:tools', delete: 'delete:tools' },
  },
  {
    key: 'toolTrackings',
    label: uiText("Werkzeugbuchungen"),
    description: uiText('Werkzeuge ausgeben, zurücknehmen und umbuchen.', 'Issue, return, and transfer tools.'),
    roles: { view: 'view:toolTrackings', manage: 'manage:toolTrackings', delete: 'delete:toolTrackings' },
  },
  {
    key: 'toolInventories',
    label: uiText("Inventur"),
    description: uiText("Werkzeuginventuren ansehen, anlegen und abschließen."),
    roles: { view: 'view:toolInventories', manage: 'manage:toolInventories', delete: 'delete:toolInventories' },
  },
  {
    key: 'products',
    label: uiText("Produkte"),
    description: uiText("Material- und Produktstamm."),
    roles: { view: 'view:products', manage: 'manage:products', delete: 'delete:products' },
  },
  {
    key: 'productVendors',
    label: uiText("Händler"),
    description: uiText("Lieferanten/Händler für Produkte."),
    roles: { view: 'view:productVendors', manage: 'manage:productVendors', delete: 'delete:productVendors' },
  },
  {
    key: 'productPriceRecords',
    label: uiText("Produktpreise"),
    description: uiText("Historische Produktpreise und Bezugspreise."),
    roles: { view: 'view:productPriceRecords', manage: 'manage:productPriceRecords', delete: 'delete:productPriceRecords' },
  },
  {
    key: 'customers',
    label: uiText("Kunden"),
    description: uiText("Kundenstamm und Kundendaten."),
    roles: { view: 'view:customers', manage: 'manage:customers', delete: 'delete:customers' },
  },
  {
    key: 'contacts',
    label: uiText("Kontakte"),
    description: uiText("Kontaktpersonen, Telefonnummern und E-Mail-Adressen."),
    roles: { view: 'view:contacts', manage: 'manage:contacts', delete: 'delete:contacts' },
  },
  {
    key: 'users',
    label: uiText("Benutzer"),
    description: uiText("Benutzerkonten, Stammdaten, Passwörter und Vorgesetzte."),
    roles: { view: 'view:users', manage: 'manage:users', delete: 'delete:users' },
  },
  {
    key: 'userVacations',
    label: uiText("Urlaub"),
    description: uiText("Urlaube beantragen, einsehen und genehmigen."),
    roles: { view: 'view:userVacations', manage: 'manage:userVacations', delete: 'delete:userVacations' },
  },
  {
    key: 'clientScripts',
    label: uiText("Client-Skripte"),
    description: uiText("Browser-Skripte ansehen, bearbeiten und ausführen."),
    roles: { view: 'view:clientScripts', manage: 'manage:clientScripts', delete: 'delete:clientScripts' },
  },
];

export const ALL_FINE_GRAINED_ROLES: Role[] = [
  ':admin',
  ':llm',
  ...ROLE_AREAS.flatMap(area => ROLE_LEVELS.map(level => area.roles[level.id]).filter(Boolean) as Role[]),
];

const presetRoleAreas = ROLE_AREAS.filter(area => area.key !== 'clientScripts');
const allViewRoles = presetRoleAreas.map(area => area.roles.view).filter(Boolean) as Role[];
const allManageRoles = presetRoleAreas.map(area => area.roles.manage).filter(Boolean) as Role[];

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'admin',
    label: uiText("Administrator"),
    description: uiText("Alle Rechte inklusive Organisation, Rollen und gefährlicher Aktionen."),
    roles: [':admin'],
  },
  {
    id: 'bauleitung',
    label: uiText("Bauleitung"),
    description: uiText("Projekte planen, Berichte erfassen, Lieferscheine prüfen, Kosten sehen."),
    roles: [
      'view:users',
      'view:customers',
      'view:contacts',
      'view:tools',
      'view:products',
      'view:productVendors',
      'view:productPriceRecords',
      'manage:projects',
      'manage:projectDeployments',
      'manage:dailyProjectReports',
      'manage:regieReports',
      'manage:deliveryNotes',
      'manage:userVacations',
    ],
  },
  {
    id: 'buero',
    label: uiText("Büro"),
    description: uiText("Stammdaten pflegen, Material und Berichte erfassen, ohne Löschrechte."),
    roles: [...allManageRoles],
  },
  {
    id: 'lager',
    label: uiText("Lager"),
    description: uiText("Werkzeuge, Inventur, Materialstamm und Lieferscheine bearbeiten."),
    roles: [
      'view:projects',
      'view:users',
      'view:tools',
      'manage:tools',
      'manage:toolTrackings',
      'manage:toolInventories',
      'manage:products',
      'manage:deliveryNotes',
    ],
  },
  {
    id: 'einkauf',
    label: uiText("Einkauf"),
    description: uiText("Produkte, Händler, Preise und Lieferscheine pflegen."),
    roles: [
      'view:projects',
      'view:customers',
      'manage:products',
      'manage:productVendors',
      'manage:productPriceRecords',
      'manage:deliveryNotes',
    ],
  },
  {
    id: 'personal',
    label: uiText("Personal"),
    description: uiText("Benutzer, Vorgesetzte, Einsatzplanung und Urlaub verwalten."),
    roles: [
      'manage:users',
      'manage:userVacations',
      'manage:projectDeployments',
      'view:projects',
    ],
  },
  {
    id: 'lesen',
    label: uiText("Nur Lesen"),
    description: uiText("Alle Bereiche sehen, nichts verändern."),
    roles: allViewRoles,
  },
];
