import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

typedef SsInteraction = ({bool hovered, bool focused, bool pressed});

class SsPressable extends StatefulWidget {
  const SsPressable({
    super.key,
    required this.builder,
    this.onPressed,
    this.focusNode,
    this.semanticLabel,
    this.selected,
    this.isLink = false,
    this.linkUrl,
  });

  final Widget Function(BuildContext context, SsInteraction state) builder;
  final VoidCallback? onPressed;
  final FocusNode? focusNode;
  final String? semanticLabel;
  final bool? selected;
  final bool isLink;
  final Uri? linkUrl;

  @override
  State<SsPressable> createState() {
    return _SsPressableState();
  }
}

class _SsPressableState extends State<SsPressable> {
  final _ownedFocus = FocusNode();
  bool _hovered = false;
  bool _focused = false;
  bool _pressed = false;

  FocusNode get _focus {
    return widget.focusNode ?? _ownedFocus;
  }

  @override
  void didUpdateWidget(covariant SsPressable oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.onPressed == null) {
      _pressed = false;
    }
  }

  @override
  void dispose() {
    _ownedFocus.dispose();

    super.dispose();
  }

  void _activate() {
    final activate = widget.onPressed;

    if (activate == null) {
      return;
    }

    _focus.requestFocus();
    activate();
  }

  void _releasePress() {
    // Cancellation may follow a rebuild that already cleared the press.
    if (!mounted || !_pressed) {
      return;
    }

    setState(() {
      _pressed = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final enabled = widget.onPressed != null;
    final spaceIntent = widget.isLink
        ? const ScrollIntent(
            direction: AxisDirection.down,
            type: ScrollIncrementType.page,
          )
        : const ActivateIntent();

    return Semantics(
      button: !widget.isLink,
      link: widget.isLink,
      linkUrl: widget.isLink && enabled ? widget.linkUrl : null,
      enabled: enabled,
      selected: widget.selected,
      label: widget.semanticLabel,
      child: FocusableActionDetector(
        focusNode: _focus,
        enabled: enabled,
        mouseCursor: enabled
            ? SystemMouseCursors.click
            : SystemMouseCursors.basic,
        onShowHoverHighlight: (value) {
          setState(() {
            _hovered = value;
          });
        },

        onShowFocusHighlight: (value) {
          setState(() {
            _focused = value;
          });
        },

        shortcuts: {
          const SingleActivator(LogicalKeyboardKey.enter):
              const ActivateIntent(),
          const SingleActivator(LogicalKeyboardKey.space): spaceIntent,
          if (widget.isLink)
            const SingleActivator(
              LogicalKeyboardKey.space,
              shift: true,
            ): const ScrollIntent(
              direction: AxisDirection.up,
              type: ScrollIncrementType.page,
            ),
        },
        actions: {
          if (widget.isLink)
            ScrollIntent: CallbackAction<ScrollIntent>(
              onInvoke: (intent) {
                final scrollAction = ScrollAction();

                if (!scrollAction.isEnabled(intent, context)) {
                  return null;
                }

                scrollAction.invoke(intent, context);

                return null;
              },
            ),
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              _activate();

              return null;
            },
          ),
        },
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: enabled ? _activate : null,
          onTapDown: !enabled
              ? null
              : (_) {
                  setState(() {
                    _pressed = true;
                  });
                },

          // Omit release callbacks too: any tap handler exposes a tap action.
          onTapUp: !enabled
              ? null
              : (_) {
                  _releasePress();
                },

          onTapCancel: enabled ? _releasePress : null,

          child: ExcludeSemantics(
            excluding: widget.semanticLabel != null,
            child: widget.builder(context, (
              hovered: enabled && _hovered,
              focused: enabled && _focused,
              pressed: enabled && _pressed,
            )),
          ),
        ),
      ),
    );
  }
}
