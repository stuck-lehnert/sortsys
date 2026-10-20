bool isCustomerDetailLocation(Uri current, String id) {
  if (id.isEmpty) {
    return false;
  }

  final List<String> segments;

  try {
    segments = current.pathSegments;
  } on FormatException {
    return false;
  }

  return segments.length == 2 &&
      segments[0] == 'customers' &&
      segments[1] == id;
}

String? customerDeletedLocation(
  Uri current, {
  required Uri ownedLocation,
  required String displayedId,
  required String acknowledgedId,
}) {
  if (current != ownedLocation ||
      acknowledgedId != displayedId ||
      !isCustomerDetailLocation(current, displayedId)) {
    return null;
  }

  return '/customers';
}
