import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/api/generated/models.g.dart' as models;
import 'package:sortsys_client/features/customers/customer_list_screen.dart';
import 'package:sortsys_client/features/customers/customer_list_state.dart';
import 'package:sortsys_client/features/projects/project_list_screen.dart';
import 'package:sortsys_client/features/projects/project_list_state.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

void main() {
  for (final customers in [false, true]) {
    testWidgets(
      '${customers ? 'customer' : 'project'} page-size change resets page like React',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1200, 800);
        addTearDown(tester.view.resetDevicePixelRatio);
        addTearDown(tester.view.resetPhysicalSize);

        final suffix = customers ? 'Customers' : 'Projects';
        final uri = Uri(
          path: customers ? '/customers' : '/projects',
          queryParameters: {
            'page$suffix': ['2'],
            'sort$suffix': ['[1,"ASC"]'],
            'keep': ['first', 'second'],
          },
          fragment: 'details',
        );
        final date = DateTime.utc(2026, 10, 12);
        Uri? changed;
        final Widget rows;

        if (customers) {
          rows = CustomerListRows(
            rows: [
              for (var index = 0; index < 90; index++)
                models.Customer(
                  id: '$index',
                  name: 'Customer $index',
                  phoneNumbers: const [],
                  emailAddresses: const [],
                  createdAt: date,
                  modifiedAt: date,
                ),
            ],
            state: CustomerListState.fromUri(uri),
            uri: uri,
            onStateChanged: (next) {
              changed = next;
            },
            onSelected: (customer) {},
          );
        } else {
          rows = ProjectListRows(
            rows: [
              for (var index = 0; index < 90; index++)
                models.Project(
                  id: '$index',
                  title: 'Project $index',
                  createdAt: date,
                  modifiedAt: date,
                ),
            ],
            state: ProjectListState.fromUri(uri),
            uri: uri,
            onStateChanged: (next) {
              changed = next;
            },
            onSelected: (project) {},
          );
        }

        await tester.pumpWidget(
          MaterialApp(
            locale: const Locale('en'),
            home: SsTheme(
              colors: SsColors.light,
              child: Scaffold(body: rows),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final pagination = tester.widget<SsPagination>(
          find.byType(SsPagination),
        );

        expect(pagination.page, 3);
        pagination.onPageSize(50);

        expect(changed, isNotNull);
        expect(changed!.queryParameters['page$suffix'], isNull);
        expect(changed!.queryParameters['pageSize$suffix'], '50');
        expect(changed!.queryParameters['sort$suffix'], '[1,"ASC"]');
        expect(changed!.queryParametersAll['keep'], ['first', 'second']);
        expect(changed!.fragment, 'details');
        expect(tester.takeException(), isNull);
      },
    );
  }
}
