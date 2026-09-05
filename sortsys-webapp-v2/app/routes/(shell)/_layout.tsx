import { Content, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderMenuButton, HeaderName, SideNav, SideNavDivider, SideNavItem, SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem, SkipToContent } from "@sortsys/react-components";
import type { ComponentProps, ReactNode } from "react";
import React, { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Authenticated } from "~/components/Authenticated";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { useDimensions } from "~/hooks/useDimensions";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
import { uiText, useI18n } from "~/lib/i18n";
import { nowrap } from "~/lib/primitives";
import type { PromiseOr } from "~/type-helpers";
import { useUserActions, type UserAction } from "~/lib/userActions";
import { showCommandPaletteModal } from "~/modals/commandPalette";


const MySideNavMenu = function(_props: ComponentProps<typeof SideNavMenu>) {
  const { children, ...props } = _props;

  const _children = React.Children.toArray(children).filter(React.isValidElement);
  if (!_children.length) return;

  return <SideNavMenu {...props}>{children}</SideNavMenu>
}

const MySideNavAction = function(props: {
  title: ReactNode;
  icon: React.ComponentType;
  action: () => PromiseOr<void>;
}) {
  return <SideNavLink renderIcon={props.icon} onClick={props.action} className="cursor-pointer">
    {props.title}
  </SideNavLink>
}

export default Authenticated(function() {
  const sessionInfo = useSessionInfo();
  const { locale, t } = useI18n();
  const isAdmin = sessionInfo.isAdmin();

  const location = useLocation();
  const path = location.pathname;
  const modals = useMyModals();
  const { visibleActions, runAction, llmStatus } = useUserActions();
  const lastVisitKeyRef = useRef<string | null>(null);
  const canViewProjects = sessionInfo.canDo('view:projects');
  const canViewTools = sessionInfo.canDo('view:tools');
  const canViewUsers = sessionInfo.canDo('view:users');
  const canViewProducts = sessionInfo.canDo('view:products') || sessionInfo.canDo('view:deliveryNotes') || sessionInfo.canDo('view:productVendors');
  const canViewCustomers = sessionInfo.canDo('view:customers');
  const canViewContacts = sessionInfo.canDo('view:contacts');
  const canViewToolInventories = sessionInfo.canDo('view:toolInventories');
  const canViewDeployments = sessionInfo.canDo('view:projectDeployments');
  const canViewVacations = sessionInfo.canDo('view:userVacations') || sessionInfo.canDo('manage:userVacations');
  const canViewClientScripts = sessionInfo.canDo('view:clientScripts');
  const canUseLlm = sessionInfo.canDo(':llm') && llmStatus?.tenantEnabled === true;
  const canSeeOrganisation = isAdmin;
  const workActions = visibleActions.filter(action => action.group === 'work');
  const createActions = visibleActions.filter(action => action.group === 'create');
  const adminActions = visibleActions.filter(action => action.group === 'admin');

  const { width } = useDimensions();
  const isSmall = width <= 1000;
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(!isSmall);

  useEffect(() => setIsSideNavExpanded(!isSmall), [isSmall]);

  useEffect(() => {
    if (!isSmall || !isSideNavExpanded) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSideNavExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [isSideNavExpanded, isSmall]);

  const closeOnNavigate = () => {
    if (isSmall) setIsSideNavExpanded(false);
  };
  const isPathActive = (href: string) => path === href || path.startsWith(`${href}/`);

  useShortcut('Control+k', e => {
    e.preventDefault();
    showCommandPaletteModal(modals);
  });

  useShortcut('Control+n', e => {
    const actionIdByPath: Record<string, string> = {
      '/projects': 'projects.create',
      '/tools': 'tools.create',
      '/products': 'products.create',
      '/products/deliveryNotes': 'deliveryNotes.create',
      '/products/vendors': 'productVendors.create',
      '/users': 'users.create',
      '/customers': 'customers.create',
      '/contacts': 'contacts.create',
    };
    const actionId = actionIdByPath[path]
      ?? (/^\/projects\/[^/]+\/dailyReports\/?$/.test(path) ? 'dailyReports.create' : null)
      ?? (/^\/projects\/[^/]+\/regieReports\/?$/.test(path) ? 'regieReports.create' : null);
    if (!actionId) return;

    const action = visibleActions.find(action => action.id === actionId);
    if (!action) return;

    e.preventDefault();
    void runAction(action);
  });

  useEffect(() => {
    const visitPath = `${location.pathname}${location.search}`;
    if (lastVisitKeyRef.current === visitPath) return;
    lastVisitKeyRef.current = visitPath;

    const timeout = window.setTimeout(() => {
      const title = document.title?.replace(/\s+[-|].*$/, '').trim() || visitPath;
      void client.mutate('personalization.visits.append', {
        path: visitPath,
        title,
      });
    }, 250);

    return () => window.clearTimeout(timeout);
  }, [location.pathname, location.search]);

  const MySideNavLink = function(props: {
    title: ReactNode;
    href: string;
    icon: React.ComponentType;
  }) {
    return <SideNavLink as={Link} to={props.href} renderIcon={props.icon} isActive={isPathActive(props.href)} onClick={closeOnNavigate}>
      {props.title}
    </SideNavLink>
  }

  const MySideNavUserAction = function({ action, title }: { action: UserAction; title?: ReactNode }) {
    return <MySideNavAction
      icon={action.icon}
      title={title ?? action.label}
      action={async () => {
        closeOnNavigate();
        await runAction(action);
      }}
    />;
  }

  return <div data-small={isSmall.toString()}>
    <Header>
      <SkipToContent />

      {isSmall && (
        <HeaderMenuButton
          aria-label={isSideNavExpanded ? t("shell.closeMenu") : t("shell.openMenu")}
          isActive={isSideNavExpanded}
          onClick={() => setIsSideNavExpanded((v) => !v)}
        />
      )}

      <HeaderName as={Link} prefix="" to="/" className={nowrap()} style={{ padding: '0 8px' }}>
        <div className={nowrap()}>
          {sessionInfo.tenant?.companyName}
        </div>
      </HeaderName>

      <HeaderGlobalBar>
        <HeaderGlobalAction
          aria-label={t("shell.search")}
          title={`${t("shell.search")} (Ctrl+K)`}
          onClick={() => showCommandPaletteModal(modals)}
        >
          <Icons.Search />
        </HeaderGlobalAction>
      </HeaderGlobalBar>
    </Header>

    <SideNav
      expanded={isSideNavExpanded}
      aria-hidden={isSmall && !isSideNavExpanded ? true : undefined}
      inert={isSmall && !isSideNavExpanded ? true : undefined}
      onOverlayClick={() => setIsSideNavExpanded(false)}
    >
      <SideNavItems aria-label={t("shell.mainNavigation")}>
        <MySideNavLink icon={Icons.Dashboard} href="/dashboard" title={t("shell.dashboard")} />
        {canUseLlm && <MySideNavLink icon={Icons.Magic} href="/llm" title={uiText("LLM")} />}

        {!!workActions.length && <MySideNavMenu title={t("shell.captureWork")} renderIcon={Icons.Create} defaultExpanded>
          {workActions.map(action => <MySideNavUserAction key={action.id} action={action} />)}
        </MySideNavMenu>}

        {!!createActions.length && <MySideNavMenu title={t("shell.createMasterData")} renderIcon={Icons.Plus} defaultExpanded={false}>
          {createActions.map(action => <MySideNavUserAction key={action.id} action={action} title={locale === "de" ? action.label.replace(/ erstellen$/, "") : action.label} />)}
        </MySideNavMenu>}

        <SideNavDivider />

        <MySideNavMenu title={t("shell.projectWork")} renderIcon={Icons.Project} defaultExpanded={isPathActive('/projects') || isPathActive('/deployments') || isPathActive('/vacations')}>
          {canViewProjects && <MySideNavLink icon={Icons.Project} href="/projects" title={t("shell.projects")} />}
          {canViewDeployments && <MySideNavLink icon={Icons.DailyReport} href="/deployments" title={t("shell.deployments")} />}
          {canViewVacations && <MySideNavLink icon={Icons.User} href="/vacations" title={t("shell.vacations")} />}
        </MySideNavMenu>

        <MySideNavMenu title={t("shell.materialTools")} renderIcon={Icons.Tool} defaultExpanded={isPathActive('/tools') || isPathActive('/inventories') || isPathActive('/products')}>
          {canViewTools && <MySideNavLink icon={Icons.Tool} href="/tools" title={t("shell.tools")} />}
          {canViewToolInventories && <MySideNavLink icon={Icons.ToolInventory} href="/inventories" title={t("shell.inventory")} />}
          {canViewProducts && <MySideNavLink icon={Icons.Product} href="/products" title={t("shell.productsDeliveryNotes")} />}
        </MySideNavMenu>

        <MySideNavMenu title={t("shell.usersContacts")} renderIcon={Icons.Customer} defaultExpanded={isPathActive('/customers') || isPathActive('/contacts') || isPathActive('/users')}>
          {canViewCustomers && <MySideNavLink icon={Icons.Customer} href="/customers" title={t("shell.customers")} />}
          {canViewContacts && <MySideNavLink icon={Icons.Contact} href="/contacts" title={t("shell.contacts")} />}
          {canViewUsers && <MySideNavLink icon={Icons.User} href="/users" title={t("shell.users")} />}
        </MySideNavMenu>

        {(!!adminActions.length || canSeeOrganisation || canViewClientScripts) && <MySideNavMenu title={t("shell.administration")} renderIcon={Icons.Info} defaultExpanded={isPathActive('/scripts') || isPathActive('/admin')}>
          {adminActions.map(action => <MySideNavUserAction key={action.id} action={action} />)}
          {canViewClientScripts && <MySideNavLink icon={Icons.Script} href="/scripts" title={t("shell.clientScripts")} />}
          {canSeeOrganisation && <MySideNavLink icon={Icons.Info} href="/admin" title={t("shell.organization")} />}
        </MySideNavMenu>}

        <SideNavDivider />

        <MySideNavLink icon={Icons.Settings} href="/settings" title={t("shell.settings")} />
        <MySideNavLink icon={Icons.Info} href="/docs" title={t("shell.help")} />

        <SideNavDivider />

        <MySideNavAction icon={Icons.Logout} title={t("shell.logout")} action={() => client.logout()} />
      </SideNavItems>
    </SideNav>

    <Content className={'main-container' + (path.startsWith('/llm') ? ' main-container--llm' : '')}>
      <ScopedErrorBoundary scope="application.content" resetKey={`${location.pathname}${location.search}`}>
        <Outlet />
      </ScopedErrorBoundary>
    </Content>
  </div>
})
