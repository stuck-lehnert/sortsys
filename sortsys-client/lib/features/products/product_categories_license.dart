import 'package:flutter/foundation.dart';

import 'product_categories_unicode_data.dart';

bool _registered = false;

void registerProductCategoryLicense() {
  if (_registered) {
    return;
  }

  _registered = true;

  LicenseRegistry.addLicense(() async* {
    yield LicenseEntryWithLineBreaks(const [
      'Unicode',
    ], productCategoryUnicodeLicense);
  });
}
