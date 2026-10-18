import 'package:flutter_test/flutter_test.dart';
import 'package:sortsys_client/navigation/route_paths.dart';

void main() {
  test(
    'legacy list and detail links use the genuine canonical Webapp paths',
    () {
      const cases = {
        '/': '/dashboard',
        '/planning': '/deployments',
        '/vendors': '/products/vendors',
        '/vendors/vendor-id': '/products/vendors/vendor-id',
        '/delivery-notes/note-id': '/products/deliveryNotes/note-id',
        '/regie-reports/report-id': '/regieReports/report-id',
      };

      for (final entry in cases.entries) {
        final uri = canonicalClientUri(Uri.parse(entry.key));

        expect(uri.path, entry.value);
      }
    },
  );

  test(
    'canonical aliases preserve search, pagination, fragments and encoded IDs',
    () {
      final source = Uri.parse(
        '/vendors/part%2Fwith%20space?pageVendors=2&search=bolt#activity',
      );

      final actual = canonicalClientUri(source);

      expect(actual.pathSegments, ['products', 'vendors', 'part/with space']);
      expect(actual.query, source.query);
      expect(actual.fragment, source.fragment);
      expect(
        actual.toString(),
        '/products/vendors/part%2Fwith%20space?pageVendors=2&search=bolt#activity',
      );
    },
  );

  test('canonical, unrelated and external URIs are not rewritten', () {
    for (final value in [
      '/products/vendors/vendor-id?search=bolt',
      '/projects/project-id',
      '/planning-extra',
      'https://example.invalid/vendors/vendor-id',
      '//example.invalid/vendors/vendor-id',
    ]) {
      final source = Uri.parse(value);

      expect(canonicalClientUri(source), source);
    }
  });
}
