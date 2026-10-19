import 'dart:convert';

import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';

enum VendorDraftIssue { required, tooLong }

final class VendorDraft {
  const VendorDraft({
    required this.name,
    this.description = const RpcOptional.absent(),
    this.vendorId,
  });

  factory VendorDraft.fromVendor(models.ProductVendor vendor) {
    return VendorDraft(
      vendorId: vendor.id,
      name: vendor.name,
      description: RpcOptional.value(vendor.description),
    );
  }

  final String name;
  final RpcOptional<String?> description;
  final String? vendorId;

  Map<String, VendorDraftIssue> validate() {
    final issues = <String, VendorDraftIssue>{};
    final trimmedName = name.trim();
    final trimmedDescription = description.valueOrNull?.trim();

    if (trimmedName.isEmpty) {
      issues['name'] = VendorDraftIssue.required;
    } else if (utf8.encode(trimmedName).length > 127) {
      issues['name'] = VendorDraftIssue.tooLong;
    }

    if (trimmedDescription != null &&
        utf8.encode(trimmedDescription).length > 255) {
      issues['description'] = VendorDraftIssue.tooLong;
    }

    if (vendorId != null && vendorId!.isEmpty) {
      issues['id'] = VendorDraftIssue.required;
    }

    return Map.unmodifiable(issues);
  }

  void _check() {
    if (validate().isNotEmpty) {
      throw const FormatException('INVALID_VENDOR_DRAFT');
    }
  }

  models.ProductsVendorsCreateInput createInput() {
    _check();

    if (vendorId != null) {
      throw const FormatException('VENDOR_CREATE_REQUIRES_NEW_DRAFT');
    }

    // Validation follows backend trimming without changing canonical raw input.
    return models.ProductsVendorsCreateInput(
      name: name,
      description: description,
    );
  }

  models.ProductsVendorsUpdateInput updateInput() {
    _check();

    final id = vendorId;

    if (id == null || id.isEmpty) {
      throw const FormatException('VENDOR_UPDATE_REQUIRES_KNOWN_ID');
    }

    return models.ProductsVendorsUpdateInput(
      id: id,
      data: models.ProductsVendorsUpdateRequestData(
        name: RpcOptional.value(name),
        description: description,
      ),
    );
  }
}
