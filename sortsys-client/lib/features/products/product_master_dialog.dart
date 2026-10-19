import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'product_detail_layout.dart' show productTitle;
import 'product_draft.dart';
import 'product_form_fields.dart';
import 'product_master_receipt.dart';
import 'product_master_write_coordinator.dart';

Future<models.Product?> showProductMasterDialog(
  BuildContext context, {
  models.Product? product,
  String initialQuery = '',
  required ProductMasterWriteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canSave,
  Future<List<String>> Function()? loadUnits,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: ProductMasterDialog(
        product: product,
        initialQuery: initialQuery,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        loadUnits: loadUnits,
        enabled: canSave(),
        onSaved: (record) {
          if (!isCurrent()) {
            return;
          }

          Navigator.of(dialogContext).pop(record);
        },
        onCancel: () {
          Navigator.of(dialogContext).pop();
        },
      ),
    );
  }

  return showDialog<models.Product>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) {
      if (changes == null) {
        return buildDialog(dialogContext);
      }

      return ListenableBuilder(
        listenable: changes,
        builder: (context, child) {
          return buildDialog(context);
        },
      );
    },
  );
}

class ProductMasterDialog extends StatefulWidget {
  const ProductMasterDialog({
    super.key,
    this.product,
    this.initialQuery = '',
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.onSaved,
    required this.onCancel,
    this.loadUnits,
    this.enabled = true,
  });

  final models.Product? product;
  final String initialQuery;
  final ProductMasterWriteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final ValueChanged<models.Product> onSaved;
  final VoidCallback onCancel;
  final Future<List<String>> Function()? loadUnits;
  final bool enabled;

  @override
  State<ProductMasterDialog> createState() {
    return _ProductMasterDialogState();
  }
}

class _ProductMasterDialogState extends State<ProductMasterDialog> {
  var _form = GlobalKey<FormState>();
  late ProductFormValues _values;
  final _retiredValues = <ProductFormValues>[];
  int _epoch = 0;

  bool _checking = true;
  bool _journalKnown = false;
  bool _busy = false;
  bool _completed = false;
  bool _uncertain = false;
  bool _conflict = false;
  bool _error = false;
  ProductMasterWriteReceipt? _receipt;

  ProductFormValues _seed() {
    final product = widget.product;
    final draft = product == null
        ? ProductDraft(name: widget.initialQuery)
        : ProductDraft.fromProduct(product);

    return ProductFormValues(draft);
  }

  @override
  void initState() {
    super.initState();

    _values = _seed();
    unawaited(_loadReceipt());
  }

  @override
  void didUpdateWidget(covariant ProductMasterDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity == oldWidget.queryIdentity &&
        widget.product == oldWidget.product &&
        widget.initialQuery == oldWidget.initialQuery &&
        widget.coordinator == oldWidget.coordinator) {
      return;
    }

    _epoch++;
    _retiredValues.add(_values);
    _values = _seed();
    _form = GlobalKey<FormState>();
    _checking = true;
    _journalKnown = false;
    _busy = false;
    _completed = false;
    _uncertain = false;
    _conflict = false;
    _error = false;
    _receipt = null;
    unawaited(_loadReceipt());
  }

  @override
  void dispose() {
    _epoch++;
    _values.dispose();

    for (final values in _retiredValues) {
      values.dispose();
    }

    super.dispose();
  }

  bool _alive(int epoch) {
    return mounted && epoch == _epoch;
  }

  bool get _current {
    if (!widget.isCurrent()) {
      return false;
    }

    try {
      widget.coordinator.access.checkCurrent();

      return true;
    } catch (_) {
      return false;
    }
  }

  bool get _ready {
    return _current &&
        widget.enabled &&
        _journalKnown &&
        !_checking &&
        !_busy &&
        !_completed &&
        !_uncertain &&
        !_conflict &&
        _receipt == null;
  }

  Future<void> _loadReceipt({bool keepError = false}) async {
    final epoch = _epoch;

    try {
      final receipt = await widget.coordinator.outstanding();

      if (!_alive(epoch)) {
        return;
      }

      setState(() {
        _receipt = receipt;
        _journalKnown = true;
        _checking = false;

        if (!keepError) {
          _error = false;
        }
      });
    } catch (_) {
      if (!_alive(epoch)) {
        return;
      }

      setState(() {
        _journalKnown = false;
        _checking = false;
        _error = true;
      });
    }
  }

  Future<void> _run({required bool recover}) async {
    final receipt = _receipt;

    if (!_current || _busy || _checking || _completed) {
      return;
    }

    if (recover) {
      if (receipt == null ||
          (receipt.dispatching &&
              !receipt.acknowledged &&
              receipt.updateInput == null)) {
        return;
      }
    } else if (!_ready || _form.currentState?.validate() != true) {
      return;
    }

    final epoch = _epoch;
    final coordinator = widget.coordinator;
    models.Product? record;

    setState(() {
      _busy = true;
      _error = false;
    });

    try {
      if (recover) {
        record = await coordinator.recover(expectedNonce: receipt!.nonce);
      } else {
        record = await coordinator.save(
          _values.draft(),
          baseline: widget.product,
        );
      }

      if (_alive(epoch) && record == null) {
        _uncertain = false;
        await _loadReceipt();
      }
    } catch (error) {
      if (!_alive(epoch)) {
        return;
      }

      if (error is ProductMasterWriteException &&
          error.failure == ProductMasterWriteFailure.cleanup &&
          error.confirmedProduct != null) {
        record = error.confirmedProduct;
      } else {
        _error = true;

        if (error is ProductMasterWriteException &&
            error.failure == ProductMasterWriteFailure.uncertain) {
          _uncertain = true;
        }

        if (error is ProductMasterWriteException &&
            error.failure == ProductMasterWriteFailure.conflict) {
          _conflict = true;
        }

        await _loadReceipt(keepError: true);
      }
    } finally {
      if (_alive(epoch)) {
        setState(() {
          _busy = false;
          _completed = record != null;
        });
      }
    }

    // Caller/navigation failures must not be reclassified as failed writes.
    if (_alive(epoch) && _current && record != null) {
      widget.onSaved(record);
    }
  }

  Widget _pending(ProductMasterWriteReceipt receipt) {
    final unsent = !receipt.dispatching && !receipt.acknowledged;
    final canVerify =
        !unsent && (receipt.acknowledged || receipt.updateInput != null);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text(
          text(
            context,
            'Ein vorheriger Speichervorgang ist noch offen. Neue Änderungen bleiben '
                'gesperrt, bis sein Ergebnis geklärt ist.',
            'A previous save is unresolved. New changes remain blocked until its '
                'outcome is confirmed.',
          ),
        ),
        const SizedBox(height: 8),
        Text(
          canVerify
              ? text(
                  context,
                  'Das Ergebnis wird ausschließlich lesend überprüft. '
                      'Der Speichervorgang wird nicht wiederholt.',
                  'The result will be verified with a read-only request. '
                      'The save will not be repeated.',
                )
              : unsent
              ? text(
                  context,
                  'Dieser Vorgang wurde noch nicht gesendet und kann verworfen werden.',
                  'This operation has not been sent and can be discarded.',
                )
              : text(
                  context,
                  'Die Serverbestätigung fehlt. Dieser Vorgang wird nicht erneut '
                      'gesendet.',
                  'The server acknowledgement is missing. This operation will not '
                      'be resubmitted.',
                ),
        ),
        if (canVerify || unsent) ...[
          const SizedBox(height: 16),
          SsButton(
            kind: SsButtonKind.secondary,
            onPressed: _busy
                ? null
                : () {
                    unawaited(_run(recover: true));
                  },
            child: Text(
              canVerify
                  ? text(
                      context,
                      'Nur lesend prüfen',
                      'Verify with read-only request',
                    )
                  : text(
                      context,
                      'Nicht gesendeten Vorgang verwerfen',
                      'Discard unsent operation',
                    ),
            ),
          ),
        ],
      ],
    );
  }

  Widget _status(bool current, ProductMasterWriteReceipt? receipt) {
    if (!current) {
      return Text(text(context, 'Keine Berechtigung', 'No permission'));
    }

    if (_checking) {
      return const Center(child: SsSpinner());
    }

    if (receipt != null) {
      return _pending(receipt);
    }

    if (_journalKnown) {
      return Form(
        key: _form,
        child: ProductFormFields(
          values: _values,
          enabled: _ready,
          queryIdentity: widget.queryIdentity,
          loadUnits: widget.loadUnits,
        ),
      );
    }

    return Text(
      text(
        context,
        'Der Status des Speichervorgangs konnte nicht geprüft '
            'werden. Es werden keine Änderungen gesendet.',
        'The save status could not be checked. No changes '
            'will be submitted.',
      ),
    );
  }

  Widget _errorNotice() {
    return Text(
      _conflict
          ? text(
              context,
              'Das Produkt wurde zwischenzeitlich geändert. '
                  'Schließen Sie den Dialog und laden Sie das Produkt neu, '
                  'bevor Sie es erneut bearbeiten.',
              'The product has changed. Close this dialog and '
                  'reload the product before editing again.',
            )
          : text(
              context,
              'Der Vorgang konnte nicht abgeschlossen werden.',
              'The operation could not be completed.',
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final current = _current;
    final product = widget.product;

    return PopScope(
      canPop: !_busy,
      child: Dialog(
        shape: const RoundedRectangleBorder(),
        insetPadding: const EdgeInsets.all(16),
        backgroundColor: SsTheme.of(context).surface,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 640),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      product == null
                          ? text(context, 'Produkt erstellen', 'Create product')
                          : text(context, 'Produkt bearbeiten', 'Edit product'),
                      style: SsTheme.of(context).heading,
                    ),
                    if (current && product != null) Text(productTitle(product)),
                  ],
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _status(current, _receipt),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        _errorNotice(),
                      ],
                      if (!_journalKnown && !_checking && current) ...[
                        const SizedBox(height: 8),
                        SsButton(
                          kind: SsButtonKind.secondary,
                          onPressed: _busy
                              ? null
                              : () {
                                  setState(() {
                                    _checking = true;
                                  });
                                  unawaited(_loadReceipt());
                                },
                          child: Text(text(context, 'Erneut laden', 'Reload')),
                        ),
                      ],
                      const SizedBox(height: 16),
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(16),
                child: Wrap(
                  alignment: WrapAlignment.end,
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    if (_busy) const SsSpinner(),
                    SsButton(
                      kind: SsButtonKind.secondary,
                      onPressed: _busy ? null : widget.onCancel,
                      child: Text(text(context, 'Abbrechen', 'Cancel')),
                    ),
                    SsButton(
                      onPressed: _ready
                          ? () {
                              unawaited(_run(recover: false));
                            }
                          : null,
                      child: Text(
                        product == null
                            ? text(context, 'Erstellen', 'Create')
                            : text(context, 'Speichern', 'Save'),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
