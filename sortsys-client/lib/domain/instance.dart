import 'dart:convert';

final class SortsysInstance {
  const SortsysInstance._(this.origin);

  final Uri origin;

  Uri get endpoint => origin.resolve('/api/v2');
  String get domain => origin.authority;

  factory SortsysInstance.parse(String value) {
    final text = value.trim();
    if (text.isEmpty || RegExp(r'\s').hasMatch(text) || text.contains(r'\')) {
      throw const FormatException('INVALID_DOMAIN');
    }

    final address = text.contains('://') ? text : 'https://$text';
    final uri = Uri.tryParse(address);
    if (uri == null) {
      throw const FormatException('INVALID_DOMAIN');
    }

    final invalidOrigin =
        uri.scheme != 'https' ||
        uri.host.isEmpty ||
        uri.host.endsWith('.') ||
        uri.userInfo.isNotEmpty ||
        uri.hasQuery ||
        uri.hasFragment;
    final invalidPath = uri.path.isNotEmpty && uri.path != '/';
    final invalidPort = uri.hasPort && (uri.port < 1 || uri.port > 65535);

    if (invalidOrigin || invalidPath || invalidPort) {
      throw const FormatException('INVALID_DOMAIN');
    }

    final origin = Uri(
      scheme: 'https',
      host: uri.host,
      port: uri.hasPort ? uri.port : null,
    );

    return SortsysInstance._(origin);
  }

  String accountScope(String tenant, String userId) {
    return jsonEncode([origin.toString(), tenant, userId]);
  }
}
