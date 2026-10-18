import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import 'package:go_router/go_router.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'command_palette_controller.dart';
import 'global_search.dart';
import 'workspace_commands.dart';

Future<void> showCommandPalette(BuildContext context) async {
  final session = context.read<SessionController>();
  final binding = session.binding;

  bool isCurrent() {
    return session.authenticated && session.binding == binding;
  }

  if (!isCurrent()) {
    return;
  }

  final repository = GlobalSearchRepository(
    read: session.read,
    can: (role) {
      return session.info?.can(role) == true;
    },

    isCurrent: isCurrent,
  );
  final commands = workspaceCommands(context);
  final closeLabel = text(context, 'Schließen', 'Close');

  final entry = await showGeneralDialog<PaletteEntry>(
    context: context,
    barrierDismissible: true,
    barrierLabel: closeLabel,
    barrierColor: const Color(0x8508111c),
    transitionDuration: const Duration(milliseconds: 120),
    pageBuilder: (context, animation, secondaryAnimation) {
      return CommandPaletteDialog(
        repository: repository,
        commands: commands,
        scopeChanges: session,
      );
    },
  );

  if (!context.mounted || entry == null || !isCurrent()) {
    return;
  }

  final command = entry.command;

  if (command != null) {
    await runWorkspaceCommand(context, command);

    return;
  }

  final hit = entry.hit;

  if (hit != null && session.info?.can(hit.resource.role) == true) {
    context.go(hit.href);
  }
}

class CommandPaletteDialog extends StatefulWidget {
  const CommandPaletteDialog({
    super.key,
    required this.repository,
    required this.commands,
    required this.scopeChanges,
  });

  final GlobalSearchRepository repository;
  final List<PaletteCommand> commands;
  final Listenable scopeChanges;

  @override
  State<CommandPaletteDialog> createState() {
    return _CommandPaletteDialogState();
  }
}

class _CommandPaletteDialogState extends State<CommandPaletteDialog> {
  late final CommandPaletteController _palette;
  final _input = TextEditingController();
  final _inputFocus = FocusNode();
  final _scroll = ScrollController();
  final _rowKeys = <String, GlobalKey>{};
  bool _closing = false;

  @override
  void initState() {
    super.initState();

    _palette = CommandPaletteController(
      repository: widget.repository,
      commands: widget.commands,
    );
    _palette.addListener(_changed);
    widget.scopeChanges.addListener(_changed);

    unawaited(_palette.loadRecentActions());
  }

  @override
  void dispose() {
    widget.scopeChanges.removeListener(_changed);
    _palette.removeListener(_changed);
    _palette.dispose();
    _input.dispose();
    _inputFocus.dispose();
    _scroll.dispose();

    super.dispose();
  }

  void _changed() {
    if (!mounted || _closing) {
      return;
    }

    setState(() {});

    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _closing) {
        return;
      }

      if (!widget.repository.isCurrent()) {
        _close();

        return;
      }

      final entry = _palette.activeEntry;
      final rowContext = entry == null
          ? null
          : _rowKeys[entry.id]?.currentContext;

      if (rowContext != null) {
        unawaited(
          Scrollable.ensureVisible(
            rowContext,
            duration: const Duration(milliseconds: 120),
            alignmentPolicy: ScrollPositionAlignmentPolicy.keepVisibleAtEnd,
          ),
        );
      }
    });
  }

  void _close([PaletteEntry? entry]) {
    if (_closing || ModalRoute.of(context)?.isCurrent != true) {
      return;
    }

    _closing = true;

    Navigator.of(context).pop(entry);
  }

  void _run(PaletteEntry? entry) {
    if (entry == null || !widget.repository.isCurrent()) {
      return;
    }

    final role = entry.command?.role ?? entry.hit?.resource.role;

    if (role == null || !widget.repository.can(role)) {
      return;
    }

    _close(entry);
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.repository.isCurrent()) {
      return const SizedBox.shrink();
    }

    final media = MediaQuery.of(context);
    final colors = SsTheme.of(context);
    final compact = media.size.width <= 672;
    final height = math.max(0.0, media.size.height - media.viewInsets.bottom);
    final maxHeight = compact
        ? height
        : math.min(height * 0.82, math.max(0.0, height - 32));
    final top = compact ? 0.0 : (height * 0.1).clamp(16.0, 96.0);

    return Shortcuts(
      shortcuts: const {
        SingleActivator(LogicalKeyboardKey.arrowDown): _MovePaletteIntent(1),
        SingleActivator(LogicalKeyboardKey.arrowUp): _MovePaletteIntent(-1),
        SingleActivator(LogicalKeyboardKey.enter): ActivateIntent(),
        SingleActivator(LogicalKeyboardKey.escape): DismissIntent(),
      },
      child: Actions(
        actions: {
          _MovePaletteIntent: CallbackAction<_MovePaletteIntent>(
            onInvoke: (intent) {
              _palette.moveActive(intent.delta);

              return null;
            },
          ),
          ActivateIntent: CallbackAction<ActivateIntent>(
            onInvoke: (_) {
              _run(_palette.activeEntry);

              return null;
            },
          ),
          DismissIntent: CallbackAction<DismissIntent>(
            onInvoke: (_) {
              _close();

              return null;
            },
          ),
        },
        child: Semantics(
          scopesRoute: true,
          explicitChildNodes: true,
          namesRoute: true,
          label: text(context, 'Befehlspalette', 'Command palette'),
          child: Align(
            alignment: Alignment.topCenter,
            child: Padding(
              padding: EdgeInsets.only(top: top),
              child: SizedBox(
                width: compact
                    ? media.size.width
                    : math.min(768, media.size.width - 25.6),
                child: ConstrainedBox(
                  constraints: BoxConstraints(
                    maxHeight: maxHeight,
                    minHeight: compact ? maxHeight : 0,
                  ),
                  child: Material(
                    color: colors.surface,
                    shape: compact ? null : Border.all(color: colors.border),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _header(context),
                        Flexible(
                          fit: compact ? FlexFit.tight : FlexFit.loose,
                          child: _body(context, compact, height),
                        ),
                        _footer(context),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _header(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(bottom: BorderSide(color: colors.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14.4, 12.8, 14.4, 8.8),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: Text(
                text(context, 'Befehlspalette', 'Command palette'),
                style: colors.heading.copyWith(fontSize: 17.92, height: 1.2),
              ),
            ),
            const SizedBox(width: 9.6),
            SsIconButton(
              icon: 'x',
              iconSize: 14.72,
              borderless: true,
              label: text(context, 'Schließen', 'Close'),
              onPressed: _close,
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, bool compact, double height) {
    final colors = SsTheme.of(context);
    final entries = _palette.entries;
    final ids = entries.map((entry) {
      return entry.id;
    }).toSet();

    _rowKeys.removeWhere((id, key) {
      return !ids.contains(id);
    });

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14.4, vertical: 12.8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text(
            text(
              context,
              'Befehl oder Suche',
              'Command or search',
            ).toUpperCase(),
            style: colors.label.copyWith(
              fontSize: 12.48,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.9984,
            ),
          ),
          const SizedBox(height: 10.4),
          _searchInput(context, compact),
          const SizedBox(height: 10.4),
          if (_palette.hasFailure) ...[
            Semantics(
              liveRegion: true,
              child: Text(
                text(
                  context,
                  'Einige Treffer konnten nicht geladen werden.',
                  'Some results could not be loaded.',
                ),
                style: colors.label,
              ),
            ),
            const SizedBox(height: 10.4),
          ],
          Flexible(
            fit: compact ? FlexFit.tight : FlexFit.loose,
            child: ConstrainedBox(
              constraints: BoxConstraints(
                maxHeight: compact
                    ? double.infinity
                    : math.min(height * 0.56, 512),
              ),
              child: Scrollbar(
                controller: _scroll,
                child: SingleChildScrollView(
                  controller: _scroll,
                  child: _results(context, entries, compact),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _searchInput(BuildContext context, bool compact) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        color: Color.lerp(colors.mutedSurface, colors.surface, 0.82),
        border: Border.all(color: colors.strongBorder),
      ),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10.4),
        child: Row(
          children: [
            const SsIcon('search'),
            const SizedBox(width: 8.8),
            Expanded(
              child: Semantics(
                label: text(context, 'Befehl oder Suche', 'Command or search'),
                child: TextField(
                  controller: _input,
                  focusNode: _inputFocus,
                  autofocus: true,
                  style: colors.body.copyWith(fontSize: 17.28, height: 1.2),
                  cursorColor: colors.accent,
                  onChanged: _palette.setQuery,
                  decoration: InputDecoration.collapsed(
                    hintText: text(
                      context,
                      'Tippe > für Befehle, sonst Suche',
                      'Type > for commands, otherwise search',
                    ),
                    hintStyle: colors.body.copyWith(
                      color: colors.secondaryText,
                      fontSize: 17.28,
                    ),
                  ),
                ),
              ),
            ),
            if (!compact) ...[
              const SizedBox(width: 8.8),
              DecoratedBox(
                decoration: BoxDecoration(
                  border: Border.all(color: colors.border),
                ),
                child: Padding(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 5.6,
                    vertical: 1.6,
                  ),
                  child: Text(
                    'Ctrl K',
                    style: colors.label.copyWith(fontSize: 11.52),
                  ),
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _results(
    BuildContext context,
    List<PaletteEntry> entries,
    bool compact,
  ) {
    final colors = SsTheme.of(context);

    if (entries.isEmpty) {
      return Semantics(
        liveRegion: true,
        child: Padding(
          padding: const EdgeInsets.all(14.4),
          child: Text(
            _palette.searching
                ? text(context, 'Suche läuft …', 'Searching …')
                : text(context, 'Keine Treffer.', 'No results.'),
            style: colors.body.copyWith(
              color: colors.secondaryText,
              fontSize: 13.12,
            ),
          ),
        ),
      );
    }

    final groups = <PaletteGroup, List<PaletteEntry>>{};

    for (final entry in entries) {
      groups
          .putIfAbsent(entry.group, () {
            return [];
          })
          .add(entry);
    }

    final sections = <Widget>[];

    for (final group in groups.entries) {
      if (sections.isNotEmpty) {
        sections.add(const SizedBox(height: 12.8));
      }

      final groupLabel = _groupLabel(context, group.key);

      sections.add(
        Text(
          groupLabel.toUpperCase(),
          style: colors.label.copyWith(
            fontSize: 12.16,
            letterSpacing: 0.9728,
            fontWeight: FontWeight.w600,
          ),
        ),
      );
      sections.add(const SizedBox(height: 4.48));

      for (final entry in group.value) {
        final index = entries.indexOf(entry);
        final rowKey = _rowKeys.putIfAbsent(entry.id, () {
          return GlobalKey();
        });

        sections.add(
          _PaletteRow(
            key: rowKey,
            entry: entry,
            active: index == _palette.activeIndex,
            compact: compact,
            group: groupLabel,
            onHover: () {
              _palette.activateIndex(index);
            },

            onPressed: () {
              _run(entry);
            },
          ),
        );
      }
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: sections,
    );
  }

  Widget _footer(BuildContext context) {
    final colors = SsTheme.of(context);

    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: colors.border)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(14.4, 10.4, 14.4, 12.8),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.end,
          children: [
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: _close,
              child: Text(text(context, 'Schließen', 'Close')),
            ),
          ],
        ),
      ),
    );
  }
}

class _MovePaletteIntent extends Intent {
  const _MovePaletteIntent(this.delta);

  final int delta;
}

class _PaletteRow extends StatelessWidget {
  const _PaletteRow({
    super.key,
    required this.entry,
    required this.active,
    required this.compact,
    required this.group,
    required this.onHover,
    required this.onPressed,
  });

  final PaletteEntry entry;
  final bool active;
  final bool compact;
  final String group;
  final VoidCallback onHover;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final hit = entry.hit;
    var title = entry.title;
    var subtitle = entry.command?.description;

    if (hit != null) {
      subtitle = _resourceLabel(context, hit.resource);

      if (hit.resource == SearchResource.deliveryNote) {
        title = text(context, 'Lieferschein $title', 'Delivery note $title');
        final recordedAt = hit.recordedAt;

        if (recordedAt != null) {
          final english = Localizations.localeOf(context).languageCode == 'en';
          final format = english ? 'MM/dd/yyyy' : 'dd.MM.yyyy';
          final date = DateFormat(format).format(recordedAt.toLocal());

          subtitle = text(context, 'Erfasst $date', 'Recorded $date');
        }
      }
    }

    return MouseRegion(
      onEnter: (_) {
        onHover();
      },

      child: SsPressable(
        selected: active,
        onPressed: onPressed,
        builder: (context, state) {
          final highlighted = active || state.hovered || state.focused;

          return DecoratedBox(
            decoration: BoxDecoration(
              color: highlighted ? colors.nestedSurfaceHover : null,
              border: Border.all(
                color: highlighted ? colors.strongBorder : Colors.transparent,
              ),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: 11.4,
                vertical: 10.28,
              ),
              child: Row(
                children: [
                  SsIcon(entry.icon),
                  const SizedBox(width: 10.4),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          title,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: colors.body,
                        ),
                        if (subtitle != null && subtitle.isNotEmpty)
                          Text(
                            subtitle,
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                            style: colors.body.copyWith(
                              color: colors.secondaryText,
                              fontSize: 13.12,
                            ),
                          ),
                      ],
                    ),
                  ),
                  if (!compact) ...[
                    const SizedBox(width: 10.4),
                    Text(group, style: colors.label.copyWith(fontSize: 13.12)),
                  ],
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

String _groupLabel(BuildContext context, PaletteGroup group) {
  return switch (group) {
    PaletteGroup.recent => text(context, 'Zuletzt verwendet', 'Recently used'),
    PaletteGroup.work => text(context, 'Arbeit', 'Work'),
    PaletteGroup.create => text(context, 'Anlegen', 'Create'),
    PaletteGroup.navigate => text(context, 'Navigation', 'Navigation'),
    PaletteGroup.admin => text(context, 'Verwaltung', 'Administration'),
    PaletteGroup.results => text(context, 'Treffer', 'Results'),
  };
}

String _resourceLabel(BuildContext context, SearchResource resource) {
  return switch (resource) {
    SearchResource.project => text(context, 'Projekt', 'Project'),
    SearchResource.tool => text(context, 'Werkzeug', 'Tool'),
    SearchResource.user => text(context, 'Benutzer', 'User'),
    SearchResource.product => text(context, 'Produkt', 'Product'),
    SearchResource.customer => text(context, 'Kunde', 'Customer'),
    SearchResource.contact => text(context, 'Kontakt', 'Contact'),
    SearchResource.vendor => text(context, 'Händler', 'Vendor'),
    SearchResource.deliveryNote => text(
      context,
      'Lieferschein',
      'Delivery note',
    ),
  };
}
