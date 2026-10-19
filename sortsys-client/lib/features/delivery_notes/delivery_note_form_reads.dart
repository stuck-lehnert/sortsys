import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import 'delivery_note_read_repository.dart';

final class DeliveryNoteFormReads {
  DeliveryNoteFormReads({
    required this.read,
    required this.isCurrent,
    required this.can,
  });

  final DeliveryNoteRead read;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  void _check([String? permission]) {
    if (!isCurrent() || !can('manage:deliveryNotes')) {
      throw StateError('DELIVERY_NOTE_FORM_SCOPE_CHANGED');
    }

    if (permission != null && !can(permission)) {
      throw StateError('DELIVERY_NOTE_FORM_PERMISSION_CHANGED');
    }
  }

  Future<List<models.Project>> projects(String search) async {
    _check();

    // Keep the server's assigned-project picker available without global view.
    final globallyVisible = can('view:projects');
    final rows = await read(
      ApiQueries.projectsList,
      models.ProjectsListInput(search: RpcOptional.value(search)),
    );
    _check();

    if (can('view:projects') != globallyVisible) {
      throw StateError('DELIVERY_NOTE_FORM_PROJECT_VISIBILITY_CHANGED');
    }

    return List.unmodifiable(rows);
  }

  Future<List<models.Product>> products(String search) async {
    _check('view:products');

    final rows = await read(
      ApiQueries.productsList,
      models.ProductsListInput(search: RpcOptional.value(search)),
    );
    _check('view:products');

    return List.unmodifiable(rows);
  }
}
