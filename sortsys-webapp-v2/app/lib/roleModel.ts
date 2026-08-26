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
    label: 'Lesen',
    description: 'sehen, suchen, öffnen. Keine Änderungen.',
  },
  {
    id: 'manage',
    label: 'Bearbeiten',
    description: 'anlegen und ändern. Lesen ist enthalten.',
  },
  {
    id: 'delete',
    label: 'Löschen',
    description: 'löschen oder endgültig entfernen. Separat vergeben.',
  },
];

export const ROLE_AREAS: RoleArea[] = [
  {
    key: 'projects',
    label: 'Projekte',
    description: 'Projektstammdaten, Status, Verantwortliche und Kostenbasis.',
    roles: { view: 'view:projects', manage: 'manage:projects', delete: 'delete:projects' },
  },
  {
    key: 'projectDeployments',
    label: 'Einsatzplanung',
    description: 'Benutzer auf Projekte und Zeiträume planen.',
    roles: { view: 'view:projectDeployments', manage: 'manage:projectDeployments', delete: 'delete:projectDeployments' },
  },
  {
    key: 'dailyProjectReports',
    label: 'Bautagesberichte',
    description: 'Tagesweise Baustellen-Dokumentation mit Wetter und Arbeitszeiten.',
    roles: { view: 'view:dailyProjectReports', manage: 'manage:dailyProjectReports', delete: 'delete:dailyProjectReports' },
  },
  {
    key: 'regieReports',
    label: 'Regieberichte',
    description: 'Regieleistungen mit Arbeitszeit, Material und Sonderpositionen.',
    roles: { view: 'view:regieReports', manage: 'manage:regieReports', delete: 'delete:regieReports' },
  },
  {
    key: 'deliveryNotes',
    label: 'Lieferscheine',
    description: 'Materiallieferungen auf Projekte erfassen und prüfen.',
    roles: { view: 'view:deliveryNotes', manage: 'manage:deliveryNotes', delete: 'delete:deliveryNotes' },
  },
  {
    key: 'tools',
    label: 'Werkzeuge',
    description: 'Werkzeugstamm, Verfügbarkeit und Stammdaten.',
    roles: { view: 'view:tools', manage: 'manage:tools', delete: 'delete:tools' },
  },
  {
    key: 'toolTrackings',
    label: 'Werkzeugbuchungen',
    description: 'Werkzeuge ausgeben, zurücknehmen und umbuchen.',
    roles: { view: 'view:toolTrackings', manage: 'manage:toolTrackings', delete: 'delete:toolTrackings' },
  },
  {
    key: 'toolInventories',
    label: 'Inventur',
    description: 'Werkzeuginventuren ansehen, anlegen und abschließen.',
    roles: { view: 'view:toolInventories', manage: 'manage:toolInventories', delete: 'delete:toolInventories' },
  },
  {
    key: 'products',
    label: 'Produkte',
    description: 'Material- und Produktstamm.',
    roles: { view: 'view:products', manage: 'manage:products', delete: 'delete:products' },
  },
  {
    key: 'productVendors',
    label: 'Händler',
    description: 'Lieferanten/Händler für Produkte.',
    roles: { view: 'view:productVendors', manage: 'manage:productVendors', delete: 'delete:productVendors' },
  },
  {
    key: 'productPriceRecords',
    label: 'Produktpreise',
    description: 'Historische Produktpreise und Bezugspreise.',
    roles: { view: 'view:productPriceRecords', manage: 'manage:productPriceRecords', delete: 'delete:productPriceRecords' },
  },
  {
    key: 'customers',
    label: 'Kunden',
    description: 'Kundenstamm und Kundendaten.',
    roles: { view: 'view:customers', manage: 'manage:customers', delete: 'delete:customers' },
  },
  {
    key: 'contacts',
    label: 'Kontakte',
    description: 'Kontaktpersonen, Telefonnummern und E-Mail-Adressen.',
    roles: { view: 'view:contacts', manage: 'manage:contacts', delete: 'delete:contacts' },
  },
  {
    key: 'users',
    label: 'Benutzer',
    description: 'Benutzerkonten, Stammdaten, Passwörter und Vorgesetzte.',
    roles: { view: 'view:users', manage: 'manage:users', delete: 'delete:users' },
  },
  {
    key: 'userVacations',
    label: 'Urlaub',
    description: 'Urlaube beantragen, einsehen und genehmigen.',
    roles: { view: 'view:userVacations', manage: 'manage:userVacations', delete: 'delete:userVacations' },
  },
  {
    key: 'clientScripts',
    label: 'Client-Skripte',
    description: 'Browser-Skripte ansehen, bearbeiten und ausführen.',
    roles: { view: 'view:clientScripts', manage: 'manage:clientScripts', delete: 'delete:clientScripts' },
  },
];

export const ALL_FINE_GRAINED_ROLES: Role[] = [
  ':admin',
  ...ROLE_AREAS.flatMap(area => ROLE_LEVELS.map(level => area.roles[level.id]).filter(Boolean) as Role[]),
];

const presetRoleAreas = ROLE_AREAS.filter(area => area.key !== 'clientScripts');
const allViewRoles = presetRoleAreas.map(area => area.roles.view).filter(Boolean) as Role[];
const allManageRoles = presetRoleAreas.map(area => area.roles.manage).filter(Boolean) as Role[];

export const ROLE_PRESETS: RolePreset[] = [
  {
    id: 'admin',
    label: 'Administrator',
    description: 'Alle Rechte inklusive Organisation, Rollen und gefährlicher Aktionen.',
    roles: [':admin'],
  },
  {
    id: 'bauleitung',
    label: 'Bauleitung',
    description: 'Projekte planen, Berichte erfassen, Lieferscheine prüfen, Kosten sehen.',
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
    label: 'Büro',
    description: 'Stammdaten pflegen, Material und Berichte erfassen, ohne Löschrechte.',
    roles: [...allManageRoles],
  },
  {
    id: 'lager',
    label: 'Lager',
    description: 'Werkzeuge, Inventur, Materialstamm und Lieferscheine bearbeiten.',
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
    label: 'Einkauf',
    description: 'Produkte, Händler, Preise und Lieferscheine pflegen.',
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
    label: 'Personal',
    description: 'Benutzer, Vorgesetzte, Einsatzplanung und Urlaub verwalten.',
    roles: [
      'manage:users',
      'manage:userVacations',
      'manage:projectDeployments',
      'view:projects',
    ],
  },
  {
    id: 'lesen',
    label: 'Nur Lesen',
    description: 'Alle Bereiche sehen, nichts verändern.',
    roles: allViewRoles,
  },
];
