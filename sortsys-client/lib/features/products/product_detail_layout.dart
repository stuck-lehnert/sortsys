import 'package:flutter/widgets.dart';
import 'package:intl/intl.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../ui/text.dart';

typedef ProductUnitEquivalent = ({num amount, String unit});
typedef ProductUnitOverview = ({
  String unit,
  List<ProductUnitEquivalent> equivalents,
});

String productTitle(models.Product product) {
  final brand = product.brand;

  if (brand != null && brand.isNotEmpty) {
    return '$brand ${product.name}';
  }

  return product.name;
}

List<ProductUnitOverview> productUnitsOverview(models.Product product) {
  final units = product.otherUnits.values;
  final ordered = units.entries.indexed.toList();
  ordered.sort((left, right) {
    final comparison = left.$2.value.compareTo(right.$2.value);

    if (comparison == 0) {
      return left.$1.compareTo(right.$1);
    }

    return comparison;
  });
  final result = <ProductUnitOverview>[];

  for (final indexed in ordered) {
    final entry = indexed.$2;
    final equivalents = <ProductUnitEquivalent>[
      (amount: entry.value, unit: product.baseUnit),
    ];

    for (final other in units.entries) {
      if (other.key == entry.key ||
          other.value > entry.value ||
          other.value == 0) {
        continue;
      }

      if (entry.value % other.value == 0) {
        equivalents.add((
          amount: (entry.value / other.value).round(),
          unit: other.key,
        ));
      }
    }

    final indexedEquivalents = equivalents.indexed.toList();
    indexedEquivalents.sort((left, right) {
      final comparison = left.$2.amount.compareTo(right.$2.amount);

      if (comparison == 0) {
        return left.$1.compareTo(right.$1);
      }

      return comparison;
    });
    result.add((
      unit: entry.key,
      equivalents: List.unmodifiable(
        indexedEquivalents.map((item) {
          return item.$2;
        }),
      ),
    ));
  }

  return List.unmodifiable(result);
}

models.ProductsPriceRecordsListResultItem? latestProductPrice(
  List<models.ProductsPriceRecordsListResultItem> records,
) {
  models.ProductsPriceRecordsListResultItem? latest;

  for (final record in records) {
    if (latest == null || record.timestamp.isAfter(latest.timestamp)) {
      latest = record;
    }
  }

  return latest;
}

class ProductDetailLayout extends StatelessWidget {
  const ProductDetailLayout({
    super.key,
    required this.product,
    this.headerActions,
    this.priceRecords = const [],
    this.priceError,
    this.onRetryPrices,
    this.priceHistory,
  });

  final models.Product product;
  final Widget? headerActions;
  final List<models.ProductsPriceRecordsListResultItem> priceRecords;
  final Object? priceError;
  final VoidCallback? onRetryPrices;
  final Widget? priceHistory;

  @override
  Widget build(BuildContext context) {
    final title = productTitle(product);
    final locale = Localizations.localeOf(context).languageCode == 'en'
        ? 'en_GB'
        : 'de_DE';
    final numbers = NumberFormat('#,##0.00##', locale);
    final currency = NumberFormat.currency(
      locale: locale,
      name: 'EUR',
      symbol: '€',
      decimalDigits: 2,
    );
    final latest = latestProductPrice(priceRecords);
    final units = productUnitsOverview(product);
    final content = ListView(
      padding: EdgeInsets.zero,
      children: [
        SsPageHeader(title: title, actions: headerActions),
        if (product.categories.isNotEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final category in product.categories)
                  SsTag(tone: SsTagTone.outline, child: Text(category)),
              ],
            ),
          ),
        _divider(context),
        SsAttributeList(
          children: [
            SsAttribute(
              label: text(context, 'Nummer', 'Number'),
              child: Text(product.customId.toString().replaceFirst(RegExp(r'\.0$'), '')),
            ),
            SsAttribute(label: 'Bezeichnung', child: Text(product.name)),
            if (product.regieReportName?.isNotEmpty == true)
              SsAttribute(
                label: text(
                  context,
                  'Bezeichnung für Regieberichte',
                  'Designation for time-and-material reports',
                ),
                child: Text(product.regieReportName!),
              ),
            if (product.brand?.isNotEmpty == true)
              SsAttribute(label: 'Hersteller', child: Text(product.brand!)),
            if (product.description?.isNotEmpty == true)
              SsAttribute(
                label: text(context, 'Beschreibung', 'Description'),
                child: Text(product.description!),
              ),
            SsAttribute(label: 'Basiseinheit', child: Text(product.baseUnit)),
            if (latest != null)
              SsAttribute(
                label: 'Letzer EK-Preis',
                child: Text('${currency.format(latest.price)} / ${product.baseUnit}'),
              ),
          ],
        ),
        if (priceError != null)
          Padding(
            padding: const EdgeInsets.only(top: 12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(text(
                  context,
                  'Preise konnten nicht geladen werden.',
                  'Prices could not be loaded.',
                )),
                if (onRetryPrices != null)
                  SsButton(
                    kind: SsButtonKind.secondary,
                    onPressed: onRetryPrices,
                    child: Text(text(context, 'Erneut laden', 'Reload')),
                  ),
              ],
            ),
          ),
        _divider(context),
        if (units.isNotEmpty)
          SsDisclosure(
            title: text(context, 'Andere Einheiten', 'Other units'),
            initiallyExpanded: true,
            child: SsAttributeList(
              children: [
                for (final unit in units)
                  SsAttribute(
                    label: unit.unit,
                    child: Text(unit.equivalents.map((equivalent) {
                      return '${numbers.format(equivalent.amount)} ${equivalent.unit}';
                    }).join('\n')),
                  ),
              ],
            ),
          ),
        if (priceHistory != null) ...[
          const SizedBox(height: 8),
          priceHistory!,
        ],
      ],
    );

    if (title.isEmpty) {
      return content;
    }

    return Title(title: title, color: SsTheme.of(context).surface, child: content);
  }
}

Widget _divider(BuildContext context) {
  return Padding(
    padding: const EdgeInsets.symmetric(vertical: 12),
    child: Container(height: 1, color: SsTheme.of(context).border),
  );
}
