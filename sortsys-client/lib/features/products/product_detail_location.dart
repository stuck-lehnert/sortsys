bool isProductDetailLocation(Uri current, String id) {
  if (id.isEmpty) {
    return false;
  }

  final List<String> segments;

  try {
    segments = current.pathSegments;
  } on FormatException {
    return false;
  }

  return segments.length == 2 && segments[0] == 'products' && segments[1] == id;
}

String? productDeletedLocation(
  Uri current, {
  required Uri ownedLocation,
  required String displayedId,
  required String acknowledgedId,
}) {
  if (current != ownedLocation ||
      acknowledgedId != displayedId ||
      !isProductDetailLocation(current, displayedId)) {
    return null;
  }

  return '/products';
}
