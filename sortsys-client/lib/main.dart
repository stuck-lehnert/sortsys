import 'dart:async';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import 'app.dart';
import 'features/products/product_categories_license.dart';
import 'state/session_controller.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();

  registerProductCategoryLicense();

  runApp(
    ChangeNotifierProvider(
      create: (_) {
        final session = SessionController();
        unawaited(session.restore());

        return session;
      },

      child: const SortsysApp(),
    ),
  );
}
