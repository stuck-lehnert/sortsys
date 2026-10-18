import 'dart:convert';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as api_models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import 'project_write_coordinator.dart';

final class SessionProjectAccess implements ProjectWriteAccess {
  SessionProjectAccess(this.session)
    : _binding = session.binding,
      scope = jsonEncode([
        session.instance?.origin.toString(),
        session.tenant,
        session.info?.userId,
      ]);

  final SessionController session;
  final String _binding;

  @override
  final String scope;

  @override
  void checkCurrent() {
    if (!session.authenticated ||
        session.binding != _binding ||
        session.info?.can('manage:projects') != true) {
      throw StateError('PROJECT_WRITE_SCOPE_CHANGED');
    }

  }

  @override
  Future<api_models.Project> getProject(String id) async {
    checkCurrent();

    final project = await session.read(
      ApiQueries.projectsGet,
      api_models.ProjectsGetInput(id: id),
    );
    checkCurrent();

    if (project.id != id) {
      throw const FormatException('PROJECT_RESPONSE_ID_MISMATCH');
    }

    return project;
  }

  @override
  Future<String> createProject(api_models.ProjectsCreateInput input) async {
    checkCurrent();

    final result = await session.write(ApiMutations.projectsCreate, input);
    checkCurrent();

    return result.id;
  }

  @override
  Future<void> updateProject(api_models.ProjectsUpdateInput input) async {
    checkCurrent();

    final result = await session.write(ApiMutations.projectsUpdate, input);
    checkCurrent();

    if (!result.success) {
      throw const FormatException('INVALID_PROJECT_UPDATE_RESULT');
    }

  }

  Future<api_models.Customer?> initialCustomer(String? id) async {
    checkCurrent();

    if (id == null || session.info?.can('view:customers') != true) {
      return null;
    }

    final customer = await session.read(
      ApiQueries.customersGet,
      api_models.CustomersGetInput(id: id),
    );
    checkCurrent();

    if (customer.id != id) {
      throw const FormatException('CUSTOMER_RESPONSE_ID_MISMATCH');
    }

    return customer;
  }

  Future<api_models.User?> initialLeader(String? id) async {
    checkCurrent();

    if (id == null || session.info?.can('view:users') != true) {
      return null;
    }

    final user = await session.read(
      ApiQueries.usersGet,
      api_models.UsersGetInput(id: id),
    );
    checkCurrent();

    if (user.id != id) {
      throw const FormatException('USER_RESPONSE_ID_MISMATCH');
    }

    return user;
  }

  Future<List<api_models.Customer>> customers(String query) async {
    checkCurrent();

    if (session.info?.can('view:customers') != true) {
      throw StateError('CUSTOMER_LOOKUP_FORBIDDEN');
    }

    final result = await session.read(
      ApiQueries.customersList,
      api_models.CustomersListInput(search: RpcOptional.value(query)),
    );
    checkCurrent();

    return result;
  }

  Future<List<api_models.User>> leaders(String query) async {
    checkCurrent();

    if (session.info?.can('view:users') != true) {
      throw StateError('PROJECT_LEADER_LOOKUP_FORBIDDEN');
    }

    final result = await session.read(
      ApiQueries.usersList,
      api_models.UsersListInput(search: RpcOptional.value(query)),
    );
    checkCurrent();

    return result;
  }

}
