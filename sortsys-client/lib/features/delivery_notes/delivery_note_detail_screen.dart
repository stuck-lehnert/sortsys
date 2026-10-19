import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import '../users/user_list_state.dart' show userListName;
import 'delivery_note_detail_layout.dart';
import 'delivery_note_detail_reads.dart';
import 'delivery_note_product_results.dart';
import 'delivery_note_products.dart';
import 'delivery_note_reference_reads.dart';
import 'delivery_note_special_items.dart';

class DeliveryNoteDetailScreen extends HookWidget {
  const DeliveryNoteDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final owner = useRef(id);
    final mounted = useRef(true);
    final revision = useState(0);
    final costRevision = useState(0);
    owner.value = id;

    useEffect(() {
      return () {
        mounted.value = false;
      };
    }, const []);

    bool isCurrent() {
      return mounted.value &&
          owner.value == id &&
          session.authenticated &&
          session.binding == binding;
    }

    bool can(String permission) {
      return session.info?.can(permission) == true;
    }

    final allowed = session.authenticated && can('view:deliveryNotes');
    final reads = DeliveryNoteDetailReads(
      noteId: id,
      read: session.read,
      isCurrent: isCurrent,
      canView: () {
        return can('view:deliveryNotes');
      },
    );
    final references = DeliveryNoteReferenceReads(
      noteId: id,
      read: session.read,
      isCurrent: isCurrent,
      can: can,
    );
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return reads.get();
    }, [binding, id, allowed, revision.value]);
    final snapshot = useFuture(future, preserveState: false);
    final note = snapshot.data;
    final costFuture = useMemoized(() {
      if (!allowed || note == null) {
        return null;
      }

      return reads.costs();
    }, [binding, id, allowed, note, costRevision.value]);
    final costs = useFuture(costFuture, preserveState: false);

    if (!allowed) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    if (snapshot.hasError) {
      return Center(
        child: _DeliveryReadError(
          onRetry: () {
            revision.value++;
          },
        ),
      );
    }

    if (note == null) {
      return const Center(child: SsSpinner());
    }

    void navigate(Uri target) {
      if (isCurrent() && can('view:deliveryNotes')) {
        context.go(target.toString());
      }
    }

    final authorId = note.createdByUserId;

    return Column(
      children: [
        if (costs.hasError)
          _DeliveryReadError(
            onRetry: () {
              costRevision.value++;
            },
          ),
        Expanded(
          child: DeliveryNoteDetailLayout(
            key: ValueKey((binding, id)),
            note: note,
            costs: costs.data,
            project: _DeliveryReference<models.Project>(
              requestKey: (binding, id, note.projectId, can('view:projects')),
              allowed: allowed,
              read: () {
                return references.project(note.projectId);
              },
              builder: (context, project) {
                final uri = Uri.parse(
                  '/projects/${Uri.encodeComponent(project.id)}',
                );

                return SsLink(
                  uri: uri,
                  onPressed: () {
                    navigate(uri);
                  },
                  child: Text(project.title),
                );
              },
            ),
            author: authorId == null || authorId.isEmpty
                ? null
                : _DeliveryReference<models.User>(
                    requestKey: (binding, id, authorId),
                    allowed: allowed && can('view:users'),
                    read: () {
                      return references.author(authorId);
                    },
                    builder: (context, author) {
                      final uri = Uri.parse(
                        '/users/${Uri.encodeComponent(author.id)}',
                      );

                      return SsLink(
                        uri: uri,
                        onPressed: () {
                          if (can('view:users')) {
                            navigate(uri);
                          }
                        },
                        child: Text(userListName(author)),
                      );
                    },
                  ),
            products: _DeliveryProducts(
              key: ValueKey((binding, id)),
              note: note,
              costs: costs.data,
              references: references,
              allowed: allowed && can('view:products'),
              binding: binding,
              onNavigate: (target) {
                if (target.path.startsWith('/products/deliveryNotes/') ||
                    can('view:products')) {
                  navigate(target);
                }
              },
            ),
            specialItems: DeliveryNoteSpecialItems(
              key: ValueKey((binding, id, 'special')),
              records: note.specialRecords.where((record) {
                return record.noteId == id;
              }).toList(),
            ),
          ),
        ),
      ],
    );
  }
}

class _DeliveryReference<T> extends HookWidget {
  const _DeliveryReference({
    required this.requestKey,
    required this.allowed,
    required this.read,
    required this.builder,
  });

  final Object requestKey;
  final bool allowed;
  final Future<T> Function() read;
  final Widget Function(BuildContext context, T value) builder;

  @override
  Widget build(BuildContext context) {
    final revision = useState(0);
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return read();
    }, [requestKey, allowed, revision.value]);
    final snapshot = useFuture(future, preserveState: false);
    final value = snapshot.data;

    if (!allowed) {
      return Text(text(context, 'Unbekannt', 'Unknown'));
    }

    if (snapshot.hasError) {
      return _DeliveryReadError(
        onRetry: () {
          revision.value++;
        },
      );
    }

    if (value == null) {
      return const SsSpinner(size: 14);
    }

    return builder(context, value);
  }
}

class _DeliveryProducts extends HookWidget {
  const _DeliveryProducts({
    super.key,
    required this.note,
    required this.costs,
    required this.references,
    required this.allowed,
    required this.binding,
    required this.onNavigate,
  });

  final models.DeliveryNote note;
  final models.DeliveryNotesCostsGetOutput? costs;
  final DeliveryNoteReferenceReads references;
  final bool allowed;
  final String binding;
  final ValueChanged<Uri> onNavigate;

  @override
  Widget build(BuildContext context) {
    final revision = useState(0);
    final futures = useMemoized(() {
      if (!allowed) {
        return <String, Future<models.Product>>{};
      }

      final identifiers = {
        for (final record in note.records)
          if (record.noteId == note.id && record.productId.isNotEmpty)
            record.productId,
      };

      return {for (final id in identifiers) id: references.product(id)};
    }, [binding, note, allowed, revision.value]);

    return DeliveryNoteProductResults(
      futures: futures,
      builder: (context, products, pending, failed) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (failed)
              _DeliveryReadError(
                onRetry: () {
                  revision.value++;
                },
              ),
            DeliveryNoteProducts(
              noteId: note.id,
              records: note.records,
              products: products,
              loadingProductIds: pending,
              costs: costs,
              uri: GoRouterState.of(context).uri,
              onNavigate: onNavigate,
            ),
          ],
        );
      },
    );
  }
}

class _DeliveryReadError extends StatelessWidget {
  const _DeliveryReadError({required this.onRetry});

  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Wrap(
      spacing: 8,
      runSpacing: 8,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          text(
            context,
            'Einträge konnten nicht geladen werden.',
            'Entries could not be loaded.',
          ),
        ),
        SsButton(
          kind: SsButtonKind.secondary,
          onPressed: onRetry,
          child: Text(text(context, 'Erneut laden', 'Reload')),
        ),
      ],
    );
  }
}
