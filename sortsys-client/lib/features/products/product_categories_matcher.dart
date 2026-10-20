import 'product_categories_unicode_data.dart';

String lowercaseProductCategory(String value) {
  final points = _queryCodePoints(value);
  final hasSigma = points.contains(0x03a3);
  final followedByCased = hasSigma ? _followingCased(points) : const <bool>[];
  final output = StringBuffer();
  var precededByCased = false;

  for (var index = 0; index < points.length; index++) {
    final point = points[index];

    if (point == 0x03a3 && precededByCased && !followedByCased[index]) {
      output.writeCharCode(0x03c2);
    } else {
      _writeLowercase(output, point);
    }

    // Final_Sigma uses the original text and skips case-ignorable characters,
    // even when a skipped character also has the Cased property.
    if (hasSigma && !_inRanges(point, productCategoryCaseIgnorableRanges)) {
      precededByCased = _inRanges(point, productCategoryCasedRanges);
    }
  }

  return output.toString();
}

String normalizeProductCategoryQuery(String query) {
  var start = 0;
  var end = query.length;

  while (start < end && _isQueryWhitespace(query.codeUnitAt(start))) {
    start++;
  }

  while (end > start && _isQueryWhitespace(query.codeUnitAt(end - 1))) {
    end--;
  }

  return lowercaseProductCategory(query.substring(start, end));
}

List<String> matchProductCategories({
  required List<String> options,
  required String query,
  List<String> selected = const [],
}) {
  final normalized = normalizeProductCategoryQuery(query);

  if (normalized.isEmpty) {
    return List.unmodifiable(selected);
  }

  final matches = <String>[];

  for (final category in options) {
    if (lowercaseProductCategory(category).contains(normalized)) {
      matches.add(category);

      if (matches.length == 20) {
        break;
      }
    }
  }

  return List.unmodifiable(matches);
}

List<int> _queryCodePoints(String value) {
  final points = <int>[];

  for (var index = 0; index < value.length; index++) {
    var point = value.codeUnitAt(index);

    if (point >= 0xd800 && point <= 0xdbff && index + 1 < value.length) {
      final next = value.codeUnitAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        point = 0x10000 + ((point - 0xd800) << 10) + next - 0xdc00;
        index++;
      }
    }

    // Keep unfinished UTF-16 input unchanged, as JavaScript strings do.
    points.add(point);
  }

  return points;
}

List<bool> _followingCased(List<int> points) {
  final result = List<bool>.filled(points.length, false);
  var following = false;

  for (var index = points.length - 1; index >= 0; index--) {
    final point = points[index];
    result[index] = following;

    if (!_inRanges(point, productCategoryCaseIgnorableRanges)) {
      following = _inRanges(point, productCategoryCasedRanges);
    }
  }

  return result;
}

void _writeLowercase(StringBuffer output, int point) {
  if (point == 0x0130) {
    output.writeCharCode(0x0069);
    output.writeCharCode(0x0307);

    return;
  }

  output.writeCharCode(productCategorySimpleLowercase[point] ?? point);
}

bool _inRanges(int point, List<(int, int)> ranges) {
  var low = 0;
  var high = ranges.length - 1;

  while (low <= high) {
    final middle = (low + high) >> 1;
    final (start, end) = ranges[middle];

    if (point < start) {
      high = middle - 1;
    } else if (point > end) {
      low = middle + 1;
    } else {
      return true;
    }
  }

  return false;
}

bool _isQueryWhitespace(int point) {
  // ECMAScript trim removes BOM, but not NEL. Rust category validation has
  // the opposite distinction, so it must retain its separate whitespace rule.
  return (point >= 0x0009 && point <= 0x000d) ||
      point == 0x0020 ||
      point == 0x00a0 ||
      point == 0x1680 ||
      (point >= 0x2000 && point <= 0x200a) ||
      point == 0x2028 ||
      point == 0x2029 ||
      point == 0x202f ||
      point == 0x205f ||
      point == 0x3000 ||
      point == 0xfeff;
}
