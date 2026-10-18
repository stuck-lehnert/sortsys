import 'package:flutter/widgets.dart';

import 'icon.dart';
import 'pressable.dart';
import 'theme.dart';

class SsDisclosure extends StatefulWidget {
  const SsDisclosure({
    super.key,
    required this.title,
    required this.child,
    this.initiallyExpanded = false,
  });

  final String title;
  final Widget child;
  final bool initiallyExpanded;

  @override
  State<SsDisclosure> createState() {
    return _SsDisclosureState();
  }
}

class _SsDisclosureState extends State<SsDisclosure> {
  late bool _expanded;
  late bool _bodyOffstage;

  @override
  void initState() {
    super.initState();

    _expanded = widget.initiallyExpanded;
    _bodyOffstage = !widget.initiallyExpanded;
  }

  void _toggle() {
    setState(() {
      if (!_expanded) {
        _bodyOffstage = false;
      }

      _expanded = !_expanded;
    });
  }

  void _animationEnded() {
    if (_expanded || _bodyOffstage || !mounted) {
      return;
    }

    setState(() {
      _bodyOffstage = true;
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final duration = MediaQuery.disableAnimationsOf(context)
        ? Duration.zero
        : const Duration(milliseconds: 200);

    return DecoratedBox(
      decoration: BoxDecoration(border: Border.all(color: colors.border)),
      child: Padding(
        padding: const EdgeInsets.all(9.6),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Semantics(
              expanded: _expanded,
              child: SsPressable(
                semanticLabel: widget.title,
                onPressed: _toggle,
                builder: (context, interaction) {
                  return DecoratedBox(
                    decoration: BoxDecoration(
                      boxShadow: interaction.focused
                          ? [
                              BoxShadow(
                                color: colors.accent.withValues(alpha: 0.36),
                                spreadRadius: 2,
                              ),
                            ]
                          : const [],
                    ),
                    child: Row(
                      children: [
                        SsIcon(
                          _expanded ? 'chevron-down' : 'chevron-right',
                          size: 18,
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: Text(
                            widget.title,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: colors.body.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                        ),
                      ],
                    ),
                  );
                },
              ),
            ),
            ClipRect(
              child: AnimatedAlign(
                alignment: AlignmentDirectional.topStart,
                heightFactor: _expanded ? 1 : 0,
                duration: duration,
                onEnd: _animationEnded,
                child: Offstage(
                  offstage: _bodyOffstage,
                  child: ExcludeFocus(
                    excluding: !_expanded,
                    child: ExcludeSemantics(
                      excluding: !_expanded,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Padding(
                            padding: const EdgeInsets.symmetric(vertical: 11.2),
                            child: Container(height: 1, color: colors.border),
                          ),
                          widget.child,
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
