import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../projects/project_filter.dart';
import 'entity_record.dart';

Future<List<EntityRecord>> loadEntityList(
  SessionController session,
  String key,
  String search, {
  ProjectListStatus projectStatus = ProjectListStatus.active,
}) async {
  final querySearch = search.isEmpty
      ? const RpcOptional<String>.absent()
      : RpcOptional<String>.value(search);

  final Future<List<RpcValue>> response = switch (key) {
    'projects' => session.read(
      ApiQueries.projectsList,
      projectListInput(search, projectStatus),
    ),
    'products' => session.read(
      ApiQueries.productsList,
      api_models.ProductsListInput(search: querySearch),
    ),
    'tools' => session.read(
      ApiQueries.toolsList,
      api_models.ToolsListInput(search: querySearch),
    ),
    'users' => session.read(
      ApiQueries.usersList,
      api_models.UsersListInput(search: querySearch),
    ),
    'customers' => session.read(
      ApiQueries.customersList,
      api_models.CustomersListInput(search: querySearch),
    ),
    'contacts' => session.read(
      ApiQueries.contactsList,
      api_models.ContactsListInput(search: querySearch),
    ),
    'vendors' => session.read(
      ApiQueries.productsVendorsList,
      api_models.ProductsVendorsListInput(search: querySearch),
    ),
    'delivery-notes' => session.read(
      ApiQueries.deliveryNotesList,
      const api_models.DeliveryNotesListInput(),
    ),
    'regie-reports' => session.read(
      ApiQueries.regieReportsList,
      const api_models.RegieReportsListInput(),
    ),
    _ => throw const FormatException('UNKNOWN_ENTITY_KIND'),
  };

  final resources = await response;

  final records = resources
      .map(EntityRecord.fromResource)
      .toList(growable: false);

  return records;
}

Future<EntityRecord> loadEntityDetail(
  SessionController session,
  String key,
  String id,
) async {
  final request = api_models.ProjectsGetInput(id: id);

  final Future<RpcValue> response = switch (key) {
    'projects' => session.read(ApiQueries.projectsGet, request),
    'products' => session.read(ApiQueries.productsGet, request),
    'tools' => session.read(ApiQueries.toolsGet, request),
    'users' => session.read(ApiQueries.usersGet, request),
    'customers' => session.read(ApiQueries.customersGet, request),
    'contacts' => session.read(ApiQueries.contactsGet, request),
    'vendors' => session.read(ApiQueries.productsVendorsGet, request),
    'delivery-notes' => session.read(
      ApiQueries.deliveryNotesGet,
      api_models.DeliveryNotesGetRequestObject(request),
    ),
    'regie-reports' => session.read(ApiQueries.regieReportsGet, request),
    _ => throw const FormatException('UNKNOWN_ENTITY_KIND'),
  };

  final resource = await response;

  return EntityRecord.fromResource(resource);
}
