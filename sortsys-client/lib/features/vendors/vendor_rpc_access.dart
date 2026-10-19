import '../../api/generated/api.g.dart';
import '../../api/generated/models.g.dart' as models;
import '../../api/model.dart';
import '../../api/procedure.dart';
import 'vendor_delete_coordinator.dart';
import 'vendor_draft.dart';

typedef VendorRead = Future<O> Function<I, O>(RpcQuery<I, O> query, I input);
typedef VendorWrite = Future<O> Function<I, O>(
  RpcMutation<I, O> mutation,
  I input,
);

final class VendorRpcAccess implements VendorDeleteAccess {
  const VendorRpcAccess({
    required this.scope,
    required this.read,
    required this.write,
    required this.isCurrent,
    required this.can,
    this.vendorId,
  });

  @override
  final String scope;

  final String? vendorId;
  final VendorRead read;
  final VendorWrite write;
  final bool Function() isCurrent;
  final bool Function(String permission) can;

  @override
  void checkCurrent() {
    if (scope.isEmpty || vendorId?.isEmpty == true) {
      throw const FormatException('INVALID_VENDOR_WRITE_OWNER');
    }

    if (!isCurrent() || !can('view:productVendors')) {
      throw StateError('VENDOR_WRITE_SCOPE_CHANGED');
    }
  }

  void _checkManage() {
    checkCurrent();

    if (!can('manage:productVendors')) {
      throw StateError('VENDOR_WRITE_NOT_ALLOWED');
    }
  }

  @override
  void checkCreate(models.ProductsVendorsCreateInput input) {
    _checkManage();

    if (vendorId != null) {
      throw const FormatException('INVALID_VENDOR_CREATE_CONTEXT');
    }

    _checkFields(input.name, input.description);
  }

  @override
  void checkUpdate(models.ProductsVendorsUpdateInput input) {
    _checkManage();

    if (vendorId == null || input.id != vendorId || !input.data.name.hasValue) {
      throw const FormatException('INVALID_VENDOR_UPDATE_CONTEXT');
    }

    _checkFields(input.data.name.value, input.data.description);
  }

  @override
  void checkDelete(models.ProductsVendorsDeleteInput input) {
    checkCurrent();

    if (!can('delete:productVendors')) {
      throw StateError('VENDOR_DELETE_NOT_ALLOWED');
    }

    if (vendorId == null || input.id.isEmpty || input.id != vendorId) {
      throw const FormatException('INVALID_VENDOR_DELETE_CONTEXT');
    }
  }

  @override
  Future<models.ProductsVendorsDeleteOutput> deleteVendor(
    models.ProductsVendorsDeleteInput input,
  ) async {
    checkDelete(input);

    final result = await write(ApiMutations.productsVendorsDelete, input);
    checkDelete(input);

    if (!result.success) {
      throw const FormatException('INVALID_VENDOR_DELETE_RESULT');
    }

    return result;
  }

  @override
  Future<models.ProductsVendorsCreateOutput> createVendor(
    models.ProductsVendorsCreateInput input,
  ) async {
    checkCreate(input);

    final result = await write(ApiMutations.productsVendorsCreate, input);
    checkCreate(input);

    if (result.id.isEmpty) {
      throw const FormatException('INVALID_VENDOR_CREATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.ProductsVendorsUpdateOutput> updateVendor(
    models.ProductsVendorsUpdateInput input,
  ) async {
    checkUpdate(input);

    final result = await write(ApiMutations.productsVendorsUpdate, input);
    checkUpdate(input);

    if (!result.success) {
      throw const FormatException('INVALID_VENDOR_UPDATE_RESULT');
    }

    return result;
  }

  @override
  Future<models.ProductVendor?> getVendor(String id) async {
    checkCurrent();

    if (id.isEmpty || (vendorId != null && vendorId != id)) {
      throw const FormatException('INVALID_VENDOR_READBACK_OWNER');
    }

    final vendor = await read(
      ApiQueries.productsVendorsGet,
      models.ProductsVendorsGetInput(id: id),
    );
    checkCurrent();

    if (vendor.id != id) {
      throw const FormatException('VENDOR_READBACK_ID_MISMATCH');
    }

    return vendor;
  }
}

void _checkFields(String name, RpcOptional<String?> description) {
  final draft = VendorDraft(name: name, description: description);
  final text = description.valueOrNull;

  if (draft.validate().isNotEmpty ||
      name != name.trim() ||
      !description.hasValue ||
      (text != null && (text.isEmpty || text != text.trim()))) {
    throw const FormatException('INVALID_VENDOR_WRITE_INPUT');
  }
}
