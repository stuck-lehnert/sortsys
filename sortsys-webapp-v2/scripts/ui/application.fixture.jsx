import React from "react";
import { Button, Content } from "@sortsys/react-components";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { Outlet, Route, Routes, useLocation } from "react-router";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { MyModalsProvider, useMyModals } from "../../app/hooks/useMyModals";
import { client } from "../../app/lib/client";
import { adminClient } from "../../app/lib/adminClient";
import GlobalAdminErrorsPage from "../../app/routes/(admin)/__admin.errors";
import GlobalAdminLlmPage from "../../app/routes/(admin)/__admin.llm";
import ClientScriptsPage from "../../app/routes/(shell)/scripts";
import CustomerPage from "../../app/routes/(shell)/customers.$id";
import { showSetUserPasswordModal } from "../../app/modals/users";
import { showCreateDailyProjectReportModal } from "../../app/modals/dailyProjectReport";
import { showCreateDeliveryNoteModal } from "../../app/modals/deliveryNotes";
import { showCommandPaletteModal } from "../../app/modals/commandPalette";
import { showPriceImportModal } from "../../app/modals/priceImports";
import { showCreateAbsenceModal } from "../../app/modals/absences";
import { showTrackToolsModal } from "../../app/modals/tools";

const bookedTool = {
  id: "tool-eleven",
  customId: 11,
  brand: "Hilti",
  category: "Bohrhammer",
  label: "TE 60 ATC AVR",
  status: null,
  available: false,
};
import DashboardPage from "../../app/routes/(shell)/dashboard";
import DocumentsPage from "../../app/routes/(shell)/documents";
import LlmPage from "../../app/routes/(shell)/llm";
import LlmChatsPage from "../../app/routes/(shell)/llm.chats";
import AdminPage from "../../app/routes/(shell)/admin";
import DeploymentsPage from "../../app/routes/(shell)/deployments";
import ProjectFilesPage from "../../app/routes/(shell)/projects.$id.files";

const priceImport = {
  supplier: "Fixture Vendor",
  effectiveDate: "2026-10-27",
  warnings: [],
  rows: Array.from({ length: 23 }, (_, index) => ({
    productId: null,
    customId: null,
    productName: `Fixture material ${index + 1}`,
    sourceText: `Material ${index + 1} · 1 kg`,
    sourceUnit: "kg",
    baseUnit: "kg",
    otherUnits: {},
    brand: null,
    description: null,
    pricePerBaseUnit: index + 1,
    comment: null,
  })),
};

if (
  new URLSearchParams(window.location.search).get("screen") === "application"
) {
  // Only synthetic, intercepted HTTP requests use this opaque fixture session.
  client.setToken("sortsys-ui-synthetic-session");
  adminClient.setToken("sortsys-ui-synthetic-admin-session");
}

function FormEntrypoints() {
  const modals = useMyModals();
  const user = {
    id: "fixture-user",
    username: "fixture.user",
    firstName: "Fixture",
    lastName: "User",
  };

  return (
    <section
      className="flex flex-wrap gap-3"
      aria-label="Business form entrypoints"
    >
      <Button
        onClick={() =>
          showCreateAbsenceModal(modals, {
            users: [user],
            currentUser: user,
            canManage: true,
            initialDay: new Date(2026, 9, 30),
          })
        }
      >
        Add absence
      </Button>
      <Button
        onClick={() =>
          showTrackToolsModal(modals, {
            tools: [bookedTool],
            responsibleUser: user,
          })
        }
      >
        Book tools
      </Button>
      <Button onClick={() => showSetUserPasswordModal(modals, user)}>
        Set password
      </Button>
      <Button onClick={() => showCreateDailyProjectReportModal(modals)}>
        Create daily report
      </Button>
      <Button onClick={() => showCreateDeliveryNoteModal(modals)}>
        Create delivery note
      </Button>
      <Button onClick={() => showCommandPaletteModal(modals)}>
        Global search
      </Button>
      <Button
        onClick={() => showPriceImportModal(modals, priceImport, "priceList")}
      >
        Import price list
      </Button>
    </section>
  );
}

function ProjectFixture() {
  const project = { id: "project-fixture", title: "Fixture project" };

  return (
    <>
      <h1 className="mb-3 text-xl font-semibold">{project.title}</h1>
      <Outlet context={{ project }} />
    </>
  );
}

function ApplicationFrame({ children }) {
  const { pathname } = useLocation();

  if (pathname === "/deployments") {
    return (
      <Content className="main-container main-container--deployments">
        {children}
      </Content>
    );
  }

  return <main className="p-3 sm:p-5">{children}</main>;
}

export function ApplicationFixture() {
  return (
    <SessionInfoProvider>
      <NotificationProvider
        closeLabel="Close notification"
        regionLabel="Notifications"
      >
        <MyModalsProvider>
          <ApplicationFrame>
            <Routes>
              <Route path="/customers/:id" element={<CustomerPage />} />
              <Route path="/fixtures/forms" element={<FormEntrypoints />} />
              <Route path="/dashboard" element={<DashboardPage />} />
              <Route path="/deployments" element={<DeploymentsPage />} />
              <Route path="/projects/:id" element={<ProjectFixture />}>
                <Route path="files" element={<ProjectFilesPage />} />
              </Route>
              <Route path="/documents" element={<DocumentsPage />} />
              <Route path="/llm" element={<LlmPage />} />
              <Route path="/llm/chats" element={<LlmChatsPage />} />
              <Route path="/llm/:chatId" element={<LlmPage />} />
              <Route path="/admin" element={<AdminPage />} />
              <Route
                path="/__admin/errors"
                element={<GlobalAdminErrorsPage />}
              />
              <Route path="/__admin/llm" element={<GlobalAdminLlmPage />} />
              <Route path="/scripts" element={<ClientScriptsPage />} />
            </Routes>
          </ApplicationFrame>
        </MyModalsProvider>
      </NotificationProvider>
    </SessionInfoProvider>
  );
}
