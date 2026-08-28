import { uiText } from "~/lib/i18n";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import { useMyModals, type MyModalsInterface } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { Icons, type Icon } from "~/lib/icons";
import { showManageCommonCostsModal } from "~/modals/commonCosts";
import { showCreateContactModal } from "~/modals/contacts";
import { showCreateCustomerModal } from "~/modals/customers";
import { showCreateDailyProjectReportModal, showCreateWeeklyDailyProjectReportModal } from "~/modals/dailyProjectReport";
import { showCreateDeliveryNoteModal } from "~/modals/deliveryNotes";
import { showCreateProductModal } from "~/modals/products";
import { showCreateProductVendorModal } from "~/modals/productVendors";
import { showCreateProjectModal } from "~/modals/projects";
import { showCreateRegieReportModal } from "~/modals/regieReports";
import { showCreateToolModal, showTrackToolsModal } from "~/modals/tools";
import { showCreateUserModal } from "~/modals/users";
import type { Role } from "~/type-helpers";

export type UserActionGroup = 'work' | 'create' | 'navigate' | 'admin';

export type UserAction = {
  id: string;
  label: string;
  description: string;
  group: UserActionGroup;
  icon: Icon;
  requiredRole?: Role;
  requiredRoles?: Role[];
  href?: string;
  run: () => void | Promise<void>;
};

export function useUserActions(modalsOverride?: MyModalsInterface) {
  const sessionInfo = useSessionInfo();
  const contextModals = useMyModals();
  const modals = modalsOverride ?? contextModals;
  const navigate = useNavigate();

  const actions = useMemo<UserAction[]>(() => [
    {
      id: 'tools.track',
      label: uiText("Werkzeuge einbuchen"),
      description: uiText("Werkzeuge ausgeben, zurücknehmen oder umbuchen."),
      group: 'work',
      icon: Icons.Track,
      requiredRole: 'manage:toolTrackings',
      run: () => showTrackToolsModal(modals, {}),
    },
    {
      id: 'deliveryNotes.create',
      label: uiText("Lieferschein erfassen"),
      description: uiText("Materiallieferung für Projekt dokumentieren."),
      group: 'work',
      icon: Icons.DeliveryNote,
      requiredRole: 'manage:deliveryNotes',
      run: () => showCreateDeliveryNoteModal(modals),
    },
    {
      id: 'dailyReports.create',
      label: uiText("Bautagesbericht"),
      description: uiText("Täglichen Baustellenstand mit Zeiten und Wetter erfassen."),
      group: 'work',
      icon: Icons.DailyReport,
      requiredRole: 'manage:dailyProjectReports',
      run: () => showCreateDailyProjectReportModal(modals),
    },
    {
      id: 'dailyReports.weeklyCreate',
      label: uiText("Bauwochenbericht"),
      description: uiText("Mehrere Bautagesberichte für Kalenderwoche erfassen."),
      group: 'work',
      icon: Icons.DailyReport,
      requiredRole: 'manage:dailyProjectReports',
      run: () => showCreateWeeklyDailyProjectReportModal(modals),
    },
    {
      id: 'regieReports.create',
      label: uiText("Regiebericht"),
      description: uiText("Zusatzleistungen mit Zeiten, Material und Sonderpositionen erfassen."),
      group: 'work',
      icon: Icons.RegieReport,
      requiredRole: 'manage:regieReports',
      run: () => showCreateRegieReportModal(modals),
    },
    {
      id: 'projects.create',
      label: uiText("Projekt erstellen"),
      description: uiText("Neues Projekt im Projektstamm anlegen."),
      group: 'create',
      icon: Icons.Project,
      requiredRole: 'manage:projects',
      run: () => showCreateProjectModal(modals),
    },
    {
      id: 'tools.create',
      label: uiText("Werkzeug erstellen"),
      description: uiText("Neues Werkzeug im Werkzeugstamm anlegen."),
      group: 'create',
      icon: Icons.Tool,
      requiredRole: 'manage:tools',
      run: () => showCreateToolModal(modals),
    },
    {
      id: 'products.create',
      label: uiText("Produkt erstellen"),
      description: uiText("Neues Material oder Produkt anlegen."),
      group: 'create',
      icon: Icons.Product,
      requiredRole: 'manage:products',
      run: () => showCreateProductModal(modals),
    },
    {
      id: 'productVendors.create',
      label: uiText("Händler erstellen"),
      description: uiText("Neuen Produkt-Händler anlegen."),
      group: 'create',
      icon: Icons.ProductVendor,
      requiredRole: 'manage:productVendors',
      run: () => showCreateProductVendorModal(modals),
    },
    {
      id: 'users.create',
      label: uiText("Benutzer erstellen"),
      description: uiText("Neues Benutzerkonto anlegen."),
      group: 'create',
      icon: Icons.User,
      requiredRole: 'manage:users',
      run: () => showCreateUserModal(modals),
    },
    {
      id: 'customers.create',
      label: uiText("Kunde erstellen"),
      description: uiText("Neuen Kundenstamm anlegen."),
      group: 'create',
      icon: Icons.Customer,
      requiredRole: 'manage:customers',
      run: () => showCreateCustomerModal(modals),
    },
    {
      id: 'contacts.create',
      label: uiText("Kontakt erstellen"),
      description: uiText("Neue Kontaktperson anlegen."),
      group: 'create',
      icon: Icons.Contact,
      requiredRole: 'manage:contacts',
      run: () => showCreateContactModal(modals),
    },
    {
      id: 'projects.costs.open',
      label: uiText("Kostenübersicht öffnen"),
      description: uiText("Projektkosten, Lieferscheine und Arbeitszeiten prüfen."),
      group: 'navigate',
      icon: Icons.PriceRecord,
      requiredRoles: ['view:projects', 'view:deliveryNotes', 'view:dailyProjectReports'],
      href: '/projects/costs',
      run: () => navigate('/projects/costs'),
    },
    {
      id: 'deployments.open',
      label: uiText("Einsatzplanung öffnen"),
      description: uiText("Projektzuweisungen und Abwesenheiten planen."),
      group: 'navigate',
      icon: Icons.DailyReport,
      requiredRole: 'view:projectDeployments',
      href: '/deployments',
      run: () => navigate('/deployments'),
    },
    {
      id: 'commonCosts.manage',
      label: uiText("Gemeinkosten"),
      description: uiText("Globale Zuschläge und Gemeinkosten bearbeiten."),
      group: 'admin',
      icon: Icons.PriceRecord,
      requiredRole: 'manage:projects',
      run: () => showManageCommonCostsModal(modals),
    },
  ], [modals, navigate]);

  const visibleActions = useMemo(() => actions.filter(action => {
    const requiredRoles = [
      ...(action.requiredRole ? [action.requiredRole] : []),
      ...(action.requiredRoles ?? []),
    ];
    return requiredRoles.every(role => sessionInfo.canDo(role));
  }), [actions, sessionInfo]);

  async function runAction(action: UserAction) {
    void client.mutate('personalization.actions.append', {
      actionId: action.id,
      label: action.label,
      href: action.href ?? undefined,
    }).catch(() => null);

    await action.run();
  }

  return { actions, visibleActions, runAction };
}
