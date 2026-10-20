bool isContactDetailLocation(Uri current, String id) {
  if (id.isEmpty) {
    return false;
  }

  final List<String> segments;

  try {
    segments = current.pathSegments;
  } on FormatException {
    return false;
  }

  return segments.length == 2 && segments[0] == 'contacts' && segments[1] == id;
}

String? contactDeletedLocation(
  Uri current, {
  required Uri ownedLocation,
  required String displayedId,
  required String acknowledgedId,
}) {
  if (current != ownedLocation ||
      acknowledgedId != displayedId ||
      !isContactDetailLocation(current, displayedId)) {
    return null;
  }

  return '/contacts';
}
