import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/procedure.dart';

typedef DeliveryNoteRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);

final class DeliveryNoteReadRepository {
  DeliveryNoteReadRepository({
    required this.read,
    required this.isCurrent,
    required this.canView,
  });

  final DeliveryNoteRead read;
  final bool Function() isCurrent;
  final bool Function() canView;

  void _checkScope() {
    if (!isCurrent() || !canView()) {
      throw StateError('DELIVERY_NOTE_LIST_SCOPE_CHANGED');
    }
  }

  Future<List<models.DeliveryNote>> list() async {
    _checkScope();

    final notes = await read(
      ApiQueries.deliveryNotesList,
      const models.DeliveryNotesListInput(),
    );

    _checkScope();

    return List.unmodifiable(notes);
  }
}
