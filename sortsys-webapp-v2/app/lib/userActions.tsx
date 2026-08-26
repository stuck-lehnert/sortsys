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
      label: 'Werkzeuge einbuchen',
      description: 'Werkzeuge ausgeben, zurücknehmen oder umbuchen.',
      group: 'work',
      icon: Icons.Track,
      requiredRole: 'manage:toolTrackings',
      run: () => showTrackToolsModal(modals, {}),
    },
    {
      id: 'deliveryNotes.create',
      label: 'Lieferschein erfassen',
      description: 'Materiallieferung für Projekt dokumentieren.',
      group: 'work',
      icon: Icons.DeliveryNote,
      requiredRole: 'manage:deliveryNotes',
      run: () => showCreateDeliveryNoteModal(modals),
    },
    {
      id: 'dailyReports.create',
      label: 'Bautagesbericht',
      description: 'Täglichen Baustellenstand mit Zeiten und Wetter erfassen.',
      group: 'work',
      icon: Icons.DailyReport,
      requiredRole: 'manage:dailyProjectReports',
      run: () => showCreateDailyProjectReportModal(modals),
    },
    {
      id: 'dailyReports.weeklyCreate',
      label: 'Bauwochenbericht',
      description: 'Mehrere Bautagesberichte für Kalenderwoche erfassen.',
      group: 'work',
      icon: Icons.DailyReport,
      requiredRole: 'manage:dailyProjectReports',
      run: () => showCreateWeeklyDailyProjectReportModal(modals),
    },
    {
      id: 'regieReports.create',
      label: 'Regiebericht',
      description: 'Zusatzleistungen mit Zeiten, Material und Sonderpositionen erfassen.',
      group: 'work',
      icon: Icons.RegieReport,
      requiredRole: 'manage:regieReports',
      run: () => showCreateRegieReportModal(modals),
    },
    {
      id: 'projects.create',
      label: 'Projekt erstellen',
      description: 'Neues Projekt im Projektstamm anlegen.',
      group: 'create',
      icon: Icons.Project,
      requiredRole: 'manage:projects',
      run: () => showCreateProjectModal(modals),
    },
    {
      id: 'tools.create',
      label: 'Werkzeug erstellen',
      description: 'Neues Werkzeug im Werkzeugstamm anlegen.',
      group: 'create',
      icon: Icons.Tool,
      requiredRole: 'manage:tools',
      run: () => showCreateToolModal(modals),
    },
    {
      id: 'products.create',
      label: 'Produkt erstellen',
      description: 'Neues Material oder Produkt anlegen.',
      group: 'create',
      icon: Icons.Product,
      requiredRole: 'manage:products',
      run: () => showCreateProductModal(modals),
    },
    {
      id: 'productVendors.create',
      label: 'Händler erstellen',
      description: 'Neuen Produkt-Händler anlegen.',
      group: 'create',
      icon: Icons.ProductVendor,
      requiredRole: 'manage:productVendors',
      run: () => showCreateProductVendorModal(modals),
    },
    {
      id: 'users.create',
      label: 'Benutzer erstellen',
      description: 'Neues Benutzerkonto anlegen.',
      group: 'create',
      icon: Icons.User,
      requiredRole: 'manage:users',
      run: () => showCreateUserModal(modals),
    },
    {
      id: 'customers.create',
      label: 'Kunde erstellen',
      description: 'Neuen Kundenstamm anlegen.',
      group: 'create',
      icon: Icons.Customer,
      requiredRole: 'manage:customers',
      run: () => showCreateCustomerModal(modals),
    },
    {
      id: 'contacts.create',
      label: 'Kontakt erstellen',
      description: 'Neue Kontaktperson anlegen.',
      group: 'create',
      icon: Icons.Contact,
      requiredRole: 'manage:contacts',
      run: () => showCreateContactModal(modals),
    },
    {
      id: 'projects.costs.open',
      label: 'Kostenübersicht öffnen',
      description: 'Projektkosten, Lieferscheine und Arbeitszeiten prüfen.',
      group: 'navigate',
      icon: Icons.PriceRecord,
      requiredRoles: ['view:projects', 'view:deliveryNotes', 'view:dailyProjectReports'],
      href: '/projects/costs',
      run: () => navigate('/projects/costs'),
    },
    {
      id: 'deployments.open',
      label: 'Einsatzplanung öffnen',
      description: 'Projektzuweisungen und Abwesenheiten planen.',
      group: 'navigate',
      icon: Icons.DailyReport,
      requiredRole: 'view:projectDeployments',
      href: '/deployments',
      run: () => navigate('/deployments'),
    },
    {
      id: 'commonCosts.manage',
      label: 'Gemeinkosten',
      description: 'Globale Zuschläge und Gemeinkosten bearbeiten.',
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
