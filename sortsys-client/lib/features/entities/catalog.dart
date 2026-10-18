class EntitySpec {
  const EntitySpec(
    this.key,
    this.de,
    this.en,
    this.icon,
    this.role,
    this.list,
    this.get, {
    this.search = true,
  });

  final String key;
  final String de;
  final String en;
  final String icon;
  final String role;
  final String list;
  final String? get;
  final bool search;

  String get path {
    return switch (key) {
      'vendors' => '/products/vendors',
      'delivery-notes' => '/products/deliveryNotes',
      'regie-reports' => '/regieReports',
      _ => '/$key',
    };
  }
}

const entityCatalog = [
  EntitySpec(
    'projects',
    'Projekte',
    'Projects',
    'building',
    'view:projects',
    'projects.list',
    'projects.get',
  ),
  EntitySpec(
    'products',
    'Produkte',
    'Products',
    'package',
    'view:products',
    'products.list',
    'products.get',
  ),
  EntitySpec(
    'tools',
    'Werkzeuge',
    'Tools',
    'tools',
    'view:tools',
    'tools.list',
    'tools.get',
  ),
  EntitySpec(
    'users',
    'Benutzer',
    'Users',
    'users',
    'view:users',
    'users.list',
    'users.get',
  ),
  EntitySpec(
    'customers',
    'Kunden',
    'Customers',
    'building',
    'view:customers',
    'customers.list',
    'customers.get',
  ),
  EntitySpec(
    'contacts',
    'Kontakte',
    'Contacts',
    'users',
    'view:contacts',
    'contacts.list',
    'contacts.get',
  ),
  EntitySpec(
    'vendors',
    'Händler',
    'Vendors',
    'truck-delivery',
    'view:productVendors',
    'products.vendors.list',
    'products.vendors.get',
  ),
  EntitySpec(
    'delivery-notes',
    'Lieferscheine',
    'Delivery notes',
    'truck-delivery',
    'view:deliveryNotes',
    'deliveryNotes.list',
    'deliveryNotes.get',
    search: false,
  ),
  EntitySpec(
    'regie-reports',
    'Regieberichte',
    'Time-and-material reports',
    'file-text',
    'view:regieReports',
    'regieReports.list',
    'regieReports.get',
    search: false,
  ),
];

EntitySpec entitySpec(String key) {
  return entityCatalog.firstWhere((spec) {
    return spec.key == key;
  });
}
