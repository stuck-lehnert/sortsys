import 'package:flutter/widgets.dart';
import 'package:sortsys_ui/sortsys_ui.dart';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../ui/text.dart';
import 'vendor_draft.dart';

final class VendorFormValues {
  VendorFormValues({models.ProductVendor? vendor, String initialQuery = ''})
    : vendorId = vendor?.id,
      name = TextEditingController(text: vendor?.name ?? initialQuery),
      description = TextEditingController(text: vendor?.description ?? '');

  final String? vendorId;
  final TextEditingController name;
  final TextEditingController description;

  VendorDraft draft() {
    return VendorDraft(
      vendorId: vendorId,
      name: name.text,
      description: RpcOptional.value(description.text),
    );
  }

  void dispose() {
    name.dispose();
    description.dispose();
  }
}

class VendorFormFields extends StatelessWidget {
  const VendorFormFields({
    super.key,
    required this.values,
    this.enabled = true,
  });

  final VendorFormValues values;
  final bool enabled;

  String? _error(BuildContext context, String field, int maximumBytes) {
    final issue = values.draft().validate()[field];

    if (issue == null) {
      return null;
    }

    if (issue == VendorDraftIssue.required) {
      return text(context, 'Pflichtfeld', 'Required field');
    }

    return text(
      context,
      'Höchstens $maximumBytes UTF-8-Bytes.',
      'Maximum $maximumBytes UTF-8 bytes.',
    );
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SsTextField(
          key: ObjectKey(values.name),
          label: 'Name *',
          controller: values.name,
          enabled: enabled,
          validator: (value) {
            return _error(context, 'name', 127);
          },
        ),
        const SizedBox(height: 16),
        SsTextField(
          key: ObjectKey(values.description),
          label: text(context, 'Beschreibung', 'Description'),
          controller: values.description,
          enabled: enabled,
          validator: (value) {
            return _error(context, 'description', 255);
          },
        ),
      ],
    );
  }
}
