import 'package:flutter/widgets.dart';

import '../api/client.dart';

String text(BuildContext context, String de, String en) {
  final locale = Localizations.localeOf(context).languageCode;

  return locale == 'en' ? en : de;
}

String errorText(BuildContext context, Object? error) {
  if (error is RpcException) {
    if (error.httpCode == 401) {
      return text(
        context,
        'Die Sitzung ist beendet. Bitte melden Sie sich erneut an.',
        'Your session has ended. Please sign in again.',
      );
    }

    if (error.httpCode == 403) {
      return text(
        context,
        'Für diesen Vorgang fehlen die erforderlichen Berechtigungen.',
        'You do not have permission for this action.',
      );
    }

    if ((error.httpCode ?? 0) >= 500) {
      return text(
        context,
        'Der Server konnte die Anfrage nicht bearbeiten.',
        'The server could not process the request.',
      );
    }
  }

  if (error is FormatException) {
    return text(
      context,
      'Bitte prüfen Sie Ihre Eingaben und die Serveradresse.',
      'Please check your input and the server address.',
    );
  }

  return text(
    context,
    'Die Anfrage konnte nicht abgeschlossen werden. '
        'Prüfen Sie die Verbindung und versuchen Sie es erneut.',
    'The request could not be completed. '
        'Check your connection and try again.',
  );
}
