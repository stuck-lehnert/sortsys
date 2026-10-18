import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:provider/provider.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../state/session_controller.dart';
import '../../ui/text.dart';

class LoginScreen extends HookWidget {
  const LoginScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final session = context.watch<SessionController>();
    final domain = useTextEditingController();
    final account = useTextEditingController();
    final password = useTextEditingController();
    final hidden = useState(true);

    Future<void> submit() async {
      await session.login(domain.text, account.text, password.text);

      if (context.mounted && session.authenticated) {
        password.clear();
      }
    }

    return SafeArea(
      child: Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(24),
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 440),
            child: SsSurface(
              padding: const EdgeInsets.all(24),
              child: AutofillGroup(
                child: _LoginForm(
                  session: session,
                  domain: domain,
                  account: account,
                  password: password,
                  hidden: hidden.value,
                  onVisibilityChanged: () {
                    hidden.value = !hidden.value;
                  },
                  onSubmit: submit,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _LoginForm extends StatelessWidget {
  const _LoginForm({
    required this.session,
    required this.domain,
    required this.account,
    required this.password,
    required this.hidden,
    required this.onVisibilityChanged,
    required this.onSubmit,
  });

  final SessionController session;
  final TextEditingController domain;
  final TextEditingController account;
  final TextEditingController password;
  final bool hidden;
  final VoidCallback onVisibilityChanged;
  final Future<void> Function() onSubmit;

  @override
  Widget build(BuildContext context) {
    final colors = SsTheme.of(context);
    final dark = colors.brightness == Brightness.dark;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Image.asset(
          'assets/brand/logo-black.png',
          height: 48,
          fit: BoxFit.contain,
          color: dark ? Colors.white : null,
        ),
        const SizedBox(height: 24),
        Text(text(context, 'Anmelden', 'Sign in'), style: colors.heading),
        const SizedBox(height: 20),
        SsTextField(
          label: text(context, 'Serveradresse', 'Server address'),
          hint: 'sortsys.example.org',
          controller: domain,
          enabled: !session.busy,
          autocorrect: false,
          keyboardType: TextInputType.url,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 16),
        SsTextField(
          label: text(context, 'Nutzername@Mandant', 'Username@tenant'),
          controller: account,
          enabled: !session.busy,
          autofillHints: const [AutofillHints.username],
          autocorrect: false,
          textInputAction: TextInputAction.next,
        ),
        const SizedBox(height: 16),
        SsTextField(
          label: text(context, 'Passwort', 'Password'),
          controller: password,
          kind: SsTextFieldKind.password,
          enabled: !session.busy,
          autofillHints: const [AutofillHints.password],
          obscureText: hidden,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) {
            if (!session.busy) {
              onSubmit();
            }
          },
          suffix: SsIconButton(
            label: text(
              context,
              'Passwort anzeigen oder verbergen',
              'Show or hide password',
            ),
            icon: hidden ? 'eye' : 'eye-off',
            onPressed: onVisibilityChanged,
          ),
        ),
        if (session.error != null)
          Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Semantics(
              liveRegion: true,
              child: Text(
                errorText(context, session.error),
                style: colors.body.copyWith(color: colors.danger),
              ),
            ),
          ),
        const SizedBox(height: 24),
        SsButton(
          onPressed: session.busy ? null : onSubmit,
          child: session.busy
              ? SsSpinner(label: text(context, 'Anmelden', 'Sign in'))
              : Text(text(context, 'Anmelden', 'Sign in')),
        ),
      ],
    );
  }
}
