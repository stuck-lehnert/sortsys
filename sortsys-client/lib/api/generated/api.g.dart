// Generated from the Rust API contract. Do not edit by hand.
import '../model.dart';
import '../procedure.dart';
import 'models.g.dart';

abstract final class ApiQueries {
  static final adminDatabasesBackupsDownloadUrl =
      RpcQuery<
        AdminDatabasesBackupsDownloadUrlInput,
        AdminDatabasesBackupsDownloadUrlOutput
      >(
        path: "admin.databases.backups.downloadUrl",
        decodeOutput: AdminDatabasesBackupsDownloadUrlResult.codec.decode,
      );

  static final adminDatabasesBackupsList =
      RpcQuery<AdminDatabasesBackupsListInput, AdminDatabasesBackupsListOutput>(
        path: "admin.databases.backups.list",
        decodeOutput: rpcArray(AdminDatabasesBackupsListResultItem.codec)
            .decode,
      );

  static final adminDatabasesHostsList =
      RpcQuery<AdminDatabasesHostsListInput, AdminDatabasesHostsListOutput>(
        path: "admin.databases.hosts.list",
        decodeOutput: rpcArray(AdminDatabasesHostsListResultItem.codec).decode,
      );

  static final adminDatabasesList =
      RpcQuery<AdminDatabasesListInput, AdminDatabasesListOutput>(
        path: "admin.databases.list",
        decodeOutput: rpcArray(AdminDatabasesListResultItem.codec).decode,
      );

  static final adminErrorsList =
      RpcQuery<AdminErrorsListInput, AdminErrorsListOutput>(
        path: "admin.errors.list",
        decodeOutput: rpcArray(AdminErrorsListResultItem.codec).decode,
      );

  static final adminLlmProvidersList =
      RpcQuery<AdminLlmProvidersListInput, AdminLlmProvidersListOutput>(
        path: "admin.llm.providers.list",
        decodeOutput: rpcArray(AdminLlmProvidersListResultItem.codec).decode,
      );

  static final adminLlmProvidersModels =
      RpcQuery<AdminLlmProvidersModelsInput, AdminLlmProvidersModelsOutput>(
        path: "admin.llm.providers.models",
        decodeOutput: rpcArray(AdminLlmProvidersModelsResultItem.codec).decode,
      );

  static final adminLlmScanSettingsGet =
      RpcQuery<AdminLlmScanSettingsGetInput, AdminLlmScanSettingsGetOutput>(
        path: "admin.llm.scanSettings.get",
        decodeOutput: rpcNullable(AdminLlmScanSettingsGetResult.codec).decode,
      );

  static final adminLlmSettingsGet =
      RpcQuery<AdminLlmSettingsGetInput, AdminLlmSettingsGetOutput>(
        path: "admin.llm.settings.get",
        decodeOutput: rpcNullable(AdminLlmScanSettingsGetResult.codec).decode,
      );

  static final adminLlmTenantsList =
      RpcQuery<AdminLlmTenantsListInput, AdminLlmTenantsListOutput>(
        path: "admin.llm.tenants.list",
        decodeOutput: rpcArray(AdminLlmTenantsListResultItem.codec).decode,
      );

  static final adminLlmUsage =
      RpcQuery<AdminLlmUsageInput, AdminLlmUsageOutput>(
        path: "admin.llm.usage",
        decodeOutput: rpcArray(AdminLlmUsageResultItem.codec).decode,
      );

  static final adminLlmUseCasesList =
      RpcQuery<AdminLlmUseCasesListInput, AdminLlmUseCasesListOutput>(
        path: "admin.llm.useCases.list",
        decodeOutput: rpcArray(AdminLlmUseCasesListResultItem.codec).decode,
      );

  static final adminTenantsGet =
      RpcQuery<AdminTenantsGetInput, AdminTenantsGetOutput>(
        path: "admin.tenants.get",
        decodeOutput: AdminTenantsGetResult.codec.decode,
      );

  static final adminTenantsList =
      RpcQuery<AdminTenantsListInput, AdminTenantsListOutput>(
        path: "admin.tenants.list",
        decodeOutput: rpcArray(AdminTenantsGetResult.codec).decode,
      );

  static final adminUsersList =
      RpcQuery<AdminUsersListInput, AdminUsersListOutput>(
        path: "admin.users.list",
        decodeOutput: rpcArray(AdminUsersListResultItem.codec).decode,
      );

  static final authCheck = RpcQuery<AuthCheckInput, AuthCheckOutput>(
    path: "auth.check",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final authPasskeysList =
      RpcQuery<AuthPasskeysListInput, AuthPasskeysListOutput>(
        path: "auth.passkeys.list",
        decodeOutput: rpcArray(AuthPasskeysListResultItem.codec).decode,
      );

  static final authSessionInfo =
      RpcQuery<AuthSessionInfoInput, AuthSessionInfoOutput>(
        path: "auth.sessionInfo",
        decodeOutput: SessionInfo.codec.decode,
      );

  static final clientScriptsGet =
      RpcQuery<ClientScriptsGetInput, ClientScriptsGetOutput>(
        path: "clientScripts.get",
        decodeOutput: rpcNullable(ClientScriptsGetResult.codec).decode,
      );

  static final clientScriptsList =
      RpcQuery<ClientScriptsListInput, ClientScriptsListOutput>(
        path: "clientScripts.list",
        decodeOutput: rpcArray(ClientScriptsListResultItem.codec).decode,
      );

  static final contactsCustomersList =
      RpcQuery<ContactsCustomersListInput, ContactsCustomersListOutput>(
        path: "contacts.customers.list",
        decodeOutput: rpcArray(Customer.codec).decode,
      );

  static final contactsGet = RpcQuery<ContactsGetInput, ContactsGetOutput>(
    path: "contacts.get",
    decodeOutput: Contact.codec.decode,
  );

  static final contactsList = RpcQuery<ContactsListInput, ContactsListOutput>(
    path: "contacts.list",
    decodeOutput: rpcArray(Contact.codec).decode,
  );

  static final contactsProjectsList =
      RpcQuery<ContactsProjectsListInput, ContactsProjectsListOutput>(
        path: "contacts.projects.list",
        decodeOutput: rpcArray(Project.codec).decode,
      );

  static final customersContactsList =
      RpcQuery<CustomersContactsListInput, CustomersContactsListOutput>(
        path: "customers.contacts.list",
        decodeOutput: rpcArray(Contact.codec).decode,
      );

  static final customersGet = RpcQuery<CustomersGetInput, CustomersGetOutput>(
    path: "customers.get",
    decodeOutput: Customer.codec.decode,
  );

  static final customersList =
      RpcQuery<CustomersListInput, CustomersListOutput>(
        path: "customers.list",
        decodeOutput: rpcArray(Customer.codec).decode,
      );

  static final deliveryNotesCostsGet =
      RpcQuery<DeliveryNotesCostsGetInput, DeliveryNotesCostsGetOutput>(
        path: "deliveryNotes.costs.get",
        decodeOutput: DeliveryNotesCostsGetResult.codec.decode,
      );

  static final deliveryNotesGet =
      RpcQuery<DeliveryNotesGetInput, DeliveryNotesGetOutput>(
        path: "deliveryNotes.get",
        decodeOutput: DeliveryNote.codec.decode,
      );

  static final deliveryNotesList =
      RpcQuery<DeliveryNotesListInput, DeliveryNotesListOutput>(
        path: "deliveryNotes.list",
        decodeOutput: rpcArray(DeliveryNote.codec).decode,
      );

  static final deliveryNotesScanList =
      RpcQuery<DeliveryNotesScanListInput, DeliveryNotesScanListOutput>(
        path: "deliveryNotes.scan.list",
        decodeOutput: rpcArray(DeliveryNotesScanListResultItem.codec).decode,
      );

  static final deliveryNotesScanStatus =
      RpcQuery<DeliveryNotesScanStatusInput, DeliveryNotesScanStatusOutput>(
        path: "deliveryNotes.scan.status",
        decodeOutput: DeliveryNotesScanStatusResult.codec.decode,
      );

  static final llmAdminUsage =
      RpcQuery<LlmAdminUsageInput, LlmAdminUsageOutput>(
        path: "llm.admin.usage",
        decodeOutput: rpcArray(AdminLlmUsageResultItem.codec).decode,
      );

  static final llmChatsGet = RpcQuery<LlmChatsGetInput, LlmChatsGetOutput>(
    path: "llm.chats.get",
    decodeOutput: LlmChatsGetResult.codec.decode,
  );

  static final llmChatsList = RpcQuery<LlmChatsListInput, LlmChatsListOutput>(
    path: "llm.chats.list",
    decodeOutput: rpcArray(ChatSummary.codec).decode,
  );

  static final llmStatus = RpcQuery<LlmStatusInput, LlmStatusOutput>(
    path: "llm.status",
    decodeOutput: LlmStatusResult.codec.decode,
  );

  static final officeExportsOfficeConfig =
      RpcQuery<OfficeExportsOfficeConfigInput, OfficeExportsOfficeConfigOutput>(
        path: "office.exports.officeConfig",
        decodeOutput: OfficeExportsOfficeConfigResult.codec.decode,
      );

  static final personalizationActionsList =
      RpcQuery<
        PersonalizationActionsListInput,
        PersonalizationActionsListOutput
      >(
        path: "personalization.actions.list",
        decodeOutput: rpcArray(PersonalizationActionsListResultItem.codec)
            .decode,
      );

  static final personalizationActivityList =
      RpcQuery<
        PersonalizationActivityListInput,
        PersonalizationActivityListOutput
      >(
        path: "personalization.activity.list",
        decodeOutput: rpcArray(ResourceActivity.codec).decode,
      );

  static final personalizationVisitsList =
      RpcQuery<PersonalizationVisitsListInput, PersonalizationVisitsListOutput>(
        path: "personalization.visits.list",
        decodeOutput: rpcArray(PersonalizationVisitsListResultItem.codec)
            .decode,
      );

  static final ping = RpcQuery<PingInput, PingOutput>(
    path: "ping",
    decodeOutput: rpcString.decode,
  );

  static final productsBrandsList =
      RpcQuery<ProductsBrandsListInput, ProductsBrandsListOutput>(
        path: "products.brands.list",
        decodeOutput: rpcArray(rpcString).decode,
      );

  static final productsCategoriesList =
      RpcQuery<ProductsCategoriesListInput, ProductsCategoriesListOutput>(
        path: "products.categories.list",
        decodeOutput: rpcArray(rpcString).decode,
      );

  static final productsGet = RpcQuery<ProductsGetInput, ProductsGetOutput>(
    path: "products.get",
    decodeOutput: Product.codec.decode,
  );

  static final productsList = RpcQuery<ProductsListInput, ProductsListOutput>(
    path: "products.list",
    decodeOutput: rpcArray(Product.codec).decode,
  );

  static final productsPriceRecordsList =
      RpcQuery<ProductsPriceRecordsListInput, ProductsPriceRecordsListOutput>(
        path: "products.priceRecords.list",
        decodeOutput: rpcArray(ProductsPriceRecordsListResultItem.codec).decode,
      );

  static final productsSuggestNextCustomId =
      RpcQuery<
        ProductsSuggestNextCustomIdInput,
        ProductsSuggestNextCustomIdOutput
      >(path: "products.suggestNextCustomId", decodeOutput: rpcNumber.decode);

  static final productsUnitsList =
      RpcQuery<ProductsUnitsListInput, ProductsUnitsListOutput>(
        path: "products.units.list",
        decodeOutput: rpcArray(rpcString).decode,
      );

  static final productsVendorsGet =
      RpcQuery<ProductsVendorsGetInput, ProductsVendorsGetOutput>(
        path: "products.vendors.get",
        decodeOutput: ProductVendor.codec.decode,
      );

  static final productsVendorsList =
      RpcQuery<ProductsVendorsListInput, ProductsVendorsListOutput>(
        path: "products.vendors.list",
        decodeOutput: rpcArray(ProductVendor.codec).decode,
      );

  static final projectsContactsList =
      RpcQuery<ProjectsContactsListInput, ProjectsContactsListOutput>(
        path: "projects.contacts.list",
        decodeOutput: rpcArray(ProjectsContactsListResultItem.codec).decode,
      );

  static final projectsCostsFilterOptions =
      RpcQuery<
        ProjectsCostsFilterOptionsInput,
        ProjectsCostsFilterOptionsOutput
      >(
        path: "projects.costs.filterOptions",
        decodeOutput: ProjectsCostsFilterOptionsResult.codec.decode,
      );

  static final projectsCostsGet =
      RpcQuery<ProjectsCostsGetInput, ProjectsCostsGetOutput>(
        path: "projects.costs.get",
        decodeOutput: ProjectsCostsGetResult.codec.decode,
      );

  static final projectsCostsOverview =
      RpcQuery<ProjectsCostsOverviewInput, ProjectsCostsOverviewOutput>(
        path: "projects.costs.overview",
        decodeOutput: rpcArray(ProjectsCostsOverviewResultItem.codec).decode,
      );

  static final projectsDailyReportsGet =
      RpcQuery<ProjectsDailyReportsGetInput, ProjectsDailyReportsGetOutput>(
        path: "projects.dailyReports.get",
        decodeOutput: ProjectsDailyReportsGetResult.codec.decode,
      );

  static final projectsDailyReportsList =
      RpcQuery<ProjectsDailyReportsListInput, ProjectsDailyReportsListOutput>(
        path: "projects.dailyReports.list",
        decodeOutput: rpcArray(ProjectsDailyReportsGetResult.codec).decode,
      );

  static final projectsDeploymentsList =
      RpcQuery<ProjectsDeploymentsListInput, ProjectsDeploymentsListOutput>(
        path: "projects.deployments.list",
        decodeOutput: rpcArray(Deployment.codec).decode,
      );

  static final projectsFilesDrawioConfig =
      RpcQuery<ProjectsFilesDrawioConfigInput, ProjectsFilesDrawioConfigOutput>(
        path: "projects.files.drawioConfig",
        decodeOutput: ProjectsFilesDrawioConfigResult.codec.decode,
      );

  static final projectsFilesFoldersList =
      RpcQuery<ProjectsFilesFoldersListInput, ProjectsFilesFoldersListOutput>(
        path: "projects.files.folders.list",
        decodeOutput: rpcArray(ProjectsFilesFoldersListResultItem.codec).decode,
      );

  static final projectsFilesList =
      RpcQuery<ProjectsFilesListInput, ProjectsFilesListOutput>(
        path: "projects.files.list",
        decodeOutput: rpcArray(ProjectsFilesListResultItem.codec).decode,
      );

  static final projectsFilesOfficeConfig =
      RpcQuery<ProjectsFilesOfficeConfigInput, ProjectsFilesOfficeConfigOutput>(
        path: "projects.files.officeConfig",
        decodeOutput: OfficeExportsOfficeConfigResult.codec.decode,
      );

  static final projectsFilesSearch =
      RpcQuery<ProjectsFilesSearchInput, ProjectsFilesSearchOutput>(
        path: "projects.files.search",
        decodeOutput: rpcArray(ProjectsFilesSearchResultItem.codec).decode,
      );

  static final projectsGet = RpcQuery<ProjectsGetInput, ProjectsGetOutput>(
    path: "projects.get",
    decodeOutput: Project.codec.decode,
  );

  static final projectsList = RpcQuery<ProjectsListInput, ProjectsListOutput>(
    path: "projects.list",
    decodeOutput: rpcArray(Project.codec).decode,
  );

  static final projectsUnavailabilityList =
      RpcQuery<
        ProjectsUnavailabilityListInput,
        ProjectsUnavailabilityListOutput
      >(
        path: "projects.unavailability.list",
        decodeOutput: rpcArray(ProjectsUnavailabilityListResultItem.codec)
            .decode,
      );

  static final regieReportsCostsGet =
      RpcQuery<RegieReportsCostsGetInput, RegieReportsCostsGetOutput>(
        path: "regieReports.costs.get",
        decodeOutput: RegieReportsCostsGetResult.codec.decode,
      );

  static final regieReportsGet =
      RpcQuery<RegieReportsGetInput, RegieReportsGetOutput>(
        path: "regieReports.get",
        decodeOutput: RegieReport.codec.decode,
      );

  static final regieReportsList =
      RpcQuery<RegieReportsListInput, RegieReportsListOutput>(
        path: "regieReports.list",
        decodeOutput: rpcArray(RegieReport.codec).decode,
      );

  static final remarksList = RpcQuery<RemarksListInput, RemarksListOutput>(
    path: "remarks.list",
    decodeOutput: rpcArray(RemarksListResultItem.codec).decode,
  );

  static final settingsCostsGet =
      RpcQuery<SettingsCostsGetInput, SettingsCostsGetOutput>(
        path: "settings.costs.get",
        decodeOutput: SettingsCostsGetResult.codec.decode,
      );

  static final settingsGlobalGet =
      RpcQuery<SettingsGlobalGetInput, SettingsGlobalGetOutput>(
        path: "settings.global.get",
        decodeOutput: SettingsGlobalGetResult.codec.decode,
      );

  static final settingsPublicGlobalGet =
      RpcQuery<SettingsPublicGlobalGetInput, SettingsPublicGlobalGetOutput>(
        path: "settings.publicGlobal.get",
        decodeOutput: SettingsGlobalGetResult.codec.decode,
      );

  static final settingsTenantLogoGet =
      RpcQuery<SettingsTenantLogoGetInput, SettingsTenantLogoGetOutput>(
        path: "settings.tenantLogo.get",
        decodeOutput: SettingsTenantLogoGetResult.codec.decode,
      );

  static final settingsTenantNameGet =
      RpcQuery<SettingsTenantNameGetInput, SettingsTenantNameGetOutput>(
        path: "settings.tenantName.get",
        decodeOutput: SettingsTenantNameGetResult.codec.decode,
      );

  static final toolsBrands = RpcQuery<ToolsBrandsInput, ToolsBrandsOutput>(
    path: "tools.brands",
    decodeOutput: rpcArray(rpcString).decode,
  );

  static final toolsCategories =
      RpcQuery<ToolsCategoriesInput, ToolsCategoriesOutput>(
        path: "tools.categories",
        decodeOutput: rpcArray(rpcString).decode,
      );

  static final toolsGet = RpcQuery<ToolsGetInput, ToolsGetOutput>(
    path: "tools.get",
    decodeOutput: Tool.codec.decode,
  );

  static final toolsInventoriesList =
      RpcQuery<ToolsInventoriesListInput, ToolsInventoriesListOutput>(
        path: "tools.inventories.list",
        decodeOutput: rpcArray(ToolsInventoriesListResultItem.codec).decode,
      );

  static final toolsInventoriesOverview =
      RpcQuery<ToolsInventoriesOverviewInput, ToolsInventoriesOverviewOutput>(
        path: "tools.inventories.overview",
        decodeOutput: rpcArray(ToolsInventoriesOverviewResultItem.codec).decode,
      );

  static final toolsList = RpcQuery<ToolsListInput, ToolsListOutput>(
    path: "tools.list",
    decodeOutput: rpcArray(Tool.codec).decode,
  );

  static final toolsSuggestNextCustomId =
      RpcQuery<ToolsSuggestNextCustomIdInput, ToolsSuggestNextCustomIdOutput>(
        path: "tools.suggestNextCustomId",
        decodeOutput: rpcNumber.decode,
      );

  static final toolsTrackingsList =
      RpcQuery<ToolsTrackingsListInput, ToolsTrackingsListOutput>(
        path: "tools.trackings.list",
        decodeOutput: rpcArray(ToolsTrackingsListResultItem.codec).decode,
      );

  static final toolsTrackingsTransfersList =
      RpcQuery<
        ToolsTrackingsTransfersListInput,
        ToolsTrackingsTransfersListOutput
      >(
        path: "tools.trackings.transfers.list",
        decodeOutput: rpcArray(ToolsTrackingsTransfersListResultItem.codec)
            .decode,
      );

  static final usersGet = RpcQuery<UsersGetInput, UsersGetOutput>(
    path: "users.get",
    decodeOutput: User.codec.decode,
  );

  static final usersList = RpcQuery<UsersListInput, UsersListOutput>(
    path: "users.list",
    decodeOutput: rpcArray(User.codec).decode,
  );

  static final usersRolesGet =
      RpcQuery<UsersRolesGetInput, UsersRolesGetOutput>(
        path: "users.roles.get",
        decodeOutput: rpcArray(UsersRolesGetResultItem.codec).decode,
      );

  static final usersRolesList =
      RpcQuery<UsersRolesListInput, UsersRolesListOutput>(
        path: "users.roles.list",
        decodeOutput: rpcArray(UsersRolesGetResultItem.codec).decode,
      );

  static final usersSupervisorsGetDefault =
      RpcQuery<
        UsersSupervisorsGetDefaultInput,
        UsersSupervisorsGetDefaultOutput
      >(
        path: "users.supervisors.getDefault",
        decodeOutput: UsersSupervisorsGetDefaultResult.codec.decode,
      );

  static final usersVacationsList =
      RpcQuery<UsersVacationsListInput, UsersVacationsListOutput>(
        path: "users.vacations.list",
        decodeOutput: rpcArray(UsersVacationsListResultItem.codec).decode,
      );
}

abstract final class ApiMutations {
  static final adminDatabasesBackupsCreateNow =
      RpcMutation<
        AdminDatabasesBackupsCreateNowInput,
        AdminDatabasesBackupsCreateNowOutput
      >(
        path: "admin.databases.backups.createNow",
        decodeOutput: AdminDatabasesBackupsListResultItem.codec.decode,
      );

  static final adminDatabasesBackupsRestore =
      RpcMutation<
        AdminDatabasesBackupsRestoreInput,
        AdminDatabasesBackupsRestoreOutput
      >(
        path: "admin.databases.backups.restore",
        decodeOutput: AdminDatabasesBackupsRestoreResult.codec.decode,
      );

  static final adminDatabasesBackupsUpload =
      RpcMutation<
        AdminDatabasesBackupsUploadInput,
        AdminDatabasesBackupsUploadOutput
      >(
        path: "admin.databases.backups.upload",
        decodeOutput: AdminDatabasesBackupsListResultItem.codec.decode,
      );

  static final adminDatabasesCreate =
      RpcMutation<AdminDatabasesCreateInput, AdminDatabasesCreateOutput>(
        path: "admin.databases.create",
        decodeOutput: AdminDatabasesCreateResult.codec.decode,
      );

  static final adminDatabasesForkFromBackup =
      RpcMutation<
        AdminDatabasesForkFromBackupInput,
        AdminDatabasesForkFromBackupOutput
      >(
        path: "admin.databases.forkFromBackup",
        decodeOutput: AdminDatabasesForkFromBackupResult.codec.decode,
      );

  static final adminDatabasesHostsCreate =
      RpcMutation<
        AdminDatabasesHostsCreateInput,
        AdminDatabasesHostsCreateOutput
      >(
        path: "admin.databases.hosts.create",
        decodeOutput: AdminDatabasesHostsListResultItem.codec.decode,
      );

  static final adminDatabasesHostsDelete =
      RpcMutation<
        AdminDatabasesHostsDeleteInput,
        AdminDatabasesHostsDeleteOutput
      >(
        path: "admin.databases.hosts.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminDatabasesHostsUpdate =
      RpcMutation<
        AdminDatabasesHostsUpdateInput,
        AdminDatabasesHostsUpdateOutput
      >(
        path: "admin.databases.hosts.update",
        decodeOutput: AdminDatabasesHostsListResultItem.codec.decode,
      );

  static final adminDatabasesRotateCredentials =
      RpcMutation<
        AdminDatabasesRotateCredentialsInput,
        AdminDatabasesRotateCredentialsOutput
      >(
        path: "admin.databases.rotateCredentials",
        decodeOutput: AdminDatabasesRotateCredentialsResult.codec.decode,
      );

  static final adminDatabasesUpdateRetention =
      RpcMutation<
        AdminDatabasesUpdateRetentionInput,
        AdminDatabasesUpdateRetentionOutput
      >(
        path: "admin.databases.updateRetention",
        decodeOutput: AdminDatabasesUpdateRetentionResult.codec.decode,
      );

  static final adminLlmProvidersDelete =
      RpcMutation<AdminLlmProvidersDeleteInput, AdminLlmProvidersDeleteOutput>(
        path: "admin.llm.providers.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminLlmProvidersUpdate =
      RpcMutation<AdminLlmProvidersUpdateInput, AdminLlmProvidersUpdateOutput>(
        path: "admin.llm.providers.update",
        decodeOutput: AdminLlmProvidersListResultItem.codec.decode,
      );

  static final adminLlmScanSettingsUpdate =
      RpcMutation<
        AdminLlmScanSettingsUpdateInput,
        AdminLlmScanSettingsUpdateOutput
      >(
        path: "admin.llm.scanSettings.update",
        decodeOutput: AdminLlmScanSettingsGetResult.codec.decode,
      );

  static final adminLlmSettingsUpdate =
      RpcMutation<AdminLlmSettingsUpdateInput, AdminLlmSettingsUpdateOutput>(
        path: "admin.llm.settings.update",
        decodeOutput: AdminLlmScanSettingsGetResult.codec.decode,
      );

  static final adminLlmTenantsUpdate =
      RpcMutation<AdminLlmTenantsUpdateInput, AdminLlmTenantsUpdateOutput>(
        path: "admin.llm.tenants.update",
        decodeOutput: AdminLlmTenantsListResultItem.codec.decode,
      );

  static final adminLlmUseCasesUpdate =
      RpcMutation<AdminLlmUseCasesUpdateInput, AdminLlmUseCasesUpdateOutput>(
        path: "admin.llm.useCases.update",
        decodeOutput: AdminLlmUseCasesListResultItem.codec.decode,
      );

  static final adminLogin = RpcMutation<AdminLoginInput, AdminLoginOutput>(
    path: "admin.login",
    decodeOutput: AdminLoginResult.codec.decode,
  );

  static final adminTenantsActivate =
      RpcMutation<AdminTenantsActivateInput, AdminTenantsActivateOutput>(
        path: "admin.tenants.activate",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsCreate =
      RpcMutation<AdminTenantsCreateInput, AdminTenantsCreateOutput>(
        path: "admin.tenants.create",
        decodeOutput: AdminTenantsCreateResult.codec.decode,
      );

  static final adminTenantsDeactivate =
      RpcMutation<AdminTenantsDeactivateInput, AdminTenantsDeactivateOutput>(
        path: "admin.tenants.deactivate",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsDelete =
      RpcMutation<AdminTenantsDeleteInput, AdminTenantsDeleteOutput>(
        path: "admin.tenants.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsDeleteForever =
      RpcMutation<
        AdminTenantsDeleteForeverInput,
        AdminTenantsDeleteForeverOutput
      >(
        path: "admin.tenants.deleteForever",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsLock =
      RpcMutation<AdminTenantsLockInput, AdminTenantsLockOutput>(
        path: "admin.tenants.lock",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsUndelete =
      RpcMutation<AdminTenantsUndeleteInput, AdminTenantsUndeleteOutput>(
        path: "admin.tenants.undelete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsUnlock =
      RpcMutation<AdminTenantsUnlockInput, AdminTenantsUnlockOutput>(
        path: "admin.tenants.unlock",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminTenantsUpdate =
      RpcMutation<AdminTenantsUpdateInput, AdminTenantsUpdateOutput>(
        path: "admin.tenants.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final adminUsersCreate =
      RpcMutation<AdminUsersCreateInput, AdminUsersCreateOutput>(
        path: "admin.users.create",
        decodeOutput: AdminUsersCreateResult.codec.decode,
      );

  static final adminUsersResetPassword =
      RpcMutation<AdminUsersResetPasswordInput, AdminUsersResetPasswordOutput>(
        path: "admin.users.resetPassword",
        decodeOutput: AdminUsersResetPasswordResult.codec.decode,
      );

  static final adminUsersSetAdmin =
      RpcMutation<AdminUsersSetAdminInput, AdminUsersSetAdminOutput>(
        path: "admin.users.setAdmin",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final authLogin = RpcMutation<AuthLoginInput, AuthLoginOutput>(
    path: "auth.login",
    decodeOutput: AdminLoginResult.codec.decode,
  );

  static final authLogout = RpcMutation<AuthLogoutInput, AuthLogoutOutput>(
    path: "auth.logout",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final authPasskeysDelete =
      RpcMutation<AuthPasskeysDeleteInput, AuthPasskeysDeleteOutput>(
        path: "auth.passkeys.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final authPasskeysLogin =
      RpcMutation<AuthPasskeysLoginInput, AuthPasskeysLoginOutput>(
        path: "auth.passkeys.login",
        decodeOutput: AdminLoginResult.codec.decode,
      );

  static final authPasskeysLoginOptions =
      RpcMutation<
        AuthPasskeysLoginOptionsInput,
        AuthPasskeysLoginOptionsOutput
      >(
        path: "auth.passkeys.loginOptions",
        decodeOutput: AuthPasskeysLoginOptionsResult.codec.decode,
      );

  static final authPasskeysRegister =
      RpcMutation<AuthPasskeysRegisterInput, AuthPasskeysRegisterOutput>(
        path: "auth.passkeys.register",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final authPasskeysRegisterOptions =
      RpcMutation<
        AuthPasskeysRegisterOptionsInput,
        AuthPasskeysRegisterOptionsOutput
      >(
        path: "auth.passkeys.registerOptions",
        decodeOutput: AuthPasskeysRegisterOptionsResult.codec.decode,
      );

  static final authSetPassword =
      RpcMutation<AuthSetPasswordInput, AuthSetPasswordOutput>(
        path: "auth.setPassword",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final clientScriptsCreate =
      RpcMutation<ClientScriptsCreateInput, ClientScriptsCreateOutput>(
        path: "clientScripts.create",
        decodeOutput: ClientScriptsGetResult.codec.decode,
      );

  static final clientScriptsDelete =
      RpcMutation<ClientScriptsDeleteInput, ClientScriptsDeleteOutput>(
        path: "clientScripts.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final clientScriptsUpdate =
      RpcMutation<ClientScriptsUpdateInput, ClientScriptsUpdateOutput>(
        path: "clientScripts.update",
        decodeOutput: rpcNullable(ClientScriptsGetResult.codec).decode,
      );

  static final contactsCreate =
      RpcMutation<ContactsCreateInput, ContactsCreateOutput>(
        path: "contacts.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final contactsDelete =
      RpcMutation<ContactsDeleteInput, ContactsDeleteOutput>(
        path: "contacts.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final contactsUpdate =
      RpcMutation<ContactsUpdateInput, ContactsUpdateOutput>(
        path: "contacts.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final customersContactsAdd =
      RpcMutation<CustomersContactsAddInput, CustomersContactsAddOutput>(
        path: "customers.contacts.add",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final customersContactsRemove =
      RpcMutation<CustomersContactsRemoveInput, CustomersContactsRemoveOutput>(
        path: "customers.contacts.remove",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final customersContactsSet =
      RpcMutation<CustomersContactsSetInput, CustomersContactsSetOutput>(
        path: "customers.contacts.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final customersCreate =
      RpcMutation<CustomersCreateInput, CustomersCreateOutput>(
        path: "customers.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final customersDelete =
      RpcMutation<CustomersDeleteInput, CustomersDeleteOutput>(
        path: "customers.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final customersUpdate =
      RpcMutation<CustomersUpdateInput, CustomersUpdateOutput>(
        path: "customers.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final deliveryNotesCreate =
      RpcMutation<DeliveryNotesCreateInput, DeliveryNotesCreateOutput>(
        path: "deliveryNotes.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final deliveryNotesDelete =
      RpcMutation<DeliveryNotesDeleteInput, DeliveryNotesDeleteOutput>(
        path: "deliveryNotes.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final deliveryNotesScanComplete =
      RpcMutation<
        DeliveryNotesScanCompleteInput,
        DeliveryNotesScanCompleteOutput
      >(
        path: "deliveryNotes.scan.complete",
        decodeOutput: DeliveryNotesScanCompleteResult.codec.decode,
      );

  static final deliveryNotesScanCreateUpload =
      RpcMutation<
        DeliveryNotesScanCreateUploadInput,
        DeliveryNotesScanCreateUploadOutput
      >(
        path: "deliveryNotes.scan.createUpload",
        decodeOutput: DeliveryNotesScanCreateUploadResult.codec.decode,
      );

  static final deliveryNotesScanParse =
      RpcMutation<DeliveryNotesScanParseInput, DeliveryNotesScanParseOutput>(
        path: "deliveryNotes.scan.parse",
        decodeOutput: DeliveryNotesScanCompleteResult.codec.decode,
      );

  static final deliveryNotesScanStart =
      RpcMutation<DeliveryNotesScanStartInput, DeliveryNotesScanStartOutput>(
        path: "deliveryNotes.scan.start",
        decodeOutput: DeliveryNotesScanStatusRequest.codec.decode,
      );

  static final deliveryNotesUpdate =
      RpcMutation<DeliveryNotesUpdateInput, DeliveryNotesUpdateOutput>(
        path: "deliveryNotes.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final errorReportsReport =
      RpcMutation<ErrorReportsReportInput, ErrorReportsReportOutput>(
        path: "errorReports.report",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final llmChatsCreate =
      RpcMutation<LlmChatsCreateInput, LlmChatsCreateOutput>(
        path: "llm.chats.create",
        decodeOutput: ChatSummary.codec.decode,
      );

  static final llmChatsDelete =
      RpcMutation<LlmChatsDeleteInput, LlmChatsDeleteOutput>(
        path: "llm.chats.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final llmMessagesSend =
      RpcMutation<LlmMessagesSendInput, LlmMessagesSendOutput>(
        path: "llm.messages.send",
        decodeOutput: LlmChatsGetResult.codec.decode,
      );

  static final llmProposalsReview =
      RpcMutation<LlmProposalsReviewInput, LlmProposalsReviewOutput>(
        path: "llm.proposals.review",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final officeExportsCreateUpload =
      RpcMutation<
        OfficeExportsCreateUploadInput,
        OfficeExportsCreateUploadOutput
      >(
        path: "office.exports.createUpload",
        decodeOutput: OfficeExportsCreateUploadResult.codec.decode,
      );

  static final personalizationActionsAppend =
      RpcMutation<
        PersonalizationActionsAppendInput,
        PersonalizationActionsAppendOutput
      >(
        path: "personalization.actions.append",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final personalizationVisitsAppend =
      RpcMutation<
        PersonalizationVisitsAppendInput,
        PersonalizationVisitsAppendOutput
      >(
        path: "personalization.visits.append",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsCategoriesSet =
      RpcMutation<ProductsCategoriesSetInput, ProductsCategoriesSetOutput>(
        path: "products.categories.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsCategoriesTag =
      RpcMutation<ProductsCategoriesTagInput, ProductsCategoriesTagOutput>(
        path: "products.categories.tag",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsCategoriesUntag =
      RpcMutation<ProductsCategoriesUntagInput, ProductsCategoriesUntagOutput>(
        path: "products.categories.untag",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsCreate =
      RpcMutation<ProductsCreateInput, ProductsCreateOutput>(
        path: "products.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final productsDelete =
      RpcMutation<ProductsDeleteInput, ProductsDeleteOutput>(
        path: "products.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsPriceImportsApply =
      RpcMutation<
        ProductsPriceImportsApplyInput,
        ProductsPriceImportsApplyOutput
      >(
        path: "products.priceImports.apply",
        decodeOutput: ProductsPriceImportsApplyResult.codec.decode,
      );

  static final productsPriceRecordsCreate =
      RpcMutation<
        ProductsPriceRecordsCreateInput,
        ProductsPriceRecordsCreateOutput
      >(
        path: "products.priceRecords.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final productsPriceRecordsDelete =
      RpcMutation<
        ProductsPriceRecordsDeleteInput,
        ProductsPriceRecordsDeleteOutput
      >(
        path: "products.priceRecords.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsPriceRecordsUpdate =
      RpcMutation<
        ProductsPriceRecordsUpdateInput,
        ProductsPriceRecordsUpdateOutput
      >(
        path: "products.priceRecords.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsUpdate =
      RpcMutation<ProductsUpdateInput, ProductsUpdateOutput>(
        path: "products.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsVendorsCreate =
      RpcMutation<ProductsVendorsCreateInput, ProductsVendorsCreateOutput>(
        path: "products.vendors.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final productsVendorsDelete =
      RpcMutation<ProductsVendorsDeleteInput, ProductsVendorsDeleteOutput>(
        path: "products.vendors.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final productsVendorsUpdate =
      RpcMutation<ProductsVendorsUpdateInput, ProductsVendorsUpdateOutput>(
        path: "products.vendors.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsContactsAdd =
      RpcMutation<ProjectsContactsAddInput, ProjectsContactsAddOutput>(
        path: "projects.contacts.add",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsContactsRemove =
      RpcMutation<ProjectsContactsRemoveInput, ProjectsContactsRemoveOutput>(
        path: "projects.contacts.remove",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsContactsSet =
      RpcMutation<ProjectsContactsSetInput, ProjectsContactsSetOutput>(
        path: "projects.contacts.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsCostsEntriesCreate =
      RpcMutation<
        ProjectsCostsEntriesCreateInput,
        ProjectsCostsEntriesCreateOutput
      >(
        path: "projects.costs.entries.create",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsCostsEntriesDelete =
      RpcMutation<
        ProjectsCostsEntriesDeleteInput,
        ProjectsCostsEntriesDeleteOutput
      >(
        path: "projects.costs.entries.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsCostsEntriesUpdate =
      RpcMutation<
        ProjectsCostsEntriesUpdateInput,
        ProjectsCostsEntriesUpdateOutput
      >(
        path: "projects.costs.entries.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsCreate =
      RpcMutation<ProjectsCreateInput, ProjectsCreateOutput>(
        path: "projects.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final projectsDailyReportsCreate =
      RpcMutation<
        ProjectsDailyReportsCreateInput,
        ProjectsDailyReportsCreateOutput
      >(
        path: "projects.dailyReports.create",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDailyReportsDelete =
      RpcMutation<
        ProjectsDailyReportsDeleteInput,
        ProjectsDailyReportsDeleteOutput
      >(
        path: "projects.dailyReports.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDailyReportsPhotosAdd =
      RpcMutation<
        ProjectsDailyReportsPhotosAddInput,
        ProjectsDailyReportsPhotosAddOutput
      >(
        path: "projects.dailyReports.photos.add",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDailyReportsPhotosRemove =
      RpcMutation<
        ProjectsDailyReportsPhotosRemoveInput,
        ProjectsDailyReportsPhotosRemoveOutput
      >(
        path: "projects.dailyReports.photos.remove",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDailyReportsUpdate =
      RpcMutation<
        ProjectsDailyReportsUpdateInput,
        ProjectsDailyReportsUpdateOutput
      >(
        path: "projects.dailyReports.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDelete =
      RpcMutation<ProjectsDeleteInput, ProjectsDeleteOutput>(
        path: "projects.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDeploymentsCreate =
      RpcMutation<
        ProjectsDeploymentsCreateInput,
        ProjectsDeploymentsCreateOutput
      >(
        path: "projects.deployments.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final projectsDeploymentsDelete =
      RpcMutation<
        ProjectsDeploymentsDeleteInput,
        ProjectsDeploymentsDeleteOutput
      >(
        path: "projects.deployments.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsDeploymentsUpdate =
      RpcMutation<
        ProjectsDeploymentsUpdateInput,
        ProjectsDeploymentsUpdateOutput
      >(
        path: "projects.deployments.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesCompleteUpload =
      RpcMutation<
        ProjectsFilesCompleteUploadInput,
        ProjectsFilesCompleteUploadOutput
      >(
        path: "projects.files.completeUpload",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesCreateUpload =
      RpcMutation<
        ProjectsFilesCreateUploadInput,
        ProjectsFilesCreateUploadOutput
      >(
        path: "projects.files.createUpload",
        decodeOutput: ProjectsFilesCreateUploadResult.codec.decode,
      );

  static final projectsFilesDelete =
      RpcMutation<ProjectsFilesDeleteInput, ProjectsFilesDeleteOutput>(
        path: "projects.files.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesDrawioSave =
      RpcMutation<ProjectsFilesDrawioSaveInput, ProjectsFilesDrawioSaveOutput>(
        path: "projects.files.drawioSave",
        decodeOutput: ProjectsFilesDrawioSaveResult.codec.decode,
      );

  static final projectsFilesFoldersCreate =
      RpcMutation<
        ProjectsFilesFoldersCreateInput,
        ProjectsFilesFoldersCreateOutput
      >(
        path: "projects.files.folders.create",
        decodeOutput: ProjectsFilesFoldersCreateResult.codec.decode,
      );

  static final projectsFilesFoldersDelete =
      RpcMutation<
        ProjectsFilesFoldersDeleteInput,
        ProjectsFilesFoldersDeleteOutput
      >(
        path: "projects.files.folders.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesFoldersMove =
      RpcMutation<
        ProjectsFilesFoldersMoveInput,
        ProjectsFilesFoldersMoveOutput
      >(
        path: "projects.files.folders.move",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesFoldersRename =
      RpcMutation<
        ProjectsFilesFoldersRenameInput,
        ProjectsFilesFoldersRenameOutput
      >(
        path: "projects.files.folders.rename",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesMove =
      RpcMutation<ProjectsFilesMoveInput, ProjectsFilesMoveOutput>(
        path: "projects.files.move",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFilesRename =
      RpcMutation<ProjectsFilesRenameInput, ProjectsFilesRenameOutput>(
        path: "projects.files.rename",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsFinish =
      RpcMutation<ProjectsFinishInput, ProjectsFinishOutput>(
        path: "projects.finish",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsResume =
      RpcMutation<ProjectsResumeInput, ProjectsResumeOutput>(
        path: "projects.resume",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsUnavailabilityCreate =
      RpcMutation<
        ProjectsUnavailabilityCreateInput,
        ProjectsUnavailabilityCreateOutput
      >(
        path: "projects.unavailability.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final projectsUnavailabilityDelete =
      RpcMutation<
        ProjectsUnavailabilityDeleteInput,
        ProjectsUnavailabilityDeleteOutput
      >(
        path: "projects.unavailability.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsUnavailabilityUpdate =
      RpcMutation<
        ProjectsUnavailabilityUpdateInput,
        ProjectsUnavailabilityUpdateOutput
      >(
        path: "projects.unavailability.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final projectsUpdate =
      RpcMutation<ProjectsUpdateInput, ProjectsUpdateOutput>(
        path: "projects.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final regieReportsCreate =
      RpcMutation<RegieReportsCreateInput, RegieReportsCreateOutput>(
        path: "regieReports.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final regieReportsDelete =
      RpcMutation<RegieReportsDeleteInput, RegieReportsDeleteOutput>(
        path: "regieReports.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final regieReportsUpdate =
      RpcMutation<RegieReportsUpdateInput, RegieReportsUpdateOutput>(
        path: "regieReports.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final remarksCreate =
      RpcMutation<RemarksCreateInput, RemarksCreateOutput>(
        path: "remarks.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final remarksDelete =
      RpcMutation<RemarksDeleteInput, RemarksDeleteOutput>(
        path: "remarks.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final remarksUpdate =
      RpcMutation<RemarksUpdateInput, RemarksUpdateOutput>(
        path: "remarks.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsCostsDelete =
      RpcMutation<SettingsCostsDeleteInput, SettingsCostsDeleteOutput>(
        path: "settings.costs.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsCostsSet =
      RpcMutation<SettingsCostsSetInput, SettingsCostsSetOutput>(
        path: "settings.costs.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsCostsUpdate =
      RpcMutation<SettingsCostsUpdateInput, SettingsCostsUpdateOutput>(
        path: "settings.costs.update",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsGlobalDelete =
      RpcMutation<SettingsGlobalDeleteInput, SettingsGlobalDeleteOutput>(
        path: "settings.global.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsGlobalSet =
      RpcMutation<SettingsGlobalSetInput, SettingsGlobalSetOutput>(
        path: "settings.global.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsLanguageSet =
      RpcMutation<SettingsLanguageSetInput, SettingsLanguageSetOutput>(
        path: "settings.language.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsPublicGlobalDelete =
      RpcMutation<
        SettingsPublicGlobalDeleteInput,
        SettingsPublicGlobalDeleteOutput
      >(
        path: "settings.publicGlobal.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsPublicGlobalSet =
      RpcMutation<SettingsPublicGlobalSetInput, SettingsPublicGlobalSetOutput>(
        path: "settings.publicGlobal.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsTenantLogoCompleteUpload =
      RpcMutation<
        SettingsTenantLogoCompleteUploadInput,
        SettingsTenantLogoCompleteUploadOutput
      >(
        path: "settings.tenantLogo.completeUpload",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final settingsTenantLogoCreateUpload =
      RpcMutation<
        SettingsTenantLogoCreateUploadInput,
        SettingsTenantLogoCreateUploadOutput
      >(
        path: "settings.tenantLogo.createUpload",
        decodeOutput: SettingsTenantLogoCreateUploadResult.codec.decode,
      );

  static final settingsTenantNameSet =
      RpcMutation<SettingsTenantNameSetInput, SettingsTenantNameSetOutput>(
        path: "settings.tenantName.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsArchive =
      RpcMutation<ToolsArchiveInput, ToolsArchiveOutput>(
        path: "tools.archive",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsCreate = RpcMutation<ToolsCreateInput, ToolsCreateOutput>(
    path: "tools.create",
    decodeOutput: ClientScriptsGetRequest.codec.decode,
  );

  static final toolsDelete = RpcMutation<ToolsDeleteInput, ToolsDeleteOutput>(
    path: "tools.delete",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final toolsInventoriesCreate =
      RpcMutation<ToolsInventoriesCreateInput, ToolsInventoriesCreateOutput>(
        path: "tools.inventories.create",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final toolsInventoriesDelete =
      RpcMutation<ToolsInventoriesDeleteInput, ToolsInventoriesDeleteOutput>(
        path: "tools.inventories.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsTrack = RpcMutation<ToolsTrackInput, ToolsTrackOutput>(
    path: "tools.track",
    decodeOutput: ToolsTrackResult.codec.decode,
  );

  static final toolsTrackingsTransfersAccept =
      RpcMutation<
        ToolsTrackingsTransfersAcceptInput,
        ToolsTrackingsTransfersAcceptOutput
      >(
        path: "tools.trackings.transfers.accept",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsTrackingsTransfersDeny =
      RpcMutation<
        ToolsTrackingsTransfersDenyInput,
        ToolsTrackingsTransfersDenyOutput
      >(
        path: "tools.trackings.transfers.deny",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsTrackingsTransfersRequest =
      RpcMutation<
        ToolsTrackingsTransfersRequestInput,
        ToolsTrackingsTransfersRequestOutput
      >(
        path: "tools.trackings.transfers.request",
        decodeOutput: ClientScriptsGetRequest.codec.decode,
      );

  static final toolsUnarchive =
      RpcMutation<ToolsUnarchiveInput, ToolsUnarchiveOutput>(
        path: "tools.unarchive",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsUntrack =
      RpcMutation<ToolsUntrackInput, ToolsUntrackOutput>(
        path: "tools.untrack",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final toolsUpdate = RpcMutation<ToolsUpdateInput, ToolsUpdateOutput>(
    path: "tools.update",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final usersActivate =
      RpcMutation<UsersActivateInput, UsersActivateOutput>(
        path: "users.activate",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersArchive =
      RpcMutation<UsersArchiveInput, UsersArchiveOutput>(
        path: "users.archive",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersCreate = RpcMutation<UsersCreateInput, UsersCreateOutput>(
    path: "users.create",
    decodeOutput: ClientScriptsGetRequest.codec.decode,
  );

  static final usersDeactivate =
      RpcMutation<UsersDeactivateInput, UsersDeactivateOutput>(
        path: "users.deactivate",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersDelete = RpcMutation<UsersDeleteInput, UsersDeleteOutput>(
    path: "users.delete",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final usersRolesSet =
      RpcMutation<UsersRolesSetInput, UsersRolesSetOutput>(
        path: "users.roles.set",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersSupervisorsSetDefault =
      RpcMutation<
        UsersSupervisorsSetDefaultInput,
        UsersSupervisorsSetDefaultOutput
      >(
        path: "users.supervisors.setDefault",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersUnarchive =
      RpcMutation<UsersUnarchiveInput, UsersUnarchiveOutput>(
        path: "users.unarchive",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersUpdate = RpcMutation<UsersUpdateInput, UsersUpdateOutput>(
    path: "users.update",
    decodeOutput: AuthCheckResult.codec.decode,
  );

  static final usersVacationsApprove =
      RpcMutation<UsersVacationsApproveInput, UsersVacationsApproveOutput>(
        path: "users.vacations.approve",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersVacationsCreate =
      RpcMutation<UsersVacationsCreateInput, UsersVacationsCreateOutput>(
        path: "users.vacations.create",
        decodeOutput: UsersVacationsCreateResult.codec.decode,
      );

  static final usersVacationsDelete =
      RpcMutation<UsersVacationsDeleteInput, UsersVacationsDeleteOutput>(
        path: "users.vacations.delete",
        decodeOutput: AuthCheckResult.codec.decode,
      );

  static final usersVacationsDeny =
      RpcMutation<UsersVacationsDenyInput, UsersVacationsDenyOutput>(
        path: "users.vacations.deny",
        decodeOutput: AuthCheckResult.codec.decode,
      );
}
