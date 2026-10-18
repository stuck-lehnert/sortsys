const _legacyPaths = {
  '/planning': '/deployments',
  '/vendors': '/products/vendors',
  '/delivery-notes': '/products/deliveryNotes',
  '/regie-reports': '/regieReports',
};

Uri canonicalClientUri(Uri uri) {
  if (uri.hasScheme || uri.hasAuthority) {
    return uri;
  }

  if (uri.path == '/') {
    return uri.replace(path: '/dashboard');
  }

  for (final entry in _legacyPaths.entries) {
    if (uri.path != entry.key && !uri.path.startsWith('${entry.key}/')) {
      continue;
    }

    final prefix = Uri.parse(entry.key).pathSegments.length;
    final destination = Uri.parse(entry.value).pathSegments;
    final suffix = uri.pathSegments.skip(prefix);

    return uri.replace(pathSegments: ['', ...destination, ...suffix]);
  }

  return uri;
}
