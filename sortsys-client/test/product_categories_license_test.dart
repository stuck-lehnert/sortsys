import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/features/products/product_categories_license.dart';
import 'package:sortsys_client/features/products/product_categories_unicode_data.dart';

void main() {
  test('registers the complete pinned Unicode license only once', () async {
    LicenseRegistry.reset();
    final expected = LicenseEntryWithLineBreaks(const [
      'Unicode',
    ], productCategoryUnicodeLicense);

    registerProductCategoryLicense();
    registerProductCategoryLicense();

    final entries = await LicenseRegistry.licenses.toList();

    expect(entries, hasLength(1));
    expect(entries.single.packages, ['Unicode']);
    expect(_paragraphs(entries.single), _paragraphs(expected));
    expect(utf8.encode(productCategoryUnicodeLicense), hasLength(1995));
  });
}

List<(String, int)> _paragraphs(LicenseEntry entry) {
  return entry.paragraphs.map((paragraph) {
    return (paragraph.text, paragraph.indent);
  }).toList();
}
