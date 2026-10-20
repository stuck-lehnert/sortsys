import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:go_router/go_router.dart';
import 'package:provider/provider.dart';

import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../state/session_controller.dart';
import '../../ui/text.dart';
import '../contacts/session_contact_dialog.dart';
import '../customers/session_customer_dialog.dart';
import '../products/session_product_master_dialog.dart';
import '../projects/project_editor.dart';
import '../vendors/session_vendor_create_dialog.dart';
import 'command_palette_controller.dart';

List<PaletteCommand> workspaceCommands(BuildContext context) {
  return [
    PaletteCommand(
      id: 'projects.create',
      label: text(context, 'Projekt erstellen', 'Create project'),
      description: text(
        context,
        'Neues Projekt im Projektstamm anlegen.',
        'Create a new project.',
      ),
      icon: 'project',
      group: PaletteGroup.create,
      role: 'manage:projects',
    ),
    PaletteCommand(
      id: 'customers.create',
      label: text(context, 'Kunde erstellen', 'Create customer'),
      description: text(
        context,
        'Neuen Kundenstamm anlegen.',
        'Create a new customer.',
      ),
      icon: 'customer',
      group: PaletteGroup.create,
      role: 'manage:customers',
      requiredRoles: const ['view:customers'],
    ),
    PaletteCommand(
      id: 'contacts.create',
      label: text(context, 'Kontakt erstellen', 'Create contact'),
      description: text(
        context,
        'Neue Kontaktperson anlegen.',
        'Create a new contact person.',
      ),
      icon: 'contact',
      group: PaletteGroup.create,
      role: 'manage:contacts',
      requiredRoles: const ['view:contacts'],
    ),
    PaletteCommand(
      id: 'products.create',
      label: text(context, 'Produkt erstellen', 'Create product'),
      description: text(
        context,
        'Neues Material oder Produkt anlegen.',
        'Create a new material or product.',
      ),
      icon: 'product',
      group: PaletteGroup.create,
      role: 'manage:products',
      requiredRoles: const ['view:products'],
    ),
    PaletteCommand(
      id: 'productVendors.create',
      label: text(context, 'Händler erstellen', 'Create vendor'),
      description: text(
        context,
        'Neuen Produkt-Händler anlegen.',
        'Create a new product vendor.',
      ),
      icon: 'vendor',
      group: PaletteGroup.create,
      role: 'manage:productVendors',
      requiredRoles: const ['view:productVendors'],
    ),
    PaletteCommand(
      id: 'deployments.open',
      label: text(context, 'Einsatzplanung öffnen', 'Open resource planning'),
      description: text(
        context,
        'Projektzuweisungen und Abwesenheiten planen.',
        'Plan project assignments and absences.',
      ),
      icon: 'calendar',
      group: PaletteGroup.navigate,
      role: 'view:projectDeployments',
      href: '/deployments',
    ),
  ];
}

Future<void> runWorkspaceCommand(
  BuildContext context,
  PaletteCommand command,
) async {
  final session = context.read<SessionController>();
  final binding = session.binding;

  bool isCurrent() {
    return session.authenticated &&
        session.binding == binding &&
        command.isAllowed((role) {
          return session.info?.can(role) == true;
        });
  }

  if (!isCurrent()) {
    return;
  }

  unawaited(_recordCommand(session, command));

  switch (command.id) {
    case 'projects.create':
      final id = await showProjectEditor(context);

      if (!context.mounted || id == null || !isCurrent()) {
        return;
      }

      context.go('/projects/${Uri.encodeComponent(id)}');
    case 'customers.create':
      bool customerCurrent() {
        return context.mounted &&
            session.authenticated &&
            session.binding == binding &&
            session.info?.can('view:customers') == true;
      }

      final customerId = await showSessionCustomerDialog(
        context,
        session,
        isActive: customerCurrent,
      );

      if (!context.mounted || customerId == null || !customerCurrent()) {
        return;
      }

      context.go('/customers/${Uri.encodeComponent(customerId)}');
    case 'contacts.create':
      final contact = await showSessionContactDialog(
        context,
        session,
        isActive: isCurrent,
      );

      if (!context.mounted || contact == null || !isCurrent()) {
        return;
      }

      context.go('/contacts/${Uri.encodeComponent(contact.id)}');
    case 'products.create':
      final product = await showSessionProductMasterDialog(
        context,
        session,
        isActive: isCurrent,
      );

      if (!context.mounted || product == null || !isCurrent()) {
        return;
      }

      context.go('/products/${Uri.encodeComponent(product.id)}');
    case 'productVendors.create':
      final vendor = await showSessionVendorCreateDialog(context, session);

      if (!context.mounted || vendor == null || !isCurrent()) {
        return;
      }

      context.go('/products/vendors/${Uri.encodeComponent(vendor.id)}');
    case 'deployments.open':
      context.go('/deployments');
    default:
      throw StateError('UNKNOWN_WORKSPACE_COMMAND');
  }
}

Future<void> _recordCommand(
  SessionController session,
  PaletteCommand command,
) async {
  final href = command.href;
  final input = models.PersonalizationActionsAppendInput(
    actionId: command.id,
    label: command.label,
    href: href == null ? const RpcOptional.absent() : RpcOptional.value(href),
  );

  try {
    await session.write(ApiMutations.personalizationActionsAppend, input);
  } catch (_) {
    // Usage history is best effort and is never replayed.
  }
}
