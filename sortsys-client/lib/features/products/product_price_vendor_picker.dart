import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';

class ProductPriceVendorPicker extends StatelessWidget {
  const ProductPriceVendorPicker({
    super.key,
    required this.queryIdentity,
    required this.loadVendors,
    required this.createVendor,
    required this.onSelected,
    this.enabled = true,
  });

  final Object queryIdentity;
  final Future<List<models.ProductVendor>> Function(String) loadVendors;
  final Future<models.ProductVendor?> Function(String) createVendor;
  final ValueChanged<models.ProductVendor> onSelected;
  final bool enabled;

  @override
  Widget build(BuildContext context) {
    return SsEntityPicker<models.ProductVendor>(
      label: text(context, 'Händler', 'Vendors'),
      queryIdentity: queryIdentity,
      enabled: enabled,
      loadOptions: (query) {
        return loadVendors(query.trim().toLowerCase());
      },
      displayString: (vendor) {
        return vendor.name;
      },
      onSelected: onSelected,
      onCreate: createVendor,
      createLabel: (query) {
        final label = text(context, 'Händler erstellen', 'Create vendor');

        return '$label: $query';
      },
      loadingText: text(context, 'Wird geladen …', 'Loading …'),
      emptyText: text(
        context,
        'Keine Einträge vorhanden.',
        'No entries available.',
      ),
      failureText: text(
        context,
        'Einträge konnten nicht geladen werden.',
        'Entries could not be loaded.',
      ),
      selectionRequiredText: text(context, 'Pflichtfeld', 'Required field'),
      createFailureText: text(
        context,
        'Der Händlerdialog konnte nicht abgeschlossen werden.',
        'The vendor dialog could not be completed.',
      ),
    );
  }
}
