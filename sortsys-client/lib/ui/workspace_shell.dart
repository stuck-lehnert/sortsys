import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../features/entities/catalog.dart';
import '../features/search/command_palette.dart';
import '../features/search/command_palette_controller.dart';
import '../features/search/workspace_commands.dart';
import '../state/session_controller.dart';
import 'text.dart';

enum _NavigationGroup { projectWork, materialsTools, usersContacts }

class WorkspaceShell extends StatefulWidget {
  const WorkspaceShell({super.key, required this.child});

  final Widget child;

  @override
  State<WorkspaceShell> createState() {
    return _WorkspaceShellState();
  }
}

class _WorkspaceShellState extends State<WorkspaceShell> {
  bool _searchOpen = false;

  Future<void> _search() async {
    if (_searchOpen) {
      return;
    }

    _searchOpen = true;

    try {
      await showCommandPalette(context);
    } finally {
      _searchOpen = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final info = session.info!;
    final colors = SsTheme.of(context);
    final location = GoRouterState.of(context).uri.path;
    final width = MediaQuery.sizeOf(context).width;
    final gutter = width <= 1000
        ? 12.0
        : (8.32 + width * 0.0105).clamp(14.4, 22.4);
    final commands = workspaceCommands(context)
        .where((command) {
          return info.can(command.role);
        })
        .toList(growable: false);
    final entries = <_NavigationEntry>[
      _NavigationEntry(
        '/dashboard',
        text(context, 'Übersicht', 'Overview'),
        'layout-dashboard',
      ),
      if (info.can('view:projects'))
        _resourceEntry(context, 'projects', _NavigationGroup.projectWork),
      if (info.can('view:regieReports'))
        _resourceEntry(context, 'regie-reports', _NavigationGroup.projectWork),
      if (info.can('view:projectDeployments'))
        _NavigationEntry(
          '/deployments',
          text(context, 'Einsatzplanung', 'Resource planning'),
          'calendar',
          _NavigationGroup.projectWork,
        ),
      if (info.can('view:tools'))
        _resourceEntry(context, 'tools', _NavigationGroup.materialsTools),
      if (info.can('view:products') ||
          info.can('view:deliveryNotes') ||
          info.can('view:productVendors'))
        _NavigationEntry(
          '/products',
          text(
            context,
            'Produkte & Lieferscheine',
            'Products & delivery notes',
          ),
          'package',
          _NavigationGroup.materialsTools,
        ),
      if (info.can('view:customers'))
        _resourceEntry(context, 'customers', _NavigationGroup.usersContacts),
      if (info.can('view:contacts'))
        _resourceEntry(context, 'contacts', _NavigationGroup.usersContacts),
      if (info.can('view:users'))
        _resourceEntry(context, 'users', _NavigationGroup.usersContacts),
    ];
    final projectCreate = commands.where((command) {
      return command.id == 'projects.create';
    }).firstOrNull;

    return Shortcuts(
      shortcuts: {
        const SingleActivator(LogicalKeyboardKey.keyK, control: true):
            const _OpenSearchIntent(),
        const SingleActivator(LogicalKeyboardKey.keyK, meta: true):
            const _OpenSearchIntent(),
        if (location == '/projects' && projectCreate != null)
          const SingleActivator(LogicalKeyboardKey.keyN, control: true):
              const _CreateProjectIntent(),
      },
      child: Actions(
        actions: {
          _OpenSearchIntent: CallbackAction<_OpenSearchIntent>(
            onInvoke: (_) {
              unawaited(_search());

              return null;
            },
          ),
          _CreateProjectIntent: CallbackAction<_CreateProjectIntent>(
            onInvoke: (_) {
              if (projectCreate != null) {
                unawaited(runWorkspaceCommand(context, projectCreate));
              }

              return null;
            },
          ),
        },
        child: Focus(
          autofocus: true,
          skipTraversal: true,
          child: SsWorkspaceLayout(
            navigationIdentity: location,
            brand: SsPressable(
              onPressed: () {
                context.go('/dashboard');
              },

              builder: (context, state) {
                return Text(
                  info.tenant.companyName ?? 'sortsys',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: colors.body.copyWith(
                    fontWeight: FontWeight.w600,
                    decoration: state.focused ? TextDecoration.underline : null,
                  ),
                );
              },
            ),
            headerActions: SsIconButton(
              icon: 'search',
              borderless: true,
              label: text(context, 'Suche', 'Search'),
              tooltip: '${text(context, 'Suche', 'Search')} (Ctrl+K)',
              onPressed: () {
                unawaited(_search());
              },
            ),
            menuLabel: text(context, 'Navigation öffnen', 'Open navigation'),
            closeMenuLabel: text(
              context,
              'Navigation schließen',
              'Close navigation',
            ),
            navigationBuilder: (closeNavigation) {
              return _WorkspaceNavigation(
                entries: entries,
                commands: commands,
                location: location,
                closeNavigation: closeNavigation,
                onCommand: (command) {
                  unawaited(runWorkspaceCommand(context, command));
                },
              );
            },

            child: Padding(
              padding: EdgeInsets.all(gutter),
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }
}

_NavigationEntry _resourceEntry(
  BuildContext context,
  String key,
  _NavigationGroup group,
) {
  final spec = entitySpec(key);

  return _NavigationEntry(
    spec.path,
    text(context, spec.de, spec.en),
    spec.icon,
    group,
  );
}

class _NavigationEntry {
  const _NavigationEntry(this.path, this.label, this.icon, [this.group]);

  final String path;
  final String label;
  final String icon;
  final _NavigationGroup? group;

  bool matches(String location) {
    return location == path || location.startsWith('$path/');
  }
}

class _WorkspaceNavigation extends StatelessWidget {
  const _WorkspaceNavigation({
    required this.entries,
    required this.commands,
    required this.location,
    required this.closeNavigation,
    required this.onCommand,
  });

  final List<_NavigationEntry> entries;
  final List<PaletteCommand> commands;
  final String location;
  final VoidCallback closeNavigation;
  final ValueChanged<PaletteCommand> onCommand;

  Widget _navigationItem(BuildContext context, _NavigationEntry entry) {
    return SsNavigationItem(
      icon: entry.icon,
      label: entry.label,
      selected: entry.matches(location),
      onPressed: () {
        closeNavigation();
        context.go(entry.path);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final colors = SsTheme.of(context);
    final sections = <Widget>[
      for (final entry in entries)
        if (entry.group == null) _navigationItem(context, entry),
    ];
    final createCommands = commands
        .where((command) {
          return command.group == PaletteGroup.create;
        })
        .toList(growable: false);

    if (createCommands.isNotEmpty) {
      sections.add(
        SsNavigationSection(
          label: text(context, 'Stammdaten anlegen', 'Create master data'),
          icon: 'plus',
          children: [
            for (final command in createCommands)
              SsNavigationItem(
                label: text(context, 'Projekt', command.label),
                icon: command.icon,
                selected: false,
                onPressed: () {
                  closeNavigation();
                  onCommand(command);
                },
              ),
          ],
        ),
      );
    }

    sections.add(_divider(colors));

    for (final group in _NavigationGroup.values) {
      final grouped = entries
          .where((entry) {
            return entry.group == group;
          })
          .toList(growable: false);

      if (grouped.isEmpty) {
        continue;
      }

      final active = grouped.any((entry) {
        return entry.matches(location);
      });

      sections.add(
        SsNavigationSection(
          key: ValueKey(group),
          label: _sectionLabel(context, group),
          icon: _sectionIcon(group),
          active: active,
          children: [
            for (final entry in grouped) _navigationItem(context, entry),
          ],
        ),
      );
    }

    sections.add(_divider(colors));
    sections.add(
      SsNavigationItem(
        icon: 'logout',
        label: text(context, 'Abmelden', 'Sign out'),
        selected: false,
        onPressed: () {
          closeNavigation();
          unawaited(session.logout());
        },
      ),
    );

    return SafeArea(
      top: false,
      child: ListView(
        padding: const EdgeInsets.all(7.2),
        children: [
          for (var index = 0; index < sections.length; index += 1)
            Padding(
              padding: EdgeInsets.only(
                bottom: index == sections.length - 1 ? 0 : 2.88,
              ),
              child: sections[index],
            ),
        ],
      ),
    );
  }

  Widget _divider(SsColors colors) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5.6),
      child: Container(height: 1, color: colors.border),
    );
  }
}

class _OpenSearchIntent extends Intent {
  const _OpenSearchIntent();
}

class _CreateProjectIntent extends Intent {
  const _CreateProjectIntent();
}

String _sectionIcon(_NavigationGroup group) {
  return switch (group) {
    _NavigationGroup.projectWork => 'building',
    _NavigationGroup.materialsTools => 'tools',
    _NavigationGroup.usersContacts => 'building',
  };
}

String _sectionLabel(BuildContext context, _NavigationGroup group) {
  return switch (group) {
    _NavigationGroup.projectWork => text(
      context,
      'Projektarbeit',
      'Project work',
    ),
    _NavigationGroup.materialsTools => text(
      context,
      'Material & Werkzeuge',
      'Materials & tools',
    ),
    _NavigationGroup.usersContacts => text(
      context,
      'Benutzer & Kontakte',
      'Users & contacts',
    ),
  };
}
