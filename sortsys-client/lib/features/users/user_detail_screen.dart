import 'package:flutter/widgets.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';
import 'user_detail_layout.dart';
import 'user_detail_reads.dart';

class UserDetailScreen extends HookWidget {
  const UserDetailScreen({super.key, required this.id});

  final String id;

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final binding = session.binding;
    final owner = useRef(id);
    final mounted = useRef(true);
    final revision = useState(0);
    owner.value = id;

    useEffect(() {
      return () {
        mounted.value = false;
      };
    }, const []);

    final allowed =
        session.authenticated && session.info?.can('view:users') == true;
    final repository = UserDetailReads(
      userId: id,
      read: session.read,
      isCurrent: () {
        return mounted.value &&
            owner.value == id &&
            session.authenticated &&
            session.binding == binding;
      },
      canView: () {
        return session.info?.can('view:users') == true;
      },
    );
    final future = useMemoized(() {
      if (!allowed) {
        return null;
      }

      return repository.get();
    }, [binding, id, allowed, revision.value]);
    final snapshot = useFuture(future, preserveState: false);
    final user = snapshot.data;
    final supervisorId = user?.supervisorUserId;
    final supervisorFuture = useMemoized(() {
      if (!allowed || supervisorId == null || supervisorId.isEmpty) {
        return null;
      }

      return repository.supervisor(supervisorId);
    }, [binding, id, allowed, supervisorId, revision.value]);
    final supervisor = useFuture(supervisorFuture, preserveState: false);

    if (!allowed) {
      return Center(
        child: Text(text(context, 'Keine Berechtigung', 'No permission')),
      );
    }

    if (snapshot.hasError) {
      return Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              text(
                context,
                'Benutzer konnte nicht geladen werden.',
                'User could not be loaded.',
              ),
            ),
            const SizedBox(height: 8),
            SsButton(
              kind: SsButtonKind.secondary,
              onPressed: () {
                revision.value++;
              },
              child: Text(text(context, 'Erneut laden', 'Reload')),
            ),
          ],
        ),
      );
    }

    if (user == null) {
      return const Center(child: SsSpinner());
    }

    final supervisorUser = supervisor.data;

    return UserDetailLayout(
      key: ValueKey((binding, id)),
      user: user,
      supervisor: supervisorUser,
      onSupervisorPressed: supervisorUser == null
          ? null
          : () {
              context.go('/users/${Uri.encodeComponent(supervisorUser.id)}');
            },
    );
  }
}
