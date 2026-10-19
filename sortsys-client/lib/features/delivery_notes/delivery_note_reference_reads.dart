import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import 'delivery_note_read_repository.dart';

final class DeliveryNoteReferenceReads {
  DeliveryNoteReferenceReads({
    required this.noteId,
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final String noteId;
  final DeliveryNoteRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _check([String? permission]) {
    if (noteId.isEmpty || !isCurrent() || !can('view:deliveryNotes')) {
      throw StateError('DELIVERY_NOTE_REFERENCE_SCOPE_CHANGED');
    }

    if (permission != null && !can(permission)) {
      throw StateError('DELIVERY_NOTE_REFERENCE_PERMISSION_CHANGED');
    }
  }

  Future<models.Product> product(String productId) async {
    _check('view:products');

    if (productId.isEmpty) {
      throw const FormatException('INVALID_DELIVERY_PRODUCT_ID');
    }

    final product = await read(
      ApiQueries.productsGet,
      models.ProductsGetInput(id: productId),
    );
    _check('view:products');

    if (product.id != productId) {
      throw const FormatException('DELIVERY_PRODUCT_RESPONSE_MISMATCH');
    }

    return product;
  }

  Future<models.User> author(String userId) async {
    _check('view:users');

    if (userId.isEmpty) {
      throw const FormatException('INVALID_DELIVERY_AUTHOR_ID');
    }

    final user = await read(
      ApiQueries.usersGet,
      models.UsersGetInput(id: userId),
    );
    _check('view:users');

    if (user.id != userId) {
      throw const FormatException('DELIVERY_AUTHOR_RESPONSE_MISMATCH');
    }

    return user;
  }

  Future<models.Project> project(String projectId) async {
    _check();

    if (projectId.isEmpty) {
      throw const FormatException('INVALID_DELIVERY_PROJECT_ID');
    }

    // The backend also authorizes assigned projects without global visibility.
    final globallyVisible = can('view:projects');
    final project = await read(
      ApiQueries.projectsGet,
      models.ProjectsGetInput(id: projectId),
    );
    _check();

    if (can('view:projects') != globallyVisible) {
      throw StateError('DELIVERY_PROJECT_VISIBILITY_CHANGED');
    }

    if (project.id != projectId) {
      throw const FormatException('DELIVERY_PROJECT_RESPONSE_MISMATCH');
    }

    return project;
  }
}
