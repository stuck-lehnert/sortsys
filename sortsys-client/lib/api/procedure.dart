import 'model.dart';

sealed class TypedProcedure<I, O> {
  const TypedProcedure({required this.path, required this.decodeOutput});

  final String path;
  final O Function(Object?) decodeOutput;

  Object? encodeInput(I input) {
    return encodeRpcValue(input);
  }
}

final class RpcQuery<I, O> extends TypedProcedure<I, O> {
  const RpcQuery({required super.path, required super.decodeOutput});
}

final class RpcMutation<I, O> extends TypedProcedure<I, O> {
  const RpcMutation({required super.path, required super.decodeOutput});
}
