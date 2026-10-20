import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';
import 'product_categories_draft.dart';
import 'product_categories_picker.dart';
import 'product_categories_receipt.dart';
import 'product_categories_write_coordinator.dart';
import 'product_detail_layout.dart' show productTitle;

Future<models.Product?> showProductCategoriesDialog(
  BuildContext context, {
  required models.Product product,
  required ProductCategoriesWriteCoordinator coordinator,
  required Object queryIdentity,
  required bool Function() isCurrent,
  required bool Function() canSave,
  required Future<List<String>> Function() loadCategories,
  Listenable? changes,
}) {
  final colors = SsTheme.of(context);

  Widget buildDialog(BuildContext dialogContext) {
    return SsTheme(
      colors: colors,
      child: ProductCategoriesDialog(
        product: product,
        coordinator: coordinator,
        queryIdentity: queryIdentity,
        isCurrent: isCurrent,
        enabled: canSave(),
        loadCategories: loadCategories,
        onSaved: (record) {
          if (!isCurrent() || !dialogContext.mounted) {
            return;
          }

          Navigator.of(dialogContext).pop(record);
        },
        onCancel: () {
          if (!dialogContext.mounted) {
            return;
          }

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

class ProductCategoriesDialog extends StatefulWidget {
  const ProductCategoriesDialog({
    super.key,
    required this.product,
    required this.coordinator,
    required this.queryIdentity,
    required this.isCurrent,
    required this.loadCategories,
    required this.onSaved,
    required this.onCancel,
    this.enabled = true,
  });

  final models.Product product;
  final ProductCategoriesWriteCoordinator coordinator;
  final Object queryIdentity;
  final bool Function() isCurrent;
  final Future<List<String>> Function() loadCategories;
  final ValueChanged<models.Product> onSaved;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<ProductCategoriesDialog> createState() {
    return _ProductCategoriesDialogState();
  }
}

class _ProductCategoriesDialogState extends State<ProductCategoriesDialog> {
  late models.Product _baseline;
  late String _scope;
  late List<String> _selected;
  List<String> _options = const [];
  ProductCategoriesWriteReceipt? _receipt;
  ProductCategoriesDraftIssue? _invalid;
  int _epoch = 0;

  bool _checkingReceipt = true;
  bool _journalKnown = false;
  bool _loadingOptions = true;
  bool _optionsKnown = false;
  bool _busy = false;
  bool _completed = false;
  bool _uncertain = false;
  bool _conflict = false;
  bool _error = false;

  void _seed() {
    final product = widget.product;

    _scope = widget.coordinator.access.scope;
    _baseline = models.Product(
      id: product.id,
      customId: product.customId,
      name: product.name,
      brand: product.brand,
      description: product.description,
      regieReportName: product.regieReportName,
      baseUnit: product.baseUnit,
      otherUnits: models.ApplyPriceImportRowOtherUnits(
        Map.unmodifiable(product.otherUnits.values),
      ),
      categories: List.unmodifiable(product.categories),
    );
    _selected = List.unmodifiable(_baseline.categories);
  }

  @override
  void initState() {
    super.initState();

    _seed();

    unawaited(_loadReceipt());
    unawaited(_loadOptions());
  }

  @override
  void didUpdateWidget(covariant ProductCategoriesDialog oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.queryIdentity == oldWidget.queryIdentity &&
        widget.coordinator == oldWidget.coordinator &&
        widget.product.id == oldWidget.product.id) {
      return;
    }

    _epoch++;
    _seed();
    _options = const [];
    _receipt = null;
    _invalid = null;
    _checkingReceipt = true;
    _journalKnown = false;
    _loadingOptions = true;
    _optionsKnown = false;
    _busy = false;
    _completed = false;
    _uncertain = false;
    _conflict = false;
    _error = false;

    unawaited(_loadReceipt());
    unawaited(_loadOptions());
  }

  @override
  void dispose() {
    _epoch++;

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
      final access = widget.coordinator.access;

      access.checkCurrent();

      return access.scope == _scope &&
          access.productId == _baseline.id &&
          widget.product.id == _baseline.id;
    } catch (_) {
      return false;
    }
  }

  bool get _ready {
    return _current &&
        widget.enabled &&
        _journalKnown &&
        !_checkingReceipt &&
        _optionsKnown &&
        !_loadingOptions &&
        !_busy &&
        !_completed &&
        !_uncertain &&
        !_conflict &&
        _receipt == null;
  }

  Future<void> _loadReceipt({bool keepError = false}) async {
    final epoch = _epoch;
    final coordinator = widget.coordinator;

    try {
      if (!_current) {
        throw StateError('PRODUCT_CATEGORIES_DIALOG_OWNER_CHANGED');
      }

      final receipt = await coordinator.outstanding();

      if (!_alive(epoch)) {
        return;
      }

      if (!_current) {
        throw StateError('PRODUCT_CATEGORIES_DIALOG_OWNER_CHANGED');
      }

      setState(() {
        _receipt = receipt;
        _journalKnown = true;
        _checkingReceipt = false;

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
        _checkingReceipt = false;
        _error = true;
      });
    }
  }

  Future<void> _loadOptions() async {
    final epoch = _epoch;
    final load = widget.loadCategories;

    try {
      if (!_current) {
        throw StateError('PRODUCT_CATEGORIES_DIALOG_OWNER_CHANGED');
      }

      final options = await load();

      if (!_alive(epoch)) {
        return;
      }

      if (!_current) {
        throw StateError('PRODUCT_CATEGORIES_DIALOG_OWNER_CHANGED');
      }

      setState(() {
        _options = List.unmodifiable(options);
        _optionsKnown = true;
        _loadingOptions = false;
      });
    } catch (_) {
      if (!_alive(epoch)) {
        return;
      }

      setState(() {
        _optionsKnown = false;
        _loadingOptions = false;
      });
    }
  }

  Future<void> _run({required bool recover}) async {
    if (!mounted || !_current || _busy || _checkingReceipt || _completed) {
      return;
    }

    final receipt = _receipt;
    final draft = ProductCategoriesDraft(
      productId: _baseline.id,
      categories: _selected,
    );

    if (recover) {
      if (receipt == null) {
        return;
      }
    } else {
      if (!_ready) {
        return;
      }

      final issues = draft.validate();

      if (issues.isNotEmpty) {
        setState(() {
          _invalid = issues.values.first;
        });

        return;
      }
    }

    final epoch = _epoch;
    final coordinator = widget.coordinator;
    final baseline = _baseline;
    models.Product? record;

    setState(() {
      _busy = true;
      _error = false;
    });

    try {
      if (recover) {
        record = await coordinator.recover(expectedNonce: receipt!.nonce);
      } else {
        record = await coordinator.save(draft, baseline: baseline);
      }

      if (_alive(epoch) && record == null) {
        _uncertain = false;

        await _loadReceipt();
      }
    } catch (error) {
      if (!_alive(epoch)) {
        return;
      }

      if (error is ProductCategoriesWriteException &&
          error.failure == ProductCategoriesWriteFailure.cleanup &&
          error.confirmedProduct != null) {
        record = error.confirmedProduct;
      } else {
        _error = true;

        if (error is ProductCategoriesWriteException &&
            error.failure == ProductCategoriesWriteFailure.uncertain) {
          _uncertain = true;
        }

        if (error is ProductCategoriesWriteException &&
            error.failure == ProductCategoriesWriteFailure.conflict) {
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

    // Navigation failures must not be reclassified as failed business writes.
    if (_alive(epoch) && _current && record != null) {
      widget.onSaved(record);
    }
  }

  String? _validationText() {
    return switch (_invalid) {
      null => null,
      ProductCategoriesDraftIssue.required => text(
        context,
        'Eine Kategorie darf nicht leer sein.',
        'A category cannot be empty.',
      ),
      ProductCategoriesDraftIssue.tooLong => text(
        context,
        'Eine Kategorie darf nach dem Kürzen höchstens 127 UTF-8-Bytes enthalten.',
        'A category must contain at most 127 UTF-8 bytes after trimming.',
      ),
      ProductCategoriesDraftIssue.invalidUnicode => text(
        context,
        'Eine Kategorie enthält ungültige Unicode-Zeichen.',
        'A category contains invalid Unicode characters.',
      ),
    };
  }

  Widget _pending(ProductCategoriesWriteReceipt receipt) {
    final unsent = !receipt.dispatching && !receipt.acknowledged;
    final epoch = _epoch;

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
          unsent
              ? text(
                  context,
                  'Dieser Vorgang wurde noch nicht gesendet und kann verworfen werden.',
                  'This operation has not been sent and can be discarded.',
                )
              : text(
                  context,
                  'Das Ergebnis wird ausschließlich lesend überprüft. '
                      'Der Speichervorgang wird nicht wiederholt.',
                  'The result will be verified with a read-only request. '
                      'The save will not be repeated.',
                ),
        ),
        const SizedBox(height: 16),
        SsButton(
          kind: SsButtonKind.secondary,
          onPressed: _busy
              ? null
              : () {
                  if (!_alive(epoch) || _receipt?.nonce != receipt.nonce) {
                    return;
                  }

                  unawaited(_run(recover: true));
                },
          child: Text(
            unsent
                ? text(
                    context,
                    'Nicht gesendeten Vorgang verwerfen',
                    'Discard unsent operation',
                  )
                : text(
                    context,
                    'Nur lesend prüfen',
                    'Verify with read-only request',
                  ),
          ),
        ),
      ],
    );
  }

  Widget _body(bool current) {
    final epoch = _epoch;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!current)
          Text(text(context, 'Keine Berechtigung', 'No permission')),
        Visibility(
          visible: current,
          maintainState: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_checkingReceipt) const Center(child: SsSpinner()),
              if (!_checkingReceipt && !_journalKnown) ...[
                Text(
                  text(
                    context,
                    'Der Status des Speichervorgangs konnte nicht geprüft werden. '
                        'Es werden keine Änderungen gesendet.',
                    'The save status could not be checked. '
                        'No changes will be submitted.',
                  ),
                ),
                const SizedBox(height: 8),
                SsButton(
                  kind: SsButtonKind.secondary,
                  onPressed: _busy
                      ? null
                      : () {
                          if (!_alive(epoch) ||
                              !_current ||
                              _busy ||
                              _checkingReceipt) {
                            return;
                          }

                          setState(() {
                            _checkingReceipt = true;
                          });

                          unawaited(_loadReceipt());
                        },
                  child: Text(text(context, 'Erneut laden', 'Reload')),
                ),
              ],
              if (_receipt case final receipt?) ...[
                _pending(receipt),
                const SizedBox(height: 16),
              ],
              if (_loadingOptions && !_checkingReceipt)
                const Center(child: SsSpinner()),
              if (!_loadingOptions && !_optionsKnown) ...[
                Text(
                  text(
                    context,
                    'Die Kategorien konnten nicht geladen werden.',
                    'Categories could not be loaded.',
                  ),
                ),
                const SizedBox(height: 8),
                SsButton(
                  kind: SsButtonKind.secondary,
                  onPressed: _busy
                      ? null
                      : () {
                          if (!_alive(epoch) ||
                              !_current ||
                              _busy ||
                              _loadingOptions) {
                            return;
                          }

                          setState(() {
                            _loadingOptions = true;
                          });

                          unawaited(_loadOptions());
                        },
                  child: Text(
                    text(context, 'Kategorien neu laden', 'Reload categories'),
                  ),
                ),
              ],
              Visibility(
                visible: _optionsKnown,
                maintainState: true,
                child: ProductCategoriesPicker(
                  key: ValueKey((_scope, _baseline.id, _epoch)),
                  label: text(context, 'Kategorien', 'Categories'),
                  options: _options,
                  selected: _selected,
                  queryIdentity: (widget.queryIdentity, _epoch),
                  enabled: _ready,
                  error: _validationText(),
                  onChanged: (values) {
                    if (!_alive(epoch) || !_ready) {
                      return;
                    }

                    setState(() {
                      _selected = List.unmodifiable(values);
                      _invalid = null;
                    });
                  },
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }

  Widget _errorNotice() {
    return Text(
      _conflict
          ? text(
              context,
              'Die Kategorien wurden zwischenzeitlich geändert. Schließen Sie den '
                  'Dialog und laden Sie das Produkt neu, bevor Sie es erneut bearbeiten.',
              'The categories have changed. Close this dialog and reload the product '
                  'before editing again.',
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
    final epoch = _epoch;

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
                      text(context, 'Kategorien bearbeiten', 'Edit categories'),
                      style: SsTheme.of(context).heading,
                    ),
                    if (current) Text(productTitle(_baseline)),
                  ],
                ),
              ),
              Flexible(
                child: SingleChildScrollView(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      _body(current),
                      if (_error && current) ...[
                        const SizedBox(height: 16),
                        _errorNotice(),
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
                      onPressed: _busy
                          ? null
                          : () {
                              if (!_alive(epoch) || _busy) {
                                return;
                              }

                              widget.onCancel();
                            },
                      child: Text(text(context, 'Abbrechen', 'Cancel')),
                    ),
                    SsButton(
                      onPressed: _ready
                          ? () {
                              if (!_alive(epoch)) {
                                return;
                              }

                              unawaited(_run(recover: false));
                            }
                          : null,
                      child: Text(text(context, 'Speichern', 'Save')),
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
