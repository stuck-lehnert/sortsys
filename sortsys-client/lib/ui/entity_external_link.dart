import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';
import 'package:url_launcher/url_launcher.dart';

import 'text.dart';

class EntityExternalLink extends StatefulWidget {
  const EntityExternalLink({super.key, required this.uri, required this.label});

  final Uri uri;
  final String label;

  @override
  State<EntityExternalLink> createState() {
    return _EntityExternalLinkState();
  }
}

class _EntityExternalLinkState extends State<EntityExternalLink> {
  bool _failed = false;

  Future<void> _open() async {
    var opened = false;

    try {
      opened = await launchUrl(
        widget.uri,
        mode: LaunchMode.externalApplication,
      );
    } catch (_) {
      opened = false;
    }

    if (!mounted) {
      return;
    }

    setState(() {
      _failed = !opened;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        SsLink(uri: widget.uri, onPressed: _open, child: Text(widget.label)),
        if (_failed)
          Text(
            text(
              context,
              'Link konnte nicht geöffnet werden.',
              'The link could not be opened.',
            ),
            style: colors.label.copyWith(color: colors.danger),
          ),
      ],
    );
  }
}
