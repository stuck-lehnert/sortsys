import 'dart:math' as math;

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';

import 'button.dart';
import 'icon.dart';
import 'pressable.dart';
import 'theme.dart';

class SsWorkspaceLayout extends StatefulWidget {
  const SsWorkspaceLayout({
    super.key,
    required this.brand,
    required this.navigationBuilder,
    required this.child,
    required this.menuLabel,
    required this.closeMenuLabel,
    this.bottomBar,
    this.headerActions,
    this.navigationIdentity,
  });

  final Widget brand;
  final Widget Function(VoidCallback closeNavigation) navigationBuilder;
  final Widget child;
  final Widget? bottomBar;
  final Widget? headerActions;
  final String menuLabel;
  final String closeMenuLabel;
  final Object? navigationIdentity;

  @override
  State<SsWorkspaceLayout> createState() {
    return _SsWorkspaceLayoutState();
  }
}

class _SsWorkspaceLayoutState extends State<SsWorkspaceLayout> {
  final _menuFocus = FocusNode();
  bool _menuOpen = false;

  @override
  void didUpdateWidget(covariant SsWorkspaceLayout oldWidget) {
    super.didUpdateWidget(oldWidget);

    if (widget.navigationIdentity != oldWidget.navigationIdentity) {
      _closeMenu();
    }
  }

  @override
  void dispose() {
    _menuFocus.dispose();

    super.dispose();
  }

  void _closeMenu() {
    if (!_menuOpen) {
      return;
    }

    setState(() {
      _menuOpen = false;
    });

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) {
        return;
      }

      _menuFocus.requestFocus();
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final media = MediaQuery.of(context);
    final width = media.size.width;
    final compact = width <= 1000;
    final menuVisible = compact && _menuOpen;
    final headerHeight = 48 + media.padding.top;
    final navigation = MediaQuery.removePadding(
      context: context,
      removeTop: true,
      child: widget.navigationBuilder(_closeMenu),
    );
    final body = Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (!compact)
          Container(
            width: 256,
            decoration: BoxDecoration(
              color: colors.surface,
              border: BorderDirectional(end: BorderSide(color: colors.border)),
            ),
            child: navigation,
          ),
        Expanded(child: SafeArea(top: false, child: widget.child)),
      ],
    );

    return PopScope(
      canPop: !menuVisible,
      onPopInvokedWithResult: (didPop, result) {
        if (!didPop && menuVisible) {
          _closeMenu();
        }
      },

      child: ColoredBox(
        color: colors.background,
        child: Stack(
          children: [
            Column(
              children: [
                _header(context, compact),
                Expanded(
                  child: ExcludeFocus(
                    excluding: menuVisible,
                    child: ExcludeSemantics(
                      excluding: menuVisible,
                      child: body,
                    ),
                  ),
                ),
                if (compact && widget.bottomBar != null)
                  DecoratedBox(
                    decoration: BoxDecoration(
                      color: colors.surface,
                      border: Border(top: BorderSide(color: colors.border)),
                    ),
                    child: SafeArea(top: false, child: widget.bottomBar!),
                  ),
              ],
            ),
            if (menuVisible) ...[
              Positioned.fill(
                top: headerHeight,
                child: ModalBarrier(
                  color: const Color(0x5c08111e),
                  dismissible: true,
                  semanticsLabel: widget.closeMenuLabel,
                  onDismiss: _closeMenu,
                ),
              ),
              PositionedDirectional(
                start: 0,
                top: headerHeight,
                bottom: 0,
                width: math.min(272, width * 0.92),
                child: Shortcuts(
                  shortcuts: const {
                    SingleActivator(LogicalKeyboardKey.escape): DismissIntent(),
                  },
                  child: Actions(
                    actions: {
                      DismissIntent: CallbackAction<DismissIntent>(
                        onInvoke: (_) {
                          _closeMenu();

                          return null;
                        },
                      ),
                    },
                    child: FocusScope(
                      autofocus: true,
                      child: Semantics(
                        scopesRoute: true,
                        explicitChildNodes: true,
                        namesRoute: true,
                        label: widget.menuLabel,
                        child: ColoredBox(
                          color: colors.surface,
                          child: navigation,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _header(BuildContext context, bool compact) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: colors.surface,
        border: Border(bottom: BorderSide(color: colors.border)),
      ),
      child: SafeArea(
        bottom: false,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 7.2),
            child: Row(
              children: [
                if (compact) ...[
                  SsIconButton(
                    focusNode: _menuFocus,
                    icon: 'menu-2',
                    iconSize: 16,
                    borderless: true,
                    label: _menuOpen ? widget.closeMenuLabel : widget.menuLabel,
                    onPressed: () {
                      if (_menuOpen) {
                        _closeMenu();

                        return;
                      }

                      setState(() {
                        _menuOpen = true;
                      });
                    },
                  ),
                  const SizedBox(width: 6.4),
                ],
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    child: Align(
                      alignment: AlignmentDirectional.centerStart,
                      child: widget.brand,
                    ),
                  ),
                ),
                if (widget.headerActions != null) ...[
                  const SizedBox(width: 6.4),
                  widget.headerActions!,
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class SsNavigationItem extends StatelessWidget {
  const SsNavigationItem({
    super.key,
    required this.label,
    required this.icon,
    required this.selected,
    required this.onPressed,
    this.vertical = false,
  });

  final String label;
  final String icon;
  final bool selected;
  final VoidCallback onPressed;
  final bool vertical;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final content = vertical
        ? Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              SsIcon(icon),
              const SizedBox(height: 3),
              Text(
                label,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                textAlign: TextAlign.center,
              ),
            ],
          )
        : Row(
            children: [
              SsIcon(icon),
              const SizedBox(width: 8.8),
              Expanded(
                child: Text(
                  label,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          );

    return SsPressable(
      selected: selected ? true : null,
      onPressed: onPressed,
      builder: (context, state) {
        var background = const Color(0x00000000);

        if (selected) {
          background = Color.lerp(colors.surface, colors.accent, 0.14)!;
        } else if (state.hovered || state.pressed) {
          background = colors.mutedSurface;
        }

        return DecoratedBox(
          decoration: BoxDecoration(
            color: background,
            border: state.focused ? Border.all(color: colors.accent) : null,
          ),
          child: Padding(
            padding: EdgeInsets.symmetric(
              horizontal: vertical ? 4 : 10.56,
              vertical: 8.8,
            ),
            child: DefaultTextStyle(style: colors.body, child: content),
          ),
        );
      },
    );
  }
}
