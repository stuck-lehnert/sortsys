import { Content, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderMenuButton, HeaderName, SideNav, SideNavDivider, SideNavItem, SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem, SkipToContent } from "@sortsys/react-components";
import type { ComponentProps, ReactNode } from "react";
import React, { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";
import { Authenticated } from "~/components/Authenticated";
import { useDimensions } from "~/hooks/useDimensions";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { client } from "~/lib/client";
import { Icons } from "~/lib/icons";
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
  const isAdmin = sessionInfo.isAdmin();

  const location = useLocation();
  const path = location.pathname;
  const modals = useMyModals();
  const { visibleActions, runAction } = useUserActions();
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
  const canSeeOrganisation = isAdmin;
  const workActions = visibleActions.filter(action => action.group === 'work');
  const createActions = visibleActions.filter(action => action.group === 'create');
  const adminActions = visibleActions.filter(action => action.group === 'admin');

  const { width, height } = useDimensions();

  const isSmall = width < 1100;
  const [isSideNavExpanded, setIsSideNavExpanded] = useState(!isSmall);

  useEffect(() => setIsSideNavExpanded(!isSmall), [isSmall]);
  const closeOnNavigate = () => {
    if (isSmall) setIsSideNavExpanded(false);
  };

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
      void (client.mutate as any)('personalization.visits.append', {
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
    return <SideNavLink as={Link} replace to={props.href} renderIcon={props.icon} isActive={path.startsWith(props.href)} onClick={closeOnNavigate}>
      {props.title}
    </SideNavLink>
  }

  const MySideNavUserAction = function({ action, title }: { action: UserAction; title?: ReactNode }) {
    return <MySideNavAction
      icon={action.icon}
      title={title ?? action.label}
      action={async () => {
        await runAction(action);
        closeOnNavigate();
      }}
    />;
  }

  return <div data-small={isSmall.toString()}>
    <Header>
      <SkipToContent />

      {isSmall && (
        <HeaderMenuButton
          aria-label={isSideNavExpanded ? "Close menu" : "Open menu"}
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
        <HeaderGlobalAction aria-label="Befehle und Suche" onClick={() => showCommandPaletteModal(modals)}>
          <Icons.Search />
        </HeaderGlobalAction>
      </HeaderGlobalBar>
    </Header>

    <SideNav expanded={isSideNavExpanded} onOverlayClick={() => setIsSideNavExpanded(false)}>
      <SideNavItems>
        <MySideNavLink icon={Icons.Dashboard} href="/dashboard" title="Dashboard" />

        {!!workActions.length && <MySideNavMenu title="Arbeit erfassen" renderIcon={Icons.Create} defaultExpanded>
          {workActions.map(action => <MySideNavUserAction key={action.id} action={action} />)}
        </MySideNavMenu>}

        {!!createActions.length && <MySideNavMenu title="Stammdaten anlegen" renderIcon={Icons.Plus} defaultExpanded={false}>
          {createActions.map(action => <MySideNavUserAction key={action.id} action={action} title={action.label.replace(/ erstellen$/, '')} />)}
        </MySideNavMenu>}

        <SideNavDivider />

        <MySideNavMenu title="Projektarbeit" renderIcon={Icons.Project} defaultExpanded>
          {canViewProjects && <MySideNavLink icon={Icons.Project} href="/projects" title="Projekte" />}
          {canViewDeployments && <MySideNavLink icon={Icons.DailyReport} href="/deployments" title="Einsatzplanung" />}
          {canViewVacations && <MySideNavLink icon={Icons.User} href="/vacations" title="Urlaub" />}
        </MySideNavMenu>

        <MySideNavMenu title="Material & Werkzeuge" renderIcon={Icons.Tool} defaultExpanded>
          {canViewTools && <MySideNavLink icon={Icons.Tool} href="/tools" title="Werkzeuge" />}
          {canViewToolInventories && <MySideNavLink icon={Icons.ToolInventory} href="/inventories" title="Inventur" />}
          {canViewProducts && <MySideNavLink icon={Icons.Product} href="/products" title="Produkte & Lieferscheine" />}
        </MySideNavMenu>

        <MySideNavMenu title="Benutzer & Kontakte" renderIcon={Icons.Customer} defaultExpanded={false}>
          {canViewCustomers && <MySideNavLink icon={Icons.Customer} href="/customers" title="Kunden" />}
          {canViewContacts && <MySideNavLink icon={Icons.Contact} href="/contacts" title="Kontakte" />}
          {canViewUsers && <MySideNavLink icon={Icons.User} href="/users" title="Benutzer" />}
        </MySideNavMenu>

        {(!!adminActions.length || canSeeOrganisation || canViewClientScripts) && <MySideNavMenu title="Verwaltung" renderIcon={Icons.Info} defaultExpanded={false}>
          {adminActions.map(action => <MySideNavUserAction key={action.id} action={action} />)}
          {canViewClientScripts && <MySideNavLink icon={Icons.Script} href="/scripts" title="Client-Skripte" />}
          {canSeeOrganisation && <MySideNavLink icon={Icons.Info} href="/admin" title="Organisation" />}
        </MySideNavMenu>}

        <SideNavDivider />

        <MySideNavLink icon={Icons.Settings} href="/settings" title="Einstellungen" />
        <MySideNavLink icon={Icons.Info} href="/docs" title="Hilfe & Begriffe" />

        <SideNavDivider />

        <MySideNavAction icon={Icons.Logout} title="Abmelden" action={() => client.logout()} />
      </SideNavItems>
    </SideNav>

    <Content className="main-container">
      <Outlet />
    </Content>
  </div>
})
