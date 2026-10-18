import 'client.dart';
import 'procedure.dart';

extension TypedSessionApi on SessionApi {
  Future<O> read<I, O>(RpcQuery<I, O> procedure, I input) async {
    final request = procedure.encodeInput(input);

    final response = await query(procedure.path, request);

    return procedure.decodeOutput(response);
  }

  Future<O> write<I, O>(
    RpcMutation<I, O> procedure,
    I input, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final request = procedure.encodeInput(input);

    final response = await mutate(procedure.path, request, timeout: timeout);

    return procedure.decodeOutput(response);
  }
}
