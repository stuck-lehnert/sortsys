import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import 'delivery_note_read_repository.dart';

final class DeliveryNoteDetailReads {
  DeliveryNoteDetailReads({
    required this.noteId,
    required this.read,
    required this.isCurrent,
    required this.canView,
  });

  final String noteId;
  final DeliveryNoteRead read;
  final bool Function() isCurrent;
  final bool Function() canView;

  void _checkScope() {
    if (noteId.isEmpty || !isCurrent() || !canView()) {
      throw StateError('DELIVERY_NOTE_DETAIL_SCOPE_CHANGED');
    }
  }

  Future<models.DeliveryNote> get() async {
    _checkScope();

    final note = await read(
      ApiQueries.deliveryNotesGet,
      models.DeliveryNotesGetRequestObject(
        models.ClientScriptsGetRequest(id: noteId),
      ),
    );

    _checkScope();

    if (note.id != noteId) {
      throw StateError('DELIVERY_NOTE_RESPONSE_MISMATCH');
    }

    return models.DeliveryNote(
      id: note.id,
      autoId: note.autoId,
      projectId: note.projectId,
      comment: note.comment,
      createdByUserId: note.createdByUserId,
      createdAt: note.createdAt,
      effectiveTimestamp: note.effectiveTimestamp,
      records: List.unmodifiable(note.records),
      specialRecords: List.unmodifiable(note.specialRecords),
    );
  }

  Future<models.DeliveryNotesCostsGetOutput> costs() async {
    _checkScope();

    final costs = await read(
      ApiQueries.deliveryNotesCostsGet,
      models.DeliveryNotesCostsGetInput(id: noteId),
    );

    _checkScope();

    if (costs.noteId != noteId) {
      throw StateError('DELIVERY_NOTE_COST_OWNER_MISMATCH');
    }

    final recordIds = <String>{};

    for (final record in costs.records) {
      if (record.recordId.isEmpty ||
          !recordIds.add(record.recordId) ||
          (record.priceRecord != null &&
              record.priceRecord!.productId != record.productId)) {
        throw const FormatException('DELIVERY_NOTE_COST_RECORD_MISMATCH');
      }
    }

    final specialIds = <String>{};

    for (final record in costs.specialRecords) {
      if (record.recordId.isEmpty || !specialIds.add(record.recordId)) {
        throw const FormatException('DELIVERY_NOTE_SPECIAL_COST_MISMATCH');
      }
    }

    return models.DeliveryNotesCostsGetOutput(
      noteId: costs.noteId,
      totalCost: costs.totalCost,
      records: List.unmodifiable(costs.records),
      specialRecords: List.unmodifiable(costs.specialRecords),
    );
  }
}
