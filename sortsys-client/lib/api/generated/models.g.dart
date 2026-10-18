// Generated from the Rust API contract. Do not edit by hand.
import '../contract.dart';
import '../model.dart';

enum ActivityResourceType implements RpcValue {
  project("project"),
  tool("tool"),
  user("user"),
  customer("customer"),
  contact("contact"),
  product("product"),
  productVendor("productVendor"),
  deliveryNote("deliveryNote"),
  regieReport("regieReport"),
  dailyProjectReport("dailyProjectReport");

  const ActivityResourceType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ActivityResourceType>(
    ActivityResourceType.fromWire,
  );

  factory ActivityResourceType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ApplyPriceImportRow implements RpcValue {
  const ApplyPriceImportRow({
    this.productId,
    required this.productName,
    this.brand,
    this.description,
    required this.baseUnit,
    required this.otherUnits,
    required this.pricePerBaseUnit,
    this.comment,
  });

  static const codec = RpcCodec<ApplyPriceImportRow>(
    ApplyPriceImportRow.fromWire,
  );

  final Id? productId;
  final String productName;
  final String? brand;
  final String? description;
  final String baseUnit;
  final ApplyPriceImportRowOtherUnits otherUnits;
  final num pricePerBaseUnit;
  final String? comment;

  factory ApplyPriceImportRow.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "productName",
      "brand",
      "description",
      "baseUnit",
      "otherUnits",
      "pricePerBaseUnit",
      "comment",
    });

    return ApplyPriceImportRow(
      productId: rpcNullable(rpcString)
          .decode(readRpcField(object, "productId")),
      productName: rpcString.decode(readRpcField(object, "productName")),
      brand: rpcNullable(rpcString).decode(readRpcField(object, "brand")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      baseUnit: rpcString.decode(readRpcField(object, "baseUnit")),
      otherUnits: ApplyPriceImportRowOtherUnits.codec.decode(
        readRpcField(object, "otherUnits"),
      ),
      pricePerBaseUnit: rpcNumber.decode(
        readRpcField(object, "pricePerBaseUnit"),
      ),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "productId": encodeRpcValue(productId),
      "productName": encodeRpcValue(productName),
      "brand": encodeRpcValue(brand),
      "description": encodeRpcValue(description),
      "baseUnit": encodeRpcValue(baseUnit),
      "otherUnits": encodeRpcValue(otherUnits),
      "pricePerBaseUnit": encodeRpcValue(pricePerBaseUnit),
      "comment": encodeRpcValue(comment),
    };

  }

}

enum AssistantLocale implements RpcValue {
  de("de"),
  en("en");

  const AssistantLocale(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<AssistantLocale>(AssistantLocale.fromWire);

  factory AssistantLocale.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ChangeProposal implements RpcValue {
  const ChangeProposal({
    required this.id,
    this.assistantMessageId,
    required this.title,
    required this.summary,
    required this.operations,
    this.executionResults,
    required this.status,
    this.reviewComment,
    required this.createdAt,
    required this.reviewedAt,
  });

  static const codec = RpcCodec<ChangeProposal>(ChangeProposal.fromWire);

  final Id id;
  final Id? assistantMessageId;
  final String title;
  final String summary;
  final JsonValue operations;
  final JsonValue? executionResults;
  final ChangeProposalStatus status;
  final String? reviewComment;
  final DateTime createdAt;
  final DateTime reviewedAt;

  factory ChangeProposal.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "assistantMessageId",
      "title",
      "summary",
      "operations",
      "executionResults",
      "status",
      "reviewComment",
      "createdAt",
      "reviewedAt",
    });

    return ChangeProposal(
      id: rpcString.decode(readRpcField(object, "id")),
      assistantMessageId: rpcNullable(rpcString)
          .decode(readRpcField(object, "assistantMessageId")),
      title: rpcString.decode(readRpcField(object, "title")),
      summary: rpcString.decode(readRpcField(object, "summary")),
      operations: JsonValue.codec.decode(readRpcField(object, "operations")),
      executionResults: rpcNullable(JsonValue.codec)
          .decode(readRpcField(object, "executionResults")),
      status: ChangeProposalStatus.codec.decode(readRpcField(object, "status")),
      reviewComment: rpcNullable(rpcString)
          .decode(readRpcField(object, "reviewComment")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      reviewedAt: rpcDate.decode(readRpcField(object, "reviewedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "assistantMessageId": encodeRpcValue(assistantMessageId),
      "title": encodeRpcValue(title),
      "summary": encodeRpcValue(summary),
      "operations": encodeRpcValue(operations),
      "executionResults": encodeRpcValue(executionResults),
      "status": encodeRpcValue(status),
      "reviewComment": encodeRpcValue(reviewComment),
      "createdAt": encodeRpcValue(createdAt),
      "reviewedAt": encodeRpcValue(reviewedAt),
    };

  }

}

final class ChatMessage implements RpcValue {
  const ChatMessage({
    required this.id,
    required this.role,
    required this.content,
    required this.createdAt,
  });

  static const codec = RpcCodec<ChatMessage>(ChatMessage.fromWire);

  final Id id;
  final ChatMessageRole role;
  final String content;
  final DateTime createdAt;

  factory ChatMessage.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "role",
      "content",
      "createdAt",
    });

    return ChatMessage(
      id: rpcString.decode(readRpcField(object, "id")),
      role: ChatMessageRole.codec.decode(readRpcField(object, "role")),
      content: rpcString.decode(readRpcField(object, "content")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "role": encodeRpcValue(role),
      "content": encodeRpcValue(content),
      "createdAt": encodeRpcValue(createdAt),
    };

  }

}

final class ChatSummary implements RpcValue {
  const ChatSummary({
    required this.id,
    required this.title,
    required this.createdAt,
    required this.updatedAt,
  });

  static const codec = RpcCodec<ChatSummary>(ChatSummary.fromWire);

  final Id id;
  final String title;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory ChatSummary.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "title",
      "createdAt",
      "updatedAt",
    });

    return ChatSummary(
      id: rpcString.decode(readRpcField(object, "id")),
      title: rpcString.decode(readRpcField(object, "title")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      updatedAt: rpcDate.decode(readRpcField(object, "updatedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "title": encodeRpcValue(title),
      "createdAt": encodeRpcValue(createdAt),
      "updatedAt": encodeRpcValue(updatedAt),
    };

  }

}

final class DeliveryNoteScanResult implements RpcValue {
  const DeliveryNoteScanResult({
    this.supplier,
    this.deliveryNumber,
    this.deliveryDate,
    this.comment,
    required this.records,
    required this.specialRecords,
    required this.warnings,
  });

  static const codec = RpcCodec<DeliveryNoteScanResult>(
    DeliveryNoteScanResult.fromWire,
  );

  final String? supplier;
  final String? deliveryNumber;
  final String? deliveryDate;
  final String? comment;
  final List<ScannedProductRecord> records;
  final List<ScannedSpecialRecord> specialRecords;
  final List<String> warnings;

  factory DeliveryNoteScanResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "supplier",
      "deliveryNumber",
      "deliveryDate",
      "comment",
      "records",
      "specialRecords",
      "warnings",
    });

    return DeliveryNoteScanResult(
      supplier: rpcNullable(rpcString).decode(readRpcField(object, "supplier")),
      deliveryNumber: rpcNullable(rpcString)
          .decode(readRpcField(object, "deliveryNumber")),
      deliveryDate: rpcNullable(rpcString)
          .decode(readRpcField(object, "deliveryDate")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      records: rpcArray(ScannedProductRecord.codec)
          .decode(readRpcField(object, "records")),
      specialRecords: rpcArray(ScannedSpecialRecord.codec)
          .decode(readRpcField(object, "specialRecords")),
      warnings: rpcArray(rpcString).decode(readRpcField(object, "warnings")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "supplier": encodeRpcValue(supplier),
      "deliveryNumber": encodeRpcValue(deliveryNumber),
      "deliveryDate": encodeRpcValue(deliveryDate),
      "comment": encodeRpcValue(comment),
      "records": encodeRpcValue(records),
      "specialRecords": encodeRpcValue(specialRecords),
      "warnings": encodeRpcValue(warnings),
    };

  }

}

sealed class JsonValue implements RpcValue {
  const JsonValue._();

  static const codec = RpcCodec<JsonValue>(JsonValue.fromWire);

  factory JsonValue.fromWire(Object? value) {
    final decoder = rpcUnion<JsonValue>([
      rpcVariant<num, JsonValue>(rpcNumber, JsonValueNumber.new),
      rpcVariant<String, JsonValue>(rpcString, JsonValueString.new),
      rpcVariant<bool, JsonValue>(rpcBoolean, JsonValueBoolean.new),
      rpcVariant<List<JsonValue>, JsonValue>(
        rpcArray(JsonValue.codec),
        JsonValueArray.new,
      ),
      rpcVariant<JsonValueVariant5, JsonValue>(
        JsonValueVariant5.codec,
        JsonValueRecord.new,
      ),
      rpcVariant<Null, JsonValue>(rpcNull, JsonValueNull.new),
    ]);

    return decoder.decode(value);
  }

}

final class JsonValueNumber extends JsonValue {
  const JsonValueNumber(this.value) : super._();

  final num value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class JsonValueString extends JsonValue {
  const JsonValueString(this.value) : super._();

  final String value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class JsonValueBoolean extends JsonValue {
  const JsonValueBoolean(this.value) : super._();

  final bool value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class JsonValueArray extends JsonValue {
  const JsonValueArray(this.value) : super._();

  final List<JsonValue> value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class JsonValueRecord extends JsonValue {
  const JsonValueRecord(this.value) : super._();

  final JsonValueVariant5 value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class JsonValueNull extends JsonValue {
  const JsonValueNull(this.value) : super._();

  final Null value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

enum LlmUseCase implements RpcValue {
  chat("chat"),
  documentImport("documentImport"),
  onlyoffice("onlyoffice");

  const LlmUseCase(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<LlmUseCase>(LlmUseCase.fromWire);

  factory LlmUseCase.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ParseScanInput implements RpcValue {
  const ParseScanInput({
    required this.objectKey,
    required this.fileName,
    required this.mimeType,
    required this.sizeBytes,
  });

  static const codec = RpcCodec<ParseScanInput>(ParseScanInput.fromWire);

  final String objectKey;
  final String fileName;
  final String mimeType;
  final num sizeBytes;

  factory ParseScanInput.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "objectKey",
      "fileName",
      "mimeType",
      "sizeBytes",
    });

    return ParseScanInput(
      objectKey: rpcString.decode(readRpcField(object, "objectKey")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      sizeBytes: rpcNumber.decode(readRpcField(object, "sizeBytes")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "objectKey": encodeRpcValue(objectKey),
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      "sizeBytes": encodeRpcValue(sizeBytes),
    };

  }

}

final class PriceListScanResult implements RpcValue {
  const PriceListScanResult({
    this.supplier,
    this.documentNumber,
    this.effectiveDate,
    required this.rows,
    required this.warnings,
  });

  static const codec = RpcCodec<PriceListScanResult>(
    PriceListScanResult.fromWire,
  );

  final String? supplier;
  final String? documentNumber;
  final String? effectiveDate;
  final List<ScannedPriceRow> rows;
  final List<String> warnings;

  factory PriceListScanResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "supplier",
      "documentNumber",
      "effectiveDate",
      "rows",
      "warnings",
    });

    return PriceListScanResult(
      supplier: rpcNullable(rpcString).decode(readRpcField(object, "supplier")),
      documentNumber: rpcNullable(rpcString)
          .decode(readRpcField(object, "documentNumber")),
      effectiveDate: rpcNullable(rpcString)
          .decode(readRpcField(object, "effectiveDate")),
      rows: rpcArray(ScannedPriceRow.codec)
          .decode(readRpcField(object, "rows")),
      warnings: rpcArray(rpcString).decode(readRpcField(object, "warnings")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "supplier": encodeRpcValue(supplier),
      "documentNumber": encodeRpcValue(documentNumber),
      "effectiveDate": encodeRpcValue(effectiveDate),
      "rows": encodeRpcValue(rows),
      "warnings": encodeRpcValue(warnings),
    };

  }

}

enum ProposalDecision implements RpcValue {
  accept("accept"),
  decline("decline"),
  requestRevision("requestRevision");

  const ProposalDecision(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProposalDecision>(ProposalDecision.fromWire);

  factory ProposalDecision.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ProposalExecutionResult implements RpcValue {
  const ProposalExecutionResult({required this.path, required this.output});

  static const codec = RpcCodec<ProposalExecutionResult>(
    ProposalExecutionResult.fromWire,
  );

  final String path;
  final JsonValue output;

  factory ProposalExecutionResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"path", "output"});

    return ProposalExecutionResult(
      path: rpcString.decode(readRpcField(object, "path")),
      output: JsonValue.codec.decode(readRpcField(object, "output")),
    );
  }

  @override
  JsonMap toWire() {
    return {"path": encodeRpcValue(path), "output": encodeRpcValue(output)};
  }

}

enum ProviderName implements RpcValue {
  openai("openai"),
  anthropic("anthropic"),
  meta("meta"),
  openrouter("openrouter"),
  deepseek("deepseek"),
  custom("custom");

  const ProviderName(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProviderName>(ProviderName.fromWire);

  factory ProviderName.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ScanDocumentType implements RpcValue {
  deliveryNote("deliveryNote"),
  priceList("priceList"),
  invoice("invoice");

  const ScanDocumentType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ScanDocumentType>(ScanDocumentType.fromWire);

  factory ScanDocumentType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ScanJobState implements RpcValue {
  queued("queued"),
  ocr("ocr"),
  matching("matching"),
  completed("completed"),
  failed("failed");

  const ScanJobState(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ScanJobState>(ScanJobState.fromWire);

  factory ScanJobState.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ScannedPriceRow implements RpcValue {
  const ScannedPriceRow({
    required this.sourceText,
    this.productId,
    this.customId,
    required this.productName,
    this.brand,
    this.description,
    required this.otherUnits,
    required this.baseUnit,
    required this.sourceUnit,
    required this.pricePerBaseUnit,
    required this.confidence,
    this.comment,
  });

  static const codec = RpcCodec<ScannedPriceRow>(ScannedPriceRow.fromWire);

  final String sourceText;
  final Id? productId;
  final num? customId;
  final String productName;
  final String? brand;
  final String? description;
  final ApplyPriceImportRowOtherUnits otherUnits;
  final String baseUnit;
  final String sourceUnit;
  final num pricePerBaseUnit;
  final num confidence;
  final String? comment;

  factory ScannedPriceRow.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "sourceText",
      "productId",
      "customId",
      "productName",
      "brand",
      "description",
      "otherUnits",
      "baseUnit",
      "sourceUnit",
      "pricePerBaseUnit",
      "confidence",
      "comment",
    });

    return ScannedPriceRow(
      sourceText: rpcString.decode(readRpcField(object, "sourceText")),
      productId: rpcNullable(rpcString)
          .decode(readRpcField(object, "productId")),
      customId: rpcNullable(rpcNumber).decode(readRpcField(object, "customId")),
      productName: rpcString.decode(readRpcField(object, "productName")),
      brand: rpcNullable(rpcString).decode(readRpcField(object, "brand")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      otherUnits: ApplyPriceImportRowOtherUnits.codec.decode(
        readRpcField(object, "otherUnits"),
      ),
      baseUnit: rpcString.decode(readRpcField(object, "baseUnit")),
      sourceUnit: rpcString.decode(readRpcField(object, "sourceUnit")),
      pricePerBaseUnit: rpcNumber.decode(
        readRpcField(object, "pricePerBaseUnit"),
      ),
      confidence: rpcNumber.decode(readRpcField(object, "confidence")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "sourceText": encodeRpcValue(sourceText),
      "productId": encodeRpcValue(productId),
      "customId": encodeRpcValue(customId),
      "productName": encodeRpcValue(productName),
      "brand": encodeRpcValue(brand),
      "description": encodeRpcValue(description),
      "otherUnits": encodeRpcValue(otherUnits),
      "baseUnit": encodeRpcValue(baseUnit),
      "sourceUnit": encodeRpcValue(sourceUnit),
      "pricePerBaseUnit": encodeRpcValue(pricePerBaseUnit),
      "confidence": encodeRpcValue(confidence),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class ScannedProductRecord implements RpcValue {
  const ScannedProductRecord({
    required this.sourceText,
    required this.productId,
    required this.customId,
    required this.productName,
    required this.quantity,
    required this.displayQuantity,
    required this.unit,
    required this.baseUnit,
    required this.confidence,
    this.comment,
  });

  static const codec = RpcCodec<ScannedProductRecord>(
    ScannedProductRecord.fromWire,
  );

  final String sourceText;
  final Id productId;
  final num customId;
  final String productName;
  final num quantity;
  final num displayQuantity;
  final String unit;
  final String baseUnit;
  final num confidence;
  final String? comment;

  factory ScannedProductRecord.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "sourceText",
      "productId",
      "customId",
      "productName",
      "quantity",
      "displayQuantity",
      "unit",
      "baseUnit",
      "confidence",
      "comment",
    });

    return ScannedProductRecord(
      sourceText: rpcString.decode(readRpcField(object, "sourceText")),
      productId: rpcString.decode(readRpcField(object, "productId")),
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      productName: rpcString.decode(readRpcField(object, "productName")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      displayQuantity: rpcNumber.decode(
        readRpcField(object, "displayQuantity"),
      ),
      unit: rpcString.decode(readRpcField(object, "unit")),
      baseUnit: rpcString.decode(readRpcField(object, "baseUnit")),
      confidence: rpcNumber.decode(readRpcField(object, "confidence")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "sourceText": encodeRpcValue(sourceText),
      "productId": encodeRpcValue(productId),
      "customId": encodeRpcValue(customId),
      "productName": encodeRpcValue(productName),
      "quantity": encodeRpcValue(quantity),
      "displayQuantity": encodeRpcValue(displayQuantity),
      "unit": encodeRpcValue(unit),
      "baseUnit": encodeRpcValue(baseUnit),
      "confidence": encodeRpcValue(confidence),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class ScannedSpecialRecord implements RpcValue {
  const ScannedSpecialRecord({
    required this.sourceText,
    required this.name,
    required this.unit,
    required this.amount,
    this.pricePerUnit,
    required this.confidence,
    this.comment,
  });

  static const codec = RpcCodec<ScannedSpecialRecord>(
    ScannedSpecialRecord.fromWire,
  );

  final String sourceText;
  final String name;
  final String unit;
  final num amount;
  final num? pricePerUnit;
  final num confidence;
  final String? comment;

  factory ScannedSpecialRecord.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "sourceText",
      "name",
      "unit",
      "amount",
      "pricePerUnit",
      "confidence",
      "comment",
    });

    return ScannedSpecialRecord(
      sourceText: rpcString.decode(readRpcField(object, "sourceText")),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      pricePerUnit: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "pricePerUnit")),
      confidence: rpcNumber.decode(readRpcField(object, "confidence")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "sourceText": encodeRpcValue(sourceText),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "pricePerUnit": encodeRpcValue(pricePerUnit),
      "confidence": encodeRpcValue(confidence),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class SessionInfo implements RpcValue {
  const SessionInfo({
    required this.user,
    required this.session,
    required this.roles,
    required this.tenant,
  });

  static const codec = RpcCodec<SessionInfo>(SessionInfo.fromWire);

  final SessionInfoUser user;
  final SessionInfoSession session;
  final List<UsersRolesGetResultItem> roles;
  final SessionInfoTenant tenant;

  factory SessionInfo.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "user",
      "session",
      "roles",
      "tenant",
    });

    return SessionInfo(
      user: SessionInfoUser.codec.decode(readRpcField(object, "user")),
      session: SessionInfoSession.codec.decode(readRpcField(object, "session")),
      roles: rpcArray(UsersRolesGetResultItem.codec)
          .decode(readRpcField(object, "roles")),
      tenant: SessionInfoTenant.codec.decode(readRpcField(object, "tenant")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "user": encodeRpcValue(user),
      "session": encodeRpcValue(session),
      "roles": encodeRpcValue(roles),
      "tenant": encodeRpcValue(tenant),
    };

  }

}

final class Project implements RpcValue {
  const Project({
    required this.id,
    required this.title,
    this.address,
    this.customerId,
    this.responsibleProjectLeaderUserId,
    this.orderReceivedAt,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
    this.finishedAt,
  });

  static const codec = RpcCodec<Project>(Project.fromWire);

  final String id;
  final String title;
  final ProjectAddress? address;
  final String? customerId;
  final String? responsibleProjectLeaderUserId;
  final DateTime? orderReceivedAt;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final DateTime? finishedAt;

  factory Project.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "title",
      "address",
      "customerId",
      "responsibleProjectLeaderUserId",
      "orderReceivedAt",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
      "finishedAt",
    });

    return Project(
      id: rpcString.decode(readRpcField(object, "id")),
      title: rpcString.decode(readRpcField(object, "title")),
      address: rpcNullable(ProjectAddress.codec)
          .decode(readRpcField(object, "address")),
      customerId: rpcNullable(rpcString)
          .decode(readRpcField(object, "customerId")),
      responsibleProjectLeaderUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "responsibleProjectLeaderUserId")),
      orderReceivedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "orderReceivedAt")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
      finishedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "finishedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "title": encodeRpcValue(title),
      "address": encodeRpcValue(address),
      "customerId": encodeRpcValue(customerId),
      "responsibleProjectLeaderUserId": encodeRpcValue(
        responsibleProjectLeaderUserId,
      ),
      "orderReceivedAt": encodeRpcValue(orderReceivedAt),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
      "finishedAt": encodeRpcValue(finishedAt),
    };

  }

}

final class Product implements RpcValue {
  const Product({
    required this.id,
    required this.customId,
    required this.name,
    this.description,
    this.regieReportName,
    this.brand,
    required this.baseUnit,
    required this.otherUnits,
    required this.categories,
  });

  static const codec = RpcCodec<Product>(Product.fromWire);

  final String id;
  final num customId;
  final String name;
  final String? description;
  final String? regieReportName;
  final String? brand;
  final String baseUnit;
  final ApplyPriceImportRowOtherUnits otherUnits;
  final List<String> categories;

  factory Product.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "customId",
      "name",
      "description",
      "regieReportName",
      "brand",
      "baseUnit",
      "otherUnits",
      "categories",
    });

    return Product(
      id: rpcString.decode(readRpcField(object, "id")),
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      name: rpcString.decode(readRpcField(object, "name")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      regieReportName: rpcNullable(rpcString)
          .decode(readRpcField(object, "regieReportName")),
      brand: rpcNullable(rpcString).decode(readRpcField(object, "brand")),
      baseUnit: rpcString.decode(readRpcField(object, "baseUnit")),
      otherUnits: ApplyPriceImportRowOtherUnits.codec.decode(
        readRpcField(object, "otherUnits"),
      ),
      categories: rpcArray(rpcString)
          .decode(readRpcField(object, "categories")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "customId": encodeRpcValue(customId),
      "name": encodeRpcValue(name),
      "description": encodeRpcValue(description),
      "regieReportName": encodeRpcValue(regieReportName),
      "brand": encodeRpcValue(brand),
      "baseUnit": encodeRpcValue(baseUnit),
      "otherUnits": encodeRpcValue(otherUnits),
      "categories": encodeRpcValue(categories),
    };

  }

}

final class Tool implements RpcValue {
  const Tool({
    required this.id,
    required this.customId,
    required this.brand,
    required this.category,
    this.label,
    this.purchasePrice,
    this.usageCostPerDay,
    this.status,
    required this.available,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
    this.archivedSince,
  });

  static const codec = RpcCodec<Tool>(Tool.fromWire);

  final String id;
  final num customId;
  final String brand;
  final String category;
  final String? label;
  final num? purchasePrice;
  final num? usageCostPerDay;
  final ToolStatus? status;
  final bool available;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final DateTime? archivedSince;

  factory Tool.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "customId",
      "brand",
      "category",
      "label",
      "purchasePrice",
      "usageCostPerDay",
      "status",
      "available",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
      "archivedSince",
    });

    return Tool(
      id: rpcString.decode(readRpcField(object, "id")),
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      brand: rpcString.decode(readRpcField(object, "brand")),
      category: rpcString.decode(readRpcField(object, "category")),
      label: rpcNullable(rpcString).decode(readRpcField(object, "label")),
      purchasePrice: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "purchasePrice")),
      usageCostPerDay: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "usageCostPerDay")),
      status: rpcNullable(ToolStatus.codec)
          .decode(readRpcField(object, "status")),
      available: rpcBoolean.decode(readRpcField(object, "available")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
      archivedSince: rpcNullable(rpcDate)
          .decode(readRpcField(object, "archivedSince")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "customId": encodeRpcValue(customId),
      "brand": encodeRpcValue(brand),
      "category": encodeRpcValue(category),
      "label": encodeRpcValue(label),
      "purchasePrice": encodeRpcValue(purchasePrice),
      "usageCostPerDay": encodeRpcValue(usageCostPerDay),
      "status": encodeRpcValue(status),
      "available": encodeRpcValue(available),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
      "archivedSince": encodeRpcValue(archivedSince),
    };

  }

}

final class User implements RpcValue {
  const User({
    required this.id,
    this.salutation,
    required this.firstName,
    this.lastName,
    required this.username,
    this.email,
    this.phone,
    required this.contractType,
    this.costPerHour,
    this.vacationDaysPerYear,
    this.supervisorUserId,
    required this.createdAt,
    required this.modifiedAt,
    this.deactivatedAt,
    this.archivedAt,
  });

  static const codec = RpcCodec<User>(User.fromWire);

  final String id;
  final String? salutation;
  final String firstName;
  final String? lastName;
  final String username;
  final String? email;
  final String? phone;
  final UserContractType contractType;
  final num? costPerHour;
  final num? vacationDaysPerYear;
  final String? supervisorUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final DateTime? deactivatedAt;
  final DateTime? archivedAt;

  factory User.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "salutation",
      "firstName",
      "lastName",
      "username",
      "email",
      "phone",
      "contractType",
      "costPerHour",
      "vacationDaysPerYear",
      "supervisorUserId",
      "createdAt",
      "modifiedAt",
      "deactivatedAt",
      "archivedAt",
    });

    return User(
      id: rpcString.decode(readRpcField(object, "id")),
      salutation: rpcNullable(rpcString)
          .decode(readRpcField(object, "salutation")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
      username: rpcString.decode(readRpcField(object, "username")),
      email: rpcNullable(rpcString).decode(readRpcField(object, "email")),
      phone: rpcNullable(rpcString).decode(readRpcField(object, "phone")),
      contractType: UserContractType.codec.decode(
        readRpcField(object, "contractType"),
      ),
      costPerHour: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "costPerHour")),
      vacationDaysPerYear: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "vacationDaysPerYear")),
      supervisorUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "supervisorUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
      deactivatedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deactivatedAt")),
      archivedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "archivedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "salutation": encodeRpcValue(salutation),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
      "username": encodeRpcValue(username),
      "email": encodeRpcValue(email),
      "phone": encodeRpcValue(phone),
      "contractType": encodeRpcValue(contractType),
      "costPerHour": encodeRpcValue(costPerHour),
      "vacationDaysPerYear": encodeRpcValue(vacationDaysPerYear),
      "supervisorUserId": encodeRpcValue(supervisorUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
      "deactivatedAt": encodeRpcValue(deactivatedAt),
      "archivedAt": encodeRpcValue(archivedAt),
    };

  }

}

final class Customer implements RpcValue {
  const Customer({
    required this.id,
    this.salutation,
    required this.name,
    this.address,
    required this.phoneNumbers,
    required this.emailAddresses,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<Customer>(Customer.fromWire);

  final String id;
  final String? salutation;
  final String name;
  final ProjectAddress? address;
  final List<CustomerPhoneNumbersItem> phoneNumbers;
  final List<CustomerEmailAddressesItem> emailAddresses;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory Customer.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "salutation",
      "name",
      "address",
      "phoneNumbers",
      "emailAddresses",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
    });

    return Customer(
      id: rpcString.decode(readRpcField(object, "id")),
      salutation: rpcNullable(rpcString)
          .decode(readRpcField(object, "salutation")),
      name: rpcString.decode(readRpcField(object, "name")),
      address: rpcNullable(ProjectAddress.codec)
          .decode(readRpcField(object, "address")),
      phoneNumbers: rpcArray(CustomerPhoneNumbersItem.codec)
          .decode(readRpcField(object, "phoneNumbers")),
      emailAddresses: rpcArray(CustomerEmailAddressesItem.codec)
          .decode(readRpcField(object, "emailAddresses")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "salutation": encodeRpcValue(salutation),
      "name": encodeRpcValue(name),
      "address": encodeRpcValue(address),
      "phoneNumbers": encodeRpcValue(phoneNumbers),
      "emailAddresses": encodeRpcValue(emailAddresses),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class Contact implements RpcValue {
  const Contact({
    required this.id,
    this.salutation,
    this.firstName,
    this.lastName,
    this.address,
    required this.phoneNumbers,
    required this.emailAddresses,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<Contact>(Contact.fromWire);

  final String id;
  final String? salutation;
  final String? firstName;
  final String? lastName;
  final ProjectAddress? address;
  final List<CustomerPhoneNumbersItem> phoneNumbers;
  final List<CustomerEmailAddressesItem> emailAddresses;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory Contact.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "salutation",
      "firstName",
      "lastName",
      "address",
      "phoneNumbers",
      "emailAddresses",
      "createdAt",
      "modifiedAt",
    });

    return Contact(
      id: rpcString.decode(readRpcField(object, "id")),
      salutation: rpcNullable(rpcString)
          .decode(readRpcField(object, "salutation")),
      firstName: rpcNullable(rpcString)
          .decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
      address: rpcNullable(ProjectAddress.codec)
          .decode(readRpcField(object, "address")),
      phoneNumbers: rpcArray(CustomerPhoneNumbersItem.codec)
          .decode(readRpcField(object, "phoneNumbers")),
      emailAddresses: rpcArray(CustomerEmailAddressesItem.codec)
          .decode(readRpcField(object, "emailAddresses")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "salutation": encodeRpcValue(salutation),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
      "address": encodeRpcValue(address),
      "phoneNumbers": encodeRpcValue(phoneNumbers),
      "emailAddresses": encodeRpcValue(emailAddresses),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ProductVendor implements RpcValue {
  const ProductVendor({
    required this.id,
    required this.name,
    this.description,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ProductVendor>(ProductVendor.fromWire);

  final String id;
  final String name;
  final String? description;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ProductVendor.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "name",
      "description",
      "createdAt",
      "modifiedAt",
    });

    return ProductVendor(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "name": encodeRpcValue(name),
      "description": encodeRpcValue(description),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class DeliveryNote implements RpcValue {
  const DeliveryNote({
    required this.id,
    required this.autoId,
    required this.projectId,
    this.comment,
    this.createdByUserId,
    required this.createdAt,
    required this.effectiveTimestamp,
    required this.records,
    required this.specialRecords,
  });

  static const codec = RpcCodec<DeliveryNote>(DeliveryNote.fromWire);

  final String id;
  final num autoId;
  final String projectId;
  final String? comment;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime effectiveTimestamp;
  final List<DeliveryNoteRecordsItem> records;
  final List<DeliveryNoteSpecialRecordsItem> specialRecords;

  factory DeliveryNote.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "autoId",
      "projectId",
      "comment",
      "createdByUserId",
      "createdAt",
      "effectiveTimestamp",
      "records",
      "specialRecords",
    });

    return DeliveryNote(
      id: rpcString.decode(readRpcField(object, "id")),
      autoId: rpcNumber.decode(readRpcField(object, "autoId")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      effectiveTimestamp: rpcDate.decode(
        readRpcField(object, "effectiveTimestamp"),
      ),
      records: rpcArray(DeliveryNoteRecordsItem.codec)
          .decode(readRpcField(object, "records")),
      specialRecords: rpcArray(DeliveryNoteSpecialRecordsItem.codec)
          .decode(readRpcField(object, "specialRecords")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "autoId": encodeRpcValue(autoId),
      "projectId": encodeRpcValue(projectId),
      "comment": encodeRpcValue(comment),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "effectiveTimestamp": encodeRpcValue(effectiveTimestamp),
      "records": encodeRpcValue(records),
      "specialRecords": encodeRpcValue(specialRecords),
    };

  }

}

final class RegieReport implements RpcValue {
  const RegieReport({
    required this.id,
    required this.projectId,
    required this.day,
    this.summary,
    required this.createdByUserId,
    required this.createdAt,
    required this.autoId,
    required this.products,
    required this.specialRecords,
    required this.workHours,
  });

  static const codec = RpcCodec<RegieReport>(RegieReport.fromWire);

  final String id;
  final String projectId;
  final DateTime day;
  final String? summary;
  final String createdByUserId;
  final DateTime createdAt;
  final num autoId;
  final List<RegieReportProductsItem> products;
  final List<RegieReportSpecialRecordsItem> specialRecords;
  final List<RegieReportWorkHoursItem> workHours;

  factory RegieReport.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "day",
      "summary",
      "createdByUserId",
      "createdAt",
      "autoId",
      "products",
      "specialRecords",
      "workHours",
    });

    return RegieReport(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcDate.decode(readRpcField(object, "day")),
      summary: rpcNullable(rpcString).decode(readRpcField(object, "summary")),
      createdByUserId: rpcString.decode(
        readRpcField(object, "createdByUserId"),
      ),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      autoId: rpcNumber.decode(readRpcField(object, "autoId")),
      products: rpcArray(RegieReportProductsItem.codec)
          .decode(readRpcField(object, "products")),
      specialRecords: rpcArray(RegieReportSpecialRecordsItem.codec)
          .decode(readRpcField(object, "specialRecords")),
      workHours: rpcArray(RegieReportWorkHoursItem.codec)
          .decode(readRpcField(object, "workHours")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      "summary": encodeRpcValue(summary),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "autoId": encodeRpcValue(autoId),
      "products": encodeRpcValue(products),
      "specialRecords": encodeRpcValue(specialRecords),
      "workHours": encodeRpcValue(workHours),
    };

  }

}

final class Deployment implements RpcValue {
  const Deployment({
    required this.id,
    required this.projectId,
    required this.userId,
    required this.from,
    required this.to,
    this.note,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<Deployment>(Deployment.fromWire);

  final String id;
  final String projectId;
  final String userId;
  final DateTime from;
  final DateTime to;
  final String? note;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory Deployment.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "userId",
      "from",
      "to",
      "note",
      "createdAt",
      "modifiedAt",
    });

    return Deployment(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      userId: rpcString.decode(readRpcField(object, "userId")),
      from: rpcDate.decode(readRpcField(object, "from")),
      to: rpcDate.decode(readRpcField(object, "to")),
      note: rpcNullable(rpcString).decode(readRpcField(object, "note")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "userId": encodeRpcValue(userId),
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      "note": encodeRpcValue(note),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ResourceActivity implements RpcValue {
  const ResourceActivity({
    required this.id,
    required this.entityTable,
    required this.entityId,
    required this.changedColumns,
    this.actorUserId,
    required this.actorKind,
    this.actorName,
    required this.isImported,
    required this.resourceType,
    required this.resourceId,
    this.contextId,
    this.contextTitle,
    this.contextDate,
    required this.title,
    this.resourceTitle,
    this.description,
    required this.action,
    required this.occurredAt,
    required this.createdAt,
    this.modifiedAt,
  });

  static const codec = RpcCodec<ResourceActivity>(ResourceActivity.fromWire);

  final Id id;
  final String entityTable;
  final String entityId;
  final List<String> changedColumns;
  final Id? actorUserId;
  final String actorKind;
  final String? actorName;
  final bool isImported;
  final ActivityResourceType resourceType;
  final Id resourceId;
  final Id? contextId;
  final String? contextTitle;
  final DateTime? contextDate;
  final String title;
  final String? resourceTitle;
  final String? description;
  final ResourceActivityAction action;
  final DateTime occurredAt;
  final DateTime createdAt;
  final DateTime? modifiedAt;

  factory ResourceActivity.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "entityTable",
      "entityId",
      "changedColumns",
      "actorUserId",
      "actorKind",
      "actorName",
      "isImported",
      "resourceType",
      "resourceId",
      "contextId",
      "contextTitle",
      "contextDate",
      "title",
      "resourceTitle",
      "description",
      "action",
      "occurredAt",
      "createdAt",
      "modifiedAt",
    });

    return ResourceActivity(
      id: rpcString.decode(readRpcField(object, "id")),
      entityTable: rpcString.decode(readRpcField(object, "entityTable")),
      entityId: rpcString.decode(readRpcField(object, "entityId")),
      changedColumns: rpcArray(rpcString)
          .decode(readRpcField(object, "changedColumns")),
      actorUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "actorUserId")),
      actorKind: rpcString.decode(readRpcField(object, "actorKind")),
      actorName: rpcNullable(rpcString)
          .decode(readRpcField(object, "actorName")),
      isImported: rpcBoolean.decode(readRpcField(object, "isImported")),
      resourceType: ActivityResourceType.codec.decode(
        readRpcField(object, "resourceType"),
      ),
      resourceId: rpcString.decode(readRpcField(object, "resourceId")),
      contextId: rpcNullable(rpcString)
          .decode(readRpcField(object, "contextId")),
      contextTitle: rpcNullable(rpcString)
          .decode(readRpcField(object, "contextTitle")),
      contextDate: rpcNullable(rpcDate)
          .decode(readRpcField(object, "contextDate")),
      title: rpcString.decode(readRpcField(object, "title")),
      resourceTitle: rpcNullable(rpcString)
          .decode(readRpcField(object, "resourceTitle")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      action: ResourceActivityAction.codec.decode(
        readRpcField(object, "action"),
      ),
      occurredAt: rpcDate.decode(readRpcField(object, "occurredAt")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "entityTable": encodeRpcValue(entityTable),
      "entityId": encodeRpcValue(entityId),
      "changedColumns": encodeRpcValue(changedColumns),
      "actorUserId": encodeRpcValue(actorUserId),
      "actorKind": encodeRpcValue(actorKind),
      "actorName": encodeRpcValue(actorName),
      "isImported": encodeRpcValue(isImported),
      "resourceType": encodeRpcValue(resourceType),
      "resourceId": encodeRpcValue(resourceId),
      "contextId": encodeRpcValue(contextId),
      "contextTitle": encodeRpcValue(contextTitle),
      "contextDate": encodeRpcValue(contextDate),
      "title": encodeRpcValue(title),
      "resourceTitle": encodeRpcValue(resourceTitle),
      "description": encodeRpcValue(description),
      "action": encodeRpcValue(action),
      "occurredAt": encodeRpcValue(occurredAt),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class AdminDatabasesBackupsDownloadUrlRequest implements RpcValue {
  const AdminDatabasesBackupsDownloadUrlRequest({
    required this.backupId,
    this.expiresInSec = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesBackupsDownloadUrlRequest>(
    AdminDatabasesBackupsDownloadUrlRequest.fromWire,
  );

  final String backupId;
  final RpcOptional<num> expiresInSec;

  factory AdminDatabasesBackupsDownloadUrlRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"backupId", "expiresInSec"});

    return AdminDatabasesBackupsDownloadUrlRequest(
      backupId: rpcString.decode(readRpcField(object, "backupId")),
      expiresInSec: readRpcOptionalField(
        object,
        "expiresInSec",
        rpcNumber.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "backupId": encodeRpcValue(backupId),
      if (!expiresInSec.isAbsent) "expiresInSec": encodeRpcValue(expiresInSec),
    };

  }

}

final class AdminDatabasesBackupsDownloadUrlResult implements RpcValue {
  const AdminDatabasesBackupsDownloadUrlResult({
    required this.backup,
    required this.downloadUrl,
  });

  static const codec = RpcCodec<AdminDatabasesBackupsDownloadUrlResult>(
    AdminDatabasesBackupsDownloadUrlResult.fromWire,
  );

  final AdminDatabasesBackupsListResultItem backup;
  final String downloadUrl;

  factory AdminDatabasesBackupsDownloadUrlResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"backup", "downloadUrl"});

    return AdminDatabasesBackupsDownloadUrlResult(
      backup: AdminDatabasesBackupsListResultItem.codec.decode(
        readRpcField(object, "backup"),
      ),
      downloadUrl: rpcString.decode(readRpcField(object, "downloadUrl")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "backup": encodeRpcValue(backup),
      "downloadUrl": encodeRpcValue(downloadUrl),
    };

  }

}

final class AdminDatabasesBackupsListRequest implements RpcValue {
  const AdminDatabasesBackupsListRequest({
    required this.databaseId,
    this.includeFailed = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesBackupsListRequest>(
    AdminDatabasesBackupsListRequest.fromWire,
  );

  final String databaseId;
  final RpcOptional<bool> includeFailed;

  factory AdminDatabasesBackupsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"databaseId", "includeFailed"});

    return AdminDatabasesBackupsListRequest(
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
      includeFailed: readRpcOptionalField(
        object,
        "includeFailed",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "databaseId": encodeRpcValue(databaseId),
      if (!includeFailed.isAbsent)
        "includeFailed": encodeRpcValue(includeFailed),
    };

  }

}

final class AdminDatabasesBackupsListResultItem implements RpcValue {
  const AdminDatabasesBackupsListResultItem({
    required this.id,
    required this.databaseId,
    required this.kind,
    required this.state,
    this.objectKey,
    this.sizeBytes,
    this.error,
    required this.createdAt,
    this.completedAt,
  });

  static const codec = RpcCodec<AdminDatabasesBackupsListResultItem>(
    AdminDatabasesBackupsListResultItem.fromWire,
  );

  final String id;
  final String databaseId;
  final AdminDatabasesBackupsListResultItemKind kind;
  final AdminDatabasesBackupsListResultItemState state;
  final String? objectKey;
  final num? sizeBytes;
  final String? error;
  final DateTime createdAt;
  final DateTime? completedAt;

  factory AdminDatabasesBackupsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "databaseId",
      "kind",
      "state",
      "objectKey",
      "sizeBytes",
      "error",
      "createdAt",
      "completedAt",
    });

    return AdminDatabasesBackupsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
      kind: AdminDatabasesBackupsListResultItemKind.codec.decode(
        readRpcField(object, "kind"),
      ),
      state: AdminDatabasesBackupsListResultItemState.codec.decode(
        readRpcField(object, "state"),
      ),
      objectKey: rpcNullable(rpcString)
          .decode(readRpcField(object, "objectKey")),
      sizeBytes: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "sizeBytes")),
      error: rpcNullable(rpcString).decode(readRpcField(object, "error")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      completedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "completedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "databaseId": encodeRpcValue(databaseId),
      "kind": encodeRpcValue(kind),
      "state": encodeRpcValue(state),
      "objectKey": encodeRpcValue(objectKey),
      "sizeBytes": encodeRpcValue(sizeBytes),
      "error": encodeRpcValue(error),
      "createdAt": encodeRpcValue(createdAt),
      "completedAt": encodeRpcValue(completedAt),
    };

  }

}

final class AdminDatabasesHostsListResultItem implements RpcValue {
  const AdminDatabasesHostsListResultItem({
    required this.id,
    required this.name,
    required this.connectionDetails,
    required this.backupDetails,
    required this.createdAt,
    required this.updatedAt,
  });

  static const codec = RpcCodec<AdminDatabasesHostsListResultItem>(
    AdminDatabasesHostsListResultItem.fromWire,
  );

  final String id;
  final String name;
  final AdminDatabasesHostsListResultItemConnectionDetails connectionDetails;
  final AdminDatabasesHostsListResultItemBackupDetails backupDetails;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory AdminDatabasesHostsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "name",
      "connectionDetails",
      "backupDetails",
      "createdAt",
      "updatedAt",
    });

    return AdminDatabasesHostsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
      connectionDetails: AdminDatabasesHostsListResultItemConnectionDetails
          .codec
          .decode(readRpcField(object, "connectionDetails")),
      backupDetails: AdminDatabasesHostsListResultItemBackupDetails.codec
          .decode(readRpcField(object, "backupDetails")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      updatedAt: rpcDate.decode(readRpcField(object, "updatedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "name": encodeRpcValue(name),
      "connectionDetails": encodeRpcValue(connectionDetails),
      "backupDetails": encodeRpcValue(backupDetails),
      "createdAt": encodeRpcValue(createdAt),
      "updatedAt": encodeRpcValue(updatedAt),
    };

  }

}

final class AdminDatabasesListResultItem implements RpcValue {
  const AdminDatabasesListResultItem({
    required this.id,
    required this.hostId,
    required this.hostName,
    required this.name,
    required this.username,
    required this.retentionDaily,
    required this.retentionWeekly,
    required this.retentionMonthly,
    required this.retentionYearly,
    required this.createdAt,
    required this.updatedAt,
  });

  static const codec = RpcCodec<AdminDatabasesListResultItem>(
    AdminDatabasesListResultItem.fromWire,
  );

  final String id;
  final String hostId;
  final String hostName;
  final String name;
  final String username;
  final num retentionDaily;
  final num retentionWeekly;
  final num retentionMonthly;
  final num retentionYearly;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory AdminDatabasesListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "hostId",
      "hostName",
      "name",
      "username",
      "retentionDaily",
      "retentionWeekly",
      "retentionMonthly",
      "retentionYearly",
      "createdAt",
      "updatedAt",
    });

    return AdminDatabasesListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      hostId: rpcString.decode(readRpcField(object, "hostId")),
      hostName: rpcString.decode(readRpcField(object, "hostName")),
      name: rpcString.decode(readRpcField(object, "name")),
      username: rpcString.decode(readRpcField(object, "username")),
      retentionDaily: rpcNumber.decode(readRpcField(object, "retentionDaily")),
      retentionWeekly: rpcNumber.decode(
        readRpcField(object, "retentionWeekly"),
      ),
      retentionMonthly: rpcNumber.decode(
        readRpcField(object, "retentionMonthly"),
      ),
      retentionYearly: rpcNumber.decode(
        readRpcField(object, "retentionYearly"),
      ),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      updatedAt: rpcDate.decode(readRpcField(object, "updatedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "hostId": encodeRpcValue(hostId),
      "hostName": encodeRpcValue(hostName),
      "name": encodeRpcValue(name),
      "username": encodeRpcValue(username),
      "retentionDaily": encodeRpcValue(retentionDaily),
      "retentionWeekly": encodeRpcValue(retentionWeekly),
      "retentionMonthly": encodeRpcValue(retentionMonthly),
      "retentionYearly": encodeRpcValue(retentionYearly),
      "createdAt": encodeRpcValue(createdAt),
      "updatedAt": encodeRpcValue(updatedAt),
    };

  }

}

final class AdminErrorsListRequest implements RpcValue {
  const AdminErrorsListRequest({
    this.tenant = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminErrorsListRequest>(
    AdminErrorsListRequest.fromWire,
  );

  final RpcOptional<String?> tenant;
  final RpcOptional<num> limit;

  factory AdminErrorsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"tenant", "limit"});

    return AdminErrorsListRequest(
      tenant: readRpcOptionalField(
        object,
        "tenant",
        rpcNullable(rpcString).decode,
      ),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!tenant.isAbsent) "tenant": encodeRpcValue(tenant),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
    };

  }

}

final class AdminErrorsListResultItem implements RpcValue {
  const AdminErrorsListResultItem({
    required this.tenant,
    required this.id,
    required this.level,
    required this.source,
    required this.message,
    this.stack,
    this.path,
    this.componentStack,
    this.metadata,
    this.userAgent,
    this.createdByUserId,
    this.username,
    required this.createdAt,
  });

  static const codec = RpcCodec<AdminErrorsListResultItem>(
    AdminErrorsListResultItem.fromWire,
  );

  final String tenant;
  final String id;
  final AdminErrorsListResultItemLevel level;
  final String source;
  final String message;
  final String? stack;
  final String? path;
  final String? componentStack;
  final AdminErrorsListResultItemMetadata? metadata;
  final String? userAgent;
  final String? createdByUserId;
  final String? username;
  final DateTime createdAt;

  factory AdminErrorsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "tenant",
      "id",
      "level",
      "source",
      "message",
      "stack",
      "path",
      "componentStack",
      "metadata",
      "userAgent",
      "createdByUserId",
      "username",
      "createdAt",
    });

    return AdminErrorsListResultItem(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      id: rpcString.decode(readRpcField(object, "id")),
      level: AdminErrorsListResultItemLevel.codec.decode(
        readRpcField(object, "level"),
      ),
      source: rpcString.decode(readRpcField(object, "source")),
      message: rpcString.decode(readRpcField(object, "message")),
      stack: rpcNullable(rpcString).decode(readRpcField(object, "stack")),
      path: rpcNullable(rpcString).decode(readRpcField(object, "path")),
      componentStack: rpcNullable(rpcString)
          .decode(readRpcField(object, "componentStack")),
      metadata: rpcNullable(AdminErrorsListResultItemMetadata.codec)
          .decode(readRpcField(object, "metadata")),
      userAgent: rpcNullable(rpcString)
          .decode(readRpcField(object, "userAgent")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      username: rpcNullable(rpcString).decode(readRpcField(object, "username")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "id": encodeRpcValue(id),
      "level": encodeRpcValue(level),
      "source": encodeRpcValue(source),
      "message": encodeRpcValue(message),
      "stack": encodeRpcValue(stack),
      "path": encodeRpcValue(path),
      "componentStack": encodeRpcValue(componentStack),
      "metadata": encodeRpcValue(metadata),
      "userAgent": encodeRpcValue(userAgent),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "username": encodeRpcValue(username),
      "createdAt": encodeRpcValue(createdAt),
    };

  }

}

final class AdminLlmProvidersListResultItem implements RpcValue {
  const AdminLlmProvidersListResultItem({
    required this.provider,
    this.baseUrl,
    required this.hasApiKey,
  });

  static const codec = RpcCodec<AdminLlmProvidersListResultItem>(
    AdminLlmProvidersListResultItem.fromWire,
  );

  final String provider;
  final String? baseUrl;
  final bool hasApiKey;

  factory AdminLlmProvidersListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "provider",
      "baseUrl",
      "hasApiKey",
    });

    return AdminLlmProvidersListResultItem(
      provider: rpcString.decode(readRpcField(object, "provider")),
      baseUrl: rpcNullable(rpcString).decode(readRpcField(object, "baseUrl")),
      hasApiKey: rpcBoolean.decode(readRpcField(object, "hasApiKey")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "provider": encodeRpcValue(provider),
      "baseUrl": encodeRpcValue(baseUrl),
      "hasApiKey": encodeRpcValue(hasApiKey),
    };

  }

}

final class AdminLlmProvidersModelsRequest implements RpcValue {
  const AdminLlmProvidersModelsRequest({required this.provider});

  static const codec = RpcCodec<AdminLlmProvidersModelsRequest>(
    AdminLlmProvidersModelsRequest.fromWire,
  );

  final ProviderName provider;

  factory AdminLlmProvidersModelsRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"provider"});

    return AdminLlmProvidersModelsRequest(
      provider: ProviderName.codec.decode(readRpcField(object, "provider")),
    );
  }

  @override
  JsonMap toWire() {
    return {"provider": encodeRpcValue(provider)};
  }

}

final class AdminLlmProvidersModelsResultItem implements RpcValue {
  const AdminLlmProvidersModelsResultItem({
    required this.id,
    required this.name,
  });

  static const codec = RpcCodec<AdminLlmProvidersModelsResultItem>(
    AdminLlmProvidersModelsResultItem.fromWire,
  );

  final String id;
  final String name;

  factory AdminLlmProvidersModelsResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "name"});

    return AdminLlmProvidersModelsResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "name": encodeRpcValue(name)};
  }

}

final class AdminLlmScanSettingsGetResult implements RpcValue {
  const AdminLlmScanSettingsGetResult({
    required this.provider,
    required this.model,
    this.baseUrl,
    required this.hasApiKey,
    required this.mcpAvailable,
  });

  static const codec = RpcCodec<AdminLlmScanSettingsGetResult>(
    AdminLlmScanSettingsGetResult.fromWire,
  );

  final String provider;
  final String model;
  final String? baseUrl;
  final bool hasApiKey;
  final bool mcpAvailable;

  factory AdminLlmScanSettingsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "provider",
      "model",
      "baseUrl",
      "hasApiKey",
      "mcpAvailable",
    });

    return AdminLlmScanSettingsGetResult(
      provider: rpcString.decode(readRpcField(object, "provider")),
      model: rpcString.decode(readRpcField(object, "model")),
      baseUrl: rpcNullable(rpcString).decode(readRpcField(object, "baseUrl")),
      hasApiKey: rpcBoolean.decode(readRpcField(object, "hasApiKey")),
      mcpAvailable: rpcBoolean.decode(readRpcField(object, "mcpAvailable")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
      "baseUrl": encodeRpcValue(baseUrl),
      "hasApiKey": encodeRpcValue(hasApiKey),
      "mcpAvailable": encodeRpcValue(mcpAvailable),
    };

  }

}

final class AdminLlmTenantsListResultItem implements RpcValue {
  const AdminLlmTenantsListResultItem({
    required this.name,
    required this.enabled,
    this.monthlyTokenQuota,
  });

  static const codec = RpcCodec<AdminLlmTenantsListResultItem>(
    AdminLlmTenantsListResultItem.fromWire,
  );

  final String name;
  final bool enabled;
  final BigInt? monthlyTokenQuota;

  factory AdminLlmTenantsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "enabled",
      "monthlyTokenQuota",
    });

    return AdminLlmTenantsListResultItem(
      name: rpcString.decode(readRpcField(object, "name")),
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      monthlyTokenQuota: rpcNullable(rpcBigInt)
          .decode(readRpcField(object, "monthlyTokenQuota")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "enabled": encodeRpcValue(enabled),
      "monthlyTokenQuota": encodeRpcValue(monthlyTokenQuota),
    };

  }

}

final class AdminLlmUsageResultItem implements RpcValue {
  const AdminLlmUsageResultItem({
    required this.tenant,
    required this.provider,
    required this.model,
    required this.purpose,
    required this.requestCount,
    required this.inputTokens,
    required this.outputTokens,
    required this.totalTokens,
    required this.failedRequests,
  });

  static const codec = RpcCodec<AdminLlmUsageResultItem>(
    AdminLlmUsageResultItem.fromWire,
  );

  final String tenant;
  final String provider;
  final String model;
  final String purpose;
  final BigInt requestCount;
  final BigInt inputTokens;
  final BigInt outputTokens;
  final BigInt totalTokens;
  final BigInt failedRequests;

  factory AdminLlmUsageResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "tenant",
      "provider",
      "model",
      "purpose",
      "requestCount",
      "inputTokens",
      "outputTokens",
      "totalTokens",
      "failedRequests",
    });

    return AdminLlmUsageResultItem(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      provider: rpcString.decode(readRpcField(object, "provider")),
      model: rpcString.decode(readRpcField(object, "model")),
      purpose: rpcString.decode(readRpcField(object, "purpose")),
      requestCount: rpcBigInt.decode(readRpcField(object, "requestCount")),
      inputTokens: rpcBigInt.decode(readRpcField(object, "inputTokens")),
      outputTokens: rpcBigInt.decode(readRpcField(object, "outputTokens")),
      totalTokens: rpcBigInt.decode(readRpcField(object, "totalTokens")),
      failedRequests: rpcBigInt.decode(readRpcField(object, "failedRequests")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
      "purpose": encodeRpcValue(purpose),
      "requestCount": encodeRpcValue(requestCount),
      "inputTokens": encodeRpcValue(inputTokens),
      "outputTokens": encodeRpcValue(outputTokens),
      "totalTokens": encodeRpcValue(totalTokens),
      "failedRequests": encodeRpcValue(failedRequests),
    };

  }

}

final class AdminLlmUseCasesListResultItem implements RpcValue {
  const AdminLlmUseCasesListResultItem({
    required this.useCase,
    this.provider,
    this.model,
  });

  static const codec = RpcCodec<AdminLlmUseCasesListResultItem>(
    AdminLlmUseCasesListResultItem.fromWire,
  );

  final LlmUseCase useCase;
  final String? provider;
  final String? model;

  factory AdminLlmUseCasesListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"useCase", "provider", "model"});

    return AdminLlmUseCasesListResultItem(
      useCase: LlmUseCase.codec.decode(readRpcField(object, "useCase")),
      provider: rpcNullable(rpcString).decode(readRpcField(object, "provider")),
      model: rpcNullable(rpcString).decode(readRpcField(object, "model")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "useCase": encodeRpcValue(useCase),
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
    };

  }

}

final class AdminTenantsGetRequest implements RpcValue {
  const AdminTenantsGetRequest({required this.name});

  static const codec = RpcCodec<AdminTenantsGetRequest>(
    AdminTenantsGetRequest.fromWire,
  );

  final String name;

  factory AdminTenantsGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"name"});

    return AdminTenantsGetRequest(
      name: rpcString.decode(readRpcField(object, "name")),
    );
  }

  @override
  JsonMap toWire() {
    return {"name": encodeRpcValue(name)};
  }

}

final class AdminTenantsGetResult implements RpcValue {
  const AdminTenantsGetResult({
    required this.name,
    this.lockedAt,
    this.deletedAt,
    this.deactivatedAt,
    required this.connectionDetails,
    required this.contactDetails,
    required this.options,
  });

  static const codec = RpcCodec<AdminTenantsGetResult>(
    AdminTenantsGetResult.fromWire,
  );

  final String name;
  final DateTime? lockedAt;
  final DateTime? deletedAt;
  final DateTime? deactivatedAt;
  final AdminTenantsGetResultConnectionDetails connectionDetails;
  final AdminTenantsGetResultContactDetails contactDetails;
  final AdminTenantsGetResultOptions options;

  factory AdminTenantsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "locked_at",
      "deleted_at",
      "deactivated_at",
      "connection_details",
      "contact_details",
      "options",
    });

    return AdminTenantsGetResult(
      name: rpcString.decode(readRpcField(object, "name")),
      lockedAt: rpcNullable(rpcDate).decode(readRpcField(object, "locked_at")),
      deletedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deleted_at")),
      deactivatedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deactivated_at")),
      connectionDetails: AdminTenantsGetResultConnectionDetails.codec.decode(
        readRpcField(object, "connection_details"),
      ),
      contactDetails: AdminTenantsGetResultContactDetails.codec.decode(
        readRpcField(object, "contact_details"),
      ),
      options: AdminTenantsGetResultOptions.codec.decode(
        readRpcField(object, "options"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "locked_at": encodeRpcValue(lockedAt),
      "deleted_at": encodeRpcValue(deletedAt),
      "deactivated_at": encodeRpcValue(deactivatedAt),
      "connection_details": encodeRpcValue(connectionDetails),
      "contact_details": encodeRpcValue(contactDetails),
      "options": encodeRpcValue(options),
    };

  }

}

final class AdminUsersListRequest implements RpcValue {
  const AdminUsersListRequest({
    required this.tenant,
    this.search = const RpcOptional.absent(),
    this.includeArchived = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminUsersListRequest>(
    AdminUsersListRequest.fromWire,
  );

  final String tenant;
  final RpcOptional<String?> search;
  final RpcOptional<bool> includeArchived;

  factory AdminUsersListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "tenant",
      "search",
      "includeArchived",
    });

    return AdminUsersListRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
      includeArchived: readRpcOptionalField(
        object,
        "includeArchived",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      if (!search.isAbsent) "search": encodeRpcValue(search),
      if (!includeArchived.isAbsent)
        "includeArchived": encodeRpcValue(includeArchived),
    };

  }

}

final class AdminUsersListResultItem implements RpcValue {
  const AdminUsersListResultItem({
    required this.id,
    required this.username,
    required this.firstName,
    this.lastName,
    this.email,
    this.deactivatedAt,
    this.archivedAt,
    required this.isAdmin,
  });

  static const codec = RpcCodec<AdminUsersListResultItem>(
    AdminUsersListResultItem.fromWire,
  );

  final String id;
  final String username;
  final String firstName;
  final String? lastName;
  final String? email;
  final DateTime? deactivatedAt;
  final DateTime? archivedAt;
  final bool isAdmin;

  factory AdminUsersListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "username",
      "firstName",
      "lastName",
      "email",
      "deactivatedAt",
      "archivedAt",
      "isAdmin",
    });

    return AdminUsersListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      username: rpcString.decode(readRpcField(object, "username")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
      email: rpcNullable(rpcString).decode(readRpcField(object, "email")),
      deactivatedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deactivatedAt")),
      archivedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "archivedAt")),
      isAdmin: rpcBoolean.decode(readRpcField(object, "isAdmin")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "username": encodeRpcValue(username),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
      "email": encodeRpcValue(email),
      "deactivatedAt": encodeRpcValue(deactivatedAt),
      "archivedAt": encodeRpcValue(archivedAt),
      "isAdmin": encodeRpcValue(isAdmin),
    };

  }

}

final class AuthCheckResult implements RpcValue {
  const AuthCheckResult({required this.success});

  static const codec = RpcCodec<AuthCheckResult>(AuthCheckResult.fromWire);

  final bool success;

  factory AuthCheckResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"success"});

    return AuthCheckResult(
      success: rpcLiteral<bool>(true).decode(readRpcField(object, "success")),
    );
  }

  @override
  JsonMap toWire() {
    return {"success": encodeRpcValue(success)};
  }

}

final class AuthPasskeysListResultItem implements RpcValue {
  const AuthPasskeysListResultItem({
    required this.id,
    required this.label,
    required this.createdAt,
    this.lastUsedAt,
  });

  static const codec = RpcCodec<AuthPasskeysListResultItem>(
    AuthPasskeysListResultItem.fromWire,
  );

  final String id;
  final String label;
  final DateTime createdAt;
  final DateTime? lastUsedAt;

  factory AuthPasskeysListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "label",
      "createdAt",
      "lastUsedAt",
    });

    return AuthPasskeysListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      label: rpcString.decode(readRpcField(object, "label")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      lastUsedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "lastUsedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "label": encodeRpcValue(label),
      "createdAt": encodeRpcValue(createdAt),
      "lastUsedAt": encodeRpcValue(lastUsedAt),
    };

  }

}

final class ClientScriptsGetRequest implements RpcValue {
  const ClientScriptsGetRequest({required this.id});

  static const codec = RpcCodec<ClientScriptsGetRequest>(
    ClientScriptsGetRequest.fromWire,
  );

  final String id;

  factory ClientScriptsGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id"});

    return ClientScriptsGetRequest(
      id: rpcString.decode(readRpcField(object, "id")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id)};
  }

}

final class ClientScriptsGetResult implements RpcValue {
  const ClientScriptsGetResult({
    required this.id,
    required this.name,
    this.description,
    required this.code,
    required this.enabled,
    this.createdByUserId,
    this.modifiedByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ClientScriptsGetResult>(
    ClientScriptsGetResult.fromWire,
  );

  final String id;
  final String name;
  final String? description;
  final String code;
  final bool enabled;
  final String? createdByUserId;
  final String? modifiedByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ClientScriptsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "name",
      "description",
      "code",
      "enabled",
      "createdByUserId",
      "modifiedByUserId",
      "createdAt",
      "modifiedAt",
    });

    return ClientScriptsGetResult(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      code: rpcString.decode(readRpcField(object, "code")),
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      modifiedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "modifiedByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "name": encodeRpcValue(name),
      "description": encodeRpcValue(description),
      "code": encodeRpcValue(code),
      "enabled": encodeRpcValue(enabled),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "modifiedByUserId": encodeRpcValue(modifiedByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ClientScriptsListRequest implements RpcValue {
  const ClientScriptsListRequest({
    this.search = const RpcOptional.absent(),
    this.includeDisabled = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ClientScriptsListRequest>(
    ClientScriptsListRequest.fromWire,
  );

  final RpcOptional<String?> search;
  final RpcOptional<bool> includeDisabled;
  final RpcOptional<num> limit;

  factory ClientScriptsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "search",
      "includeDisabled",
      "limit",
    });

    return ClientScriptsListRequest(
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
      includeDisabled: readRpcOptionalField(
        object,
        "includeDisabled",
        rpcBoolean.decode,
      ),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!search.isAbsent) "search": encodeRpcValue(search),
      if (!includeDisabled.isAbsent)
        "includeDisabled": encodeRpcValue(includeDisabled),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
    };

  }

}

final class ClientScriptsListResultItem implements RpcValue {
  const ClientScriptsListResultItem({
    required this.id,
    required this.name,
    this.description,
    required this.enabled,
    this.createdByUserId,
    this.modifiedByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ClientScriptsListResultItem>(
    ClientScriptsListResultItem.fromWire,
  );

  final String id;
  final String name;
  final String? description;
  final bool enabled;
  final String? createdByUserId;
  final String? modifiedByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ClientScriptsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "name",
      "description",
      "enabled",
      "createdByUserId",
      "modifiedByUserId",
      "createdAt",
      "modifiedAt",
    });

    return ClientScriptsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
      description: rpcNullable(rpcString)
          .decode(readRpcField(object, "description")),
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      modifiedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "modifiedByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "name": encodeRpcValue(name),
      "description": encodeRpcValue(description),
      "enabled": encodeRpcValue(enabled),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "modifiedByUserId": encodeRpcValue(modifiedByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ContactsCustomersListRequest implements RpcValue {
  const ContactsCustomersListRequest({required this.contactId});

  static const codec = RpcCodec<ContactsCustomersListRequest>(
    ContactsCustomersListRequest.fromWire,
  );

  final String contactId;

  factory ContactsCustomersListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"contactId"});

    return ContactsCustomersListRequest(
      contactId: rpcString.decode(readRpcField(object, "contactId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"contactId": encodeRpcValue(contactId)};
  }

}

final class ContactsListRequest implements RpcValue {
  const ContactsListRequest({this.search = const RpcOptional.absent()});

  static const codec = RpcCodec<ContactsListRequest>(
    ContactsListRequest.fromWire,
  );

  final RpcOptional<String?> search;

  factory ContactsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"search"});

    return ContactsListRequest(
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {if (!search.isAbsent) "search": encodeRpcValue(search)};
  }

}

final class CustomersContactsListRequest implements RpcValue {
  const CustomersContactsListRequest({required this.customerId});

  static const codec = RpcCodec<CustomersContactsListRequest>(
    CustomersContactsListRequest.fromWire,
  );

  final String customerId;

  factory CustomersContactsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"customerId"});

    return CustomersContactsListRequest(
      customerId: rpcString.decode(readRpcField(object, "customerId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"customerId": encodeRpcValue(customerId)};
  }

}

final class DeliveryNotesCostsGetResult implements RpcValue {
  const DeliveryNotesCostsGetResult({
    required this.noteId,
    required this.totalCost,
    required this.records,
    required this.specialRecords,
  });

  static const codec = RpcCodec<DeliveryNotesCostsGetResult>(
    DeliveryNotesCostsGetResult.fromWire,
  );

  final String noteId;
  final num totalCost;
  final List<DeliveryNotesCostsGetResultRecordsItem> records;
  final List<DeliveryNotesCostsGetResultSpecialRecordsItem> specialRecords;

  factory DeliveryNotesCostsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "noteId",
      "totalCost",
      "records",
      "specialRecords",
    });

    return DeliveryNotesCostsGetResult(
      noteId: rpcString.decode(readRpcField(object, "noteId")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
      records: rpcArray(DeliveryNotesCostsGetResultRecordsItem.codec)
          .decode(readRpcField(object, "records")),
      specialRecords: rpcArray(
        DeliveryNotesCostsGetResultSpecialRecordsItem.codec,
      ).decode(readRpcField(object, "specialRecords")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "noteId": encodeRpcValue(noteId),
      "totalCost": encodeRpcValue(totalCost),
      "records": encodeRpcValue(records),
      "specialRecords": encodeRpcValue(specialRecords),
    };

  }

}

sealed class DeliveryNotesGetRequest implements RpcValue {
  const DeliveryNotesGetRequest._();

  static const codec = RpcCodec<DeliveryNotesGetRequest>(
    DeliveryNotesGetRequest.fromWire,
  );

  factory DeliveryNotesGetRequest.fromWire(Object? value) {
    final decoder = rpcUnion<DeliveryNotesGetRequest>([
      rpcVariant<ClientScriptsGetRequest, DeliveryNotesGetRequest>(
        ClientScriptsGetRequest.codec,
        DeliveryNotesGetRequestObject.new,
      ),
      rpcVariant<DeliveryNotesGetRequestVariant2, DeliveryNotesGetRequest>(
        DeliveryNotesGetRequestVariant2.codec,
        DeliveryNotesGetRequestObjectSchemaE547a4fe.new,
      ),
    ]);

    return decoder.decode(value);
  }

}

final class DeliveryNotesGetRequestObject extends DeliveryNotesGetRequest {
  const DeliveryNotesGetRequestObject(this.value) : super._();

  final ClientScriptsGetRequest value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class DeliveryNotesGetRequestObjectSchemaE547a4fe
    extends DeliveryNotesGetRequest {
  const DeliveryNotesGetRequestObjectSchemaE547a4fe(this.value) : super._();

  final DeliveryNotesGetRequestVariant2 value;

  @override
  Object? toWire() {
    return encodeRpcValue(value);
  }

}

final class DeliveryNotesListRequest implements RpcValue {
  const DeliveryNotesListRequest({
    this.projectId = const RpcOptional.absent(),
    this.createdByUserId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<DeliveryNotesListRequest>(
    DeliveryNotesListRequest.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<String?> createdByUserId;

  factory DeliveryNotesListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "createdByUserId"});

    return DeliveryNotesListRequest(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      createdByUserId: readRpcOptionalField(
        object,
        "createdByUserId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!createdByUserId.isAbsent)
        "createdByUserId": encodeRpcValue(createdByUserId),
    };

  }

}

final class DeliveryNotesScanListResultItem implements RpcValue {
  const DeliveryNotesScanListResultItem({
    required this.id,
    required this.fileName,
    required this.fileNames,
    required this.state,
    this.documentType,
    this.error,
    required this.createdAt,
    required this.updatedAt,
  });

  static const codec = RpcCodec<DeliveryNotesScanListResultItem>(
    DeliveryNotesScanListResultItem.fromWire,
  );

  final Id id;
  final String fileName;
  final List<String> fileNames;
  final ScanJobState state;
  final ScanDocumentType? documentType;
  final String? error;
  final DateTime createdAt;
  final DateTime updatedAt;

  factory DeliveryNotesScanListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "fileName",
      "fileNames",
      "state",
      "documentType",
      "error",
      "createdAt",
      "updatedAt",
    });

    return DeliveryNotesScanListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      fileNames: rpcArray(rpcString).decode(readRpcField(object, "fileNames")),
      state: ScanJobState.codec.decode(readRpcField(object, "state")),
      documentType: rpcNullable(ScanDocumentType.codec)
          .decode(readRpcField(object, "documentType")),
      error: rpcNullable(rpcString).decode(readRpcField(object, "error")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      updatedAt: rpcDate.decode(readRpcField(object, "updatedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "fileName": encodeRpcValue(fileName),
      "fileNames": encodeRpcValue(fileNames),
      "state": encodeRpcValue(state),
      "documentType": encodeRpcValue(documentType),
      "error": encodeRpcValue(error),
      "createdAt": encodeRpcValue(createdAt),
      "updatedAt": encodeRpcValue(updatedAt),
    };

  }

}

final class DeliveryNotesScanStatusRequest implements RpcValue {
  const DeliveryNotesScanStatusRequest({required this.scanId});

  static const codec = RpcCodec<DeliveryNotesScanStatusRequest>(
    DeliveryNotesScanStatusRequest.fromWire,
  );

  final Id scanId;

  factory DeliveryNotesScanStatusRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"scanId"});

    return DeliveryNotesScanStatusRequest(
      scanId: rpcString.decode(readRpcField(object, "scanId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"scanId": encodeRpcValue(scanId)};
  }

}

final class DeliveryNotesScanStatusResult implements RpcValue {
  const DeliveryNotesScanStatusResult({required this.state, this.error});

  static const codec = RpcCodec<DeliveryNotesScanStatusResult>(
    DeliveryNotesScanStatusResult.fromWire,
  );

  final ScanJobState state;
  final String? error;

  factory DeliveryNotesScanStatusResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"state", "error"});

    return DeliveryNotesScanStatusResult(
      state: ScanJobState.codec.decode(readRpcField(object, "state")),
      error: rpcNullable(rpcString).decode(readRpcField(object, "error")),
    );
  }

  @override
  JsonMap toWire() {
    return {"state": encodeRpcValue(state), "error": encodeRpcValue(error)};
  }

}

final class LlmChatsGetRequest implements RpcValue {
  const LlmChatsGetRequest({required this.chatId});

  static const codec = RpcCodec<LlmChatsGetRequest>(
    LlmChatsGetRequest.fromWire,
  );

  final Id chatId;

  factory LlmChatsGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"chatId"});

    return LlmChatsGetRequest(
      chatId: rpcString.decode(readRpcField(object, "chatId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"chatId": encodeRpcValue(chatId)};
  }

}

final class LlmChatsGetResult implements RpcValue {
  const LlmChatsGetResult({
    required this.chat,
    required this.messages,
    required this.proposals,
  });

  static const codec = RpcCodec<LlmChatsGetResult>(LlmChatsGetResult.fromWire);

  final ChatSummary chat;
  final List<ChatMessage> messages;
  final List<ChangeProposal> proposals;

  factory LlmChatsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "chat",
      "messages",
      "proposals",
    });

    return LlmChatsGetResult(
      chat: ChatSummary.codec.decode(readRpcField(object, "chat")),
      messages: rpcArray(ChatMessage.codec)
          .decode(readRpcField(object, "messages")),
      proposals: rpcArray(ChangeProposal.codec)
          .decode(readRpcField(object, "proposals")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "chat": encodeRpcValue(chat),
      "messages": encodeRpcValue(messages),
      "proposals": encodeRpcValue(proposals),
    };

  }

}

final class LlmStatusResult implements RpcValue {
  const LlmStatusResult({
    required this.available,
    required this.hasRole,
    required this.tenantEnabled,
    required this.providerConfigured,
    required this.scanProviderConfigured,
    this.provider,
    this.model,
    this.monthlyTokenQuota,
    required this.usedTokens,
  });

  static const codec = RpcCodec<LlmStatusResult>(LlmStatusResult.fromWire);

  final bool available;
  final bool hasRole;
  final bool tenantEnabled;
  final bool providerConfigured;
  final bool scanProviderConfigured;
  final String? provider;
  final String? model;
  final BigInt? monthlyTokenQuota;
  final BigInt usedTokens;

  factory LlmStatusResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "available",
      "hasRole",
      "tenantEnabled",
      "providerConfigured",
      "scanProviderConfigured",
      "provider",
      "model",
      "monthlyTokenQuota",
      "usedTokens",
    });

    return LlmStatusResult(
      available: rpcBoolean.decode(readRpcField(object, "available")),
      hasRole: rpcBoolean.decode(readRpcField(object, "hasRole")),
      tenantEnabled: rpcBoolean.decode(readRpcField(object, "tenantEnabled")),
      providerConfigured: rpcBoolean.decode(
        readRpcField(object, "providerConfigured"),
      ),
      scanProviderConfigured: rpcBoolean.decode(
        readRpcField(object, "scanProviderConfigured"),
      ),
      provider: rpcNullable(rpcString).decode(readRpcField(object, "provider")),
      model: rpcNullable(rpcString).decode(readRpcField(object, "model")),
      monthlyTokenQuota: rpcNullable(rpcBigInt)
          .decode(readRpcField(object, "monthlyTokenQuota")),
      usedTokens: rpcBigInt.decode(readRpcField(object, "usedTokens")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "available": encodeRpcValue(available),
      "hasRole": encodeRpcValue(hasRole),
      "tenantEnabled": encodeRpcValue(tenantEnabled),
      "providerConfigured": encodeRpcValue(providerConfigured),
      "scanProviderConfigured": encodeRpcValue(scanProviderConfigured),
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
      "monthlyTokenQuota": encodeRpcValue(monthlyTokenQuota),
      "usedTokens": encodeRpcValue(usedTokens),
    };

  }

}

final class OfficeExportsOfficeConfigRequest implements RpcValue {
  const OfficeExportsOfficeConfigRequest({required this.sessionToken});

  static const codec = RpcCodec<OfficeExportsOfficeConfigRequest>(
    OfficeExportsOfficeConfigRequest.fromWire,
  );

  final String sessionToken;

  factory OfficeExportsOfficeConfigRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"sessionToken"});

    return OfficeExportsOfficeConfigRequest(
      sessionToken: rpcString.decode(readRpcField(object, "sessionToken")),
    );
  }

  @override
  JsonMap toWire() {
    return {"sessionToken": encodeRpcValue(sessionToken)};
  }

}

final class OfficeExportsOfficeConfigResult implements RpcValue {
  const OfficeExportsOfficeConfigResult({
    required this.apiUrl,
    required this.canEdit,
    required this.config,
  });

  static const codec = RpcCodec<OfficeExportsOfficeConfigResult>(
    OfficeExportsOfficeConfigResult.fromWire,
  );

  final String apiUrl;
  final bool canEdit;
  final AdminErrorsListResultItemMetadata config;

  factory OfficeExportsOfficeConfigResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"apiUrl", "canEdit", "config"});

    return OfficeExportsOfficeConfigResult(
      apiUrl: rpcString.decode(readRpcField(object, "apiUrl")),
      canEdit: rpcBoolean.decode(readRpcField(object, "canEdit")),
      config: AdminErrorsListResultItemMetadata.codec.decode(
        readRpcField(object, "config"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "apiUrl": encodeRpcValue(apiUrl),
      "canEdit": encodeRpcValue(canEdit),
      "config": encodeRpcValue(config),
    };

  }

}

final class PersonalizationActionsListRequest implements RpcValue {
  const PersonalizationActionsListRequest({
    this.limit = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<PersonalizationActionsListRequest>(
    PersonalizationActionsListRequest.fromWire,
  );

  final RpcOptional<num> limit;

  factory PersonalizationActionsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"limit"});

    return PersonalizationActionsListRequest(
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {if (!limit.isAbsent) "limit": encodeRpcValue(limit)};
  }

}

final class PersonalizationActionsListResultItem implements RpcValue {
  const PersonalizationActionsListResultItem({
    required this.id,
    required this.actionId,
    required this.label,
    this.href,
    required this.usedAt,
  });

  static const codec = RpcCodec<PersonalizationActionsListResultItem>(
    PersonalizationActionsListResultItem.fromWire,
  );

  final String id;
  final String actionId;
  final String label;
  final String? href;
  final DateTime usedAt;

  factory PersonalizationActionsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "actionId",
      "label",
      "href",
      "usedAt",
    });

    return PersonalizationActionsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      actionId: rpcString.decode(readRpcField(object, "actionId")),
      label: rpcString.decode(readRpcField(object, "label")),
      href: rpcNullable(rpcString).decode(readRpcField(object, "href")),
      usedAt: rpcDate.decode(readRpcField(object, "usedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "actionId": encodeRpcValue(actionId),
      "label": encodeRpcValue(label),
      "href": encodeRpcValue(href),
      "usedAt": encodeRpcValue(usedAt),
    };

  }

}

final class PersonalizationActivityListRequest implements RpcValue {
  const PersonalizationActivityListRequest({
    this.latestPerResource = const RpcOptional.absent(),
    this.cursor = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
    this.resourceType = const RpcOptional.absent(),
    this.resourceId = const RpcOptional.absent(),
    this.contextId = const RpcOptional.absent(),
    this.includeProjectContext = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<PersonalizationActivityListRequest>(
    PersonalizationActivityListRequest.fromWire,
  );

  final RpcOptional<bool> latestPerResource;
  final RpcOptional<Id?> cursor;
  final RpcOptional<num> limit;
  final RpcOptional<ActivityResourceType?> resourceType;
  final RpcOptional<Id?> resourceId;
  final RpcOptional<Id?> contextId;
  final RpcOptional<bool> includeProjectContext;

  factory PersonalizationActivityListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "latestPerResource",
      "cursor",
      "limit",
      "resourceType",
      "resourceId",
      "contextId",
      "includeProjectContext",
    });

    return PersonalizationActivityListRequest(
      latestPerResource: readRpcOptionalField(
        object,
        "latestPerResource",
        rpcBoolean.decode,
      ),
      cursor: readRpcOptionalField(
        object,
        "cursor",
        rpcNullable(rpcString).decode,
      ),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
      resourceType: readRpcOptionalField(
        object,
        "resourceType",
        rpcNullable(ActivityResourceType.codec).decode,
      ),
      resourceId: readRpcOptionalField(
        object,
        "resourceId",
        rpcNullable(rpcString).decode,
      ),
      contextId: readRpcOptionalField(
        object,
        "contextId",
        rpcNullable(rpcString).decode,
      ),
      includeProjectContext: readRpcOptionalField(
        object,
        "includeProjectContext",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!latestPerResource.isAbsent)
        "latestPerResource": encodeRpcValue(latestPerResource),
      if (!cursor.isAbsent) "cursor": encodeRpcValue(cursor),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
      if (!resourceType.isAbsent) "resourceType": encodeRpcValue(resourceType),
      if (!resourceId.isAbsent) "resourceId": encodeRpcValue(resourceId),
      if (!contextId.isAbsent) "contextId": encodeRpcValue(contextId),
      if (!includeProjectContext.isAbsent)
        "includeProjectContext": encodeRpcValue(includeProjectContext),
    };

  }

}

final class PersonalizationVisitsListResultItem implements RpcValue {
  const PersonalizationVisitsListResultItem({
    required this.id,
    required this.path,
    this.title,
    required this.visitedAt,
  });

  static const codec = RpcCodec<PersonalizationVisitsListResultItem>(
    PersonalizationVisitsListResultItem.fromWire,
  );

  final String id;
  final String path;
  final String? title;
  final DateTime visitedAt;

  factory PersonalizationVisitsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "path",
      "title",
      "visitedAt",
    });

    return PersonalizationVisitsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      path: rpcString.decode(readRpcField(object, "path")),
      title: rpcNullable(rpcString).decode(readRpcField(object, "title")),
      visitedAt: rpcDate.decode(readRpcField(object, "visitedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "path": encodeRpcValue(path),
      "title": encodeRpcValue(title),
      "visitedAt": encodeRpcValue(visitedAt),
    };

  }

}

final class ProductsListRequest implements RpcValue {
  const ProductsListRequest({
    this.category = const RpcOptional.absent(),
    this.search = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsListRequest>(
    ProductsListRequest.fromWire,
  );

  final RpcOptional<String?> category;
  final RpcOptional<String?> search;

  factory ProductsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"category", "search"});

    return ProductsListRequest(
      category: readRpcOptionalField(
        object,
        "category",
        rpcNullable(rpcString).decode,
      ),
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!category.isAbsent) "category": encodeRpcValue(category),
      if (!search.isAbsent) "search": encodeRpcValue(search),
    };

  }

}

final class ProductsPriceRecordsListRequest implements RpcValue {
  const ProductsPriceRecordsListRequest({
    this.productId = const RpcOptional.absent(),
    this.vendorId = const RpcOptional.absent(),
    this.isRealPurchase = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsPriceRecordsListRequest>(
    ProductsPriceRecordsListRequest.fromWire,
  );

  final RpcOptional<String?> productId;
  final RpcOptional<String?> vendorId;
  final RpcOptional<bool?> isRealPurchase;

  factory ProductsPriceRecordsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "vendorId",
      "isRealPurchase",
    });

    return ProductsPriceRecordsListRequest(
      productId: readRpcOptionalField(
        object,
        "productId",
        rpcNullable(rpcString).decode,
      ),
      vendorId: readRpcOptionalField(
        object,
        "vendorId",
        rpcNullable(rpcString).decode,
      ),
      isRealPurchase: readRpcOptionalField(
        object,
        "isRealPurchase",
        rpcNullable(rpcBoolean).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!productId.isAbsent) "productId": encodeRpcValue(productId),
      if (!vendorId.isAbsent) "vendorId": encodeRpcValue(vendorId),
      if (!isRealPurchase.isAbsent)
        "isRealPurchase": encodeRpcValue(isRealPurchase),
    };

  }

}

final class ProductsPriceRecordsListResultItem implements RpcValue {
  const ProductsPriceRecordsListResultItem({
    required this.id,
    required this.productId,
    this.vendorId,
    required this.timestamp,
    required this.price,
    required this.isRealPurchase,
    this.comment,
  });

  static const codec = RpcCodec<ProductsPriceRecordsListResultItem>(
    ProductsPriceRecordsListResultItem.fromWire,
  );

  final String id;
  final String productId;
  final String? vendorId;
  final DateTime timestamp;
  final num price;
  final bool isRealPurchase;
  final String? comment;

  factory ProductsPriceRecordsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "productId",
      "vendorId",
      "timestamp",
      "price",
      "isRealPurchase",
      "comment",
    });

    return ProductsPriceRecordsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      productId: rpcString.decode(readRpcField(object, "productId")),
      vendorId: rpcNullable(rpcString).decode(readRpcField(object, "vendorId")),
      timestamp: rpcDate.decode(readRpcField(object, "timestamp")),
      price: rpcNumber.decode(readRpcField(object, "price")),
      isRealPurchase: rpcBoolean.decode(readRpcField(object, "isRealPurchase")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "productId": encodeRpcValue(productId),
      "vendorId": encodeRpcValue(vendorId),
      "timestamp": encodeRpcValue(timestamp),
      "price": encodeRpcValue(price),
      "isRealPurchase": encodeRpcValue(isRealPurchase),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class ProjectsContactsListRequest implements RpcValue {
  const ProjectsContactsListRequest({required this.projectId});

  static const codec = RpcCodec<ProjectsContactsListRequest>(
    ProjectsContactsListRequest.fromWire,
  );

  final String projectId;

  factory ProjectsContactsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId"});

    return ProjectsContactsListRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"projectId": encodeRpcValue(projectId)};
  }

}

final class ProjectsContactsListResultItem implements RpcValue {
  const ProjectsContactsListResultItem({
    this.label,
    required this.id,
    this.salutation,
    this.firstName,
    this.lastName,
    this.address,
    required this.phoneNumbers,
    required this.emailAddresses,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ProjectsContactsListResultItem>(
    ProjectsContactsListResultItem.fromWire,
  );

  final String? label;
  final String id;
  final String? salutation;
  final String? firstName;
  final String? lastName;
  final ProjectAddress? address;
  final List<CustomerPhoneNumbersItem> phoneNumbers;
  final List<CustomerEmailAddressesItem> emailAddresses;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ProjectsContactsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "label",
      "id",
      "salutation",
      "firstName",
      "lastName",
      "address",
      "phoneNumbers",
      "emailAddresses",
      "createdAt",
      "modifiedAt",
    });

    return ProjectsContactsListResultItem(
      label: rpcNullable(rpcString).decode(readRpcField(object, "label")),
      id: rpcString.decode(readRpcField(object, "id")),
      salutation: rpcNullable(rpcString)
          .decode(readRpcField(object, "salutation")),
      firstName: rpcNullable(rpcString)
          .decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
      address: rpcNullable(ProjectAddress.codec)
          .decode(readRpcField(object, "address")),
      phoneNumbers: rpcArray(CustomerPhoneNumbersItem.codec)
          .decode(readRpcField(object, "phoneNumbers")),
      emailAddresses: rpcArray(CustomerEmailAddressesItem.codec)
          .decode(readRpcField(object, "emailAddresses")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "label": encodeRpcValue(label),
      "id": encodeRpcValue(id),
      "salutation": encodeRpcValue(salutation),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
      "address": encodeRpcValue(address),
      "phoneNumbers": encodeRpcValue(phoneNumbers),
      "emailAddresses": encodeRpcValue(emailAddresses),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ProjectsCostsFilterOptionsResult implements RpcValue {
  const ProjectsCostsFilterOptionsResult({
    required this.finishingYears,
    required this.projectLeaders,
  });

  static const codec = RpcCodec<ProjectsCostsFilterOptionsResult>(
    ProjectsCostsFilterOptionsResult.fromWire,
  );

  final List<num> finishingYears;
  final List<ProjectsCostsFilterOptionsResultProjectLeadersItem> projectLeaders;

  factory ProjectsCostsFilterOptionsResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "finishingYears",
      "projectLeaders",
    });

    return ProjectsCostsFilterOptionsResult(
      finishingYears: rpcArray(rpcNumber)
          .decode(readRpcField(object, "finishingYears")),
      projectLeaders: rpcArray(
        ProjectsCostsFilterOptionsResultProjectLeadersItem.codec,
      ).decode(readRpcField(object, "projectLeaders")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "finishingYears": encodeRpcValue(finishingYears),
      "projectLeaders": encodeRpcValue(projectLeaders),
    };

  }

}

final class ProjectsCostsGetRequest implements RpcValue {
  const ProjectsCostsGetRequest({
    required this.projectId,
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsCostsGetRequest>(
    ProjectsCostsGetRequest.fromWire,
  );

  final String projectId;
  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;

  factory ProjectsCostsGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "from", "to"});

    return ProjectsCostsGetRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
    };

  }

}

final class ProjectsCostsGetResult implements RpcValue {
  const ProjectsCostsGetResult({
    required this.offers,
    required this.invoices,
    required this.deliveryNotes,
    required this.products,
    required this.specialRecords,
    required this.workHours,
    required this.subcontractorWorkHours,
    required this.toolTrackings,
    required this.commonCosts,
    required this.totalCosts,
  });

  static const codec = RpcCodec<ProjectsCostsGetResult>(
    ProjectsCostsGetResult.fromWire,
  );

  final List<ProjectsCostsGetResultOffersItem> offers;
  final List<ProjectsCostsGetResultOffersItem> invoices;
  final List<ProjectsCostsGetResultDeliveryNotesItem> deliveryNotes;
  final List<ProjectsCostsGetResultProductsItem> products;
  final List<ProjectsCostsGetResultSpecialRecordsItem> specialRecords;
  final List<ProjectsCostsGetResultWorkHoursItem> workHours;
  final List<ProjectsCostsGetResultWorkHoursItem> subcontractorWorkHours;
  final List<ProjectsCostsGetResultToolTrackingsItem> toolTrackings;
  final ProjectsCostsGetResultCommonCosts commonCosts;
  final ProjectsCostsGetResultTotalCosts totalCosts;

  factory ProjectsCostsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "offers",
      "invoices",
      "deliveryNotes",
      "products",
      "specialRecords",
      "workHours",
      "subcontractorWorkHours",
      "toolTrackings",
      "commonCosts",
      "totalCosts",
    });

    return ProjectsCostsGetResult(
      offers: rpcArray(ProjectsCostsGetResultOffersItem.codec)
          .decode(readRpcField(object, "offers")),
      invoices: rpcArray(ProjectsCostsGetResultOffersItem.codec)
          .decode(readRpcField(object, "invoices")),
      deliveryNotes: rpcArray(ProjectsCostsGetResultDeliveryNotesItem.codec)
          .decode(readRpcField(object, "deliveryNotes")),
      products: rpcArray(ProjectsCostsGetResultProductsItem.codec)
          .decode(readRpcField(object, "products")),
      specialRecords: rpcArray(ProjectsCostsGetResultSpecialRecordsItem.codec)
          .decode(readRpcField(object, "specialRecords")),
      workHours: rpcArray(ProjectsCostsGetResultWorkHoursItem.codec)
          .decode(readRpcField(object, "workHours")),
      subcontractorWorkHours: rpcArray(
        ProjectsCostsGetResultWorkHoursItem.codec,
      ).decode(readRpcField(object, "subcontractorWorkHours")),
      toolTrackings: rpcArray(ProjectsCostsGetResultToolTrackingsItem.codec)
          .decode(readRpcField(object, "toolTrackings")),
      commonCosts: ProjectsCostsGetResultCommonCosts.codec.decode(
        readRpcField(object, "commonCosts"),
      ),
      totalCosts: ProjectsCostsGetResultTotalCosts.codec.decode(
        readRpcField(object, "totalCosts"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "offers": encodeRpcValue(offers),
      "invoices": encodeRpcValue(invoices),
      "deliveryNotes": encodeRpcValue(deliveryNotes),
      "products": encodeRpcValue(products),
      "specialRecords": encodeRpcValue(specialRecords),
      "workHours": encodeRpcValue(workHours),
      "subcontractorWorkHours": encodeRpcValue(subcontractorWorkHours),
      "toolTrackings": encodeRpcValue(toolTrackings),
      "commonCosts": encodeRpcValue(commonCosts),
      "totalCosts": encodeRpcValue(totalCosts),
    };

  }

}

final class ProjectsCostsOverviewRequest implements RpcValue {
  const ProjectsCostsOverviewRequest({
    this.status = const RpcOptional.absent(),
    this.closingYear = const RpcOptional.absent(),
    this.responsibleProjectLeaderUserId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsCostsOverviewRequest>(
    ProjectsCostsOverviewRequest.fromWire,
  );

  final RpcOptional<ProjectsCostsOverviewRequestStatus> status;
  final RpcOptional<num?> closingYear;
  final RpcOptional<String?> responsibleProjectLeaderUserId;

  factory ProjectsCostsOverviewRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "status",
      "closingYear",
      "responsibleProjectLeaderUserId",
    });

    return ProjectsCostsOverviewRequest(
      status: readRpcOptionalField(
        object,
        "status",
        ProjectsCostsOverviewRequestStatus.codec.decode,
      ),
      closingYear: readRpcOptionalField(
        object,
        "closingYear",
        rpcNullable(rpcNumber).decode,
      ),
      responsibleProjectLeaderUserId: readRpcOptionalField(
        object,
        "responsibleProjectLeaderUserId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!status.isAbsent) "status": encodeRpcValue(status),
      if (!closingYear.isAbsent) "closingYear": encodeRpcValue(closingYear),
      if (!responsibleProjectLeaderUserId.isAbsent)
        "responsibleProjectLeaderUserId": encodeRpcValue(
          responsibleProjectLeaderUserId,
        ),
    };

  }

}

final class ProjectsCostsOverviewResultItem implements RpcValue {
  const ProjectsCostsOverviewResultItem({
    required this.projectId,
    required this.title,
    this.address,
    required this.costs,
    required this.offersTotal,
    required this.invoicesTotal,
    this.gainOrLoss,
    required this.hasInvoices,
    this.finishedAt,
    this.responsibleProjectLeaderUserId,
  });

  static const codec = RpcCodec<ProjectsCostsOverviewResultItem>(
    ProjectsCostsOverviewResultItem.fromWire,
  );

  final String projectId;
  final String title;
  final ProjectAddress? address;
  final num costs;
  final num offersTotal;
  final num invoicesTotal;
  final num? gainOrLoss;
  final bool hasInvoices;
  final DateTime? finishedAt;
  final String? responsibleProjectLeaderUserId;

  factory ProjectsCostsOverviewResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "title",
      "address",
      "costs",
      "offersTotal",
      "invoicesTotal",
      "gainOrLoss",
      "hasInvoices",
      "finishedAt",
      "responsibleProjectLeaderUserId",
    });

    return ProjectsCostsOverviewResultItem(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      title: rpcString.decode(readRpcField(object, "title")),
      address: rpcNullable(ProjectAddress.codec)
          .decode(readRpcField(object, "address")),
      costs: rpcNumber.decode(readRpcField(object, "costs")),
      offersTotal: rpcNumber.decode(readRpcField(object, "offersTotal")),
      invoicesTotal: rpcNumber.decode(readRpcField(object, "invoicesTotal")),
      gainOrLoss: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "gainOrLoss")),
      hasInvoices: rpcBoolean.decode(readRpcField(object, "hasInvoices")),
      finishedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "finishedAt")),
      responsibleProjectLeaderUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "responsibleProjectLeaderUserId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "title": encodeRpcValue(title),
      "address": encodeRpcValue(address),
      "costs": encodeRpcValue(costs),
      "offersTotal": encodeRpcValue(offersTotal),
      "invoicesTotal": encodeRpcValue(invoicesTotal),
      "gainOrLoss": encodeRpcValue(gainOrLoss),
      "hasInvoices": encodeRpcValue(hasInvoices),
      "finishedAt": encodeRpcValue(finishedAt),
      "responsibleProjectLeaderUserId": encodeRpcValue(
        responsibleProjectLeaderUserId,
      ),
    };

  }

}

final class ProjectsDailyReportsGetRequest implements RpcValue {
  const ProjectsDailyReportsGetRequest({required this.projectId, this.day});

  static const codec = RpcCodec<ProjectsDailyReportsGetRequest>(
    ProjectsDailyReportsGetRequest.fromWire,
  );

  final String projectId;
  final Object? day;

  factory ProjectsDailyReportsGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "day"});

    return ProjectsDailyReportsGetRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcUnknown.decode(readRpcField(object, "day")),
    );
  }

  @override
  JsonMap toWire() {
    return {"projectId": encodeRpcValue(projectId), "day": encodeRpcValue(day)};
  }

}

final class ProjectsDailyReportsGetResult implements RpcValue {
  const ProjectsDailyReportsGetResult({
    required this.id,
    required this.projectId,
    required this.day,
    this.summary,
    this.weather,
    this.createdByUserId,
    required this.createdAt,
    required this.workHours,
    required this.photos,
  });

  static const codec = RpcCodec<ProjectsDailyReportsGetResult>(
    ProjectsDailyReportsGetResult.fromWire,
  );

  final String id;
  final String projectId;
  final DateTime day;
  final String? summary;
  final ProjectsDailyReportsGetResultWeather? weather;
  final String? createdByUserId;
  final DateTime createdAt;
  final List<ProjectsDailyReportsGetResultWorkHoursItem> workHours;
  final List<ProjectsDailyReportsGetResultPhotosItem> photos;

  factory ProjectsDailyReportsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "day",
      "summary",
      "weather",
      "createdByUserId",
      "createdAt",
      "workHours",
      "photos",
    });

    return ProjectsDailyReportsGetResult(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcDate.decode(readRpcField(object, "day")),
      summary: rpcNullable(rpcString).decode(readRpcField(object, "summary")),
      weather: rpcNullable(ProjectsDailyReportsGetResultWeather.codec)
          .decode(readRpcField(object, "weather")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      workHours: rpcArray(ProjectsDailyReportsGetResultWorkHoursItem.codec)
          .decode(readRpcField(object, "workHours")),
      photos: rpcArray(ProjectsDailyReportsGetResultPhotosItem.codec)
          .decode(readRpcField(object, "photos")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      "summary": encodeRpcValue(summary),
      "weather": encodeRpcValue(weather),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "workHours": encodeRpcValue(workHours),
      "photos": encodeRpcValue(photos),
    };

  }

}

final class ProjectsDailyReportsListRequest implements RpcValue {
  const ProjectsDailyReportsListRequest({
    this.projectId = const RpcOptional.absent(),
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
    this.offset = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsListRequest>(
    ProjectsDailyReportsListRequest.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;
  final RpcOptional<num> limit;
  final RpcOptional<num> offset;

  factory ProjectsDailyReportsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "from",
      "to",
      "limit",
      "offset",
    });

    return ProjectsDailyReportsListRequest(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
      offset: readRpcOptionalField(object, "offset", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
      if (!offset.isAbsent) "offset": encodeRpcValue(offset),
    };

  }

}

final class ProjectsDeploymentsListRequest implements RpcValue {
  const ProjectsDeploymentsListRequest({
    this.from,
    this.to,
    this.since = const RpcOptional.absent(),
    this.projectId = const RpcOptional.absent(),
    this.userId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDeploymentsListRequest>(
    ProjectsDeploymentsListRequest.fromWire,
  );

  final Object? from;
  final Object? to;
  final RpcOptional<Object?> since;
  final RpcOptional<String?> projectId;
  final RpcOptional<String?> userId;

  factory ProjectsDeploymentsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "from",
      "to",
      "since",
      "projectId",
      "userId",
    });

    return ProjectsDeploymentsListRequest(
      from: rpcUnknown.decode(readRpcField(object, "from")),
      to: rpcUnknown.decode(readRpcField(object, "to")),
      since: readRpcOptionalField(object, "since", rpcUnknown.decode),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      if (!since.isAbsent) "since": encodeRpcValue(since),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
    };

  }

}

final class ProjectsFilesDrawioConfigRequest implements RpcValue {
  const ProjectsFilesDrawioConfigRequest({
    required this.projectId,
    required this.fileId,
  });

  static const codec = RpcCodec<ProjectsFilesDrawioConfigRequest>(
    ProjectsFilesDrawioConfigRequest.fromWire,
  );

  final Id projectId;
  final Id fileId;

  factory ProjectsFilesDrawioConfigRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "fileId"});

    return ProjectsFilesDrawioConfigRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileId": encodeRpcValue(fileId),
    };

  }

}

final class ProjectsFilesDrawioConfigResult implements RpcValue {
  const ProjectsFilesDrawioConfigResult({
    required this.editorUrl,
    required this.canEdit,
    required this.fileName,
    required this.version,
    required this.xml,
  });

  static const codec = RpcCodec<ProjectsFilesDrawioConfigResult>(
    ProjectsFilesDrawioConfigResult.fromWire,
  );

  final String editorUrl;
  final bool canEdit;
  final String fileName;
  final BigInt version;
  final String xml;

  factory ProjectsFilesDrawioConfigResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "editorUrl",
      "canEdit",
      "fileName",
      "version",
      "xml",
    });

    return ProjectsFilesDrawioConfigResult(
      editorUrl: rpcString.decode(readRpcField(object, "editorUrl")),
      canEdit: rpcBoolean.decode(readRpcField(object, "canEdit")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      version: rpcBigInt.decode(readRpcField(object, "version")),
      xml: rpcString.decode(readRpcField(object, "xml")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "editorUrl": encodeRpcValue(editorUrl),
      "canEdit": encodeRpcValue(canEdit),
      "fileName": encodeRpcValue(fileName),
      "version": encodeRpcValue(version),
      "xml": encodeRpcValue(xml),
    };

  }

}

final class ProjectsFilesFoldersListRequest implements RpcValue {
  const ProjectsFilesFoldersListRequest({required this.projectId});

  static const codec = RpcCodec<ProjectsFilesFoldersListRequest>(
    ProjectsFilesFoldersListRequest.fromWire,
  );

  final Id projectId;

  factory ProjectsFilesFoldersListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId"});

    return ProjectsFilesFoldersListRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"projectId": encodeRpcValue(projectId)};
  }

}

final class ProjectsFilesFoldersListResultItem implements RpcValue {
  const ProjectsFilesFoldersListResultItem({
    required this.id,
    required this.projectId,
    this.parentFolderId,
    required this.name,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ProjectsFilesFoldersListResultItem>(
    ProjectsFilesFoldersListResultItem.fromWire,
  );

  final Id id;
  final Id projectId;
  final Id? parentFolderId;
  final String name;
  final Id? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ProjectsFilesFoldersListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "parentFolderId",
      "name",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
    });

    return ProjectsFilesFoldersListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      parentFolderId: rpcNullable(rpcString)
          .decode(readRpcField(object, "parentFolderId")),
      name: rpcString.decode(readRpcField(object, "name")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "parentFolderId": encodeRpcValue(parentFolderId),
      "name": encodeRpcValue(name),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ProjectsFilesListResultItem implements RpcValue {
  const ProjectsFilesListResultItem({
    required this.id,
    required this.projectId,
    this.folderId,
    required this.fileName,
    required this.mimeType,
    required this.kind,
    this.sizeBytes,
    required this.status,
    required this.thumbnailStatus,
    this.thumbnailExpiresAt,
    this.previewExpiresAt,
    this.thumbnailWidth,
    this.thumbnailHeight,
    required this.textExtractionStatus,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
    this.uploadedAt,
    this.downloadExpiresAt,
    this.downloadAttachmentExpiresAt,
    this.thumbnailUrl = const RpcOptional.absent(),
    this.previewUrl = const RpcOptional.absent(),
    this.downloadUrl = const RpcOptional.absent(),
    this.downloadAttachmentUrl = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesListResultItem>(
    ProjectsFilesListResultItem.fromWire,
  );

  final String id;
  final String projectId;
  final String? folderId;
  final String fileName;
  final String mimeType;
  final ProjectsFilesListResultItemKind kind;
  final num? sizeBytes;
  final ProjectsFilesListResultItemStatus status;
  final ProjectsFilesListResultItemThumbnailStatus thumbnailStatus;
  final DateTime? thumbnailExpiresAt;
  final DateTime? previewExpiresAt;
  final num? thumbnailWidth;
  final num? thumbnailHeight;
  final String textExtractionStatus;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final DateTime? uploadedAt;
  final DateTime? downloadExpiresAt;
  final DateTime? downloadAttachmentExpiresAt;
  final RpcOptional<String?> thumbnailUrl;
  final RpcOptional<String?> previewUrl;
  final RpcOptional<String?> downloadUrl;
  final RpcOptional<String?> downloadAttachmentUrl;

  factory ProjectsFilesListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "folderId",
      "fileName",
      "mimeType",
      "kind",
      "sizeBytes",
      "status",
      "thumbnailStatus",
      "thumbnailExpiresAt",
      "previewExpiresAt",
      "thumbnailWidth",
      "thumbnailHeight",
      "textExtractionStatus",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
      "uploadedAt",
      "downloadExpiresAt",
      "downloadAttachmentExpiresAt",
      "thumbnailUrl",
      "previewUrl",
      "downloadUrl",
      "downloadAttachmentUrl",
    });

    return ProjectsFilesListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      folderId: rpcNullable(rpcString).decode(readRpcField(object, "folderId")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      kind: ProjectsFilesListResultItemKind.codec.decode(
        readRpcField(object, "kind"),
      ),
      sizeBytes: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "sizeBytes")),
      status: ProjectsFilesListResultItemStatus.codec.decode(
        readRpcField(object, "status"),
      ),
      thumbnailStatus: ProjectsFilesListResultItemThumbnailStatus.codec.decode(
        readRpcField(object, "thumbnailStatus"),
      ),
      thumbnailExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "thumbnailExpiresAt")),
      previewExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "previewExpiresAt")),
      thumbnailWidth: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "thumbnailWidth")),
      thumbnailHeight: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "thumbnailHeight")),
      textExtractionStatus: rpcString.decode(
        readRpcField(object, "textExtractionStatus"),
      ),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
      uploadedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "uploadedAt")),
      downloadExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "downloadExpiresAt")),
      downloadAttachmentExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "downloadAttachmentExpiresAt")),
      thumbnailUrl: readRpcOptionalField(
        object,
        "thumbnailUrl",
        rpcNullable(rpcString).decode,
      ),
      previewUrl: readRpcOptionalField(
        object,
        "previewUrl",
        rpcNullable(rpcString).decode,
      ),
      downloadUrl: readRpcOptionalField(
        object,
        "downloadUrl",
        rpcNullable(rpcString).decode,
      ),
      downloadAttachmentUrl: readRpcOptionalField(
        object,
        "downloadAttachmentUrl",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "folderId": encodeRpcValue(folderId),
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      "kind": encodeRpcValue(kind),
      "sizeBytes": encodeRpcValue(sizeBytes),
      "status": encodeRpcValue(status),
      "thumbnailStatus": encodeRpcValue(thumbnailStatus),
      "thumbnailExpiresAt": encodeRpcValue(thumbnailExpiresAt),
      "previewExpiresAt": encodeRpcValue(previewExpiresAt),
      "thumbnailWidth": encodeRpcValue(thumbnailWidth),
      "thumbnailHeight": encodeRpcValue(thumbnailHeight),
      "textExtractionStatus": encodeRpcValue(textExtractionStatus),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
      "uploadedAt": encodeRpcValue(uploadedAt),
      "downloadExpiresAt": encodeRpcValue(downloadExpiresAt),
      "downloadAttachmentExpiresAt": encodeRpcValue(
        downloadAttachmentExpiresAt,
      ),
      if (!thumbnailUrl.isAbsent) "thumbnailUrl": encodeRpcValue(thumbnailUrl),
      if (!previewUrl.isAbsent) "previewUrl": encodeRpcValue(previewUrl),
      if (!downloadUrl.isAbsent) "downloadUrl": encodeRpcValue(downloadUrl),
      if (!downloadAttachmentUrl.isAbsent)
        "downloadAttachmentUrl": encodeRpcValue(downloadAttachmentUrl),
    };

  }

}

final class ProjectsFilesSearchRequest implements RpcValue {
  const ProjectsFilesSearchRequest({
    required this.query,
    this.projectId = const RpcOptional.absent(),
    required this.limit,
  });

  static const codec = RpcCodec<ProjectsFilesSearchRequest>(
    ProjectsFilesSearchRequest.fromWire,
  );

  final String query;
  final RpcOptional<Id?> projectId;
  final BigInt limit;

  factory ProjectsFilesSearchRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"query", "projectId", "limit"});

    return ProjectsFilesSearchRequest(
      query: rpcString.decode(readRpcField(object, "query")),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      limit: rpcBigInt.decode(readRpcField(object, "limit")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "query": encodeRpcValue(query),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      "limit": encodeRpcValue(limit),
    };

  }

}

final class ProjectsFilesSearchResultItem implements RpcValue {
  const ProjectsFilesSearchResultItem({
    required this.id,
    required this.projectId,
    required this.projectTitle,
    required this.fileName,
    required this.mimeType,
    required this.textExtractionStatus,
    this.excerpt,
    required this.rank,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ProjectsFilesSearchResultItem>(
    ProjectsFilesSearchResultItem.fromWire,
  );

  final Id id;
  final Id projectId;
  final String projectTitle;
  final String fileName;
  final String mimeType;
  final String textExtractionStatus;
  final String? excerpt;
  final num rank;
  final DateTime modifiedAt;

  factory ProjectsFilesSearchResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "projectTitle",
      "fileName",
      "mimeType",
      "textExtractionStatus",
      "excerpt",
      "rank",
      "modifiedAt",
    });

    return ProjectsFilesSearchResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      projectTitle: rpcString.decode(readRpcField(object, "projectTitle")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      textExtractionStatus: rpcString.decode(
        readRpcField(object, "textExtractionStatus"),
      ),
      excerpt: rpcNullable(rpcString).decode(readRpcField(object, "excerpt")),
      rank: rpcNumber.decode(readRpcField(object, "rank")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "projectTitle": encodeRpcValue(projectTitle),
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      "textExtractionStatus": encodeRpcValue(textExtractionStatus),
      "excerpt": encodeRpcValue(excerpt),
      "rank": encodeRpcValue(rank),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class ProjectsListRequest implements RpcValue {
  const ProjectsListRequest({
    this.search = const RpcOptional.absent(),
    this.finished = const RpcOptional.absent(),
    this.customerId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsListRequest>(
    ProjectsListRequest.fromWire,
  );

  final RpcOptional<String?> search;
  final RpcOptional<bool?> finished;
  final RpcOptional<String?> customerId;

  factory ProjectsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "search",
      "finished",
      "customerId",
    });

    return ProjectsListRequest(
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
      finished: readRpcOptionalField(
        object,
        "finished",
        rpcNullable(rpcBoolean).decode,
      ),
      customerId: readRpcOptionalField(
        object,
        "customerId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!search.isAbsent) "search": encodeRpcValue(search),
      if (!finished.isAbsent) "finished": encodeRpcValue(finished),
      if (!customerId.isAbsent) "customerId": encodeRpcValue(customerId),
    };

  }

}

final class ProjectsUnavailabilityListRequest implements RpcValue {
  const ProjectsUnavailabilityListRequest({
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
    this.projectId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsUnavailabilityListRequest>(
    ProjectsUnavailabilityListRequest.fromWire,
  );

  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;
  final RpcOptional<String?> projectId;

  factory ProjectsUnavailabilityListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"from", "to", "projectId"});

    return ProjectsUnavailabilityListRequest(
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
    };

  }

}

final class ProjectsUnavailabilityListResultItem implements RpcValue {
  const ProjectsUnavailabilityListResultItem({
    required this.id,
    required this.projectId,
    required this.from,
    required this.to,
    required this.reason,
    this.note,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<ProjectsUnavailabilityListResultItem>(
    ProjectsUnavailabilityListResultItem.fromWire,
  );

  final String id;
  final String projectId;
  final DateTime from;
  final DateTime to;
  final String reason;
  final String? note;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory ProjectsUnavailabilityListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "from",
      "to",
      "reason",
      "note",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
    });

    return ProjectsUnavailabilityListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      from: rpcDate.decode(readRpcField(object, "from")),
      to: rpcDate.decode(readRpcField(object, "to")),
      reason: rpcString.decode(readRpcField(object, "reason")),
      note: rpcNullable(rpcString).decode(readRpcField(object, "note")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      "reason": encodeRpcValue(reason),
      "note": encodeRpcValue(note),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class RegieReportsCostsGetResult implements RpcValue {
  const RegieReportsCostsGetResult({
    required this.reportId,
    required this.totalCost,
    required this.products,
    required this.specialRecords,
    required this.workHours,
  });

  static const codec = RpcCodec<RegieReportsCostsGetResult>(
    RegieReportsCostsGetResult.fromWire,
  );

  final String reportId;
  final num totalCost;
  final List<DeliveryNotesCostsGetResultRecordsItem> products;
  final List<RegieReportsCostsGetResultSpecialRecordsItem> specialRecords;
  final List<RegieReportsCostsGetResultWorkHoursItem> workHours;

  factory RegieReportsCostsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "reportId",
      "totalCost",
      "products",
      "specialRecords",
      "workHours",
    });

    return RegieReportsCostsGetResult(
      reportId: rpcString.decode(readRpcField(object, "reportId")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
      products: rpcArray(DeliveryNotesCostsGetResultRecordsItem.codec)
          .decode(readRpcField(object, "products")),
      specialRecords: rpcArray(
        RegieReportsCostsGetResultSpecialRecordsItem.codec,
      ).decode(readRpcField(object, "specialRecords")),
      workHours: rpcArray(RegieReportsCostsGetResultWorkHoursItem.codec)
          .decode(readRpcField(object, "workHours")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "reportId": encodeRpcValue(reportId),
      "totalCost": encodeRpcValue(totalCost),
      "products": encodeRpcValue(products),
      "specialRecords": encodeRpcValue(specialRecords),
      "workHours": encodeRpcValue(workHours),
    };

  }

}

final class RegieReportsListRequest implements RpcValue {
  const RegieReportsListRequest({
    this.projectId = const RpcOptional.absent(),
    this.dayFrom = const RpcOptional.absent(),
    this.dayTo = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
    this.offset = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsListRequest>(
    RegieReportsListRequest.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<String> dayFrom;
  final RpcOptional<String> dayTo;
  final RpcOptional<num> limit;
  final RpcOptional<num> offset;

  factory RegieReportsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "dayFrom",
      "dayTo",
      "limit",
      "offset",
    });

    return RegieReportsListRequest(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      dayFrom: readRpcOptionalField(object, "dayFrom", rpcString.decode),
      dayTo: readRpcOptionalField(object, "dayTo", rpcString.decode),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
      offset: readRpcOptionalField(object, "offset", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!dayFrom.isAbsent) "dayFrom": encodeRpcValue(dayFrom),
      if (!dayTo.isAbsent) "dayTo": encodeRpcValue(dayTo),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
      if (!offset.isAbsent) "offset": encodeRpcValue(offset),
    };

  }

}

final class RemarksListRequest implements RpcValue {
  const RemarksListRequest({
    required this.resourceType,
    required this.resourceId,
  });

  static const codec = RpcCodec<RemarksListRequest>(
    RemarksListRequest.fromWire,
  );

  final RemarksListRequestResourceType resourceType;
  final String resourceId;

  factory RemarksListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"resourceType", "resourceId"});

    return RemarksListRequest(
      resourceType: RemarksListRequestResourceType.codec.decode(
        readRpcField(object, "resourceType"),
      ),
      resourceId: rpcString.decode(readRpcField(object, "resourceId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "resourceType": encodeRpcValue(resourceType),
      "resourceId": encodeRpcValue(resourceId),
    };

  }

}

final class RemarksListResultItem implements RpcValue {
  const RemarksListResultItem({
    required this.id,
    required this.body,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<RemarksListResultItem>(
    RemarksListResultItem.fromWire,
  );

  final String id;
  final String body;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory RemarksListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "body",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
    });

    return RemarksListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      body: rpcString.decode(readRpcField(object, "body")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "body": encodeRpcValue(body),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

final class SettingsCostsGetResult implements RpcValue {
  const SettingsCostsGetResult({
    required this.fgk,
    required this.mgk,
    required this.ngk,
    required this.history,
    required this.productOverheadFactor,
    required this.workHourOverheadFactor,
    required this.specialRecordOverheadFactor,
    required this.toolOverheadFactor,
  });

  static const codec = RpcCodec<SettingsCostsGetResult>(
    SettingsCostsGetResult.fromWire,
  );

  final SettingsCostsGetResultFgk fgk;
  final SettingsCostsGetResultFgk mgk;
  final SettingsCostsGetResultFgk ngk;
  final List<SettingsCostsGetResultHistoryItem> history;
  final num productOverheadFactor;
  final num workHourOverheadFactor;
  final num specialRecordOverheadFactor;
  final num toolOverheadFactor;

  factory SettingsCostsGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "fgk",
      "mgk",
      "ngk",
      "history",
      "productOverheadFactor",
      "workHourOverheadFactor",
      "specialRecordOverheadFactor",
      "toolOverheadFactor",
    });

    return SettingsCostsGetResult(
      fgk: SettingsCostsGetResultFgk.codec.decode(readRpcField(object, "fgk")),
      mgk: SettingsCostsGetResultFgk.codec.decode(readRpcField(object, "mgk")),
      ngk: SettingsCostsGetResultFgk.codec.decode(readRpcField(object, "ngk")),
      history: rpcArray(SettingsCostsGetResultHistoryItem.codec)
          .decode(readRpcField(object, "history")),
      productOverheadFactor: rpcNumber.decode(
        readRpcField(object, "productOverheadFactor"),
      ),
      workHourOverheadFactor: rpcNumber.decode(
        readRpcField(object, "workHourOverheadFactor"),
      ),
      specialRecordOverheadFactor: rpcNumber.decode(
        readRpcField(object, "specialRecordOverheadFactor"),
      ),
      toolOverheadFactor: rpcNumber.decode(
        readRpcField(object, "toolOverheadFactor"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "fgk": encodeRpcValue(fgk),
      "mgk": encodeRpcValue(mgk),
      "ngk": encodeRpcValue(ngk),
      "history": encodeRpcValue(history),
      "productOverheadFactor": encodeRpcValue(productOverheadFactor),
      "workHourOverheadFactor": encodeRpcValue(workHourOverheadFactor),
      "specialRecordOverheadFactor": encodeRpcValue(
        specialRecordOverheadFactor,
      ),
      "toolOverheadFactor": encodeRpcValue(toolOverheadFactor),
    };

  }

}

final class SettingsGlobalGetRequest implements RpcValue {
  const SettingsGlobalGetRequest({required this.key});

  static const codec = RpcCodec<SettingsGlobalGetRequest>(
    SettingsGlobalGetRequest.fromWire,
  );

  final String key;

  factory SettingsGlobalGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"key"});

    return SettingsGlobalGetRequest(
      key: rpcString.decode(readRpcField(object, "key")),
    );
  }

  @override
  JsonMap toWire() {
    return {"key": encodeRpcValue(key)};
  }

}

final class SettingsGlobalGetResult implements RpcValue {
  const SettingsGlobalGetResult({required this.key, this.name});

  static const codec = RpcCodec<SettingsGlobalGetResult>(
    SettingsGlobalGetResult.fromWire,
  );

  final String key;
  final Object? name;

  factory SettingsGlobalGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"key", "name"});

    return SettingsGlobalGetResult(
      key: rpcString.decode(readRpcField(object, "key")),
      name: rpcUnknown.decode(readRpcField(object, "name")),
    );
  }

  @override
  JsonMap toWire() {
    return {"key": encodeRpcValue(key), "name": encodeRpcValue(name)};
  }

}

final class SettingsTenantLogoGetResult implements RpcValue {
  const SettingsTenantLogoGetResult({
    required this.status,
    this.mimeType,
    this.fileName,
    this.width,
    this.height,
    this.downloadUrl,
    this.downloadExpiresAt,
    this.error,
  });

  static const codec = RpcCodec<SettingsTenantLogoGetResult>(
    SettingsTenantLogoGetResult.fromWire,
  );

  final SettingsTenantLogoGetResultStatus status;
  final String? mimeType;
  final String? fileName;
  final num? width;
  final num? height;
  final String? downloadUrl;
  final DateTime? downloadExpiresAt;
  final String? error;

  factory SettingsTenantLogoGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "status",
      "mimeType",
      "fileName",
      "width",
      "height",
      "downloadUrl",
      "downloadExpiresAt",
      "error",
    });

    return SettingsTenantLogoGetResult(
      status: SettingsTenantLogoGetResultStatus.codec.decode(
        readRpcField(object, "status"),
      ),
      mimeType: rpcNullable(rpcString).decode(readRpcField(object, "mimeType")),
      fileName: rpcNullable(rpcString).decode(readRpcField(object, "fileName")),
      width: rpcNullable(rpcNumber).decode(readRpcField(object, "width")),
      height: rpcNullable(rpcNumber).decode(readRpcField(object, "height")),
      downloadUrl: rpcNullable(rpcString)
          .decode(readRpcField(object, "downloadUrl")),
      downloadExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "downloadExpiresAt")),
      error: rpcNullable(rpcString).decode(readRpcField(object, "error")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "status": encodeRpcValue(status),
      "mimeType": encodeRpcValue(mimeType),
      "fileName": encodeRpcValue(fileName),
      "width": encodeRpcValue(width),
      "height": encodeRpcValue(height),
      "downloadUrl": encodeRpcValue(downloadUrl),
      "downloadExpiresAt": encodeRpcValue(downloadExpiresAt),
      "error": encodeRpcValue(error),
    };

  }

}

final class SettingsTenantNameGetResult implements RpcValue {
  const SettingsTenantNameGetResult({this.companyName});

  static const codec = RpcCodec<SettingsTenantNameGetResult>(
    SettingsTenantNameGetResult.fromWire,
  );

  final String? companyName;

  factory SettingsTenantNameGetResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"companyName"});

    return SettingsTenantNameGetResult(
      companyName: rpcNullable(rpcString)
          .decode(readRpcField(object, "companyName")),
    );
  }

  @override
  JsonMap toWire() {
    return {"companyName": encodeRpcValue(companyName)};
  }

}

final class ToolsInventoriesListRequest implements RpcValue {
  const ToolsInventoriesListRequest({this.toolId = const RpcOptional.absent()});

  static const codec = RpcCodec<ToolsInventoriesListRequest>(
    ToolsInventoriesListRequest.fromWire,
  );

  final RpcOptional<String?> toolId;

  factory ToolsInventoriesListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"toolId"});

    return ToolsInventoriesListRequest(
      toolId: readRpcOptionalField(
        object,
        "toolId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {if (!toolId.isAbsent) "toolId": encodeRpcValue(toolId)};
  }

}

final class ToolsInventoriesListResultItem implements RpcValue {
  const ToolsInventoriesListResultItem({
    required this.id,
    required this.toolId,
    this.comment,
    required this.createdAt,
  });

  static const codec = RpcCodec<ToolsInventoriesListResultItem>(
    ToolsInventoriesListResultItem.fromWire,
  );

  final String id;
  final String toolId;
  final String? comment;
  final DateTime createdAt;

  factory ToolsInventoriesListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "toolId",
      "comment",
      "createdAt",
    });

    return ToolsInventoriesListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      toolId: rpcString.decode(readRpcField(object, "toolId")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "toolId": encodeRpcValue(toolId),
      "comment": encodeRpcValue(comment),
      "createdAt": encodeRpcValue(createdAt),
    };

  }

}

final class ToolsInventoriesOverviewRequest implements RpcValue {
  const ToolsInventoriesOverviewRequest({
    required this.hadInventory,
    this.days = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsInventoriesOverviewRequest>(
    ToolsInventoriesOverviewRequest.fromWire,
  );

  final bool hadInventory;
  final RpcOptional<num> days;

  factory ToolsInventoriesOverviewRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"hadInventory", "days"});

    return ToolsInventoriesOverviewRequest(
      hadInventory: rpcBoolean.decode(readRpcField(object, "hadInventory")),
      days: readRpcOptionalField(object, "days", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "hadInventory": encodeRpcValue(hadInventory),
      if (!days.isAbsent) "days": encodeRpcValue(days),
    };

  }

}

final class ToolsInventoriesOverviewResultItem implements RpcValue {
  const ToolsInventoriesOverviewResultItem({
    required this.id,
    required this.customId,
    required this.brand,
    required this.category,
    this.label,
    this.status,
    required this.available,
    this.archivedSince,
    this.lastInventoryAt,
    this.lastResponsibleUserId,
    this.lastResponsibleFirstName,
    this.lastResponsibleLastName,
  });

  static const codec = RpcCodec<ToolsInventoriesOverviewResultItem>(
    ToolsInventoriesOverviewResultItem.fromWire,
  );

  final String id;
  final num customId;
  final String brand;
  final String category;
  final String? label;
  final ToolStatus? status;
  final bool available;
  final DateTime? archivedSince;
  final DateTime? lastInventoryAt;
  final String? lastResponsibleUserId;
  final String? lastResponsibleFirstName;
  final String? lastResponsibleLastName;

  factory ToolsInventoriesOverviewResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "customId",
      "brand",
      "category",
      "label",
      "status",
      "available",
      "archivedSince",
      "lastInventoryAt",
      "lastResponsibleUserId",
      "lastResponsibleFirstName",
      "lastResponsibleLastName",
    });

    return ToolsInventoriesOverviewResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      brand: rpcString.decode(readRpcField(object, "brand")),
      category: rpcString.decode(readRpcField(object, "category")),
      label: rpcNullable(rpcString).decode(readRpcField(object, "label")),
      status: rpcNullable(ToolStatus.codec)
          .decode(readRpcField(object, "status")),
      available: rpcBoolean.decode(readRpcField(object, "available")),
      archivedSince: rpcNullable(rpcDate)
          .decode(readRpcField(object, "archivedSince")),
      lastInventoryAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "lastInventoryAt")),
      lastResponsibleUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "lastResponsibleUserId")),
      lastResponsibleFirstName: rpcNullable(rpcString)
          .decode(readRpcField(object, "lastResponsibleFirstName")),
      lastResponsibleLastName: rpcNullable(rpcString)
          .decode(readRpcField(object, "lastResponsibleLastName")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "customId": encodeRpcValue(customId),
      "brand": encodeRpcValue(brand),
      "category": encodeRpcValue(category),
      "label": encodeRpcValue(label),
      "status": encodeRpcValue(status),
      "available": encodeRpcValue(available),
      "archivedSince": encodeRpcValue(archivedSince),
      "lastInventoryAt": encodeRpcValue(lastInventoryAt),
      "lastResponsibleUserId": encodeRpcValue(lastResponsibleUserId),
      "lastResponsibleFirstName": encodeRpcValue(lastResponsibleFirstName),
      "lastResponsibleLastName": encodeRpcValue(lastResponsibleLastName),
    };

  }

}

final class ToolsListRequest implements RpcValue {
  const ToolsListRequest({
    this.search = const RpcOptional.absent(),
    this.status = const RpcOptional.absent(),
    this.brand = const RpcOptional.absent(),
    this.category = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsListRequest>(ToolsListRequest.fromWire);

  final RpcOptional<String?> search;
  final RpcOptional<ToolsListRequestStatus?> status;
  final RpcOptional<String?> brand;
  final RpcOptional<String?> category;

  factory ToolsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "search",
      "status",
      "brand",
      "category",
    });

    return ToolsListRequest(
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
      status: readRpcOptionalField(
        object,
        "status",
        rpcNullable(ToolsListRequestStatus.codec).decode,
      ),
      brand: readRpcOptionalField(
        object,
        "brand",
        rpcNullable(rpcString).decode,
      ),
      category: readRpcOptionalField(
        object,
        "category",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!search.isAbsent) "search": encodeRpcValue(search),
      if (!status.isAbsent) "status": encodeRpcValue(status),
      if (!brand.isAbsent) "brand": encodeRpcValue(brand),
      if (!category.isAbsent) "category": encodeRpcValue(category),
    };

  }

}

final class ToolsTrackingsListRequest implements RpcValue {
  const ToolsTrackingsListRequest({
    this.finished = const RpcOptional.absent(),
    this.toolId = const RpcOptional.absent(),
    this.projectId = const RpcOptional.absent(),
    this.responsibleUserId = const RpcOptional.absent(),
    this.startedByUserId = const RpcOptional.absent(),
    this.endedByUserId = const RpcOptional.absent(),
    this.startedBefore = const RpcOptional.absent(),
    this.startedAfter = const RpcOptional.absent(),
    this.endedBefore = const RpcOptional.absent(),
    this.endedAfter = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
    this.offset = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsTrackingsListRequest>(
    ToolsTrackingsListRequest.fromWire,
  );

  final RpcOptional<bool?> finished;
  final RpcOptional<String?> toolId;
  final RpcOptional<String?> projectId;
  final RpcOptional<String?> responsibleUserId;
  final RpcOptional<String?> startedByUserId;
  final RpcOptional<String?> endedByUserId;
  final RpcOptional<Object?> startedBefore;
  final RpcOptional<Object?> startedAfter;
  final RpcOptional<Object?> endedBefore;
  final RpcOptional<Object?> endedAfter;
  final RpcOptional<num> limit;
  final RpcOptional<num> offset;

  factory ToolsTrackingsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "finished",
      "toolId",
      "projectId",
      "responsibleUserId",
      "startedByUserId",
      "endedByUserId",
      "startedBefore",
      "startedAfter",
      "endedBefore",
      "endedAfter",
      "limit",
      "offset",
    });

    return ToolsTrackingsListRequest(
      finished: readRpcOptionalField(
        object,
        "finished",
        rpcNullable(rpcBoolean).decode,
      ),
      toolId: readRpcOptionalField(
        object,
        "toolId",
        rpcNullable(rpcString).decode,
      ),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      responsibleUserId: readRpcOptionalField(
        object,
        "responsibleUserId",
        rpcNullable(rpcString).decode,
      ),
      startedByUserId: readRpcOptionalField(
        object,
        "startedByUserId",
        rpcNullable(rpcString).decode,
      ),
      endedByUserId: readRpcOptionalField(
        object,
        "endedByUserId",
        rpcNullable(rpcString).decode,
      ),
      startedBefore: readRpcOptionalField(
        object,
        "startedBefore",
        rpcUnknown.decode,
      ),
      startedAfter: readRpcOptionalField(
        object,
        "startedAfter",
        rpcUnknown.decode,
      ),
      endedBefore: readRpcOptionalField(
        object,
        "endedBefore",
        rpcUnknown.decode,
      ),
      endedAfter: readRpcOptionalField(object, "endedAfter", rpcUnknown.decode),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
      offset: readRpcOptionalField(object, "offset", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!finished.isAbsent) "finished": encodeRpcValue(finished),
      if (!toolId.isAbsent) "toolId": encodeRpcValue(toolId),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!responsibleUserId.isAbsent)
        "responsibleUserId": encodeRpcValue(responsibleUserId),
      if (!startedByUserId.isAbsent)
        "startedByUserId": encodeRpcValue(startedByUserId),
      if (!endedByUserId.isAbsent)
        "endedByUserId": encodeRpcValue(endedByUserId),
      if (!startedBefore.isAbsent)
        "startedBefore": encodeRpcValue(startedBefore),
      if (!startedAfter.isAbsent) "startedAfter": encodeRpcValue(startedAfter),
      if (!endedBefore.isAbsent) "endedBefore": encodeRpcValue(endedBefore),
      if (!endedAfter.isAbsent) "endedAfter": encodeRpcValue(endedAfter),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
      if (!offset.isAbsent) "offset": encodeRpcValue(offset),
    };

  }

}

final class ToolsTrackingsListResultItem implements RpcValue {
  const ToolsTrackingsListResultItem({
    required this.id,
    required this.toolId,
    this.projectId,
    this.responsibleUserId,
    this.startedByUserId,
    this.endedByUserId,
    this.toolUsageCostPerDay,
    this.comment,
    required this.startedAt,
    this.endedAt,
    this.deadlineAt,
  });

  static const codec = RpcCodec<ToolsTrackingsListResultItem>(
    ToolsTrackingsListResultItem.fromWire,
  );

  final String id;
  final String toolId;
  final String? projectId;
  final String? responsibleUserId;
  final String? startedByUserId;
  final String? endedByUserId;
  final num? toolUsageCostPerDay;
  final String? comment;
  final DateTime startedAt;
  final DateTime? endedAt;
  final DateTime? deadlineAt;

  factory ToolsTrackingsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "toolId",
      "projectId",
      "responsibleUserId",
      "startedByUserId",
      "endedByUserId",
      "toolUsageCostPerDay",
      "comment",
      "startedAt",
      "endedAt",
      "deadlineAt",
    });

    return ToolsTrackingsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      toolId: rpcString.decode(readRpcField(object, "toolId")),
      projectId: rpcNullable(rpcString)
          .decode(readRpcField(object, "projectId")),
      responsibleUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "responsibleUserId")),
      startedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "startedByUserId")),
      endedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "endedByUserId")),
      toolUsageCostPerDay: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "toolUsageCostPerDay")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      startedAt: rpcDate.decode(readRpcField(object, "startedAt")),
      endedAt: rpcNullable(rpcDate).decode(readRpcField(object, "endedAt")),
      deadlineAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deadlineAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "toolId": encodeRpcValue(toolId),
      "projectId": encodeRpcValue(projectId),
      "responsibleUserId": encodeRpcValue(responsibleUserId),
      "startedByUserId": encodeRpcValue(startedByUserId),
      "endedByUserId": encodeRpcValue(endedByUserId),
      "toolUsageCostPerDay": encodeRpcValue(toolUsageCostPerDay),
      "comment": encodeRpcValue(comment),
      "startedAt": encodeRpcValue(startedAt),
      "endedAt": encodeRpcValue(endedAt),
      "deadlineAt": encodeRpcValue(deadlineAt),
    };

  }

}

final class ToolsTrackingsTransfersListRequest implements RpcValue {
  const ToolsTrackingsTransfersListRequest({
    this.toolId = const RpcOptional.absent(),
    this.status = const RpcOptional.absent(),
    this.createdByUserId = const RpcOptional.absent(),
    this.transferToUserId = const RpcOptional.absent(),
    this.projectId = const RpcOptional.absent(),
    this.limit = const RpcOptional.absent(),
    this.offset = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsTrackingsTransfersListRequest>(
    ToolsTrackingsTransfersListRequest.fromWire,
  );

  final RpcOptional<String?> toolId;
  final RpcOptional<ToolsTrackingsTransfersListRequestStatus?> status;
  final RpcOptional<String?> createdByUserId;
  final RpcOptional<String?> transferToUserId;
  final RpcOptional<String?> projectId;
  final RpcOptional<num> limit;
  final RpcOptional<num> offset;

  factory ToolsTrackingsTransfersListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "toolId",
      "status",
      "createdByUserId",
      "transferToUserId",
      "projectId",
      "limit",
      "offset",
    });

    return ToolsTrackingsTransfersListRequest(
      toolId: readRpcOptionalField(
        object,
        "toolId",
        rpcNullable(rpcString).decode,
      ),
      status: readRpcOptionalField(
        object,
        "status",
        rpcNullable(ToolsTrackingsTransfersListRequestStatus.codec).decode,
      ),
      createdByUserId: readRpcOptionalField(
        object,
        "createdByUserId",
        rpcNullable(rpcString).decode,
      ),
      transferToUserId: readRpcOptionalField(
        object,
        "transferToUserId",
        rpcNullable(rpcString).decode,
      ),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      limit: readRpcOptionalField(object, "limit", rpcNumber.decode),
      offset: readRpcOptionalField(object, "offset", rpcNumber.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!toolId.isAbsent) "toolId": encodeRpcValue(toolId),
      if (!status.isAbsent) "status": encodeRpcValue(status),
      if (!createdByUserId.isAbsent)
        "createdByUserId": encodeRpcValue(createdByUserId),
      if (!transferToUserId.isAbsent)
        "transferToUserId": encodeRpcValue(transferToUserId),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!limit.isAbsent) "limit": encodeRpcValue(limit),
      if (!offset.isAbsent) "offset": encodeRpcValue(offset),
    };

  }

}

final class ToolsTrackingsTransfersListResultItem implements RpcValue {
  const ToolsTrackingsTransfersListResultItem({
    required this.id,
    required this.toolTrackingId,
    required this.toolId,
    required this.transferToUserId,
    required this.createdByUserId,
    this.projectId,
    required this.status,
    this.notes,
    required this.createdAt,
    this.responsibleUserId,
    this.toolUsageCostPerDay,
  });

  static const codec = RpcCodec<ToolsTrackingsTransfersListResultItem>(
    ToolsTrackingsTransfersListResultItem.fromWire,
  );

  final String id;
  final String toolTrackingId;
  final String toolId;
  final String transferToUserId;
  final String createdByUserId;
  final String? projectId;
  final ToolsTrackingsTransfersListRequestStatus status;
  final String? notes;
  final DateTime createdAt;
  final String? responsibleUserId;
  final num? toolUsageCostPerDay;

  factory ToolsTrackingsTransfersListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "toolTrackingId",
      "toolId",
      "transferToUserId",
      "createdByUserId",
      "projectId",
      "status",
      "notes",
      "createdAt",
      "responsibleUserId",
      "toolUsageCostPerDay",
    });

    return ToolsTrackingsTransfersListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      toolTrackingId: rpcString.decode(readRpcField(object, "toolTrackingId")),
      toolId: rpcString.decode(readRpcField(object, "toolId")),
      transferToUserId: rpcString.decode(
        readRpcField(object, "transferToUserId"),
      ),
      createdByUserId: rpcString.decode(
        readRpcField(object, "createdByUserId"),
      ),
      projectId: rpcNullable(rpcString)
          .decode(readRpcField(object, "projectId")),
      status: ToolsTrackingsTransfersListRequestStatus.codec.decode(
        readRpcField(object, "status"),
      ),
      notes: rpcNullable(rpcString).decode(readRpcField(object, "notes")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      responsibleUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "responsibleUserId")),
      toolUsageCostPerDay: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "toolUsageCostPerDay")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "toolTrackingId": encodeRpcValue(toolTrackingId),
      "toolId": encodeRpcValue(toolId),
      "transferToUserId": encodeRpcValue(transferToUserId),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "projectId": encodeRpcValue(projectId),
      "status": encodeRpcValue(status),
      "notes": encodeRpcValue(notes),
      "createdAt": encodeRpcValue(createdAt),
      "responsibleUserId": encodeRpcValue(responsibleUserId),
      "toolUsageCostPerDay": encodeRpcValue(toolUsageCostPerDay),
    };

  }

}

final class UsersListRequest implements RpcValue {
  const UsersListRequest({
    this.search = const RpcOptional.absent(),
    this.deactivated = const RpcOptional.absent(),
    this.includeArchived = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<UsersListRequest>(UsersListRequest.fromWire);

  final RpcOptional<String?> search;
  final RpcOptional<bool?> deactivated;
  final RpcOptional<bool> includeArchived;

  factory UsersListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "search",
      "deactivated",
      "includeArchived",
    });

    return UsersListRequest(
      search: readRpcOptionalField(
        object,
        "search",
        rpcNullable(rpcString).decode,
      ),
      deactivated: readRpcOptionalField(
        object,
        "deactivated",
        rpcNullable(rpcBoolean).decode,
      ),
      includeArchived: readRpcOptionalField(
        object,
        "includeArchived",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!search.isAbsent) "search": encodeRpcValue(search),
      if (!deactivated.isAbsent) "deactivated": encodeRpcValue(deactivated),
      if (!includeArchived.isAbsent)
        "includeArchived": encodeRpcValue(includeArchived),
    };

  }

}

final class UsersRolesGetRequest implements RpcValue {
  const UsersRolesGetRequest({required this.userId});

  static const codec = RpcCodec<UsersRolesGetRequest>(
    UsersRolesGetRequest.fromWire,
  );

  final String userId;

  factory UsersRolesGetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"userId"});

    return UsersRolesGetRequest(
      userId: rpcString.decode(readRpcField(object, "userId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"userId": encodeRpcValue(userId)};
  }

}

enum UsersRolesGetResultItem implements RpcValue {
  admin(":admin"),
  llm(":llm"),
  viewUsers("view:users"),
  manageUsers("manage:users"),
  deleteUsers("delete:users"),
  viewProjects("view:projects"),
  manageProjects("manage:projects"),
  deleteProjects("delete:projects"),
  viewProjectDeployments("view:projectDeployments"),
  manageProjectDeployments("manage:projectDeployments"),
  deleteProjectDeployments("delete:projectDeployments"),
  viewUserVacations("view:userVacations"),
  manageUserVacations("manage:userVacations"),
  deleteUserVacations("delete:userVacations"),
  viewTools("view:tools"),
  manageTools("manage:tools"),
  deleteTools("delete:tools"),
  viewToolTrackings("view:toolTrackings"),
  manageToolTrackings("manage:toolTrackings"),
  deleteToolTrackings("delete:toolTrackings"),
  viewToolInventories("view:toolInventories"),
  manageToolInventories("manage:toolInventories"),
  deleteToolInventories("delete:toolInventories"),
  viewProducts("view:products"),
  manageProducts("manage:products"),
  deleteProducts("delete:products"),
  viewDeliveryNotes("view:deliveryNotes"),
  manageDeliveryNotes("manage:deliveryNotes"),
  deleteDeliveryNotes("delete:deliveryNotes"),
  viewProductVendors("view:productVendors"),
  manageProductVendors("manage:productVendors"),
  deleteProductVendors("delete:productVendors"),
  viewProductPriceRecords("view:productPriceRecords"),
  manageProductPriceRecords("manage:productPriceRecords"),
  deleteProductPriceRecords("delete:productPriceRecords"),
  viewCustomers("view:customers"),
  manageCustomers("manage:customers"),
  deleteCustomers("delete:customers"),
  viewContacts("view:contacts"),
  manageContacts("manage:contacts"),
  deleteContacts("delete:contacts"),
  viewDailyProjectReports("view:dailyProjectReports"),
  manageDailyProjectReports("manage:dailyProjectReports"),
  deleteDailyProjectReports("delete:dailyProjectReports"),
  viewRegieReports("view:regieReports"),
  manageRegieReports("manage:regieReports"),
  deleteRegieReports("delete:regieReports"),
  viewClientScripts("view:clientScripts"),
  manageClientScripts("manage:clientScripts"),
  deleteClientScripts("delete:clientScripts");

  const UsersRolesGetResultItem(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<UsersRolesGetResultItem>(
    UsersRolesGetResultItem.fromWire,
  );

  factory UsersRolesGetResultItem.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class UsersSupervisorsGetDefaultResult implements RpcValue {
  const UsersSupervisorsGetDefaultResult({this.userId});

  static const codec = RpcCodec<UsersSupervisorsGetDefaultResult>(
    UsersSupervisorsGetDefaultResult.fromWire,
  );

  final String? userId;

  factory UsersSupervisorsGetDefaultResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"userId"});

    return UsersSupervisorsGetDefaultResult(
      userId: rpcNullable(rpcString).decode(readRpcField(object, "userId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"userId": encodeRpcValue(userId)};
  }

}

final class UsersVacationsListRequest implements RpcValue {
  const UsersVacationsListRequest({
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
    this.userId = const RpcOptional.absent(),
    this.includeDenied = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<UsersVacationsListRequest>(
    UsersVacationsListRequest.fromWire,
  );

  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;
  final RpcOptional<String?> userId;
  final RpcOptional<bool> includeDenied;

  factory UsersVacationsListRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "from",
      "to",
      "userId",
      "includeDenied",
    });

    return UsersVacationsListRequest(
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
      includeDenied: readRpcOptionalField(
        object,
        "includeDenied",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
      if (!includeDenied.isAbsent)
        "includeDenied": encodeRpcValue(includeDenied),
    };

  }

}

final class UsersVacationsListResultItem implements RpcValue {
  const UsersVacationsListResultItem({
    required this.id,
    required this.userId,
    required this.from,
    required this.to,
    required this.type,
    this.label,
    required this.status,
    this.note,
    this.denialReason,
    this.requestedByUserId,
    this.decidedByUserId,
    this.decidedAt,
    required this.createdAt,
    required this.modifiedAt,
    required this.canApprove,
    required this.canDeny,
    required this.canDelete,
    required this.vacationUsage,
  });

  static const codec = RpcCodec<UsersVacationsListResultItem>(
    UsersVacationsListResultItem.fromWire,
  );

  final String id;
  final String userId;
  final DateTime from;
  final DateTime to;
  final UsersVacationsListResultItemType type;
  final String? label;
  final UsersVacationsListResultItemStatus status;
  final String? note;
  final String? denialReason;
  final String? requestedByUserId;
  final String? decidedByUserId;
  final DateTime? decidedAt;
  final DateTime createdAt;
  final DateTime modifiedAt;
  final bool canApprove;
  final bool canDeny;
  final bool canDelete;
  final List<UsersVacationsListResultItemVacationUsageItem> vacationUsage;

  factory UsersVacationsListResultItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "userId",
      "from",
      "to",
      "type",
      "label",
      "status",
      "note",
      "denialReason",
      "requestedByUserId",
      "decidedByUserId",
      "decidedAt",
      "createdAt",
      "modifiedAt",
      "canApprove",
      "canDeny",
      "canDelete",
      "vacationUsage",
    });

    return UsersVacationsListResultItem(
      id: rpcString.decode(readRpcField(object, "id")),
      userId: rpcString.decode(readRpcField(object, "userId")),
      from: rpcDate.decode(readRpcField(object, "from")),
      to: rpcDate.decode(readRpcField(object, "to")),
      type: UsersVacationsListResultItemType.codec.decode(
        readRpcField(object, "type"),
      ),
      label: rpcNullable(rpcString).decode(readRpcField(object, "label")),
      status: UsersVacationsListResultItemStatus.codec.decode(
        readRpcField(object, "status"),
      ),
      note: rpcNullable(rpcString).decode(readRpcField(object, "note")),
      denialReason: rpcNullable(rpcString)
          .decode(readRpcField(object, "denialReason")),
      requestedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "requestedByUserId")),
      decidedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "decidedByUserId")),
      decidedAt: rpcNullable(rpcDate).decode(readRpcField(object, "decidedAt")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
      canApprove: rpcBoolean.decode(readRpcField(object, "canApprove")),
      canDeny: rpcBoolean.decode(readRpcField(object, "canDeny")),
      canDelete: rpcBoolean.decode(readRpcField(object, "canDelete")),
      vacationUsage: rpcArray(
        UsersVacationsListResultItemVacationUsageItem.codec,
      ).decode(readRpcField(object, "vacationUsage")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "userId": encodeRpcValue(userId),
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      "type": encodeRpcValue(type),
      "label": encodeRpcValue(label),
      "status": encodeRpcValue(status),
      "note": encodeRpcValue(note),
      "denialReason": encodeRpcValue(denialReason),
      "requestedByUserId": encodeRpcValue(requestedByUserId),
      "decidedByUserId": encodeRpcValue(decidedByUserId),
      "decidedAt": encodeRpcValue(decidedAt),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
      "canApprove": encodeRpcValue(canApprove),
      "canDeny": encodeRpcValue(canDeny),
      "canDelete": encodeRpcValue(canDelete),
      "vacationUsage": encodeRpcValue(vacationUsage),
    };

  }

}

final class AdminDatabasesBackupsCreateNowRequest implements RpcValue {
  const AdminDatabasesBackupsCreateNowRequest({
    required this.databaseId,
    this.kind = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesBackupsCreateNowRequest>(
    AdminDatabasesBackupsCreateNowRequest.fromWire,
  );

  final String databaseId;
  final RpcOptional<AdminDatabasesBackupsListResultItemKind> kind;

  factory AdminDatabasesBackupsCreateNowRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"databaseId", "kind"});

    return AdminDatabasesBackupsCreateNowRequest(
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
      kind: readRpcOptionalField(
        object,
        "kind",
        AdminDatabasesBackupsListResultItemKind.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "databaseId": encodeRpcValue(databaseId),
      if (!kind.isAbsent) "kind": encodeRpcValue(kind),
    };

  }

}

final class AdminDatabasesBackupsRestoreRequest implements RpcValue {
  const AdminDatabasesBackupsRestoreRequest({
    required this.backupId,
    this.targetDatabaseId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesBackupsRestoreRequest>(
    AdminDatabasesBackupsRestoreRequest.fromWire,
  );

  final String backupId;
  final RpcOptional<String?> targetDatabaseId;

  factory AdminDatabasesBackupsRestoreRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"backupId", "targetDatabaseId"});

    return AdminDatabasesBackupsRestoreRequest(
      backupId: rpcString.decode(readRpcField(object, "backupId")),
      targetDatabaseId: readRpcOptionalField(
        object,
        "targetDatabaseId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "backupId": encodeRpcValue(backupId),
      if (!targetDatabaseId.isAbsent)
        "targetDatabaseId": encodeRpcValue(targetDatabaseId),
    };

  }

}

final class AdminDatabasesBackupsRestoreResult implements RpcValue {
  const AdminDatabasesBackupsRestoreResult({
    required this.backupId,
    required this.targetDatabaseId,
  });

  static const codec = RpcCodec<AdminDatabasesBackupsRestoreResult>(
    AdminDatabasesBackupsRestoreResult.fromWire,
  );

  final String backupId;
  final String targetDatabaseId;

  factory AdminDatabasesBackupsRestoreResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"backupId", "targetDatabaseId"});

    return AdminDatabasesBackupsRestoreResult(
      backupId: rpcString.decode(readRpcField(object, "backupId")),
      targetDatabaseId: rpcString.decode(
        readRpcField(object, "targetDatabaseId"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "backupId": encodeRpcValue(backupId),
      "targetDatabaseId": encodeRpcValue(targetDatabaseId),
    };

  }

}

final class AdminDatabasesBackupsUploadRequest implements RpcValue {
  const AdminDatabasesBackupsUploadRequest({
    required this.databaseId,
    required this.fileName,
    required this.fileBase64,
  });

  static const codec = RpcCodec<AdminDatabasesBackupsUploadRequest>(
    AdminDatabasesBackupsUploadRequest.fromWire,
  );

  final String databaseId;
  final String fileName;
  final String fileBase64;

  factory AdminDatabasesBackupsUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "databaseId",
      "fileName",
      "fileBase64",
    });

    return AdminDatabasesBackupsUploadRequest(
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      fileBase64: rpcString.decode(readRpcField(object, "fileBase64")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "databaseId": encodeRpcValue(databaseId),
      "fileName": encodeRpcValue(fileName),
      "fileBase64": encodeRpcValue(fileBase64),
    };

  }

}

final class AdminDatabasesCreateRequest implements RpcValue {
  const AdminDatabasesCreateRequest({
    required this.hostId,
    required this.name,
    this.username = const RpcOptional.absent(),
    this.retentionDaily = const RpcOptional.absent(),
    this.retentionWeekly = const RpcOptional.absent(),
    this.retentionMonthly = const RpcOptional.absent(),
    this.retentionYearly = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesCreateRequest>(
    AdminDatabasesCreateRequest.fromWire,
  );

  final String hostId;
  final String name;
  final RpcOptional<String?> username;
  final RpcOptional<num> retentionDaily;
  final RpcOptional<num> retentionWeekly;
  final RpcOptional<num> retentionMonthly;
  final RpcOptional<num> retentionYearly;

  factory AdminDatabasesCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "hostId",
      "name",
      "username",
      "retentionDaily",
      "retentionWeekly",
      "retentionMonthly",
      "retentionYearly",
    });

    return AdminDatabasesCreateRequest(
      hostId: rpcString.decode(readRpcField(object, "hostId")),
      name: rpcString.decode(readRpcField(object, "name")),
      username: readRpcOptionalField(
        object,
        "username",
        rpcNullable(rpcString).decode,
      ),
      retentionDaily: readRpcOptionalField(
        object,
        "retentionDaily",
        rpcNumber.decode,
      ),
      retentionWeekly: readRpcOptionalField(
        object,
        "retentionWeekly",
        rpcNumber.decode,
      ),
      retentionMonthly: readRpcOptionalField(
        object,
        "retentionMonthly",
        rpcNumber.decode,
      ),
      retentionYearly: readRpcOptionalField(
        object,
        "retentionYearly",
        rpcNumber.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "hostId": encodeRpcValue(hostId),
      "name": encodeRpcValue(name),
      if (!username.isAbsent) "username": encodeRpcValue(username),
      if (!retentionDaily.isAbsent)
        "retentionDaily": encodeRpcValue(retentionDaily),
      if (!retentionWeekly.isAbsent)
        "retentionWeekly": encodeRpcValue(retentionWeekly),
      if (!retentionMonthly.isAbsent)
        "retentionMonthly": encodeRpcValue(retentionMonthly),
      if (!retentionYearly.isAbsent)
        "retentionYearly": encodeRpcValue(retentionYearly),
    };

  }

}

final class AdminDatabasesCreateResult implements RpcValue {
  const AdminDatabasesCreateResult({
    required this.id,
    required this.hostId,
    required this.name,
    required this.username,
    required this.password,
  });

  static const codec = RpcCodec<AdminDatabasesCreateResult>(
    AdminDatabasesCreateResult.fromWire,
  );

  final String id;
  final String hostId;
  final String name;
  final String username;
  final String password;

  factory AdminDatabasesCreateResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "hostId",
      "name",
      "username",
      "password",
    });

    return AdminDatabasesCreateResult(
      id: rpcString.decode(readRpcField(object, "id")),
      hostId: rpcString.decode(readRpcField(object, "hostId")),
      name: rpcString.decode(readRpcField(object, "name")),
      username: rpcString.decode(readRpcField(object, "username")),
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "hostId": encodeRpcValue(hostId),
      "name": encodeRpcValue(name),
      "username": encodeRpcValue(username),
      "password": encodeRpcValue(password),
    };

  }

}

final class AdminDatabasesForkFromBackupRequest implements RpcValue {
  const AdminDatabasesForkFromBackupRequest({
    required this.backupId,
    required this.name,
    this.hostId = const RpcOptional.absent(),
    this.username = const RpcOptional.absent(),
    this.retentionDaily = const RpcOptional.absent(),
    this.retentionWeekly = const RpcOptional.absent(),
    this.retentionMonthly = const RpcOptional.absent(),
    this.retentionYearly = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesForkFromBackupRequest>(
    AdminDatabasesForkFromBackupRequest.fromWire,
  );

  final String backupId;
  final String name;
  final RpcOptional<String?> hostId;
  final RpcOptional<String?> username;
  final RpcOptional<num?> retentionDaily;
  final RpcOptional<num?> retentionWeekly;
  final RpcOptional<num?> retentionMonthly;
  final RpcOptional<num?> retentionYearly;

  factory AdminDatabasesForkFromBackupRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "backupId",
      "name",
      "hostId",
      "username",
      "retentionDaily",
      "retentionWeekly",
      "retentionMonthly",
      "retentionYearly",
    });

    return AdminDatabasesForkFromBackupRequest(
      backupId: rpcString.decode(readRpcField(object, "backupId")),
      name: rpcString.decode(readRpcField(object, "name")),
      hostId: readRpcOptionalField(
        object,
        "hostId",
        rpcNullable(rpcString).decode,
      ),
      username: readRpcOptionalField(
        object,
        "username",
        rpcNullable(rpcString).decode,
      ),
      retentionDaily: readRpcOptionalField(
        object,
        "retentionDaily",
        rpcNullable(rpcNumber).decode,
      ),
      retentionWeekly: readRpcOptionalField(
        object,
        "retentionWeekly",
        rpcNullable(rpcNumber).decode,
      ),
      retentionMonthly: readRpcOptionalField(
        object,
        "retentionMonthly",
        rpcNullable(rpcNumber).decode,
      ),
      retentionYearly: readRpcOptionalField(
        object,
        "retentionYearly",
        rpcNullable(rpcNumber).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "backupId": encodeRpcValue(backupId),
      "name": encodeRpcValue(name),
      if (!hostId.isAbsent) "hostId": encodeRpcValue(hostId),
      if (!username.isAbsent) "username": encodeRpcValue(username),
      if (!retentionDaily.isAbsent)
        "retentionDaily": encodeRpcValue(retentionDaily),
      if (!retentionWeekly.isAbsent)
        "retentionWeekly": encodeRpcValue(retentionWeekly),
      if (!retentionMonthly.isAbsent)
        "retentionMonthly": encodeRpcValue(retentionMonthly),
      if (!retentionYearly.isAbsent)
        "retentionYearly": encodeRpcValue(retentionYearly),
    };

  }

}

final class AdminDatabasesForkFromBackupResult implements RpcValue {
  const AdminDatabasesForkFromBackupResult({
    required this.id,
    required this.hostId,
    required this.name,
    required this.username,
    required this.password,
    required this.restoredFromBackupId,
  });

  static const codec = RpcCodec<AdminDatabasesForkFromBackupResult>(
    AdminDatabasesForkFromBackupResult.fromWire,
  );

  final String id;
  final String hostId;
  final String name;
  final String username;
  final String password;
  final String restoredFromBackupId;

  factory AdminDatabasesForkFromBackupResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "hostId",
      "name",
      "username",
      "password",
      "restoredFromBackupId",
    });

    return AdminDatabasesForkFromBackupResult(
      id: rpcString.decode(readRpcField(object, "id")),
      hostId: rpcString.decode(readRpcField(object, "hostId")),
      name: rpcString.decode(readRpcField(object, "name")),
      username: rpcString.decode(readRpcField(object, "username")),
      password: rpcString.decode(readRpcField(object, "password")),
      restoredFromBackupId: rpcString.decode(
        readRpcField(object, "restoredFromBackupId"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "hostId": encodeRpcValue(hostId),
      "name": encodeRpcValue(name),
      "username": encodeRpcValue(username),
      "password": encodeRpcValue(password),
      "restoredFromBackupId": encodeRpcValue(restoredFromBackupId),
    };

  }

}

final class AdminDatabasesHostsCreateRequest implements RpcValue {
  const AdminDatabasesHostsCreateRequest({
    required this.name,
    required this.connectionDetails,
    this.backupDetails = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesHostsCreateRequest>(
    AdminDatabasesHostsCreateRequest.fromWire,
  );

  final String name;
  final AdminDatabasesHostsCreateRequestConnectionDetails connectionDetails;
  final RpcOptional<AdminDatabasesHostsCreateRequestBackupDetails>
  backupDetails;

  factory AdminDatabasesHostsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "connectionDetails",
      "backupDetails",
    });

    return AdminDatabasesHostsCreateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      connectionDetails: AdminDatabasesHostsCreateRequestConnectionDetails.codec
          .decode(readRpcField(object, "connectionDetails")),
      backupDetails: readRpcOptionalField(
        object,
        "backupDetails",
        AdminDatabasesHostsCreateRequestBackupDetails.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "connectionDetails": encodeRpcValue(connectionDetails),
      if (!backupDetails.isAbsent)
        "backupDetails": encodeRpcValue(backupDetails),
    };

  }

}

final class AdminDatabasesHostsDeleteRequest implements RpcValue {
  const AdminDatabasesHostsDeleteRequest({required this.hostId});

  static const codec = RpcCodec<AdminDatabasesHostsDeleteRequest>(
    AdminDatabasesHostsDeleteRequest.fromWire,
  );

  final String hostId;

  factory AdminDatabasesHostsDeleteRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"hostId"});

    return AdminDatabasesHostsDeleteRequest(
      hostId: rpcString.decode(readRpcField(object, "hostId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"hostId": encodeRpcValue(hostId)};
  }

}

final class AdminDatabasesHostsUpdateRequest implements RpcValue {
  const AdminDatabasesHostsUpdateRequest({
    required this.hostId,
    required this.data,
  });

  static const codec = RpcCodec<AdminDatabasesHostsUpdateRequest>(
    AdminDatabasesHostsUpdateRequest.fromWire,
  );

  final String hostId;
  final AdminDatabasesHostsUpdateRequestData data;

  factory AdminDatabasesHostsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"hostId", "data"});

    return AdminDatabasesHostsUpdateRequest(
      hostId: rpcString.decode(readRpcField(object, "hostId")),
      data: AdminDatabasesHostsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"hostId": encodeRpcValue(hostId), "data": encodeRpcValue(data)};
  }

}

final class AdminDatabasesRotateCredentialsRequest implements RpcValue {
  const AdminDatabasesRotateCredentialsRequest({required this.databaseId});

  static const codec = RpcCodec<AdminDatabasesRotateCredentialsRequest>(
    AdminDatabasesRotateCredentialsRequest.fromWire,
  );

  final String databaseId;

  factory AdminDatabasesRotateCredentialsRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"databaseId"});

    return AdminDatabasesRotateCredentialsRequest(
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"databaseId": encodeRpcValue(databaseId)};
  }

}

final class AdminDatabasesRotateCredentialsResult implements RpcValue {
  const AdminDatabasesRotateCredentialsResult({
    required this.id,
    required this.username,
    required this.password,
  });

  static const codec = RpcCodec<AdminDatabasesRotateCredentialsResult>(
    AdminDatabasesRotateCredentialsResult.fromWire,
  );

  final String id;
  final String username;
  final String password;

  factory AdminDatabasesRotateCredentialsResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "username", "password"});

    return AdminDatabasesRotateCredentialsResult(
      id: rpcString.decode(readRpcField(object, "id")),
      username: rpcString.decode(readRpcField(object, "username")),
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "username": encodeRpcValue(username),
      "password": encodeRpcValue(password),
    };

  }

}

final class AdminDatabasesUpdateRetentionRequest implements RpcValue {
  const AdminDatabasesUpdateRetentionRequest({
    required this.databaseId,
    required this.data,
  });

  static const codec = RpcCodec<AdminDatabasesUpdateRetentionRequest>(
    AdminDatabasesUpdateRetentionRequest.fromWire,
  );

  final String databaseId;
  final AdminDatabasesUpdateRetentionRequestData data;

  factory AdminDatabasesUpdateRetentionRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"databaseId", "data"});

    return AdminDatabasesUpdateRetentionRequest(
      databaseId: rpcString.decode(readRpcField(object, "databaseId")),
      data: AdminDatabasesUpdateRetentionRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "databaseId": encodeRpcValue(databaseId),
      "data": encodeRpcValue(data),
    };

  }

}

final class AdminDatabasesUpdateRetentionResult implements RpcValue {
  const AdminDatabasesUpdateRetentionResult({
    required this.id,
    required this.retentionDaily,
    required this.retentionWeekly,
    required this.retentionMonthly,
    required this.retentionYearly,
  });

  static const codec = RpcCodec<AdminDatabasesUpdateRetentionResult>(
    AdminDatabasesUpdateRetentionResult.fromWire,
  );

  final String id;
  final num retentionDaily;
  final num retentionWeekly;
  final num retentionMonthly;
  final num retentionYearly;

  factory AdminDatabasesUpdateRetentionResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "retentionDaily",
      "retentionWeekly",
      "retentionMonthly",
      "retentionYearly",
    });

    return AdminDatabasesUpdateRetentionResult(
      id: rpcString.decode(readRpcField(object, "id")),
      retentionDaily: rpcNumber.decode(readRpcField(object, "retentionDaily")),
      retentionWeekly: rpcNumber.decode(
        readRpcField(object, "retentionWeekly"),
      ),
      retentionMonthly: rpcNumber.decode(
        readRpcField(object, "retentionMonthly"),
      ),
      retentionYearly: rpcNumber.decode(
        readRpcField(object, "retentionYearly"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "retentionDaily": encodeRpcValue(retentionDaily),
      "retentionWeekly": encodeRpcValue(retentionWeekly),
      "retentionMonthly": encodeRpcValue(retentionMonthly),
      "retentionYearly": encodeRpcValue(retentionYearly),
    };

  }

}

final class AdminLlmProvidersUpdateRequest implements RpcValue {
  const AdminLlmProvidersUpdateRequest({
    required this.provider,
    this.baseUrl = const RpcOptional.absent(),
    this.apiKey = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminLlmProvidersUpdateRequest>(
    AdminLlmProvidersUpdateRequest.fromWire,
  );

  final ProviderName provider;
  final RpcOptional<String?> baseUrl;
  final RpcOptional<String?> apiKey;

  factory AdminLlmProvidersUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "provider",
      "baseUrl",
      "apiKey",
    });

    return AdminLlmProvidersUpdateRequest(
      provider: ProviderName.codec.decode(readRpcField(object, "provider")),
      baseUrl: readRpcOptionalField(
        object,
        "baseUrl",
        rpcNullable(rpcString).decode,
      ),
      apiKey: readRpcOptionalField(
        object,
        "apiKey",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "provider": encodeRpcValue(provider),
      if (!baseUrl.isAbsent) "baseUrl": encodeRpcValue(baseUrl),
      if (!apiKey.isAbsent) "apiKey": encodeRpcValue(apiKey),
    };

  }

}

final class AdminLlmScanSettingsUpdateRequest implements RpcValue {
  const AdminLlmScanSettingsUpdateRequest({
    required this.provider,
    required this.model,
    this.baseUrl = const RpcOptional.absent(),
    this.apiKey = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminLlmScanSettingsUpdateRequest>(
    AdminLlmScanSettingsUpdateRequest.fromWire,
  );

  final ProviderName provider;
  final String model;
  final RpcOptional<String?> baseUrl;
  final RpcOptional<String?> apiKey;

  factory AdminLlmScanSettingsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "provider",
      "model",
      "baseUrl",
      "apiKey",
    });

    return AdminLlmScanSettingsUpdateRequest(
      provider: ProviderName.codec.decode(readRpcField(object, "provider")),
      model: rpcString.decode(readRpcField(object, "model")),
      baseUrl: readRpcOptionalField(
        object,
        "baseUrl",
        rpcNullable(rpcString).decode,
      ),
      apiKey: readRpcOptionalField(
        object,
        "apiKey",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
      if (!baseUrl.isAbsent) "baseUrl": encodeRpcValue(baseUrl),
      if (!apiKey.isAbsent) "apiKey": encodeRpcValue(apiKey),
    };

  }

}

final class AdminLlmTenantsUpdateRequest implements RpcValue {
  const AdminLlmTenantsUpdateRequest({
    required this.name,
    required this.enabled,
    this.monthlyTokenQuota = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminLlmTenantsUpdateRequest>(
    AdminLlmTenantsUpdateRequest.fromWire,
  );

  final String name;
  final bool enabled;
  final RpcOptional<BigInt?> monthlyTokenQuota;

  factory AdminLlmTenantsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "enabled",
      "monthlyTokenQuota",
    });

    return AdminLlmTenantsUpdateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      monthlyTokenQuota: readRpcOptionalField(
        object,
        "monthlyTokenQuota",
        rpcNullable(rpcBigInt).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "enabled": encodeRpcValue(enabled),
      if (!monthlyTokenQuota.isAbsent)
        "monthlyTokenQuota": encodeRpcValue(monthlyTokenQuota),
    };

  }

}

final class AdminLlmUseCasesUpdateRequest implements RpcValue {
  const AdminLlmUseCasesUpdateRequest({
    required this.useCase,
    required this.provider,
    required this.model,
  });

  static const codec = RpcCodec<AdminLlmUseCasesUpdateRequest>(
    AdminLlmUseCasesUpdateRequest.fromWire,
  );

  final LlmUseCase useCase;
  final ProviderName provider;
  final String model;

  factory AdminLlmUseCasesUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"useCase", "provider", "model"});

    return AdminLlmUseCasesUpdateRequest(
      useCase: LlmUseCase.codec.decode(readRpcField(object, "useCase")),
      provider: ProviderName.codec.decode(readRpcField(object, "provider")),
      model: rpcString.decode(readRpcField(object, "model")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "useCase": encodeRpcValue(useCase),
      "provider": encodeRpcValue(provider),
      "model": encodeRpcValue(model),
    };

  }

}

final class AdminLoginRequest implements RpcValue {
  const AdminLoginRequest({
    required this.password,
    this.tenant = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminLoginRequest>(AdminLoginRequest.fromWire);

  final String password;
  final RpcOptional<String?> tenant;

  factory AdminLoginRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"password", "tenant"});

    return AdminLoginRequest(
      password: rpcString.decode(readRpcField(object, "password")),
      tenant: readRpcOptionalField(
        object,
        "tenant",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "password": encodeRpcValue(password),
      if (!tenant.isAbsent) "tenant": encodeRpcValue(tenant),
    };

  }

}

final class AdminLoginResult implements RpcValue {
  const AdminLoginResult({required this.token});

  static const codec = RpcCodec<AdminLoginResult>(AdminLoginResult.fromWire);

  final String token;

  factory AdminLoginResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"token"});

    return AdminLoginResult(
      token: rpcString.decode(readRpcField(object, "token")),
    );
  }

  @override
  JsonMap toWire() {
    return {"token": encodeRpcValue(token)};
  }

}

final class AdminTenantsCreateRequest implements RpcValue {
  const AdminTenantsCreateRequest({
    required this.name,
    required this.contactDetails,
    this.options = const RpcOptional.absent(),
    this.connectionDetails = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsCreateRequest>(
    AdminTenantsCreateRequest.fromWire,
  );

  final String name;
  final AdminTenantsGetResultContactDetails contactDetails;
  final RpcOptional<AdminTenantsGetResultOptions> options;
  final RpcOptional<AdminTenantsCreateRequestConnectionDetails>
  connectionDetails;

  factory AdminTenantsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "contact_details",
      "options",
      "connection_details",
    });

    return AdminTenantsCreateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      contactDetails: AdminTenantsGetResultContactDetails.codec.decode(
        readRpcField(object, "contact_details"),
      ),
      options: readRpcOptionalField(
        object,
        "options",
        AdminTenantsGetResultOptions.codec.decode,
      ),
      connectionDetails: readRpcOptionalField(
        object,
        "connection_details",
        AdminTenantsCreateRequestConnectionDetails.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "contact_details": encodeRpcValue(contactDetails),
      if (!options.isAbsent) "options": encodeRpcValue(options),
      if (!connectionDetails.isAbsent)
        "connection_details": encodeRpcValue(connectionDetails),
    };

  }

}

final class AdminTenantsCreateResult implements RpcValue {
  const AdminTenantsCreateResult({required this.adminPassword});

  static const codec = RpcCodec<AdminTenantsCreateResult>(
    AdminTenantsCreateResult.fromWire,
  );

  final String adminPassword;

  factory AdminTenantsCreateResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"adminPassword"});

    return AdminTenantsCreateResult(
      adminPassword: rpcString.decode(readRpcField(object, "adminPassword")),
    );
  }

  @override
  JsonMap toWire() {
    return {"adminPassword": encodeRpcValue(adminPassword)};
  }

}

final class AdminTenantsUpdateRequest implements RpcValue {
  const AdminTenantsUpdateRequest({required this.name, required this.data});

  static const codec = RpcCodec<AdminTenantsUpdateRequest>(
    AdminTenantsUpdateRequest.fromWire,
  );

  final String name;
  final AdminTenantsUpdateRequestData data;

  factory AdminTenantsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"name", "data"});

    return AdminTenantsUpdateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      data: AdminTenantsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"name": encodeRpcValue(name), "data": encodeRpcValue(data)};
  }

}

final class AdminUsersCreateRequest implements RpcValue {
  const AdminUsersCreateRequest({
    required this.tenant,
    required this.username,
    required this.firstName,
    this.lastName = const RpcOptional.absent(),
    this.email = const RpcOptional.absent(),
    this.phone = const RpcOptional.absent(),
    this.salutation = const RpcOptional.absent(),
    this.contractType = const RpcOptional.absent(),
    this.password = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminUsersCreateRequest>(
    AdminUsersCreateRequest.fromWire,
  );

  final String tenant;
  final String username;
  final String firstName;
  final RpcOptional<String?> lastName;
  final RpcOptional<String?> email;
  final RpcOptional<String?> phone;
  final RpcOptional<String?> salutation;
  final RpcOptional<UserContractType?> contractType;
  final RpcOptional<String?> password;

  factory AdminUsersCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "tenant",
      "username",
      "firstName",
      "lastName",
      "email",
      "phone",
      "salutation",
      "contractType",
      "password",
    });

    return AdminUsersCreateRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      username: rpcString.decode(readRpcField(object, "username")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: readRpcOptionalField(
        object,
        "lastName",
        rpcNullable(rpcString).decode,
      ),
      email: readRpcOptionalField(
        object,
        "email",
        rpcNullable(rpcString).decode,
      ),
      phone: readRpcOptionalField(
        object,
        "phone",
        rpcNullable(rpcString).decode,
      ),
      salutation: readRpcOptionalField(
        object,
        "salutation",
        rpcNullable(rpcString).decode,
      ),
      contractType: readRpcOptionalField(
        object,
        "contractType",
        rpcNullable(UserContractType.codec).decode,
      ),
      password: readRpcOptionalField(
        object,
        "password",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "username": encodeRpcValue(username),
      "firstName": encodeRpcValue(firstName),
      if (!lastName.isAbsent) "lastName": encodeRpcValue(lastName),
      if (!email.isAbsent) "email": encodeRpcValue(email),
      if (!phone.isAbsent) "phone": encodeRpcValue(phone),
      if (!salutation.isAbsent) "salutation": encodeRpcValue(salutation),
      if (!contractType.isAbsent) "contractType": encodeRpcValue(contractType),
      if (!password.isAbsent) "password": encodeRpcValue(password),
    };

  }

}

final class AdminUsersCreateResult implements RpcValue {
  const AdminUsersCreateResult({required this.userId, required this.password});

  static const codec = RpcCodec<AdminUsersCreateResult>(
    AdminUsersCreateResult.fromWire,
  );

  final String userId;
  final String password;

  factory AdminUsersCreateResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"userId", "password"});

    return AdminUsersCreateResult(
      userId: rpcString.decode(readRpcField(object, "userId")),
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "userId": encodeRpcValue(userId),
      "password": encodeRpcValue(password),
    };

  }

}

final class AdminUsersResetPasswordRequest implements RpcValue {
  const AdminUsersResetPasswordRequest({
    required this.tenant,
    required this.userId,
    this.password = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminUsersResetPasswordRequest>(
    AdminUsersResetPasswordRequest.fromWire,
  );

  final String tenant;
  final String userId;
  final RpcOptional<String?> password;

  factory AdminUsersResetPasswordRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"tenant", "userId", "password"});

    return AdminUsersResetPasswordRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      userId: rpcString.decode(readRpcField(object, "userId")),
      password: readRpcOptionalField(
        object,
        "password",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "userId": encodeRpcValue(userId),
      if (!password.isAbsent) "password": encodeRpcValue(password),
    };

  }

}

final class AdminUsersResetPasswordResult implements RpcValue {
  const AdminUsersResetPasswordResult({required this.password});

  static const codec = RpcCodec<AdminUsersResetPasswordResult>(
    AdminUsersResetPasswordResult.fromWire,
  );

  final String password;

  factory AdminUsersResetPasswordResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"password"});

    return AdminUsersResetPasswordResult(
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {"password": encodeRpcValue(password)};
  }

}

final class AdminUsersSetAdminRequest implements RpcValue {
  const AdminUsersSetAdminRequest({
    required this.tenant,
    required this.userId,
    required this.admin,
  });

  static const codec = RpcCodec<AdminUsersSetAdminRequest>(
    AdminUsersSetAdminRequest.fromWire,
  );

  final String tenant;
  final String userId;
  final bool admin;

  factory AdminUsersSetAdminRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"tenant", "userId", "admin"});

    return AdminUsersSetAdminRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      userId: rpcString.decode(readRpcField(object, "userId")),
      admin: rpcBoolean.decode(readRpcField(object, "admin")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "userId": encodeRpcValue(userId),
      "admin": encodeRpcValue(admin),
    };

  }

}

final class AuthLoginRequest implements RpcValue {
  const AuthLoginRequest({
    required this.tenant,
    required this.username,
    required this.password,
  });

  static const codec = RpcCodec<AuthLoginRequest>(AuthLoginRequest.fromWire);

  final String tenant;
  final String username;
  final String password;

  factory AuthLoginRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "tenant",
      "username",
      "password",
    });

    return AuthLoginRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      username: rpcString.decode(readRpcField(object, "username")),
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "username": encodeRpcValue(username),
      "password": encodeRpcValue(password),
    };

  }

}

final class AuthPasskeysLoginRequest implements RpcValue {
  const AuthPasskeysLoginRequest({
    required this.challengeToken,
    required this.credential,
  });

  static const codec = RpcCodec<AuthPasskeysLoginRequest>(
    AuthPasskeysLoginRequest.fromWire,
  );

  final String challengeToken;
  final AuthPasskeysLoginRequestCredential credential;

  factory AuthPasskeysLoginRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"challengeToken", "credential"});

    return AuthPasskeysLoginRequest(
      challengeToken: rpcString.decode(readRpcField(object, "challengeToken")),
      credential: AuthPasskeysLoginRequestCredential.codec.decode(
        readRpcField(object, "credential"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challengeToken": encodeRpcValue(challengeToken),
      "credential": encodeRpcValue(credential),
    };

  }

}

final class AuthPasskeysLoginOptionsRequest implements RpcValue {
  const AuthPasskeysLoginOptionsRequest({
    required this.tenant,
    required this.username,
  });

  static const codec = RpcCodec<AuthPasskeysLoginOptionsRequest>(
    AuthPasskeysLoginOptionsRequest.fromWire,
  );

  final String tenant;
  final String username;

  factory AuthPasskeysLoginOptionsRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"tenant", "username"});

    return AuthPasskeysLoginOptionsRequest(
      tenant: rpcString.decode(readRpcField(object, "tenant")),
      username: rpcString.decode(readRpcField(object, "username")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "tenant": encodeRpcValue(tenant),
      "username": encodeRpcValue(username),
    };

  }

}

final class AuthPasskeysLoginOptionsResult implements RpcValue {
  const AuthPasskeysLoginOptionsResult({
    required this.challengeToken,
    required this.options,
  });

  static const codec = RpcCodec<AuthPasskeysLoginOptionsResult>(
    AuthPasskeysLoginOptionsResult.fromWire,
  );

  final String challengeToken;
  final AuthPasskeysLoginOptionsResultOptions options;

  factory AuthPasskeysLoginOptionsResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"challengeToken", "options"});

    return AuthPasskeysLoginOptionsResult(
      challengeToken: rpcString.decode(readRpcField(object, "challengeToken")),
      options: AuthPasskeysLoginOptionsResultOptions.codec.decode(
        readRpcField(object, "options"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challengeToken": encodeRpcValue(challengeToken),
      "options": encodeRpcValue(options),
    };

  }

}

final class AuthPasskeysRegisterRequest implements RpcValue {
  const AuthPasskeysRegisterRequest({
    required this.challengeToken,
    required this.label,
    required this.credential,
  });

  static const codec = RpcCodec<AuthPasskeysRegisterRequest>(
    AuthPasskeysRegisterRequest.fromWire,
  );

  final String challengeToken;
  final String label;
  final AuthPasskeysRegisterRequestCredential credential;

  factory AuthPasskeysRegisterRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "challengeToken",
      "label",
      "credential",
    });

    return AuthPasskeysRegisterRequest(
      challengeToken: rpcString.decode(readRpcField(object, "challengeToken")),
      label: rpcString.decode(readRpcField(object, "label")),
      credential: AuthPasskeysRegisterRequestCredential.codec.decode(
        readRpcField(object, "credential"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challengeToken": encodeRpcValue(challengeToken),
      "label": encodeRpcValue(label),
      "credential": encodeRpcValue(credential),
    };

  }

}

final class AuthPasskeysRegisterOptionsResult implements RpcValue {
  const AuthPasskeysRegisterOptionsResult({
    required this.challengeToken,
    required this.options,
  });

  static const codec = RpcCodec<AuthPasskeysRegisterOptionsResult>(
    AuthPasskeysRegisterOptionsResult.fromWire,
  );

  final String challengeToken;
  final AuthPasskeysRegisterOptionsResultOptions options;

  factory AuthPasskeysRegisterOptionsResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"challengeToken", "options"});

    return AuthPasskeysRegisterOptionsResult(
      challengeToken: rpcString.decode(readRpcField(object, "challengeToken")),
      options: AuthPasskeysRegisterOptionsResultOptions.codec.decode(
        readRpcField(object, "options"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challengeToken": encodeRpcValue(challengeToken),
      "options": encodeRpcValue(options),
    };

  }

}

final class AuthSetPasswordRequest implements RpcValue {
  const AuthSetPasswordRequest({
    required this.username,
    required this.password,
  });

  static const codec = RpcCodec<AuthSetPasswordRequest>(
    AuthSetPasswordRequest.fromWire,
  );

  final String username;
  final String password;

  factory AuthSetPasswordRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"username", "password"});

    return AuthSetPasswordRequest(
      username: rpcString.decode(readRpcField(object, "username")),
      password: rpcString.decode(readRpcField(object, "password")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "username": encodeRpcValue(username),
      "password": encodeRpcValue(password),
    };

  }

}

final class ClientScriptsCreateRequest implements RpcValue {
  const ClientScriptsCreateRequest({
    required this.name,
    required this.code,
    this.description = const RpcOptional.absent(),
    this.enabled = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ClientScriptsCreateRequest>(
    ClientScriptsCreateRequest.fromWire,
  );

  final String name;
  final String code;
  final RpcOptional<String?> description;
  final RpcOptional<bool> enabled;

  factory ClientScriptsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "code",
      "description",
      "enabled",
    });

    return ClientScriptsCreateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      code: rpcString.decode(readRpcField(object, "code")),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
      enabled: readRpcOptionalField(object, "enabled", rpcBoolean.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "code": encodeRpcValue(code),
      if (!description.isAbsent) "description": encodeRpcValue(description),
      if (!enabled.isAbsent) "enabled": encodeRpcValue(enabled),
    };

  }

}

final class ClientScriptsUpdateRequest implements RpcValue {
  const ClientScriptsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ClientScriptsUpdateRequest>(
    ClientScriptsUpdateRequest.fromWire,
  );

  final String id;
  final ClientScriptsUpdateRequestData data;

  factory ClientScriptsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ClientScriptsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ClientScriptsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ContactsCreateRequest implements RpcValue {
  const ContactsCreateRequest({
    this.salutation = const RpcOptional.absent(),
    this.firstName = const RpcOptional.absent(),
    this.lastName = const RpcOptional.absent(),
    this.address = const RpcOptional.absent(),
    this.phoneNumbers = const RpcOptional.absent(),
    this.emailAddresses = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ContactsCreateRequest>(
    ContactsCreateRequest.fromWire,
  );

  final RpcOptional<String?> salutation;
  final RpcOptional<String?> firstName;
  final RpcOptional<String?> lastName;
  final RpcOptional<ProjectAddress?> address;
  final RpcOptional<List<CustomerPhoneNumbersItem>> phoneNumbers;
  final RpcOptional<List<CustomerEmailAddressesItem>> emailAddresses;

  factory ContactsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "salutation",
      "firstName",
      "lastName",
      "address",
      "phoneNumbers",
      "emailAddresses",
    });

    return ContactsCreateRequest(
      salutation: readRpcOptionalField(
        object,
        "salutation",
        rpcNullable(rpcString).decode,
      ),
      firstName: readRpcOptionalField(
        object,
        "firstName",
        rpcNullable(rpcString).decode,
      ),
      lastName: readRpcOptionalField(
        object,
        "lastName",
        rpcNullable(rpcString).decode,
      ),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(ProjectAddress.codec).decode,
      ),
      phoneNumbers: readRpcOptionalField(
        object,
        "phoneNumbers",
        rpcArray(CustomerPhoneNumbersItem.codec).decode,
      ),
      emailAddresses: readRpcOptionalField(
        object,
        "emailAddresses",
        rpcArray(CustomerEmailAddressesItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!salutation.isAbsent) "salutation": encodeRpcValue(salutation),
      if (!firstName.isAbsent) "firstName": encodeRpcValue(firstName),
      if (!lastName.isAbsent) "lastName": encodeRpcValue(lastName),
      if (!address.isAbsent) "address": encodeRpcValue(address),
      if (!phoneNumbers.isAbsent) "phoneNumbers": encodeRpcValue(phoneNumbers),
      if (!emailAddresses.isAbsent)
        "emailAddresses": encodeRpcValue(emailAddresses),
    };

  }

}

final class ContactsUpdateRequest implements RpcValue {
  const ContactsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ContactsUpdateRequest>(
    ContactsUpdateRequest.fromWire,
  );

  final String id;
  final ContactsCreateRequest data;

  factory ContactsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ContactsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ContactsCreateRequest.codec.decode(readRpcField(object, "data")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class CustomersContactsAddRequest implements RpcValue {
  const CustomersContactsAddRequest({
    required this.customerId,
    required this.contactId,
  });

  static const codec = RpcCodec<CustomersContactsAddRequest>(
    CustomersContactsAddRequest.fromWire,
  );

  final String customerId;
  final String contactId;

  factory CustomersContactsAddRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"customerId", "contactId"});

    return CustomersContactsAddRequest(
      customerId: rpcString.decode(readRpcField(object, "customerId")),
      contactId: rpcString.decode(readRpcField(object, "contactId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "customerId": encodeRpcValue(customerId),
      "contactId": encodeRpcValue(contactId),
    };

  }

}

final class CustomersContactsSetRequest implements RpcValue {
  const CustomersContactsSetRequest({
    required this.customerId,
    required this.contactIds,
  });

  static const codec = RpcCodec<CustomersContactsSetRequest>(
    CustomersContactsSetRequest.fromWire,
  );

  final String customerId;
  final List<String> contactIds;

  factory CustomersContactsSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"customerId", "contactIds"});

    return CustomersContactsSetRequest(
      customerId: rpcString.decode(readRpcField(object, "customerId")),
      contactIds: rpcArray(rpcString)
          .decode(readRpcField(object, "contactIds")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "customerId": encodeRpcValue(customerId),
      "contactIds": encodeRpcValue(contactIds),
    };

  }

}

final class CustomersCreateRequest implements RpcValue {
  const CustomersCreateRequest({
    required this.name,
    this.salutation = const RpcOptional.absent(),
    this.address = const RpcOptional.absent(),
    this.phoneNumbers = const RpcOptional.absent(),
    this.emailAddresses = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<CustomersCreateRequest>(
    CustomersCreateRequest.fromWire,
  );

  final String name;
  final RpcOptional<String?> salutation;
  final RpcOptional<ProjectAddress?> address;
  final RpcOptional<List<CustomerPhoneNumbersItem>> phoneNumbers;
  final RpcOptional<List<CustomerEmailAddressesItem>> emailAddresses;

  factory CustomersCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "salutation",
      "address",
      "phoneNumbers",
      "emailAddresses",
    });

    return CustomersCreateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      salutation: readRpcOptionalField(
        object,
        "salutation",
        rpcNullable(rpcString).decode,
      ),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(ProjectAddress.codec).decode,
      ),
      phoneNumbers: readRpcOptionalField(
        object,
        "phoneNumbers",
        rpcArray(CustomerPhoneNumbersItem.codec).decode,
      ),
      emailAddresses: readRpcOptionalField(
        object,
        "emailAddresses",
        rpcArray(CustomerEmailAddressesItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      if (!salutation.isAbsent) "salutation": encodeRpcValue(salutation),
      if (!address.isAbsent) "address": encodeRpcValue(address),
      if (!phoneNumbers.isAbsent) "phoneNumbers": encodeRpcValue(phoneNumbers),
      if (!emailAddresses.isAbsent)
        "emailAddresses": encodeRpcValue(emailAddresses),
    };

  }

}

final class CustomersUpdateRequest implements RpcValue {
  const CustomersUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<CustomersUpdateRequest>(
    CustomersUpdateRequest.fromWire,
  );

  final String id;
  final CustomersUpdateRequestData data;

  factory CustomersUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return CustomersUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: CustomersUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class DeliveryNotesCreateRequest implements RpcValue {
  const DeliveryNotesCreateRequest({
    required this.projectId,
    this.effectiveTimestamp = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
    this.records = const RpcOptional.absent(),
    this.specialRecords = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<DeliveryNotesCreateRequest>(
    DeliveryNotesCreateRequest.fromWire,
  );

  final String projectId;
  final RpcOptional<DateTime?> effectiveTimestamp;
  final RpcOptional<String?> comment;
  final RpcOptional<List<DeliveryNotesCreateRequestRecordsItem>> records;
  final RpcOptional<List<DeliveryNotesCreateRequestSpecialRecordsItem>>
  specialRecords;

  factory DeliveryNotesCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "effectiveTimestamp",
      "comment",
      "records",
      "specialRecords",
    });

    return DeliveryNotesCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      effectiveTimestamp: readRpcOptionalField(
        object,
        "effectiveTimestamp",
        rpcNullable(rpcDate).decode,
      ),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
      records: readRpcOptionalField(
        object,
        "records",
        rpcArray(DeliveryNotesCreateRequestRecordsItem.codec).decode,
      ),
      specialRecords: readRpcOptionalField(
        object,
        "specialRecords",
        rpcArray(DeliveryNotesCreateRequestSpecialRecordsItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      if (!effectiveTimestamp.isAbsent)
        "effectiveTimestamp": encodeRpcValue(effectiveTimestamp),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
      if (!records.isAbsent) "records": encodeRpcValue(records),
      if (!specialRecords.isAbsent)
        "specialRecords": encodeRpcValue(specialRecords),
    };

  }

}

final class DeliveryNotesScanCompleteResult implements RpcValue {
  const DeliveryNotesScanCompleteResult({
    required this.documentType,
    this.deliveryNote,
    this.priceList,
  });

  static const codec = RpcCodec<DeliveryNotesScanCompleteResult>(
    DeliveryNotesScanCompleteResult.fromWire,
  );

  final ScanDocumentType documentType;
  final DeliveryNoteScanResult? deliveryNote;
  final PriceListScanResult? priceList;

  factory DeliveryNotesScanCompleteResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "documentType",
      "deliveryNote",
      "priceList",
    });

    return DeliveryNotesScanCompleteResult(
      documentType: ScanDocumentType.codec.decode(
        readRpcField(object, "documentType"),
      ),
      deliveryNote: rpcNullable(DeliveryNoteScanResult.codec)
          .decode(readRpcField(object, "deliveryNote")),
      priceList: rpcNullable(PriceListScanResult.codec)
          .decode(readRpcField(object, "priceList")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "documentType": encodeRpcValue(documentType),
      "deliveryNote": encodeRpcValue(deliveryNote),
      "priceList": encodeRpcValue(priceList),
    };

  }

}

final class DeliveryNotesScanCreateUploadRequest implements RpcValue {
  const DeliveryNotesScanCreateUploadRequest({
    required this.fileName,
    required this.mimeType,
    required this.sizeBytes,
  });

  static const codec = RpcCodec<DeliveryNotesScanCreateUploadRequest>(
    DeliveryNotesScanCreateUploadRequest.fromWire,
  );

  final String fileName;
  final String mimeType;
  final num sizeBytes;

  factory DeliveryNotesScanCreateUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "fileName",
      "mimeType",
      "sizeBytes",
    });

    return DeliveryNotesScanCreateUploadRequest(
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      sizeBytes: rpcNumber.decode(readRpcField(object, "sizeBytes")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      "sizeBytes": encodeRpcValue(sizeBytes),
    };

  }

}

final class DeliveryNotesScanCreateUploadResult implements RpcValue {
  const DeliveryNotesScanCreateUploadResult({
    required this.objectKey,
    required this.uploadUrl,
    required this.expiresAt,
  });

  static const codec = RpcCodec<DeliveryNotesScanCreateUploadResult>(
    DeliveryNotesScanCreateUploadResult.fromWire,
  );

  final String objectKey;
  final String uploadUrl;
  final DateTime expiresAt;

  factory DeliveryNotesScanCreateUploadResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "objectKey",
      "uploadUrl",
      "expiresAt",
    });

    return DeliveryNotesScanCreateUploadResult(
      objectKey: rpcString.decode(readRpcField(object, "objectKey")),
      uploadUrl: rpcString.decode(readRpcField(object, "uploadUrl")),
      expiresAt: rpcDate.decode(readRpcField(object, "expiresAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "objectKey": encodeRpcValue(objectKey),
      "uploadUrl": encodeRpcValue(uploadUrl),
      "expiresAt": encodeRpcValue(expiresAt),
    };

  }

}

final class DeliveryNotesScanStartRequest implements RpcValue {
  const DeliveryNotesScanStartRequest({required this.documents});

  static const codec = RpcCodec<DeliveryNotesScanStartRequest>(
    DeliveryNotesScanStartRequest.fromWire,
  );

  final List<ParseScanInput> documents;

  factory DeliveryNotesScanStartRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"documents"});

    return DeliveryNotesScanStartRequest(
      documents: rpcArray(ParseScanInput.codec)
          .decode(readRpcField(object, "documents")),
    );
  }

  @override
  JsonMap toWire() {
    return {"documents": encodeRpcValue(documents)};
  }

}

final class DeliveryNotesUpdateRequest implements RpcValue {
  const DeliveryNotesUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<DeliveryNotesUpdateRequest>(
    DeliveryNotesUpdateRequest.fromWire,
  );

  final String id;
  final DeliveryNotesUpdateRequestData data;

  factory DeliveryNotesUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return DeliveryNotesUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: DeliveryNotesUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ErrorReportsReportRequest implements RpcValue {
  const ErrorReportsReportRequest({
    required this.source,
    required this.message,
    this.level = const RpcOptional.absent(),
    this.stack = const RpcOptional.absent(),
    this.path = const RpcOptional.absent(),
    this.componentStack = const RpcOptional.absent(),
    this.metadata = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ErrorReportsReportRequest>(
    ErrorReportsReportRequest.fromWire,
  );

  final String source;
  final String message;
  final RpcOptional<AdminErrorsListResultItemLevel> level;
  final RpcOptional<String?> stack;
  final RpcOptional<String?> path;
  final RpcOptional<String?> componentStack;
  final RpcOptional<AdminErrorsListResultItemMetadata?> metadata;

  factory ErrorReportsReportRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "source",
      "message",
      "level",
      "stack",
      "path",
      "componentStack",
      "metadata",
    });

    return ErrorReportsReportRequest(
      source: rpcString.decode(readRpcField(object, "source")),
      message: rpcString.decode(readRpcField(object, "message")),
      level: readRpcOptionalField(
        object,
        "level",
        AdminErrorsListResultItemLevel.codec.decode,
      ),
      stack: readRpcOptionalField(
        object,
        "stack",
        rpcNullable(rpcString).decode,
      ),
      path: readRpcOptionalField(object, "path", rpcNullable(rpcString).decode),
      componentStack: readRpcOptionalField(
        object,
        "componentStack",
        rpcNullable(rpcString).decode,
      ),
      metadata: readRpcOptionalField(
        object,
        "metadata",
        rpcNullable(AdminErrorsListResultItemMetadata.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "source": encodeRpcValue(source),
      "message": encodeRpcValue(message),
      if (!level.isAbsent) "level": encodeRpcValue(level),
      if (!stack.isAbsent) "stack": encodeRpcValue(stack),
      if (!path.isAbsent) "path": encodeRpcValue(path),
      if (!componentStack.isAbsent)
        "componentStack": encodeRpcValue(componentStack),
      if (!metadata.isAbsent) "metadata": encodeRpcValue(metadata),
    };

  }

}

final class LlmChatsCreateRequest implements RpcValue {
  const LlmChatsCreateRequest({this.title = const RpcOptional.absent()});

  static const codec = RpcCodec<LlmChatsCreateRequest>(
    LlmChatsCreateRequest.fromWire,
  );

  final RpcOptional<String?> title;

  factory LlmChatsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"title"});

    return LlmChatsCreateRequest(
      title: readRpcOptionalField(
        object,
        "title",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {if (!title.isAbsent) "title": encodeRpcValue(title)};
  }

}

final class LlmMessagesSendRequest implements RpcValue {
  const LlmMessagesSendRequest({
    required this.chatId,
    required this.content,
    this.locale = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<LlmMessagesSendRequest>(
    LlmMessagesSendRequest.fromWire,
  );

  final Id chatId;
  final String content;
  final RpcOptional<AssistantLocale> locale;

  factory LlmMessagesSendRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"chatId", "content", "locale"});

    return LlmMessagesSendRequest(
      chatId: rpcString.decode(readRpcField(object, "chatId")),
      content: rpcString.decode(readRpcField(object, "content")),
      locale: readRpcOptionalField(
        object,
        "locale",
        AssistantLocale.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "chatId": encodeRpcValue(chatId),
      "content": encodeRpcValue(content),
      if (!locale.isAbsent) "locale": encodeRpcValue(locale),
    };

  }

}

final class LlmProposalsReviewRequest implements RpcValue {
  const LlmProposalsReviewRequest({
    required this.proposalId,
    required this.decision,
    this.comment = const RpcOptional.absent(),
    this.executionResults = const RpcOptional.absent(),
    this.continueConversation = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<LlmProposalsReviewRequest>(
    LlmProposalsReviewRequest.fromWire,
  );

  final Id proposalId;
  final ProposalDecision decision;
  final RpcOptional<String?> comment;
  final RpcOptional<List<ProposalExecutionResult>?> executionResults;
  final RpcOptional<bool> continueConversation;

  factory LlmProposalsReviewRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "proposalId",
      "decision",
      "comment",
      "executionResults",
      "continueConversation",
    });

    return LlmProposalsReviewRequest(
      proposalId: rpcString.decode(readRpcField(object, "proposalId")),
      decision: ProposalDecision.codec.decode(readRpcField(object, "decision")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
      executionResults: readRpcOptionalField(
        object,
        "executionResults",
        rpcNullable(rpcArray(ProposalExecutionResult.codec)).decode,
      ),
      continueConversation: readRpcOptionalField(
        object,
        "continueConversation",
        rpcBoolean.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "proposalId": encodeRpcValue(proposalId),
      "decision": encodeRpcValue(decision),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
      if (!executionResults.isAbsent)
        "executionResults": encodeRpcValue(executionResults),
      if (!continueConversation.isAbsent)
        "continueConversation": encodeRpcValue(continueConversation),
    };

  }

}

final class OfficeExportsCreateUploadResult implements RpcValue {
  const OfficeExportsCreateUploadResult({
    required this.uploadUrl,
    required this.uploadMethod,
    required this.uploadHeaders,
    required this.expiresAt,
    required this.sessionToken,
  });

  static const codec = RpcCodec<OfficeExportsCreateUploadResult>(
    OfficeExportsCreateUploadResult.fromWire,
  );

  final String uploadUrl;
  final String uploadMethod;
  final OfficeExportsCreateUploadResultUploadHeaders uploadHeaders;
  final String expiresAt;
  final String sessionToken;

  factory OfficeExportsCreateUploadResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "uploadUrl",
      "uploadMethod",
      "uploadHeaders",
      "expiresAt",
      "sessionToken",
    });

    return OfficeExportsCreateUploadResult(
      uploadUrl: rpcString.decode(readRpcField(object, "uploadUrl")),
      uploadMethod: rpcString.decode(readRpcField(object, "uploadMethod")),
      uploadHeaders: OfficeExportsCreateUploadResultUploadHeaders.codec.decode(
        readRpcField(object, "uploadHeaders"),
      ),
      expiresAt: rpcString.decode(readRpcField(object, "expiresAt")),
      sessionToken: rpcString.decode(readRpcField(object, "sessionToken")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "uploadUrl": encodeRpcValue(uploadUrl),
      "uploadMethod": encodeRpcValue(uploadMethod),
      "uploadHeaders": encodeRpcValue(uploadHeaders),
      "expiresAt": encodeRpcValue(expiresAt),
      "sessionToken": encodeRpcValue(sessionToken),
    };

  }

}

final class PersonalizationActionsAppendRequest implements RpcValue {
  const PersonalizationActionsAppendRequest({
    required this.actionId,
    required this.label,
    this.href = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<PersonalizationActionsAppendRequest>(
    PersonalizationActionsAppendRequest.fromWire,
  );

  final String actionId;
  final String label;
  final RpcOptional<String?> href;

  factory PersonalizationActionsAppendRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"actionId", "label", "href"});

    return PersonalizationActionsAppendRequest(
      actionId: rpcString.decode(readRpcField(object, "actionId")),
      label: rpcString.decode(readRpcField(object, "label")),
      href: readRpcOptionalField(object, "href", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "actionId": encodeRpcValue(actionId),
      "label": encodeRpcValue(label),
      if (!href.isAbsent) "href": encodeRpcValue(href),
    };

  }

}

final class PersonalizationVisitsAppendRequest implements RpcValue {
  const PersonalizationVisitsAppendRequest({
    required this.path,
    this.title = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<PersonalizationVisitsAppendRequest>(
    PersonalizationVisitsAppendRequest.fromWire,
  );

  final String path;
  final RpcOptional<String?> title;

  factory PersonalizationVisitsAppendRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"path", "title"});

    return PersonalizationVisitsAppendRequest(
      path: rpcString.decode(readRpcField(object, "path")),
      title: readRpcOptionalField(
        object,
        "title",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "path": encodeRpcValue(path),
      if (!title.isAbsent) "title": encodeRpcValue(title),
    };

  }

}

final class ProductsCategoriesSetRequest implements RpcValue {
  const ProductsCategoriesSetRequest({
    required this.id,
    required this.categories,
  });

  static const codec = RpcCodec<ProductsCategoriesSetRequest>(
    ProductsCategoriesSetRequest.fromWire,
  );

  final String id;
  final List<String> categories;

  factory ProductsCategoriesSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "categories"});

    return ProductsCategoriesSetRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      categories: rpcArray(rpcString)
          .decode(readRpcField(object, "categories")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "categories": encodeRpcValue(categories)};
  }

}

final class ProductsCategoriesTagRequest implements RpcValue {
  const ProductsCategoriesTagRequest({
    required this.id,
    required this.category,
  });

  static const codec = RpcCodec<ProductsCategoriesTagRequest>(
    ProductsCategoriesTagRequest.fromWire,
  );

  final String id;
  final String category;

  factory ProductsCategoriesTagRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "category"});

    return ProductsCategoriesTagRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      category: rpcString.decode(readRpcField(object, "category")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "category": encodeRpcValue(category)};
  }

}

final class ProductsCreateRequest implements RpcValue {
  const ProductsCreateRequest({
    required this.customId,
    required this.name,
    required this.baseUnit,
    this.brand = const RpcOptional.absent(),
    this.description = const RpcOptional.absent(),
    this.regieReportName = const RpcOptional.absent(),
    this.otherUnits = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsCreateRequest>(
    ProductsCreateRequest.fromWire,
  );

  final num customId;
  final String name;
  final String baseUnit;
  final RpcOptional<String?> brand;
  final RpcOptional<String?> description;
  final RpcOptional<String?> regieReportName;
  final RpcOptional<ApplyPriceImportRowOtherUnits> otherUnits;

  factory ProductsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "customId",
      "name",
      "baseUnit",
      "brand",
      "description",
      "regieReportName",
      "otherUnits",
    });

    return ProductsCreateRequest(
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      name: rpcString.decode(readRpcField(object, "name")),
      baseUnit: rpcString.decode(readRpcField(object, "baseUnit")),
      brand: readRpcOptionalField(
        object,
        "brand",
        rpcNullable(rpcString).decode,
      ),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
      regieReportName: readRpcOptionalField(
        object,
        "regieReportName",
        rpcNullable(rpcString).decode,
      ),
      otherUnits: readRpcOptionalField(
        object,
        "otherUnits",
        ApplyPriceImportRowOtherUnits.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "customId": encodeRpcValue(customId),
      "name": encodeRpcValue(name),
      "baseUnit": encodeRpcValue(baseUnit),
      if (!brand.isAbsent) "brand": encodeRpcValue(brand),
      if (!description.isAbsent) "description": encodeRpcValue(description),
      if (!regieReportName.isAbsent)
        "regieReportName": encodeRpcValue(regieReportName),
      if (!otherUnits.isAbsent) "otherUnits": encodeRpcValue(otherUnits),
    };

  }

}

final class ProductsPriceImportsApplyRequest implements RpcValue {
  const ProductsPriceImportsApplyRequest({
    required this.vendorId,
    required this.effectiveAt,
    required this.isRealPurchase,
    required this.rows,
  });

  static const codec = RpcCodec<ProductsPriceImportsApplyRequest>(
    ProductsPriceImportsApplyRequest.fromWire,
  );

  final Id vendorId;
  final DateTime effectiveAt;
  final bool isRealPurchase;
  final List<ApplyPriceImportRow> rows;

  factory ProductsPriceImportsApplyRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "vendorId",
      "effectiveAt",
      "isRealPurchase",
      "rows",
    });

    return ProductsPriceImportsApplyRequest(
      vendorId: rpcString.decode(readRpcField(object, "vendorId")),
      effectiveAt: rpcDate.decode(readRpcField(object, "effectiveAt")),
      isRealPurchase: rpcBoolean.decode(readRpcField(object, "isRealPurchase")),
      rows: rpcArray(ApplyPriceImportRow.codec)
          .decode(readRpcField(object, "rows")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "vendorId": encodeRpcValue(vendorId),
      "effectiveAt": encodeRpcValue(effectiveAt),
      "isRealPurchase": encodeRpcValue(isRealPurchase),
      "rows": encodeRpcValue(rows),
    };

  }

}

final class ProductsPriceImportsApplyResult implements RpcValue {
  const ProductsPriceImportsApplyResult({
    required this.createdProducts,
    required this.createdPriceRecords,
  });

  static const codec = RpcCodec<ProductsPriceImportsApplyResult>(
    ProductsPriceImportsApplyResult.fromWire,
  );

  final num createdProducts;
  final num createdPriceRecords;

  factory ProductsPriceImportsApplyResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "createdProducts",
      "createdPriceRecords",
    });

    return ProductsPriceImportsApplyResult(
      createdProducts: rpcNumber.decode(
        readRpcField(object, "createdProducts"),
      ),
      createdPriceRecords: rpcNumber.decode(
        readRpcField(object, "createdPriceRecords"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "createdProducts": encodeRpcValue(createdProducts),
      "createdPriceRecords": encodeRpcValue(createdPriceRecords),
    };

  }

}

final class ProductsPriceRecordsCreateRequest implements RpcValue {
  const ProductsPriceRecordsCreateRequest({
    required this.productId,
    required this.pricePerBaseUnit,
    required this.timestamp,
    required this.isRealPurchase,
    this.vendorId = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsPriceRecordsCreateRequest>(
    ProductsPriceRecordsCreateRequest.fromWire,
  );

  final String productId;
  final num pricePerBaseUnit;
  final DateTime timestamp;
  final bool isRealPurchase;
  final RpcOptional<String?> vendorId;
  final RpcOptional<String?> comment;

  factory ProductsPriceRecordsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "pricePerBaseUnit",
      "timestamp",
      "isRealPurchase",
      "vendorId",
      "comment",
    });

    return ProductsPriceRecordsCreateRequest(
      productId: rpcString.decode(readRpcField(object, "productId")),
      pricePerBaseUnit: rpcNumber.decode(
        readRpcField(object, "pricePerBaseUnit"),
      ),
      timestamp: rpcDate.decode(readRpcField(object, "timestamp")),
      isRealPurchase: rpcBoolean.decode(readRpcField(object, "isRealPurchase")),
      vendorId: readRpcOptionalField(
        object,
        "vendorId",
        rpcNullable(rpcString).decode,
      ),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "productId": encodeRpcValue(productId),
      "pricePerBaseUnit": encodeRpcValue(pricePerBaseUnit),
      "timestamp": encodeRpcValue(timestamp),
      "isRealPurchase": encodeRpcValue(isRealPurchase),
      if (!vendorId.isAbsent) "vendorId": encodeRpcValue(vendorId),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ProductsPriceRecordsUpdateRequest implements RpcValue {
  const ProductsPriceRecordsUpdateRequest({
    required this.id,
    required this.data,
  });

  static const codec = RpcCodec<ProductsPriceRecordsUpdateRequest>(
    ProductsPriceRecordsUpdateRequest.fromWire,
  );

  final String id;
  final ProductsPriceRecordsUpdateRequestData data;

  factory ProductsPriceRecordsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProductsPriceRecordsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProductsPriceRecordsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ProductsUpdateRequest implements RpcValue {
  const ProductsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ProductsUpdateRequest>(
    ProductsUpdateRequest.fromWire,
  );

  final String id;
  final ProductsUpdateRequestData data;

  factory ProductsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProductsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProductsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ProductsVendorsCreateRequest implements RpcValue {
  const ProductsVendorsCreateRequest({
    required this.name,
    this.description = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsVendorsCreateRequest>(
    ProductsVendorsCreateRequest.fromWire,
  );

  final String name;
  final RpcOptional<String?> description;

  factory ProductsVendorsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"name", "description"});

    return ProductsVendorsCreateRequest(
      name: rpcString.decode(readRpcField(object, "name")),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      if (!description.isAbsent) "description": encodeRpcValue(description),
    };

  }

}

final class ProductsVendorsUpdateRequest implements RpcValue {
  const ProductsVendorsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ProductsVendorsUpdateRequest>(
    ProductsVendorsUpdateRequest.fromWire,
  );

  final String id;
  final ProductsVendorsUpdateRequestData data;

  factory ProductsVendorsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProductsVendorsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProductsVendorsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ProjectsContactsAddRequest implements RpcValue {
  const ProjectsContactsAddRequest({
    required this.projectId,
    required this.contactId,
    this.label = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsContactsAddRequest>(
    ProjectsContactsAddRequest.fromWire,
  );

  final String projectId;
  final String contactId;
  final RpcOptional<String?> label;

  factory ProjectsContactsAddRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "contactId",
      "label",
    });

    return ProjectsContactsAddRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      contactId: rpcString.decode(readRpcField(object, "contactId")),
      label: readRpcOptionalField(
        object,
        "label",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "contactId": encodeRpcValue(contactId),
      if (!label.isAbsent) "label": encodeRpcValue(label),
    };

  }

}

final class ProjectsContactsSetRequest implements RpcValue {
  const ProjectsContactsSetRequest({
    required this.projectId,
    required this.contacts,
  });

  static const codec = RpcCodec<ProjectsContactsSetRequest>(
    ProjectsContactsSetRequest.fromWire,
  );

  final String projectId;
  final List<ProjectsContactsSetRequestContactsItem> contacts;

  factory ProjectsContactsSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "contacts"});

    return ProjectsContactsSetRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      contacts: rpcArray(ProjectsContactsSetRequestContactsItem.codec)
          .decode(readRpcField(object, "contacts")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "contacts": encodeRpcValue(contacts),
    };

  }

}

final class ProjectsCostsEntriesCreateRequest implements RpcValue {
  const ProjectsCostsEntriesCreateRequest({
    required this.projectId,
    required this.type,
    required this.amount,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsCostsEntriesCreateRequest>(
    ProjectsCostsEntriesCreateRequest.fromWire,
  );

  final String projectId;
  final ProjectsCostsEntriesCreateRequestType type;
  final num amount;
  final RpcOptional<String?> comment;

  factory ProjectsCostsEntriesCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "type",
      "amount",
      "comment",
    });

    return ProjectsCostsEntriesCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      type: ProjectsCostsEntriesCreateRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "type": encodeRpcValue(type),
      "amount": encodeRpcValue(amount),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ProjectsCostsEntriesDeleteRequest implements RpcValue {
  const ProjectsCostsEntriesDeleteRequest({
    required this.projectId,
    required this.id,
  });

  static const codec = RpcCodec<ProjectsCostsEntriesDeleteRequest>(
    ProjectsCostsEntriesDeleteRequest.fromWire,
  );

  final String projectId;
  final String id;

  factory ProjectsCostsEntriesDeleteRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "id"});

    return ProjectsCostsEntriesDeleteRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      id: rpcString.decode(readRpcField(object, "id")),
    );
  }

  @override
  JsonMap toWire() {
    return {"projectId": encodeRpcValue(projectId), "id": encodeRpcValue(id)};
  }

}

final class ProjectsCostsEntriesUpdateRequest implements RpcValue {
  const ProjectsCostsEntriesUpdateRequest({
    required this.projectId,
    required this.id,
    required this.data,
  });

  static const codec = RpcCodec<ProjectsCostsEntriesUpdateRequest>(
    ProjectsCostsEntriesUpdateRequest.fromWire,
  );

  final String projectId;
  final String id;
  final ProjectsCostsEntriesUpdateRequestData data;

  factory ProjectsCostsEntriesUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "id", "data"});

    return ProjectsCostsEntriesUpdateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProjectsCostsEntriesUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "id": encodeRpcValue(id),
      "data": encodeRpcValue(data),
    };

  }

}

final class ProjectsCreateRequest implements RpcValue {
  const ProjectsCreateRequest({
    required this.title,
    this.address = const RpcOptional.absent(),
    this.customerId = const RpcOptional.absent(),
    this.responsibleProjectLeaderUserId = const RpcOptional.absent(),
    this.orderReceivedAt = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsCreateRequest>(
    ProjectsCreateRequest.fromWire,
  );

  final String title;
  final RpcOptional<ProjectAddress?> address;
  final RpcOptional<String?> customerId;
  final RpcOptional<String?> responsibleProjectLeaderUserId;
  final RpcOptional<DateTime?> orderReceivedAt;

  factory ProjectsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "title",
      "address",
      "customerId",
      "responsibleProjectLeaderUserId",
      "orderReceivedAt",
    });

    return ProjectsCreateRequest(
      title: rpcString.decode(readRpcField(object, "title")),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(ProjectAddress.codec).decode,
      ),
      customerId: readRpcOptionalField(
        object,
        "customerId",
        rpcNullable(rpcString).decode,
      ),
      responsibleProjectLeaderUserId: readRpcOptionalField(
        object,
        "responsibleProjectLeaderUserId",
        rpcNullable(rpcString).decode,
      ),
      orderReceivedAt: readRpcOptionalField(
        object,
        "orderReceivedAt",
        rpcNullable(rpcDate).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "title": encodeRpcValue(title),
      if (!address.isAbsent) "address": encodeRpcValue(address),
      if (!customerId.isAbsent) "customerId": encodeRpcValue(customerId),
      if (!responsibleProjectLeaderUserId.isAbsent)
        "responsibleProjectLeaderUserId": encodeRpcValue(
          responsibleProjectLeaderUserId,
        ),
      if (!orderReceivedAt.isAbsent)
        "orderReceivedAt": encodeRpcValue(orderReceivedAt),
    };

  }

}

final class ProjectsDailyReportsCreateRequest implements RpcValue {
  const ProjectsDailyReportsCreateRequest({
    required this.projectId,
    this.day,
    this.summary = const RpcOptional.absent(),
    this.weather = const RpcOptional.absent(),
    this.workHours = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsCreateRequest>(
    ProjectsDailyReportsCreateRequest.fromWire,
  );

  final String projectId;
  final Object? day;
  final RpcOptional<String?> summary;
  final RpcOptional<ProjectsDailyReportsGetResultWeather?> weather;
  final RpcOptional<List<ProjectsDailyReportsCreateRequestWorkHoursItem>>
  workHours;

  factory ProjectsDailyReportsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "day",
      "summary",
      "weather",
      "workHours",
    });

    return ProjectsDailyReportsCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcUnknown.decode(readRpcField(object, "day")),
      summary: readRpcOptionalField(
        object,
        "summary",
        rpcNullable(rpcString).decode,
      ),
      weather: readRpcOptionalField(
        object,
        "weather",
        rpcNullable(ProjectsDailyReportsGetResultWeather.codec).decode,
      ),
      workHours: readRpcOptionalField(
        object,
        "workHours",
        rpcArray(ProjectsDailyReportsCreateRequestWorkHoursItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      if (!summary.isAbsent) "summary": encodeRpcValue(summary),
      if (!weather.isAbsent) "weather": encodeRpcValue(weather),
      if (!workHours.isAbsent) "workHours": encodeRpcValue(workHours),
    };

  }

}

final class ProjectsDailyReportsPhotosAddRequest implements RpcValue {
  const ProjectsDailyReportsPhotosAddRequest({
    required this.projectId,
    this.day,
    required this.fileId,
  });

  static const codec = RpcCodec<ProjectsDailyReportsPhotosAddRequest>(
    ProjectsDailyReportsPhotosAddRequest.fromWire,
  );

  final String projectId;
  final Object? day;
  final String fileId;

  factory ProjectsDailyReportsPhotosAddRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "day", "fileId"});

    return ProjectsDailyReportsPhotosAddRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcUnknown.decode(readRpcField(object, "day")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      "fileId": encodeRpcValue(fileId),
    };

  }

}

final class ProjectsDailyReportsUpdateRequest implements RpcValue {
  const ProjectsDailyReportsUpdateRequest({
    required this.projectId,
    this.day,
    required this.data,
  });

  static const codec = RpcCodec<ProjectsDailyReportsUpdateRequest>(
    ProjectsDailyReportsUpdateRequest.fromWire,
  );

  final String projectId;
  final Object? day;
  final ProjectsDailyReportsUpdateRequestData data;

  factory ProjectsDailyReportsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "day", "data"});

    return ProjectsDailyReportsUpdateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcUnknown.decode(readRpcField(object, "day")),
      data: ProjectsDailyReportsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      "data": encodeRpcValue(data),
    };

  }

}

final class ProjectsDeploymentsCreateRequest implements RpcValue {
  const ProjectsDeploymentsCreateRequest({
    required this.projectId,
    required this.userId,
    this.from,
    this.to,
    this.note = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDeploymentsCreateRequest>(
    ProjectsDeploymentsCreateRequest.fromWire,
  );

  final String projectId;
  final String userId;
  final Object? from;
  final Object? to;
  final RpcOptional<String?> note;

  factory ProjectsDeploymentsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "userId",
      "from",
      "to",
      "note",
    });

    return ProjectsDeploymentsCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      userId: rpcString.decode(readRpcField(object, "userId")),
      from: rpcUnknown.decode(readRpcField(object, "from")),
      to: rpcUnknown.decode(readRpcField(object, "to")),
      note: readRpcOptionalField(object, "note", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "userId": encodeRpcValue(userId),
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      if (!note.isAbsent) "note": encodeRpcValue(note),
    };

  }

}

final class ProjectsDeploymentsUpdateRequest implements RpcValue {
  const ProjectsDeploymentsUpdateRequest({
    required this.id,
    required this.data,
  });

  static const codec = RpcCodec<ProjectsDeploymentsUpdateRequest>(
    ProjectsDeploymentsUpdateRequest.fromWire,
  );

  final String id;
  final ProjectsDeploymentsUpdateRequestData data;

  factory ProjectsDeploymentsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProjectsDeploymentsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProjectsDeploymentsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ProjectsFilesCompleteUploadRequest implements RpcValue {
  const ProjectsFilesCompleteUploadRequest({
    required this.projectId,
    required this.fileId,
    this.etag = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesCompleteUploadRequest>(
    ProjectsFilesCompleteUploadRequest.fromWire,
  );

  final String projectId;
  final String fileId;
  final RpcOptional<String?> etag;

  factory ProjectsFilesCompleteUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "fileId", "etag"});

    return ProjectsFilesCompleteUploadRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
      etag: readRpcOptionalField(object, "etag", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileId": encodeRpcValue(fileId),
      if (!etag.isAbsent) "etag": encodeRpcValue(etag),
    };

  }

}

final class ProjectsFilesCreateUploadRequest implements RpcValue {
  const ProjectsFilesCreateUploadRequest({
    required this.projectId,
    required this.fileName,
    required this.mimeType,
    this.folderId = const RpcOptional.absent(),
    this.sizeBytes = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesCreateUploadRequest>(
    ProjectsFilesCreateUploadRequest.fromWire,
  );

  final String projectId;
  final String fileName;
  final String mimeType;
  final RpcOptional<String?> folderId;
  final RpcOptional<num?> sizeBytes;

  factory ProjectsFilesCreateUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "fileName",
      "mimeType",
      "folderId",
      "sizeBytes",
    });

    return ProjectsFilesCreateUploadRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      folderId: readRpcOptionalField(
        object,
        "folderId",
        rpcNullable(rpcString).decode,
      ),
      sizeBytes: readRpcOptionalField(
        object,
        "sizeBytes",
        rpcNullable(rpcNumber).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      if (!folderId.isAbsent) "folderId": encodeRpcValue(folderId),
      if (!sizeBytes.isAbsent) "sizeBytes": encodeRpcValue(sizeBytes),
    };

  }

}

final class ProjectsFilesCreateUploadResult implements RpcValue {
  const ProjectsFilesCreateUploadResult({
    required this.fileId,
    required this.objectKey,
    required this.uploadUrl,
    required this.uploadMethod,
    required this.uploadHeaders,
    required this.expiresAt,
  });

  static const codec = RpcCodec<ProjectsFilesCreateUploadResult>(
    ProjectsFilesCreateUploadResult.fromWire,
  );

  final String fileId;
  final String objectKey;
  final String uploadUrl;
  final String uploadMethod;
  final OfficeExportsCreateUploadResultUploadHeaders uploadHeaders;
  final DateTime expiresAt;

  factory ProjectsFilesCreateUploadResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "fileId",
      "objectKey",
      "uploadUrl",
      "uploadMethod",
      "uploadHeaders",
      "expiresAt",
    });

    return ProjectsFilesCreateUploadResult(
      fileId: rpcString.decode(readRpcField(object, "fileId")),
      objectKey: rpcString.decode(readRpcField(object, "objectKey")),
      uploadUrl: rpcString.decode(readRpcField(object, "uploadUrl")),
      uploadMethod: rpcLiteral<String>("PUT")
          .decode(readRpcField(object, "uploadMethod")),
      uploadHeaders: OfficeExportsCreateUploadResultUploadHeaders.codec.decode(
        readRpcField(object, "uploadHeaders"),
      ),
      expiresAt: rpcDate.decode(readRpcField(object, "expiresAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "fileId": encodeRpcValue(fileId),
      "objectKey": encodeRpcValue(objectKey),
      "uploadUrl": encodeRpcValue(uploadUrl),
      "uploadMethod": encodeRpcValue(uploadMethod),
      "uploadHeaders": encodeRpcValue(uploadHeaders),
      "expiresAt": encodeRpcValue(expiresAt),
    };

  }

}

final class ProjectsFilesDeleteRequest implements RpcValue {
  const ProjectsFilesDeleteRequest({
    required this.projectId,
    required this.fileId,
  });

  static const codec = RpcCodec<ProjectsFilesDeleteRequest>(
    ProjectsFilesDeleteRequest.fromWire,
  );

  final String projectId;
  final String fileId;

  factory ProjectsFilesDeleteRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "fileId"});

    return ProjectsFilesDeleteRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileId": encodeRpcValue(fileId),
    };

  }

}

final class ProjectsFilesDrawioSaveRequest implements RpcValue {
  const ProjectsFilesDrawioSaveRequest({
    required this.projectId,
    required this.fileId,
    required this.version,
    required this.xml,
  });

  static const codec = RpcCodec<ProjectsFilesDrawioSaveRequest>(
    ProjectsFilesDrawioSaveRequest.fromWire,
  );

  final Id projectId;
  final Id fileId;
  final BigInt version;
  final String xml;

  factory ProjectsFilesDrawioSaveRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "fileId",
      "version",
      "xml",
    });

    return ProjectsFilesDrawioSaveRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
      version: rpcBigInt.decode(readRpcField(object, "version")),
      xml: rpcString.decode(readRpcField(object, "xml")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileId": encodeRpcValue(fileId),
      "version": encodeRpcValue(version),
      "xml": encodeRpcValue(xml),
    };

  }

}

final class ProjectsFilesDrawioSaveResult implements RpcValue {
  const ProjectsFilesDrawioSaveResult({
    required this.version,
    required this.savedAt,
  });

  static const codec = RpcCodec<ProjectsFilesDrawioSaveResult>(
    ProjectsFilesDrawioSaveResult.fromWire,
  );

  final BigInt version;
  final DateTime savedAt;

  factory ProjectsFilesDrawioSaveResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"version", "savedAt"});

    return ProjectsFilesDrawioSaveResult(
      version: rpcBigInt.decode(readRpcField(object, "version")),
      savedAt: rpcDate.decode(readRpcField(object, "savedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "version": encodeRpcValue(version),
      "savedAt": encodeRpcValue(savedAt),
    };

  }

}

final class ProjectsFilesFoldersCreateRequest implements RpcValue {
  const ProjectsFilesFoldersCreateRequest({
    required this.projectId,
    required this.name,
    this.parentFolderId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesFoldersCreateRequest>(
    ProjectsFilesFoldersCreateRequest.fromWire,
  );

  final Id projectId;
  final String name;
  final RpcOptional<Id?> parentFolderId;

  factory ProjectsFilesFoldersCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "name",
      "parentFolderId",
    });

    return ProjectsFilesFoldersCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      name: rpcString.decode(readRpcField(object, "name")),
      parentFolderId: readRpcOptionalField(
        object,
        "parentFolderId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "name": encodeRpcValue(name),
      if (!parentFolderId.isAbsent)
        "parentFolderId": encodeRpcValue(parentFolderId),
    };

  }

}

final class ProjectsFilesFoldersCreateResult implements RpcValue {
  const ProjectsFilesFoldersCreateResult({required this.id});

  static const codec = RpcCodec<ProjectsFilesFoldersCreateResult>(
    ProjectsFilesFoldersCreateResult.fromWire,
  );

  final Id id;

  factory ProjectsFilesFoldersCreateResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id"});

    return ProjectsFilesFoldersCreateResult(
      id: rpcString.decode(readRpcField(object, "id")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id)};
  }

}

final class ProjectsFilesFoldersDeleteRequest implements RpcValue {
  const ProjectsFilesFoldersDeleteRequest({
    required this.projectId,
    required this.folderId,
  });

  static const codec = RpcCodec<ProjectsFilesFoldersDeleteRequest>(
    ProjectsFilesFoldersDeleteRequest.fromWire,
  );

  final Id projectId;
  final Id folderId;

  factory ProjectsFilesFoldersDeleteRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"projectId", "folderId"});

    return ProjectsFilesFoldersDeleteRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      folderId: rpcString.decode(readRpcField(object, "folderId")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "folderId": encodeRpcValue(folderId),
    };

  }

}

final class ProjectsFilesFoldersMoveRequest implements RpcValue {
  const ProjectsFilesFoldersMoveRequest({
    required this.projectId,
    required this.folderId,
    this.parentFolderId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesFoldersMoveRequest>(
    ProjectsFilesFoldersMoveRequest.fromWire,
  );

  final Id projectId;
  final Id folderId;
  final RpcOptional<Id?> parentFolderId;

  factory ProjectsFilesFoldersMoveRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "folderId",
      "parentFolderId",
    });

    return ProjectsFilesFoldersMoveRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      folderId: rpcString.decode(readRpcField(object, "folderId")),
      parentFolderId: readRpcOptionalField(
        object,
        "parentFolderId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "folderId": encodeRpcValue(folderId),
      if (!parentFolderId.isAbsent)
        "parentFolderId": encodeRpcValue(parentFolderId),
    };

  }

}

final class ProjectsFilesFoldersRenameRequest implements RpcValue {
  const ProjectsFilesFoldersRenameRequest({
    required this.projectId,
    required this.folderId,
    required this.name,
  });

  static const codec = RpcCodec<ProjectsFilesFoldersRenameRequest>(
    ProjectsFilesFoldersRenameRequest.fromWire,
  );

  final Id projectId;
  final Id folderId;
  final String name;

  factory ProjectsFilesFoldersRenameRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "folderId",
      "name",
    });

    return ProjectsFilesFoldersRenameRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      folderId: rpcString.decode(readRpcField(object, "folderId")),
      name: rpcString.decode(readRpcField(object, "name")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "folderId": encodeRpcValue(folderId),
      "name": encodeRpcValue(name),
    };

  }

}

final class ProjectsFilesMoveRequest implements RpcValue {
  const ProjectsFilesMoveRequest({
    required this.projectId,
    required this.fileIds,
    this.folderId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsFilesMoveRequest>(
    ProjectsFilesMoveRequest.fromWire,
  );

  final Id projectId;
  final List<Id> fileIds;
  final RpcOptional<Id?> folderId;

  factory ProjectsFilesMoveRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "fileIds",
      "folderId",
    });

    return ProjectsFilesMoveRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileIds: rpcArray(rpcString).decode(readRpcField(object, "fileIds")),
      folderId: readRpcOptionalField(
        object,
        "folderId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileIds": encodeRpcValue(fileIds),
      if (!folderId.isAbsent) "folderId": encodeRpcValue(folderId),
    };

  }

}

final class ProjectsFilesRenameRequest implements RpcValue {
  const ProjectsFilesRenameRequest({
    required this.projectId,
    required this.fileId,
    required this.fileName,
  });

  static const codec = RpcCodec<ProjectsFilesRenameRequest>(
    ProjectsFilesRenameRequest.fromWire,
  );

  final Id projectId;
  final Id fileId;
  final String fileName;

  factory ProjectsFilesRenameRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "fileId",
      "fileName",
    });

    return ProjectsFilesRenameRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileId: rpcString.decode(readRpcField(object, "fileId")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "fileId": encodeRpcValue(fileId),
      "fileName": encodeRpcValue(fileName),
    };

  }

}

final class ProjectsUnavailabilityCreateRequest implements RpcValue {
  const ProjectsUnavailabilityCreateRequest({
    required this.projectId,
    this.from,
    this.to,
    required this.reason,
    this.note = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsUnavailabilityCreateRequest>(
    ProjectsUnavailabilityCreateRequest.fromWire,
  );

  final String projectId;
  final Object? from;
  final Object? to;
  final String reason;
  final RpcOptional<String?> note;

  factory ProjectsUnavailabilityCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "from",
      "to",
      "reason",
      "note",
    });

    return ProjectsUnavailabilityCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      from: rpcUnknown.decode(readRpcField(object, "from")),
      to: rpcUnknown.decode(readRpcField(object, "to")),
      reason: rpcString.decode(readRpcField(object, "reason")),
      note: readRpcOptionalField(object, "note", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      "reason": encodeRpcValue(reason),
      if (!note.isAbsent) "note": encodeRpcValue(note),
    };

  }

}

final class ProjectsUnavailabilityUpdateRequest implements RpcValue {
  const ProjectsUnavailabilityUpdateRequest({
    required this.id,
    required this.data,
  });

  static const codec = RpcCodec<ProjectsUnavailabilityUpdateRequest>(
    ProjectsUnavailabilityUpdateRequest.fromWire,
  );

  final String id;
  final ProjectsUnavailabilityUpdateRequestData data;

  factory ProjectsUnavailabilityUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProjectsUnavailabilityUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProjectsUnavailabilityUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ProjectsUpdateRequest implements RpcValue {
  const ProjectsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ProjectsUpdateRequest>(
    ProjectsUpdateRequest.fromWire,
  );

  final String id;
  final ProjectsUpdateRequestData data;

  factory ProjectsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ProjectsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ProjectsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class RegieReportsCreateRequest implements RpcValue {
  const RegieReportsCreateRequest({
    required this.projectId,
    required this.day,
    this.summary = const RpcOptional.absent(),
    this.products = const RpcOptional.absent(),
    this.specialRecords = const RpcOptional.absent(),
    this.workHours = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsCreateRequest>(
    RegieReportsCreateRequest.fromWire,
  );

  final String projectId;
  final String day;
  final RpcOptional<String?> summary;
  final RpcOptional<List<RegieReportsCreateRequestProductsItem>> products;
  final RpcOptional<List<RegieReportsCreateRequestSpecialRecordsItem>>
  specialRecords;
  final RpcOptional<List<RegieReportsCreateRequestWorkHoursItem>> workHours;

  factory RegieReportsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "day",
      "summary",
      "products",
      "specialRecords",
      "workHours",
    });

    return RegieReportsCreateRequest(
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      day: rpcString.decode(readRpcField(object, "day")),
      summary: readRpcOptionalField(
        object,
        "summary",
        rpcNullable(rpcString).decode,
      ),
      products: readRpcOptionalField(
        object,
        "products",
        rpcArray(RegieReportsCreateRequestProductsItem.codec).decode,
      ),
      specialRecords: readRpcOptionalField(
        object,
        "specialRecords",
        rpcArray(RegieReportsCreateRequestSpecialRecordsItem.codec).decode,
      ),
      workHours: readRpcOptionalField(
        object,
        "workHours",
        rpcArray(RegieReportsCreateRequestWorkHoursItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "projectId": encodeRpcValue(projectId),
      "day": encodeRpcValue(day),
      if (!summary.isAbsent) "summary": encodeRpcValue(summary),
      if (!products.isAbsent) "products": encodeRpcValue(products),
      if (!specialRecords.isAbsent)
        "specialRecords": encodeRpcValue(specialRecords),
      if (!workHours.isAbsent) "workHours": encodeRpcValue(workHours),
    };

  }

}

final class RegieReportsUpdateRequest implements RpcValue {
  const RegieReportsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<RegieReportsUpdateRequest>(
    RegieReportsUpdateRequest.fromWire,
  );

  final String id;
  final RegieReportsUpdateRequestData data;

  factory RegieReportsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return RegieReportsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: RegieReportsUpdateRequestData.codec.decode(
        readRpcField(object, "data"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class RemarksCreateRequest implements RpcValue {
  const RemarksCreateRequest({
    required this.resourceType,
    required this.resourceId,
    required this.body,
  });

  static const codec = RpcCodec<RemarksCreateRequest>(
    RemarksCreateRequest.fromWire,
  );

  final RemarksListRequestResourceType resourceType;
  final String resourceId;
  final String body;

  factory RemarksCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "resourceType",
      "resourceId",
      "body",
    });

    return RemarksCreateRequest(
      resourceType: RemarksListRequestResourceType.codec.decode(
        readRpcField(object, "resourceType"),
      ),
      resourceId: rpcString.decode(readRpcField(object, "resourceId")),
      body: rpcString.decode(readRpcField(object, "body")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "resourceType": encodeRpcValue(resourceType),
      "resourceId": encodeRpcValue(resourceId),
      "body": encodeRpcValue(body),
    };

  }

}

final class RemarksUpdateRequest implements RpcValue {
  const RemarksUpdateRequest({required this.id, required this.body});

  static const codec = RpcCodec<RemarksUpdateRequest>(
    RemarksUpdateRequest.fromWire,
  );

  final String id;
  final String body;

  factory RemarksUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "body"});

    return RemarksUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      body: rpcString.decode(readRpcField(object, "body")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "body": encodeRpcValue(body)};
  }

}

final class SettingsCostsDeleteRequest implements RpcValue {
  const SettingsCostsDeleteRequest({required this.type, this.effectiveAt});

  static const codec = RpcCodec<SettingsCostsDeleteRequest>(
    SettingsCostsDeleteRequest.fromWire,
  );

  final SettingsCostsDeleteRequestType type;
  final Object? effectiveAt;

  factory SettingsCostsDeleteRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"type", "effectiveAt"});

    return SettingsCostsDeleteRequest(
      type: SettingsCostsDeleteRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      effectiveAt: rpcUnknown.decode(readRpcField(object, "effectiveAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "type": encodeRpcValue(type),
      "effectiveAt": encodeRpcValue(effectiveAt),
    };

  }

}

final class SettingsCostsSetRequest implements RpcValue {
  const SettingsCostsSetRequest({
    required this.type,
    this.effectiveAt,
    required this.relativeFactor,
    required this.constant,
  });

  static const codec = RpcCodec<SettingsCostsSetRequest>(
    SettingsCostsSetRequest.fromWire,
  );

  final SettingsCostsDeleteRequestType type;
  final Object? effectiveAt;
  final num relativeFactor;
  final num constant;

  factory SettingsCostsSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "type",
      "effectiveAt",
      "relativeFactor",
      "constant",
    });

    return SettingsCostsSetRequest(
      type: SettingsCostsDeleteRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      effectiveAt: rpcUnknown.decode(readRpcField(object, "effectiveAt")),
      relativeFactor: rpcNumber.decode(readRpcField(object, "relativeFactor")),
      constant: rpcNumber.decode(readRpcField(object, "constant")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "type": encodeRpcValue(type),
      "effectiveAt": encodeRpcValue(effectiveAt),
      "relativeFactor": encodeRpcValue(relativeFactor),
      "constant": encodeRpcValue(constant),
    };

  }

}

final class SettingsCostsUpdateRequest implements RpcValue {
  const SettingsCostsUpdateRequest({
    this.productOverheadFactor = const RpcOptional.absent(),
    this.workHourOverheadFactor = const RpcOptional.absent(),
    this.specialRecordOverheadFactor = const RpcOptional.absent(),
    this.toolOverheadFactor = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<SettingsCostsUpdateRequest>(
    SettingsCostsUpdateRequest.fromWire,
  );

  final RpcOptional<num> productOverheadFactor;
  final RpcOptional<num> workHourOverheadFactor;
  final RpcOptional<num> specialRecordOverheadFactor;
  final RpcOptional<num> toolOverheadFactor;

  factory SettingsCostsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productOverheadFactor",
      "workHourOverheadFactor",
      "specialRecordOverheadFactor",
      "toolOverheadFactor",
    });

    return SettingsCostsUpdateRequest(
      productOverheadFactor: readRpcOptionalField(
        object,
        "productOverheadFactor",
        rpcNumber.decode,
      ),
      workHourOverheadFactor: readRpcOptionalField(
        object,
        "workHourOverheadFactor",
        rpcNumber.decode,
      ),
      specialRecordOverheadFactor: readRpcOptionalField(
        object,
        "specialRecordOverheadFactor",
        rpcNumber.decode,
      ),
      toolOverheadFactor: readRpcOptionalField(
        object,
        "toolOverheadFactor",
        rpcNumber.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!productOverheadFactor.isAbsent)
        "productOverheadFactor": encodeRpcValue(productOverheadFactor),
      if (!workHourOverheadFactor.isAbsent)
        "workHourOverheadFactor": encodeRpcValue(workHourOverheadFactor),
      if (!specialRecordOverheadFactor.isAbsent)
        "specialRecordOverheadFactor": encodeRpcValue(
          specialRecordOverheadFactor,
        ),
      if (!toolOverheadFactor.isAbsent)
        "toolOverheadFactor": encodeRpcValue(toolOverheadFactor),
    };

  }

}

final class SettingsLanguageSetRequest implements RpcValue {
  const SettingsLanguageSetRequest({required this.locale});

  static const codec = RpcCodec<SettingsLanguageSetRequest>(
    SettingsLanguageSetRequest.fromWire,
  );

  final AssistantLocale locale;

  factory SettingsLanguageSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"locale"});

    return SettingsLanguageSetRequest(
      locale: AssistantLocale.codec.decode(readRpcField(object, "locale")),
    );
  }

  @override
  JsonMap toWire() {
    return {"locale": encodeRpcValue(locale)};
  }

}

final class SettingsTenantLogoCompleteUploadRequest implements RpcValue {
  const SettingsTenantLogoCompleteUploadRequest({
    required this.generationId,
    this.etag = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<SettingsTenantLogoCompleteUploadRequest>(
    SettingsTenantLogoCompleteUploadRequest.fromWire,
  );

  final String generationId;
  final RpcOptional<String?> etag;

  factory SettingsTenantLogoCompleteUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"generationId", "etag"});

    return SettingsTenantLogoCompleteUploadRequest(
      generationId: rpcString.decode(readRpcField(object, "generationId")),
      etag: readRpcOptionalField(object, "etag", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "generationId": encodeRpcValue(generationId),
      if (!etag.isAbsent) "etag": encodeRpcValue(etag),
    };

  }

}

final class SettingsTenantLogoCreateUploadRequest implements RpcValue {
  const SettingsTenantLogoCreateUploadRequest({
    required this.fileName,
    required this.mimeType,
    this.sizeBytes = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<SettingsTenantLogoCreateUploadRequest>(
    SettingsTenantLogoCreateUploadRequest.fromWire,
  );

  final String fileName;
  final String mimeType;
  final RpcOptional<num?> sizeBytes;

  factory SettingsTenantLogoCreateUploadRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "fileName",
      "mimeType",
      "sizeBytes",
    });

    return SettingsTenantLogoCreateUploadRequest(
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      sizeBytes: readRpcOptionalField(
        object,
        "sizeBytes",
        rpcNullable(rpcNumber).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      if (!sizeBytes.isAbsent) "sizeBytes": encodeRpcValue(sizeBytes),
    };

  }

}

final class SettingsTenantLogoCreateUploadResult implements RpcValue {
  const SettingsTenantLogoCreateUploadResult({
    required this.generationId,
    required this.uploadUrl,
    required this.uploadMethod,
    required this.uploadHeaders,
    required this.expiresAt,
  });

  static const codec = RpcCodec<SettingsTenantLogoCreateUploadResult>(
    SettingsTenantLogoCreateUploadResult.fromWire,
  );

  final String generationId;
  final String uploadUrl;
  final String uploadMethod;
  final OfficeExportsCreateUploadResultUploadHeaders uploadHeaders;
  final DateTime expiresAt;

  factory SettingsTenantLogoCreateUploadResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "generationId",
      "uploadUrl",
      "uploadMethod",
      "uploadHeaders",
      "expiresAt",
    });

    return SettingsTenantLogoCreateUploadResult(
      generationId: rpcString.decode(readRpcField(object, "generationId")),
      uploadUrl: rpcString.decode(readRpcField(object, "uploadUrl")),
      uploadMethod: rpcLiteral<String>("PUT")
          .decode(readRpcField(object, "uploadMethod")),
      uploadHeaders: OfficeExportsCreateUploadResultUploadHeaders.codec.decode(
        readRpcField(object, "uploadHeaders"),
      ),
      expiresAt: rpcDate.decode(readRpcField(object, "expiresAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "generationId": encodeRpcValue(generationId),
      "uploadUrl": encodeRpcValue(uploadUrl),
      "uploadMethod": encodeRpcValue(uploadMethod),
      "uploadHeaders": encodeRpcValue(uploadHeaders),
      "expiresAt": encodeRpcValue(expiresAt),
    };

  }

}

final class SettingsTenantNameSetRequest implements RpcValue {
  const SettingsTenantNameSetRequest({required this.companyName});

  static const codec = RpcCodec<SettingsTenantNameSetRequest>(
    SettingsTenantNameSetRequest.fromWire,
  );

  final String companyName;

  factory SettingsTenantNameSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"companyName"});

    return SettingsTenantNameSetRequest(
      companyName: rpcString.decode(readRpcField(object, "companyName")),
    );
  }

  @override
  JsonMap toWire() {
    return {"companyName": encodeRpcValue(companyName)};
  }

}

final class ToolsCreateRequest implements RpcValue {
  const ToolsCreateRequest({
    required this.customId,
    required this.brand,
    required this.category,
    this.label = const RpcOptional.absent(),
    this.purchasePrice = const RpcOptional.absent(),
    this.usageCostPerDay = const RpcOptional.absent(),
    this.status = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsCreateRequest>(
    ToolsCreateRequest.fromWire,
  );

  final num customId;
  final String brand;
  final String category;
  final RpcOptional<String?> label;
  final RpcOptional<num?> purchasePrice;
  final RpcOptional<num?> usageCostPerDay;
  final RpcOptional<ToolStatus?> status;

  factory ToolsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "customId",
      "brand",
      "category",
      "label",
      "purchasePrice",
      "usageCostPerDay",
      "status",
    });

    return ToolsCreateRequest(
      customId: rpcNumber.decode(readRpcField(object, "customId")),
      brand: rpcString.decode(readRpcField(object, "brand")),
      category: rpcString.decode(readRpcField(object, "category")),
      label: readRpcOptionalField(
        object,
        "label",
        rpcNullable(rpcString).decode,
      ),
      purchasePrice: readRpcOptionalField(
        object,
        "purchasePrice",
        rpcNullable(rpcNumber).decode,
      ),
      usageCostPerDay: readRpcOptionalField(
        object,
        "usageCostPerDay",
        rpcNullable(rpcNumber).decode,
      ),
      status: readRpcOptionalField(
        object,
        "status",
        rpcNullable(ToolStatus.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "customId": encodeRpcValue(customId),
      "brand": encodeRpcValue(brand),
      "category": encodeRpcValue(category),
      if (!label.isAbsent) "label": encodeRpcValue(label),
      if (!purchasePrice.isAbsent)
        "purchasePrice": encodeRpcValue(purchasePrice),
      if (!usageCostPerDay.isAbsent)
        "usageCostPerDay": encodeRpcValue(usageCostPerDay),
      if (!status.isAbsent) "status": encodeRpcValue(status),
    };

  }

}

final class ToolsInventoriesCreateRequest implements RpcValue {
  const ToolsInventoriesCreateRequest({
    required this.toolId,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsInventoriesCreateRequest>(
    ToolsInventoriesCreateRequest.fromWire,
  );

  final String toolId;
  final RpcOptional<String?> comment;

  factory ToolsInventoriesCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"toolId", "comment"});

    return ToolsInventoriesCreateRequest(
      toolId: rpcString.decode(readRpcField(object, "toolId")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "toolId": encodeRpcValue(toolId),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ToolsTrackRequest implements RpcValue {
  const ToolsTrackRequest({required this.id, required this.data});

  static const codec = RpcCodec<ToolsTrackRequest>(ToolsTrackRequest.fromWire);

  final String id;
  final ToolsTrackRequestData data;

  factory ToolsTrackRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ToolsTrackRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ToolsTrackRequestData.codec.decode(readRpcField(object, "data")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class ToolsTrackResult implements RpcValue {
  const ToolsTrackResult({required this.trackingId});

  static const codec = RpcCodec<ToolsTrackResult>(ToolsTrackResult.fromWire);

  final String trackingId;

  factory ToolsTrackResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"trackingId"});

    return ToolsTrackResult(
      trackingId: rpcString.decode(readRpcField(object, "trackingId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"trackingId": encodeRpcValue(trackingId)};
  }

}

final class ToolsTrackingsTransfersAcceptRequest implements RpcValue {
  const ToolsTrackingsTransfersAcceptRequest({
    required this.id,
    this.projectId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsTrackingsTransfersAcceptRequest>(
    ToolsTrackingsTransfersAcceptRequest.fromWire,
  );

  final String id;
  final RpcOptional<String?> projectId;

  factory ToolsTrackingsTransfersAcceptRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "projectId"});

    return ToolsTrackingsTransfersAcceptRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
    };

  }

}

final class ToolsTrackingsTransfersRequestRequest implements RpcValue {
  const ToolsTrackingsTransfersRequestRequest({
    required this.toolTrackingId,
    this.transferToUserId = const RpcOptional.absent(),
    this.projectId = const RpcOptional.absent(),
    this.notes = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsTrackingsTransfersRequestRequest>(
    ToolsTrackingsTransfersRequestRequest.fromWire,
  );

  final String toolTrackingId;
  final RpcOptional<String?> transferToUserId;
  final RpcOptional<String?> projectId;
  final RpcOptional<String?> notes;

  factory ToolsTrackingsTransfersRequestRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "toolTrackingId",
      "transferToUserId",
      "projectId",
      "notes",
    });

    return ToolsTrackingsTransfersRequestRequest(
      toolTrackingId: rpcString.decode(readRpcField(object, "toolTrackingId")),
      transferToUserId: readRpcOptionalField(
        object,
        "transferToUserId",
        rpcNullable(rpcString).decode,
      ),
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      notes: readRpcOptionalField(
        object,
        "notes",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "toolTrackingId": encodeRpcValue(toolTrackingId),
      if (!transferToUserId.isAbsent)
        "transferToUserId": encodeRpcValue(transferToUserId),
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!notes.isAbsent) "notes": encodeRpcValue(notes),
    };

  }

}

final class ToolsUpdateRequest implements RpcValue {
  const ToolsUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<ToolsUpdateRequest>(
    ToolsUpdateRequest.fromWire,
  );

  final String id;
  final ToolsUpdateRequestData data;

  factory ToolsUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return ToolsUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: ToolsUpdateRequestData.codec.decode(readRpcField(object, "data")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class UsersCreateRequest implements RpcValue {
  const UsersCreateRequest({
    required this.username,
    required this.firstName,
    this.lastName = const RpcOptional.absent(),
    this.email = const RpcOptional.absent(),
    this.phone = const RpcOptional.absent(),
    this.contractType = const RpcOptional.absent(),
    this.costPerHour = const RpcOptional.absent(),
    this.vacationDaysPerYear = const RpcOptional.absent(),
    this.supervisorUserId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<UsersCreateRequest>(
    UsersCreateRequest.fromWire,
  );

  final String username;
  final String firstName;
  final RpcOptional<String?> lastName;
  final RpcOptional<String?> email;
  final RpcOptional<String?> phone;
  final RpcOptional<UserContractType> contractType;
  final RpcOptional<num?> costPerHour;
  final RpcOptional<num?> vacationDaysPerYear;
  final RpcOptional<String?> supervisorUserId;

  factory UsersCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "username",
      "firstName",
      "lastName",
      "email",
      "phone",
      "contractType",
      "costPerHour",
      "vacationDaysPerYear",
      "supervisorUserId",
    });

    return UsersCreateRequest(
      username: rpcString.decode(readRpcField(object, "username")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: readRpcOptionalField(
        object,
        "lastName",
        rpcNullable(rpcString).decode,
      ),
      email: readRpcOptionalField(
        object,
        "email",
        rpcNullable(rpcString).decode,
      ),
      phone: readRpcOptionalField(
        object,
        "phone",
        rpcNullable(rpcString).decode,
      ),
      contractType: readRpcOptionalField(
        object,
        "contractType",
        UserContractType.codec.decode,
      ),
      costPerHour: readRpcOptionalField(
        object,
        "costPerHour",
        rpcNullable(rpcNumber).decode,
      ),
      vacationDaysPerYear: readRpcOptionalField(
        object,
        "vacationDaysPerYear",
        rpcNullable(rpcNumber).decode,
      ),
      supervisorUserId: readRpcOptionalField(
        object,
        "supervisorUserId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "username": encodeRpcValue(username),
      "firstName": encodeRpcValue(firstName),
      if (!lastName.isAbsent) "lastName": encodeRpcValue(lastName),
      if (!email.isAbsent) "email": encodeRpcValue(email),
      if (!phone.isAbsent) "phone": encodeRpcValue(phone),
      if (!contractType.isAbsent) "contractType": encodeRpcValue(contractType),
      if (!costPerHour.isAbsent) "costPerHour": encodeRpcValue(costPerHour),
      if (!vacationDaysPerYear.isAbsent)
        "vacationDaysPerYear": encodeRpcValue(vacationDaysPerYear),
      if (!supervisorUserId.isAbsent)
        "supervisorUserId": encodeRpcValue(supervisorUserId),
    };

  }

}

final class UsersRolesSetRequest implements RpcValue {
  const UsersRolesSetRequest({required this.userId, required this.assignments});

  static const codec = RpcCodec<UsersRolesSetRequest>(
    UsersRolesSetRequest.fromWire,
  );

  final String userId;
  final UsersRolesSetRequestAssignments assignments;

  factory UsersRolesSetRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"userId", "assignments"});

    return UsersRolesSetRequest(
      userId: rpcString.decode(readRpcField(object, "userId")),
      assignments: UsersRolesSetRequestAssignments.codec.decode(
        readRpcField(object, "assignments"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "userId": encodeRpcValue(userId),
      "assignments": encodeRpcValue(assignments),
    };

  }

}

final class UsersUpdateRequest implements RpcValue {
  const UsersUpdateRequest({required this.id, required this.data});

  static const codec = RpcCodec<UsersUpdateRequest>(
    UsersUpdateRequest.fromWire,
  );

  final String id;
  final UsersUpdateRequestData data;

  factory UsersUpdateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "data"});

    return UsersUpdateRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      data: UsersUpdateRequestData.codec.decode(readRpcField(object, "data")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "data": encodeRpcValue(data)};
  }

}

final class UsersVacationsCreateRequest implements RpcValue {
  const UsersVacationsCreateRequest({
    this.from,
    this.to,
    this.userId = const RpcOptional.absent(),
    this.type = const RpcOptional.absent(),
    this.label = const RpcOptional.absent(),
    this.note = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<UsersVacationsCreateRequest>(
    UsersVacationsCreateRequest.fromWire,
  );

  final Object? from;
  final Object? to;
  final RpcOptional<String?> userId;
  final RpcOptional<UsersVacationsListResultItemType> type;
  final RpcOptional<String?> label;
  final RpcOptional<String?> note;

  factory UsersVacationsCreateRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "from",
      "to",
      "userId",
      "type",
      "label",
      "note",
    });

    return UsersVacationsCreateRequest(
      from: rpcUnknown.decode(readRpcField(object, "from")),
      to: rpcUnknown.decode(readRpcField(object, "to")),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
      type: readRpcOptionalField(
        object,
        "type",
        UsersVacationsListResultItemType.codec.decode,
      ),
      label: readRpcOptionalField(
        object,
        "label",
        rpcNullable(rpcString).decode,
      ),
      note: readRpcOptionalField(object, "note", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "from": encodeRpcValue(from),
      "to": encodeRpcValue(to),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
      if (!type.isAbsent) "type": encodeRpcValue(type),
      if (!label.isAbsent) "label": encodeRpcValue(label),
      if (!note.isAbsent) "note": encodeRpcValue(note),
    };

  }

}

final class UsersVacationsCreateResult implements RpcValue {
  const UsersVacationsCreateResult({required this.id, required this.status});

  static const codec = RpcCodec<UsersVacationsCreateResult>(
    UsersVacationsCreateResult.fromWire,
  );

  final String id;
  final UsersVacationsListResultItemStatus status;

  factory UsersVacationsCreateResult.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "status"});

    return UsersVacationsCreateResult(
      id: rpcString.decode(readRpcField(object, "id")),
      status: UsersVacationsListResultItemStatus.codec.decode(
        readRpcField(object, "status"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "status": encodeRpcValue(status)};
  }

}

final class UsersVacationsDenyRequest implements RpcValue {
  const UsersVacationsDenyRequest({required this.id, required this.reason});

  static const codec = RpcCodec<UsersVacationsDenyRequest>(
    UsersVacationsDenyRequest.fromWire,
  );

  final String id;
  final String reason;

  factory UsersVacationsDenyRequest.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "reason"});

    return UsersVacationsDenyRequest(
      id: rpcString.decode(readRpcField(object, "id")),
      reason: rpcString.decode(readRpcField(object, "reason")),
    );
  }

  @override
  JsonMap toWire() {
    return {"id": encodeRpcValue(id), "reason": encodeRpcValue(reason)};
  }

}

final class ApplyPriceImportRowOtherUnits implements RpcValue {
  const ApplyPriceImportRowOtherUnits(this.values);

  static const codec = RpcCodec<ApplyPriceImportRowOtherUnits>(
    ApplyPriceImportRowOtherUnits.fromWire,
  );

  final Map<String, num> values;

  factory ApplyPriceImportRowOtherUnits.fromWire(Object? value) {
    final decoded = readRpcRecord(value, rpcNumber.decode);

    return ApplyPriceImportRowOtherUnits(decoded);
  }

  @override
  JsonMap toWire() {
    return {
      for (final entry in values.entries)
        entry.key: encodeRpcValue(entry.value),
    };

  }

}

enum ChangeProposalStatus implements RpcValue {
  pending("pending"),
  declined("declined"),
  revisionRequested("revision_requested"),
  accepted("accepted");

  const ChangeProposalStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ChangeProposalStatus>(
    ChangeProposalStatus.fromWire,
  );

  factory ChangeProposalStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ChatMessageRole implements RpcValue {
  user("user"),
  assistant("assistant");

  const ChatMessageRole(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ChatMessageRole>(ChatMessageRole.fromWire);

  factory ChatMessageRole.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class JsonValueVariant5 implements RpcValue {
  const JsonValueVariant5(this.values);

  static const codec = RpcCodec<JsonValueVariant5>(JsonValueVariant5.fromWire);

  final Map<String, JsonValue> values;

  factory JsonValueVariant5.fromWire(Object? value) {
    final decoded = readRpcRecord(value, JsonValue.codec.decode);

    return JsonValueVariant5(decoded);
  }

  @override
  JsonMap toWire() {
    return {
      for (final entry in values.entries)
        entry.key: encodeRpcValue(entry.value),
    };

  }

}

final class SessionInfoUser implements RpcValue {
  const SessionInfoUser({
    required this.id,
    required this.username,
    this.salutation,
    required this.firstName,
    this.lastName,
    required this.contractType,
    this.phone,
    this.email,
    required this.locale,
  });

  static const codec = RpcCodec<SessionInfoUser>(SessionInfoUser.fromWire);

  final String id;
  final String username;
  final String? salutation;
  final String firstName;
  final String? lastName;
  final UserContractType contractType;
  final String? phone;
  final String? email;
  final AssistantLocale locale;

  factory SessionInfoUser.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "username",
      "salutation",
      "firstName",
      "lastName",
      "contractType",
      "phone",
      "email",
      "locale",
    });

    return SessionInfoUser(
      id: rpcString.decode(readRpcField(object, "id")),
      username: rpcString.decode(readRpcField(object, "username")),
      salutation: rpcNullable(rpcString)
          .decode(readRpcField(object, "salutation")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
      contractType: UserContractType.codec.decode(
        readRpcField(object, "contractType"),
      ),
      phone: rpcNullable(rpcString).decode(readRpcField(object, "phone")),
      email: rpcNullable(rpcString).decode(readRpcField(object, "email")),
      locale: AssistantLocale.codec.decode(readRpcField(object, "locale")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "username": encodeRpcValue(username),
      "salutation": encodeRpcValue(salutation),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
      "contractType": encodeRpcValue(contractType),
      "phone": encodeRpcValue(phone),
      "email": encodeRpcValue(email),
      "locale": encodeRpcValue(locale),
    };

  }

}

final class SessionInfoSession implements RpcValue {
  const SessionInfoSession({
    required this.id,
    this.inetAddr,
    this.userAgent,
    required this.createdAt,
    required this.expiresAt,
  });

  static const codec = RpcCodec<SessionInfoSession>(
    SessionInfoSession.fromWire,
  );

  final String id;
  final String? inetAddr;
  final String? userAgent;
  final DateTime createdAt;
  final DateTime expiresAt;

  factory SessionInfoSession.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "inetAddr",
      "userAgent",
      "createdAt",
      "expiresAt",
    });

    return SessionInfoSession(
      id: rpcString.decode(readRpcField(object, "id")),
      inetAddr: rpcNullable(rpcString).decode(readRpcField(object, "inetAddr")),
      userAgent: rpcNullable(rpcString)
          .decode(readRpcField(object, "userAgent")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      expiresAt: rpcDate.decode(readRpcField(object, "expiresAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "inetAddr": encodeRpcValue(inetAddr),
      "userAgent": encodeRpcValue(userAgent),
      "createdAt": encodeRpcValue(createdAt),
      "expiresAt": encodeRpcValue(expiresAt),
    };

  }

}

final class SessionInfoTenant implements RpcValue {
  const SessionInfoTenant({
    this.companyName,
    required this.objectStorageEnabled,
  });

  static const codec = RpcCodec<SessionInfoTenant>(SessionInfoTenant.fromWire);

  final String? companyName;
  final bool objectStorageEnabled;

  factory SessionInfoTenant.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "companyName",
      "objectStorageEnabled",
    });

    return SessionInfoTenant(
      companyName: rpcNullable(rpcString)
          .decode(readRpcField(object, "companyName")),
      objectStorageEnabled: rpcBoolean.decode(
        readRpcField(object, "objectStorageEnabled"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "companyName": encodeRpcValue(companyName),
      "objectStorageEnabled": encodeRpcValue(objectStorageEnabled),
    };

  }

}

final class ProjectAddress implements RpcValue {
  const ProjectAddress({
    required this.city,
    required this.streetAddress,
    this.country = const RpcOptional.absent(),
    this.zip = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectAddress>(ProjectAddress.fromWire);

  final String city;
  final String streetAddress;
  final RpcOptional<String?> country;
  final RpcOptional<String?> zip;

  factory ProjectAddress.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "city",
      "streetAddress",
      "country",
      "zip",
    });

    return ProjectAddress(
      city: rpcString.decode(readRpcField(object, "city")),
      streetAddress: rpcString.decode(readRpcField(object, "streetAddress")),
      country: readRpcOptionalField(
        object,
        "country",
        rpcNullable(rpcString).decode,
      ),
      zip: readRpcOptionalField(object, "zip", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "city": encodeRpcValue(city),
      "streetAddress": encodeRpcValue(streetAddress),
      if (!country.isAbsent) "country": encodeRpcValue(country),
      if (!zip.isAbsent) "zip": encodeRpcValue(zip),
    };

  }

}

enum ToolStatus implements RpcValue {
  lost("lost"),
  broken("broken");

  const ToolStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ToolStatus>(ToolStatus.fromWire);

  factory ToolStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum UserContractType implements RpcValue {
  internal("internal"),
  externalValue("external"),
  subcontractor("subcontractor");

  const UserContractType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<UserContractType>(UserContractType.fromWire);

  factory UserContractType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class CustomerPhoneNumbersItem implements RpcValue {
  const CustomerPhoneNumbersItem({
    required this.number,
    this.name = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<CustomerPhoneNumbersItem>(
    CustomerPhoneNumbersItem.fromWire,
  );

  final String number;
  final RpcOptional<String?> name;

  factory CustomerPhoneNumbersItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"number", "name"});

    return CustomerPhoneNumbersItem(
      number: rpcString.decode(readRpcField(object, "number")),
      name: readRpcOptionalField(object, "name", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "number": encodeRpcValue(number),
      if (!name.isAbsent) "name": encodeRpcValue(name),
    };

  }

}

final class CustomerEmailAddressesItem implements RpcValue {
  const CustomerEmailAddressesItem({
    required this.email,
    this.name = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<CustomerEmailAddressesItem>(
    CustomerEmailAddressesItem.fromWire,
  );

  final String email;
  final RpcOptional<String?> name;

  factory CustomerEmailAddressesItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"email", "name"});

    return CustomerEmailAddressesItem(
      email: rpcString.decode(readRpcField(object, "email")),
      name: readRpcOptionalField(object, "name", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "email": encodeRpcValue(email),
      if (!name.isAbsent) "name": encodeRpcValue(name),
    };

  }

}

final class DeliveryNoteRecordsItem implements RpcValue {
  const DeliveryNoteRecordsItem({
    required this.id,
    required this.noteId,
    required this.productId,
    required this.quantity,
    required this.unit,
    this.comment,
  });

  static const codec = RpcCodec<DeliveryNoteRecordsItem>(
    DeliveryNoteRecordsItem.fromWire,
  );

  final String id;
  final String noteId;
  final String productId;
  final num quantity;
  final String unit;
  final String? comment;

  factory DeliveryNoteRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "noteId",
      "productId",
      "quantity",
      "unit",
      "comment",
    });

    return DeliveryNoteRecordsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      noteId: rpcString.decode(readRpcField(object, "noteId")),
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "noteId": encodeRpcValue(noteId),
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      "unit": encodeRpcValue(unit),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class DeliveryNoteSpecialRecordsItem implements RpcValue {
  const DeliveryNoteSpecialRecordsItem({
    required this.id,
    required this.noteId,
    required this.name,
    required this.unit,
    required this.amount,
    this.pricePerUnit,
    this.comment,
  });

  static const codec = RpcCodec<DeliveryNoteSpecialRecordsItem>(
    DeliveryNoteSpecialRecordsItem.fromWire,
  );

  final String id;
  final String noteId;
  final String name;
  final String unit;
  final num amount;
  final num? pricePerUnit;
  final String? comment;

  factory DeliveryNoteSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "noteId",
      "name",
      "unit",
      "amount",
      "pricePerUnit",
      "comment",
    });

    return DeliveryNoteSpecialRecordsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      noteId: rpcString.decode(readRpcField(object, "noteId")),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      pricePerUnit: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "pricePerUnit")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "noteId": encodeRpcValue(noteId),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "pricePerUnit": encodeRpcValue(pricePerUnit),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportProductsItem implements RpcValue {
  const RegieReportProductsItem({
    required this.id,
    required this.reportId,
    required this.productId,
    required this.quantity,
    this.comment,
  });

  static const codec = RpcCodec<RegieReportProductsItem>(
    RegieReportProductsItem.fromWire,
  );

  final String id;
  final String reportId;
  final String productId;
  final num quantity;
  final String? comment;

  factory RegieReportProductsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "reportId",
      "productId",
      "quantity",
      "comment",
    });

    return RegieReportProductsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      reportId: rpcString.decode(readRpcField(object, "reportId")),
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "reportId": encodeRpcValue(reportId),
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportSpecialRecordsItem implements RpcValue {
  const RegieReportSpecialRecordsItem({
    required this.id,
    required this.reportId,
    required this.name,
    required this.unit,
    required this.amount,
    this.comment,
  });

  static const codec = RpcCodec<RegieReportSpecialRecordsItem>(
    RegieReportSpecialRecordsItem.fromWire,
  );

  final String id;
  final String reportId;
  final String name;
  final String unit;
  final num amount;
  final String? comment;

  factory RegieReportSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "reportId",
      "name",
      "unit",
      "amount",
      "comment",
    });

    return RegieReportSpecialRecordsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      reportId: rpcString.decode(readRpcField(object, "reportId")),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "reportId": encodeRpcValue(reportId),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportWorkHoursItem implements RpcValue {
  const RegieReportWorkHoursItem({
    required this.id,
    required this.reportId,
    this.userId,
    required this.day,
    required this.hours,
  });

  static const codec = RpcCodec<RegieReportWorkHoursItem>(
    RegieReportWorkHoursItem.fromWire,
  );

  final String id;
  final String reportId;
  final String? userId;
  final DateTime day;
  final num hours;

  factory RegieReportWorkHoursItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "reportId",
      "userId",
      "day",
      "hours",
    });

    return RegieReportWorkHoursItem(
      id: rpcString.decode(readRpcField(object, "id")),
      reportId: rpcString.decode(readRpcField(object, "reportId")),
      userId: rpcNullable(rpcString).decode(readRpcField(object, "userId")),
      day: rpcDate.decode(readRpcField(object, "day")),
      hours: rpcNumber.decode(readRpcField(object, "hours")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "reportId": encodeRpcValue(reportId),
      "userId": encodeRpcValue(userId),
      "day": encodeRpcValue(day),
      "hours": encodeRpcValue(hours),
    };

  }

}

enum ResourceActivityAction implements RpcValue {
  created("created"),
  updated("updated"),
  deleted("deleted"),
  completed("completed"),
  resumed("resumed");

  const ResourceActivityAction(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ResourceActivityAction>(
    ResourceActivityAction.fromWire,
  );

  factory ResourceActivityAction.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum AdminDatabasesBackupsListResultItemKind implements RpcValue {
  manual("manual"),
  auto("auto");

  const AdminDatabasesBackupsListResultItemKind(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<AdminDatabasesBackupsListResultItemKind>(
    AdminDatabasesBackupsListResultItemKind.fromWire,
  );

  factory AdminDatabasesBackupsListResultItemKind.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum AdminDatabasesBackupsListResultItemState implements RpcValue {
  processing("processing"),
  uploaded("uploaded"),
  failed("failed");

  const AdminDatabasesBackupsListResultItemState(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<AdminDatabasesBackupsListResultItemState>(
    AdminDatabasesBackupsListResultItemState.fromWire,
  );

  factory AdminDatabasesBackupsListResultItemState.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class AdminDatabasesHostsListResultItemConnectionDetails
    implements RpcValue {
  const AdminDatabasesHostsListResultItemConnectionDetails({
    required this.host,
    required this.port,
    required this.adminDatabase,
    required this.adminUsername,
    required this.adminPassword,
  });

  static const codec =
      RpcCodec<AdminDatabasesHostsListResultItemConnectionDetails>(
        AdminDatabasesHostsListResultItemConnectionDetails.fromWire,
      );

  final String host;
  final num port;
  final String adminDatabase;
  final String adminUsername;
  final String adminPassword;

  factory AdminDatabasesHostsListResultItemConnectionDetails.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "host",
      "port",
      "adminDatabase",
      "adminUsername",
      "adminPassword",
    });

    return AdminDatabasesHostsListResultItemConnectionDetails(
      host: rpcString.decode(readRpcField(object, "host")),
      port: rpcNumber.decode(readRpcField(object, "port")),
      adminDatabase: rpcString.decode(readRpcField(object, "adminDatabase")),
      adminUsername: rpcString.decode(readRpcField(object, "adminUsername")),
      adminPassword: rpcString.decode(readRpcField(object, "adminPassword")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "host": encodeRpcValue(host),
      "port": encodeRpcValue(port),
      "adminDatabase": encodeRpcValue(adminDatabase),
      "adminUsername": encodeRpcValue(adminUsername),
      "adminPassword": encodeRpcValue(adminPassword),
    };

  }

}

final class AdminDatabasesHostsListResultItemBackupDetails implements RpcValue {
  const AdminDatabasesHostsListResultItemBackupDetails({
    required this.enabled,
    required this.forcePathStyle,
    this.bucket = const RpcOptional.absent(),
    this.region = const RpcOptional.absent(),
    this.endpoint = const RpcOptional.absent(),
    this.publicBaseUrl = const RpcOptional.absent(),
    this.accessKeyId = const RpcOptional.absent(),
    this.secretAccessKey = const RpcOptional.absent(),
    this.sessionToken = const RpcOptional.absent(),
    this.keyPrefix = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesHostsListResultItemBackupDetails>(
    AdminDatabasesHostsListResultItemBackupDetails.fromWire,
  );

  final bool enabled;
  final bool forcePathStyle;
  final RpcOptional<String?> bucket;
  final RpcOptional<String?> region;
  final RpcOptional<String?> endpoint;
  final RpcOptional<String?> publicBaseUrl;
  final RpcOptional<String?> accessKeyId;
  final RpcOptional<String?> secretAccessKey;
  final RpcOptional<String?> sessionToken;
  final RpcOptional<String?> keyPrefix;

  factory AdminDatabasesHostsListResultItemBackupDetails.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "enabled",
      "forcePathStyle",
      "bucket",
      "region",
      "endpoint",
      "publicBaseUrl",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "keyPrefix",
    });

    return AdminDatabasesHostsListResultItemBackupDetails(
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      forcePathStyle: rpcBoolean.decode(readRpcField(object, "forcePathStyle")),
      bucket: readRpcOptionalField(
        object,
        "bucket",
        rpcNullable(rpcString).decode,
      ),
      region: readRpcOptionalField(
        object,
        "region",
        rpcNullable(rpcString).decode,
      ),
      endpoint: readRpcOptionalField(
        object,
        "endpoint",
        rpcNullable(rpcString).decode,
      ),
      publicBaseUrl: readRpcOptionalField(
        object,
        "publicBaseUrl",
        rpcNullable(rpcString).decode,
      ),
      accessKeyId: readRpcOptionalField(
        object,
        "accessKeyId",
        rpcNullable(rpcString).decode,
      ),
      secretAccessKey: readRpcOptionalField(
        object,
        "secretAccessKey",
        rpcNullable(rpcString).decode,
      ),
      sessionToken: readRpcOptionalField(
        object,
        "sessionToken",
        rpcNullable(rpcString).decode,
      ),
      keyPrefix: readRpcOptionalField(
        object,
        "keyPrefix",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "enabled": encodeRpcValue(enabled),
      "forcePathStyle": encodeRpcValue(forcePathStyle),
      if (!bucket.isAbsent) "bucket": encodeRpcValue(bucket),
      if (!region.isAbsent) "region": encodeRpcValue(region),
      if (!endpoint.isAbsent) "endpoint": encodeRpcValue(endpoint),
      if (!publicBaseUrl.isAbsent)
        "publicBaseUrl": encodeRpcValue(publicBaseUrl),
      if (!accessKeyId.isAbsent) "accessKeyId": encodeRpcValue(accessKeyId),
      if (!secretAccessKey.isAbsent)
        "secretAccessKey": encodeRpcValue(secretAccessKey),
      if (!sessionToken.isAbsent) "sessionToken": encodeRpcValue(sessionToken),
      if (!keyPrefix.isAbsent) "keyPrefix": encodeRpcValue(keyPrefix),
    };

  }

}

enum AdminErrorsListResultItemLevel implements RpcValue {
  error("error"),
  warning("warning");

  const AdminErrorsListResultItemLevel(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<AdminErrorsListResultItemLevel>(
    AdminErrorsListResultItemLevel.fromWire,
  );

  factory AdminErrorsListResultItemLevel.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class AdminErrorsListResultItemMetadata implements RpcValue {
  const AdminErrorsListResultItemMetadata(this.values);

  static const codec = RpcCodec<AdminErrorsListResultItemMetadata>(
    AdminErrorsListResultItemMetadata.fromWire,
  );

  final Map<String, Object?> values;

  factory AdminErrorsListResultItemMetadata.fromWire(Object? value) {
    final decoded = readRpcRecord(value, rpcUnknown.decode);

    return AdminErrorsListResultItemMetadata(decoded);
  }

  @override
  JsonMap toWire() {
    return {
      for (final entry in values.entries)
        entry.key: encodeRpcValue(entry.value),
    };

  }

}

final class AdminTenantsGetResultConnectionDetails implements RpcValue {
  const AdminTenantsGetResultConnectionDetails({
    this.postgresDSN = const RpcOptional.absent(),
    this.postgresDatabaseId = const RpcOptional.absent(),
    this.objectStorage = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsGetResultConnectionDetails>(
    AdminTenantsGetResultConnectionDetails.fromWire,
  );

  final RpcOptional<String?> postgresDSN;
  final RpcOptional<String?> postgresDatabaseId;
  final RpcOptional<AdminTenantsGetResultConnectionDetailsObjectStorage?>
  objectStorage;

  factory AdminTenantsGetResultConnectionDetails.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "postgresDSN",
      "postgresDatabaseId",
      "objectStorage",
    });

    return AdminTenantsGetResultConnectionDetails(
      postgresDSN: readRpcOptionalField(
        object,
        "postgresDSN",
        rpcNullable(rpcString).decode,
      ),
      postgresDatabaseId: readRpcOptionalField(
        object,
        "postgresDatabaseId",
        rpcNullable(rpcString).decode,
      ),
      objectStorage: readRpcOptionalField(
        object,
        "objectStorage",
        rpcNullable(AdminTenantsGetResultConnectionDetailsObjectStorage.codec)
            .decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!postgresDSN.isAbsent) "postgresDSN": encodeRpcValue(postgresDSN),
      if (!postgresDatabaseId.isAbsent)
        "postgresDatabaseId": encodeRpcValue(postgresDatabaseId),
      if (!objectStorage.isAbsent)
        "objectStorage": encodeRpcValue(objectStorage),
    };

  }

}

final class AdminTenantsGetResultContactDetails implements RpcValue {
  const AdminTenantsGetResultContactDetails({
    required this.email,
    this.companyName = const RpcOptional.absent(),
    this.address = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsGetResultContactDetails>(
    AdminTenantsGetResultContactDetails.fromWire,
  );

  final String email;
  final RpcOptional<String?> companyName;
  final RpcOptional<AdminTenantsGetResultContactDetailsAddress?> address;

  factory AdminTenantsGetResultContactDetails.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "email",
      "companyName",
      "address",
    });

    return AdminTenantsGetResultContactDetails(
      email: rpcString.decode(readRpcField(object, "email")),
      companyName: readRpcOptionalField(
        object,
        "companyName",
        rpcNullable(rpcString).decode,
      ),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(AdminTenantsGetResultContactDetailsAddress.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "email": encodeRpcValue(email),
      if (!companyName.isAbsent) "companyName": encodeRpcValue(companyName),
      if (!address.isAbsent) "address": encodeRpcValue(address),
    };

  }

}

final class AdminTenantsGetResultOptions implements RpcValue {
  const AdminTenantsGetResultOptions({required this.sso});

  static const codec = RpcCodec<AdminTenantsGetResultOptions>(
    AdminTenantsGetResultOptions.fromWire,
  );

  final AdminTenantsGetResultOptionsSso sso;

  factory AdminTenantsGetResultOptions.fromWire(Object? value) {
    final object = readRpcObject(value, const {"sso"});

    return AdminTenantsGetResultOptions(
      sso: AdminTenantsGetResultOptionsSso.codec.decode(
        readRpcField(object, "sso"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"sso": encodeRpcValue(sso)};
  }

}

final class DeliveryNotesCostsGetResultRecordsItem implements RpcValue {
  const DeliveryNotesCostsGetResultRecordsItem({
    required this.recordId,
    required this.productId,
    required this.quantity,
    this.priceRecord,
  });

  static const codec = RpcCodec<DeliveryNotesCostsGetResultRecordsItem>(
    DeliveryNotesCostsGetResultRecordsItem.fromWire,
  );

  final String recordId;
  final String productId;
  final num quantity;
  final ProductsPriceRecordsListResultItem? priceRecord;

  factory DeliveryNotesCostsGetResultRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "recordId",
      "productId",
      "quantity",
      "priceRecord",
    });

    return DeliveryNotesCostsGetResultRecordsItem(
      recordId: rpcString.decode(readRpcField(object, "recordId")),
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      priceRecord: rpcNullable(ProductsPriceRecordsListResultItem.codec)
          .decode(readRpcField(object, "priceRecord")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "recordId": encodeRpcValue(recordId),
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      "priceRecord": encodeRpcValue(priceRecord),
    };

  }

}

final class DeliveryNotesCostsGetResultSpecialRecordsItem implements RpcValue {
  const DeliveryNotesCostsGetResultSpecialRecordsItem({
    required this.recordId,
    required this.name,
    required this.unit,
    required this.amount,
    this.pricePerUnit,
    this.comment,
    required this.totalCost,
  });

  static const codec = RpcCodec<DeliveryNotesCostsGetResultSpecialRecordsItem>(
    DeliveryNotesCostsGetResultSpecialRecordsItem.fromWire,
  );

  final String recordId;
  final String name;
  final String unit;
  final num amount;
  final num? pricePerUnit;
  final String? comment;
  final num totalCost;

  factory DeliveryNotesCostsGetResultSpecialRecordsItem.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "recordId",
      "name",
      "unit",
      "amount",
      "pricePerUnit",
      "comment",
      "totalCost",
    });

    return DeliveryNotesCostsGetResultSpecialRecordsItem(
      recordId: rpcString.decode(readRpcField(object, "recordId")),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      pricePerUnit: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "pricePerUnit")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "recordId": encodeRpcValue(recordId),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "pricePerUnit": encodeRpcValue(pricePerUnit),
      "comment": encodeRpcValue(comment),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class DeliveryNotesGetRequestVariant2 implements RpcValue {
  const DeliveryNotesGetRequestVariant2({this.autoId});

  static const codec = RpcCodec<DeliveryNotesGetRequestVariant2>(
    DeliveryNotesGetRequestVariant2.fromWire,
  );

  final Object? autoId;

  factory DeliveryNotesGetRequestVariant2.fromWire(Object? value) {
    final object = readRpcObject(value, const {"autoId"});

    return DeliveryNotesGetRequestVariant2(
      autoId: rpcUnknown.decode(readRpcField(object, "autoId")),
    );
  }

  @override
  JsonMap toWire() {
    return {"autoId": encodeRpcValue(autoId)};
  }

}

final class ProjectsCostsFilterOptionsResultProjectLeadersItem
    implements RpcValue {
  const ProjectsCostsFilterOptionsResultProjectLeadersItem({
    required this.id,
    required this.firstName,
    this.lastName,
  });

  static const codec =
      RpcCodec<ProjectsCostsFilterOptionsResultProjectLeadersItem>(
        ProjectsCostsFilterOptionsResultProjectLeadersItem.fromWire,
      );

  final String id;
  final String firstName;
  final String? lastName;

  factory ProjectsCostsFilterOptionsResultProjectLeadersItem.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {"id", "firstName", "lastName"});

    return ProjectsCostsFilterOptionsResultProjectLeadersItem(
      id: rpcString.decode(readRpcField(object, "id")),
      firstName: rpcString.decode(readRpcField(object, "firstName")),
      lastName: rpcNullable(rpcString).decode(readRpcField(object, "lastName")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "firstName": encodeRpcValue(firstName),
      "lastName": encodeRpcValue(lastName),
    };

  }

}

final class ProjectsCostsGetResultOffersItem implements RpcValue {
  const ProjectsCostsGetResultOffersItem({
    required this.id,
    required this.projectId,
    required this.type,
    required this.amount,
    this.comment,
    this.createdByUserId,
    required this.createdAt,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultOffersItem>(
    ProjectsCostsGetResultOffersItem.fromWire,
  );

  final String id;
  final String projectId;
  final ProjectsCostsEntriesCreateRequestType type;
  final num amount;
  final String? comment;
  final String? createdByUserId;
  final DateTime createdAt;

  factory ProjectsCostsGetResultOffersItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "type",
      "amount",
      "comment",
      "createdByUserId",
      "createdAt",
    });

    return ProjectsCostsGetResultOffersItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      type: ProjectsCostsEntriesCreateRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "type": encodeRpcValue(type),
      "amount": encodeRpcValue(amount),
      "comment": encodeRpcValue(comment),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
    };

  }

}

final class ProjectsCostsGetResultDeliveryNotesItem implements RpcValue {
  const ProjectsCostsGetResultDeliveryNotesItem({
    required this.noteId,
    required this.autoId,
    required this.effectiveTimestamp,
    required this.totalCost,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultDeliveryNotesItem>(
    ProjectsCostsGetResultDeliveryNotesItem.fromWire,
  );

  final String noteId;
  final num autoId;
  final DateTime effectiveTimestamp;
  final num totalCost;

  factory ProjectsCostsGetResultDeliveryNotesItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "noteId",
      "autoId",
      "effectiveTimestamp",
      "totalCost",
    });

    return ProjectsCostsGetResultDeliveryNotesItem(
      noteId: rpcString.decode(readRpcField(object, "noteId")),
      autoId: rpcNumber.decode(readRpcField(object, "autoId")),
      effectiveTimestamp: rpcDate.decode(
        readRpcField(object, "effectiveTimestamp"),
      ),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "noteId": encodeRpcValue(noteId),
      "autoId": encodeRpcValue(autoId),
      "effectiveTimestamp": encodeRpcValue(effectiveTimestamp),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class ProjectsCostsGetResultProductsItem implements RpcValue {
  const ProjectsCostsGetResultProductsItem({
    required this.productId,
    required this.quantity,
    required this.totalCost,
    this.priceRecord,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultProductsItem>(
    ProjectsCostsGetResultProductsItem.fromWire,
  );

  final String productId;
  final num quantity;
  final num totalCost;
  final ProductsPriceRecordsListResultItem? priceRecord;

  factory ProjectsCostsGetResultProductsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "quantity",
      "totalCost",
      "priceRecord",
    });

    return ProjectsCostsGetResultProductsItem(
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
      priceRecord: rpcNullable(ProductsPriceRecordsListResultItem.codec)
          .decode(readRpcField(object, "priceRecord")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      "totalCost": encodeRpcValue(totalCost),
      "priceRecord": encodeRpcValue(priceRecord),
    };

  }

}

final class ProjectsCostsGetResultSpecialRecordsItem implements RpcValue {
  const ProjectsCostsGetResultSpecialRecordsItem({
    required this.id,
    required this.noteId,
    required this.noteAutoId,
    required this.effectiveTimestamp,
    required this.name,
    required this.unit,
    required this.amount,
    this.pricePerUnit,
    this.comment,
    required this.totalCost,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultSpecialRecordsItem>(
    ProjectsCostsGetResultSpecialRecordsItem.fromWire,
  );

  final String id;
  final String noteId;
  final num noteAutoId;
  final DateTime effectiveTimestamp;
  final String name;
  final String unit;
  final num amount;
  final num? pricePerUnit;
  final String? comment;
  final num totalCost;

  factory ProjectsCostsGetResultSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "noteId",
      "noteAutoId",
      "effectiveTimestamp",
      "name",
      "unit",
      "amount",
      "pricePerUnit",
      "comment",
      "totalCost",
    });

    return ProjectsCostsGetResultSpecialRecordsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      noteId: rpcString.decode(readRpcField(object, "noteId")),
      noteAutoId: rpcNumber.decode(readRpcField(object, "noteAutoId")),
      effectiveTimestamp: rpcDate.decode(
        readRpcField(object, "effectiveTimestamp"),
      ),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      pricePerUnit: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "pricePerUnit")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "noteId": encodeRpcValue(noteId),
      "noteAutoId": encodeRpcValue(noteAutoId),
      "effectiveTimestamp": encodeRpcValue(effectiveTimestamp),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "pricePerUnit": encodeRpcValue(pricePerUnit),
      "comment": encodeRpcValue(comment),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class ProjectsCostsGetResultWorkHoursItem implements RpcValue {
  const ProjectsCostsGetResultWorkHoursItem({
    required this.id,
    this.userId,
    required this.day,
    required this.hours,
    this.costPerHour,
    required this.contractType,
    required this.totalCost,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultWorkHoursItem>(
    ProjectsCostsGetResultWorkHoursItem.fromWire,
  );

  final String id;
  final String? userId;
  final DateTime day;
  final num hours;
  final num? costPerHour;
  final UserContractType contractType;
  final num totalCost;

  factory ProjectsCostsGetResultWorkHoursItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "userId",
      "day",
      "hours",
      "costPerHour",
      "contractType",
      "totalCost",
    });

    return ProjectsCostsGetResultWorkHoursItem(
      id: rpcString.decode(readRpcField(object, "id")),
      userId: rpcNullable(rpcString).decode(readRpcField(object, "userId")),
      day: rpcDate.decode(readRpcField(object, "day")),
      hours: rpcNumber.decode(readRpcField(object, "hours")),
      costPerHour: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "costPerHour")),
      contractType: UserContractType.codec.decode(
        readRpcField(object, "contractType"),
      ),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "userId": encodeRpcValue(userId),
      "day": encodeRpcValue(day),
      "hours": encodeRpcValue(hours),
      "costPerHour": encodeRpcValue(costPerHour),
      "contractType": encodeRpcValue(contractType),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class ProjectsCostsGetResultToolTrackingsItem implements RpcValue {
  const ProjectsCostsGetResultToolTrackingsItem({
    required this.id,
    required this.toolId,
    this.responsibleUserId,
    this.startedByUserId,
    this.endedByUserId,
    this.toolUsageCostPerDay,
    this.comment,
    required this.startedAt,
    this.endedAt,
    this.deadlineAt,
    required this.totalCost,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultToolTrackingsItem>(
    ProjectsCostsGetResultToolTrackingsItem.fromWire,
  );

  final String id;
  final String toolId;
  final String? responsibleUserId;
  final String? startedByUserId;
  final String? endedByUserId;
  final num? toolUsageCostPerDay;
  final String? comment;
  final DateTime startedAt;
  final DateTime? endedAt;
  final DateTime? deadlineAt;
  final num totalCost;

  factory ProjectsCostsGetResultToolTrackingsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "toolId",
      "responsibleUserId",
      "startedByUserId",
      "endedByUserId",
      "toolUsageCostPerDay",
      "comment",
      "startedAt",
      "endedAt",
      "deadlineAt",
      "totalCost",
    });

    return ProjectsCostsGetResultToolTrackingsItem(
      id: rpcString.decode(readRpcField(object, "id")),
      toolId: rpcString.decode(readRpcField(object, "toolId")),
      responsibleUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "responsibleUserId")),
      startedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "startedByUserId")),
      endedByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "endedByUserId")),
      toolUsageCostPerDay: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "toolUsageCostPerDay")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
      startedAt: rpcDate.decode(readRpcField(object, "startedAt")),
      endedAt: rpcNullable(rpcDate).decode(readRpcField(object, "endedAt")),
      deadlineAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "deadlineAt")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "toolId": encodeRpcValue(toolId),
      "responsibleUserId": encodeRpcValue(responsibleUserId),
      "startedByUserId": encodeRpcValue(startedByUserId),
      "endedByUserId": encodeRpcValue(endedByUserId),
      "toolUsageCostPerDay": encodeRpcValue(toolUsageCostPerDay),
      "comment": encodeRpcValue(comment),
      "startedAt": encodeRpcValue(startedAt),
      "endedAt": encodeRpcValue(endedAt),
      "deadlineAt": encodeRpcValue(deadlineAt),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class ProjectsCostsGetResultCommonCosts implements RpcValue {
  const ProjectsCostsGetResultCommonCosts({
    required this.fgk,
    required this.mgk,
    required this.ngk,
    required this.overallOverhead,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultCommonCosts>(
    ProjectsCostsGetResultCommonCosts.fromWire,
  );

  final ProjectsCostsGetResultCommonCostsFgk fgk;
  final ProjectsCostsGetResultCommonCostsFgk mgk;
  final ProjectsCostsGetResultCommonCostsFgk ngk;
  final num overallOverhead;

  factory ProjectsCostsGetResultCommonCosts.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "fgk",
      "mgk",
      "ngk",
      "overallOverhead",
    });

    return ProjectsCostsGetResultCommonCosts(
      fgk: ProjectsCostsGetResultCommonCostsFgk.codec.decode(
        readRpcField(object, "fgk"),
      ),
      mgk: ProjectsCostsGetResultCommonCostsFgk.codec.decode(
        readRpcField(object, "mgk"),
      ),
      ngk: ProjectsCostsGetResultCommonCostsFgk.codec.decode(
        readRpcField(object, "ngk"),
      ),
      overallOverhead: rpcNumber.decode(
        readRpcField(object, "overallOverhead"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "fgk": encodeRpcValue(fgk),
      "mgk": encodeRpcValue(mgk),
      "ngk": encodeRpcValue(ngk),
      "overallOverhead": encodeRpcValue(overallOverhead),
    };

  }

}

final class ProjectsCostsGetResultTotalCosts implements RpcValue {
  const ProjectsCostsGetResultTotalCosts({
    required this.offers,
    required this.invoices,
    required this.deliveryNotes,
    required this.products,
    required this.specialRecords,
    required this.workHours,
    required this.subcontractorWorkHours,
    required this.toolTrackings,
    required this.overall,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultTotalCosts>(
    ProjectsCostsGetResultTotalCosts.fromWire,
  );

  final num offers;
  final num invoices;
  final num deliveryNotes;
  final num products;
  final num specialRecords;
  final num workHours;
  final num subcontractorWorkHours;
  final num toolTrackings;
  final num overall;

  factory ProjectsCostsGetResultTotalCosts.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "offers",
      "invoices",
      "deliveryNotes",
      "products",
      "specialRecords",
      "workHours",
      "subcontractorWorkHours",
      "toolTrackings",
      "overall",
    });

    return ProjectsCostsGetResultTotalCosts(
      offers: rpcNumber.decode(readRpcField(object, "offers")),
      invoices: rpcNumber.decode(readRpcField(object, "invoices")),
      deliveryNotes: rpcNumber.decode(readRpcField(object, "deliveryNotes")),
      products: rpcNumber.decode(readRpcField(object, "products")),
      specialRecords: rpcNumber.decode(readRpcField(object, "specialRecords")),
      workHours: rpcNumber.decode(readRpcField(object, "workHours")),
      subcontractorWorkHours: rpcNumber.decode(
        readRpcField(object, "subcontractorWorkHours"),
      ),
      toolTrackings: rpcNumber.decode(readRpcField(object, "toolTrackings")),
      overall: rpcNumber.decode(readRpcField(object, "overall")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "offers": encodeRpcValue(offers),
      "invoices": encodeRpcValue(invoices),
      "deliveryNotes": encodeRpcValue(deliveryNotes),
      "products": encodeRpcValue(products),
      "specialRecords": encodeRpcValue(specialRecords),
      "workHours": encodeRpcValue(workHours),
      "subcontractorWorkHours": encodeRpcValue(subcontractorWorkHours),
      "toolTrackings": encodeRpcValue(toolTrackings),
      "overall": encodeRpcValue(overall),
    };

  }

}

enum ProjectsCostsOverviewRequestStatus implements RpcValue {
  finished("finished"),
  active("active"),
  all("all");

  const ProjectsCostsOverviewRequestStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProjectsCostsOverviewRequestStatus>(
    ProjectsCostsOverviewRequestStatus.fromWire,
  );

  factory ProjectsCostsOverviewRequestStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ProjectsDailyReportsGetResultWeather implements RpcValue {
  const ProjectsDailyReportsGetResultWeather({
    this.summary = const RpcOptional.absent(),
    this.temperatureC = const RpcOptional.absent(),
    this.precipitationMm = const RpcOptional.absent(),
    this.windKph = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsGetResultWeather>(
    ProjectsDailyReportsGetResultWeather.fromWire,
  );

  final RpcOptional<String?> summary;
  final RpcOptional<num?> temperatureC;
  final RpcOptional<num?> precipitationMm;
  final RpcOptional<num?> windKph;

  factory ProjectsDailyReportsGetResultWeather.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "summary",
      "temperatureC",
      "precipitationMm",
      "windKph",
    });

    return ProjectsDailyReportsGetResultWeather(
      summary: readRpcOptionalField(
        object,
        "summary",
        rpcNullable(rpcString).decode,
      ),
      temperatureC: readRpcOptionalField(
        object,
        "temperatureC",
        rpcNullable(rpcNumber).decode,
      ),
      precipitationMm: readRpcOptionalField(
        object,
        "precipitationMm",
        rpcNullable(rpcNumber).decode,
      ),
      windKph: readRpcOptionalField(
        object,
        "windKph",
        rpcNullable(rpcNumber).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!summary.isAbsent) "summary": encodeRpcValue(summary),
      if (!temperatureC.isAbsent) "temperatureC": encodeRpcValue(temperatureC),
      if (!precipitationMm.isAbsent)
        "precipitationMm": encodeRpcValue(precipitationMm),
      if (!windKph.isAbsent) "windKph": encodeRpcValue(windKph),
    };

  }

}

final class ProjectsDailyReportsGetResultWorkHoursItem implements RpcValue {
  const ProjectsDailyReportsGetResultWorkHoursItem({
    required this.id,
    required this.reportId,
    this.userId,
    required this.hours,
    this.costPerHour,
    required this.contractType,
  });

  static const codec = RpcCodec<ProjectsDailyReportsGetResultWorkHoursItem>(
    ProjectsDailyReportsGetResultWorkHoursItem.fromWire,
  );

  final String id;
  final String reportId;
  final String? userId;
  final num hours;
  final num? costPerHour;
  final UserContractType contractType;

  factory ProjectsDailyReportsGetResultWorkHoursItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "reportId",
      "userId",
      "hours",
      "costPerHour",
      "contractType",
    });

    return ProjectsDailyReportsGetResultWorkHoursItem(
      id: rpcString.decode(readRpcField(object, "id")),
      reportId: rpcString.decode(readRpcField(object, "reportId")),
      userId: rpcNullable(rpcString).decode(readRpcField(object, "userId")),
      hours: rpcNumber.decode(readRpcField(object, "hours")),
      costPerHour: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "costPerHour")),
      contractType: UserContractType.codec.decode(
        readRpcField(object, "contractType"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "reportId": encodeRpcValue(reportId),
      "userId": encodeRpcValue(userId),
      "hours": encodeRpcValue(hours),
      "costPerHour": encodeRpcValue(costPerHour),
      "contractType": encodeRpcValue(contractType),
    };

  }

}

final class ProjectsDailyReportsGetResultPhotosItem implements RpcValue {
  const ProjectsDailyReportsGetResultPhotosItem({
    required this.id,
    required this.projectId,
    required this.fileName,
    required this.mimeType,
    required this.kind,
    this.sizeBytes,
    required this.status,
    required this.thumbnailStatus,
    this.thumbnailExpiresAt,
    this.previewExpiresAt,
    this.thumbnailWidth,
    this.thumbnailHeight,
    this.createdByUserId,
    required this.createdAt,
    this.uploadedAt,
    this.downloadExpiresAt,
    this.downloadAttachmentExpiresAt,
    this.thumbnailUrl = const RpcOptional.absent(),
    this.previewUrl = const RpcOptional.absent(),
    this.downloadUrl = const RpcOptional.absent(),
    this.downloadAttachmentUrl = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsGetResultPhotosItem>(
    ProjectsDailyReportsGetResultPhotosItem.fromWire,
  );

  final String id;
  final String projectId;
  final String fileName;
  final String mimeType;
  final ProjectsFilesListResultItemKind kind;
  final num? sizeBytes;
  final ProjectsFilesListResultItemStatus status;
  final ProjectsFilesListResultItemThumbnailStatus thumbnailStatus;
  final DateTime? thumbnailExpiresAt;
  final DateTime? previewExpiresAt;
  final num? thumbnailWidth;
  final num? thumbnailHeight;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime? uploadedAt;
  final DateTime? downloadExpiresAt;
  final DateTime? downloadAttachmentExpiresAt;
  final RpcOptional<String?> thumbnailUrl;
  final RpcOptional<String?> previewUrl;
  final RpcOptional<String?> downloadUrl;
  final RpcOptional<String?> downloadAttachmentUrl;

  factory ProjectsDailyReportsGetResultPhotosItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "projectId",
      "fileName",
      "mimeType",
      "kind",
      "sizeBytes",
      "status",
      "thumbnailStatus",
      "thumbnailExpiresAt",
      "previewExpiresAt",
      "thumbnailWidth",
      "thumbnailHeight",
      "createdByUserId",
      "createdAt",
      "uploadedAt",
      "downloadExpiresAt",
      "downloadAttachmentExpiresAt",
      "thumbnailUrl",
      "previewUrl",
      "downloadUrl",
      "downloadAttachmentUrl",
    });

    return ProjectsDailyReportsGetResultPhotosItem(
      id: rpcString.decode(readRpcField(object, "id")),
      projectId: rpcString.decode(readRpcField(object, "projectId")),
      fileName: rpcString.decode(readRpcField(object, "fileName")),
      mimeType: rpcString.decode(readRpcField(object, "mimeType")),
      kind: ProjectsFilesListResultItemKind.codec.decode(
        readRpcField(object, "kind"),
      ),
      sizeBytes: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "sizeBytes")),
      status: ProjectsFilesListResultItemStatus.codec.decode(
        readRpcField(object, "status"),
      ),
      thumbnailStatus: ProjectsFilesListResultItemThumbnailStatus.codec.decode(
        readRpcField(object, "thumbnailStatus"),
      ),
      thumbnailExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "thumbnailExpiresAt")),
      previewExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "previewExpiresAt")),
      thumbnailWidth: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "thumbnailWidth")),
      thumbnailHeight: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "thumbnailHeight")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      uploadedAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "uploadedAt")),
      downloadExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "downloadExpiresAt")),
      downloadAttachmentExpiresAt: rpcNullable(rpcDate)
          .decode(readRpcField(object, "downloadAttachmentExpiresAt")),
      thumbnailUrl: readRpcOptionalField(
        object,
        "thumbnailUrl",
        rpcNullable(rpcString).decode,
      ),
      previewUrl: readRpcOptionalField(
        object,
        "previewUrl",
        rpcNullable(rpcString).decode,
      ),
      downloadUrl: readRpcOptionalField(
        object,
        "downloadUrl",
        rpcNullable(rpcString).decode,
      ),
      downloadAttachmentUrl: readRpcOptionalField(
        object,
        "downloadAttachmentUrl",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "projectId": encodeRpcValue(projectId),
      "fileName": encodeRpcValue(fileName),
      "mimeType": encodeRpcValue(mimeType),
      "kind": encodeRpcValue(kind),
      "sizeBytes": encodeRpcValue(sizeBytes),
      "status": encodeRpcValue(status),
      "thumbnailStatus": encodeRpcValue(thumbnailStatus),
      "thumbnailExpiresAt": encodeRpcValue(thumbnailExpiresAt),
      "previewExpiresAt": encodeRpcValue(previewExpiresAt),
      "thumbnailWidth": encodeRpcValue(thumbnailWidth),
      "thumbnailHeight": encodeRpcValue(thumbnailHeight),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "uploadedAt": encodeRpcValue(uploadedAt),
      "downloadExpiresAt": encodeRpcValue(downloadExpiresAt),
      "downloadAttachmentExpiresAt": encodeRpcValue(
        downloadAttachmentExpiresAt,
      ),
      if (!thumbnailUrl.isAbsent) "thumbnailUrl": encodeRpcValue(thumbnailUrl),
      if (!previewUrl.isAbsent) "previewUrl": encodeRpcValue(previewUrl),
      if (!downloadUrl.isAbsent) "downloadUrl": encodeRpcValue(downloadUrl),
      if (!downloadAttachmentUrl.isAbsent)
        "downloadAttachmentUrl": encodeRpcValue(downloadAttachmentUrl),
    };

  }

}

enum ProjectsFilesListResultItemKind implements RpcValue {
  file("file"),
  image("image");

  const ProjectsFilesListResultItemKind(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProjectsFilesListResultItemKind>(
    ProjectsFilesListResultItemKind.fromWire,
  );

  factory ProjectsFilesListResultItemKind.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ProjectsFilesListResultItemStatus implements RpcValue {
  uploaded("uploaded"),
  pending("pending");

  const ProjectsFilesListResultItemStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProjectsFilesListResultItemStatus>(
    ProjectsFilesListResultItemStatus.fromWire,
  );

  factory ProjectsFilesListResultItemStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ProjectsFilesListResultItemThumbnailStatus implements RpcValue {
  none("none"),
  processing("processing"),
  failed("failed"),
  queued("queued"),
  ready("ready");

  const ProjectsFilesListResultItemThumbnailStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProjectsFilesListResultItemThumbnailStatus>(
    ProjectsFilesListResultItemThumbnailStatus.fromWire,
  );

  factory ProjectsFilesListResultItemThumbnailStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class RegieReportsCostsGetResultSpecialRecordsItem implements RpcValue {
  const RegieReportsCostsGetResultSpecialRecordsItem({
    required this.recordId,
    required this.name,
    required this.unit,
    required this.amount,
    this.comment,
  });

  static const codec = RpcCodec<RegieReportsCostsGetResultSpecialRecordsItem>(
    RegieReportsCostsGetResultSpecialRecordsItem.fromWire,
  );

  final String recordId;
  final String name;
  final String unit;
  final num amount;
  final String? comment;

  factory RegieReportsCostsGetResultSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "recordId",
      "name",
      "unit",
      "amount",
      "comment",
    });

    return RegieReportsCostsGetResultSpecialRecordsItem(
      recordId: rpcString.decode(readRpcField(object, "recordId")),
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: rpcNullable(rpcString).decode(readRpcField(object, "comment")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "recordId": encodeRpcValue(recordId),
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportsCostsGetResultWorkHoursItem implements RpcValue {
  const RegieReportsCostsGetResultWorkHoursItem({
    required this.recordId,
    this.userId,
    required this.day,
    required this.hours,
  });

  static const codec = RpcCodec<RegieReportsCostsGetResultWorkHoursItem>(
    RegieReportsCostsGetResultWorkHoursItem.fromWire,
  );

  final String recordId;
  final String? userId;
  final DateTime day;
  final num hours;

  factory RegieReportsCostsGetResultWorkHoursItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "recordId",
      "userId",
      "day",
      "hours",
    });

    return RegieReportsCostsGetResultWorkHoursItem(
      recordId: rpcString.decode(readRpcField(object, "recordId")),
      userId: rpcNullable(rpcString).decode(readRpcField(object, "userId")),
      day: rpcDate.decode(readRpcField(object, "day")),
      hours: rpcNumber.decode(readRpcField(object, "hours")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "recordId": encodeRpcValue(recordId),
      "userId": encodeRpcValue(userId),
      "day": encodeRpcValue(day),
      "hours": encodeRpcValue(hours),
    };

  }

}

enum RemarksListRequestResourceType implements RpcValue {
  customer("customer"),
  project("project"),
  contact("contact"),
  tool("tool");

  const RemarksListRequestResourceType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<RemarksListRequestResourceType>(
    RemarksListRequestResourceType.fromWire,
  );

  factory RemarksListRequestResourceType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class SettingsCostsGetResultFgk implements RpcValue {
  const SettingsCostsGetResultFgk({
    required this.type,
    required this.effectiveAt,
    required this.relativeFactor,
    required this.constant,
  });

  static const codec = RpcCodec<SettingsCostsGetResultFgk>(
    SettingsCostsGetResultFgk.fromWire,
  );

  final SettingsCostsDeleteRequestType type;
  final DateTime effectiveAt;
  final num relativeFactor;
  final num constant;

  factory SettingsCostsGetResultFgk.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "type",
      "effectiveAt",
      "relativeFactor",
      "constant",
    });

    return SettingsCostsGetResultFgk(
      type: SettingsCostsDeleteRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      effectiveAt: rpcDate.decode(readRpcField(object, "effectiveAt")),
      relativeFactor: rpcNumber.decode(readRpcField(object, "relativeFactor")),
      constant: rpcNumber.decode(readRpcField(object, "constant")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "type": encodeRpcValue(type),
      "effectiveAt": encodeRpcValue(effectiveAt),
      "relativeFactor": encodeRpcValue(relativeFactor),
      "constant": encodeRpcValue(constant),
    };

  }

}

final class SettingsCostsGetResultHistoryItem implements RpcValue {
  const SettingsCostsGetResultHistoryItem({
    required this.id,
    required this.type,
    required this.effectiveAt,
    required this.relativeFactor,
    required this.constant,
    this.createdByUserId,
    required this.createdAt,
    required this.modifiedAt,
  });

  static const codec = RpcCodec<SettingsCostsGetResultHistoryItem>(
    SettingsCostsGetResultHistoryItem.fromWire,
  );

  final String id;
  final SettingsCostsDeleteRequestType type;
  final DateTime effectiveAt;
  final num relativeFactor;
  final num constant;
  final String? createdByUserId;
  final DateTime createdAt;
  final DateTime modifiedAt;

  factory SettingsCostsGetResultHistoryItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "type",
      "effectiveAt",
      "relativeFactor",
      "constant",
      "createdByUserId",
      "createdAt",
      "modifiedAt",
    });

    return SettingsCostsGetResultHistoryItem(
      id: rpcString.decode(readRpcField(object, "id")),
      type: SettingsCostsDeleteRequestType.codec.decode(
        readRpcField(object, "type"),
      ),
      effectiveAt: rpcDate.decode(readRpcField(object, "effectiveAt")),
      relativeFactor: rpcNumber.decode(readRpcField(object, "relativeFactor")),
      constant: rpcNumber.decode(readRpcField(object, "constant")),
      createdByUserId: rpcNullable(rpcString)
          .decode(readRpcField(object, "createdByUserId")),
      createdAt: rpcDate.decode(readRpcField(object, "createdAt")),
      modifiedAt: rpcDate.decode(readRpcField(object, "modifiedAt")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "type": encodeRpcValue(type),
      "effectiveAt": encodeRpcValue(effectiveAt),
      "relativeFactor": encodeRpcValue(relativeFactor),
      "constant": encodeRpcValue(constant),
      "createdByUserId": encodeRpcValue(createdByUserId),
      "createdAt": encodeRpcValue(createdAt),
      "modifiedAt": encodeRpcValue(modifiedAt),
    };

  }

}

enum SettingsTenantLogoGetResultStatus implements RpcValue {
  none("none"),
  processing("processing"),
  failed("failed"),
  queued("queued"),
  ready("ready"),
  uploading("uploading");

  const SettingsTenantLogoGetResultStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<SettingsTenantLogoGetResultStatus>(
    SettingsTenantLogoGetResultStatus.fromWire,
  );

  factory SettingsTenantLogoGetResultStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ToolsListRequestStatus implements RpcValue {
  lost("lost"),
  broken("broken"),
  available("available"),
  unavailable("unavailable");

  const ToolsListRequestStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ToolsListRequestStatus>(
    ToolsListRequestStatus.fromWire,
  );

  factory ToolsListRequestStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum ToolsTrackingsTransfersListRequestStatus implements RpcValue {
  open("open"),
  denied("denied"),
  accepted("accepted");

  const ToolsTrackingsTransfersListRequestStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ToolsTrackingsTransfersListRequestStatus>(
    ToolsTrackingsTransfersListRequestStatus.fromWire,
  );

  factory ToolsTrackingsTransfersListRequestStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum UsersVacationsListResultItemType implements RpcValue {
  vacation("vacation"),
  other("other");

  const UsersVacationsListResultItemType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<UsersVacationsListResultItemType>(
    UsersVacationsListResultItemType.fromWire,
  );

  factory UsersVacationsListResultItemType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

enum UsersVacationsListResultItemStatus implements RpcValue {
  denied("denied"),
  requested("requested"),
  approved("approved");

  const UsersVacationsListResultItemStatus(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<UsersVacationsListResultItemStatus>(
    UsersVacationsListResultItemStatus.fromWire,
  );

  factory UsersVacationsListResultItemStatus.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class UsersVacationsListResultItemVacationUsageItem implements RpcValue {
  const UsersVacationsListResultItemVacationUsageItem({
    required this.year,
    this.allowanceDays,
    required this.approvedDays,
    required this.requestedDays,
    this.remainingAfterApproval,
  });

  static const codec = RpcCodec<UsersVacationsListResultItemVacationUsageItem>(
    UsersVacationsListResultItemVacationUsageItem.fromWire,
  );

  final num year;
  final num? allowanceDays;
  final num approvedDays;
  final num requestedDays;
  final num? remainingAfterApproval;

  factory UsersVacationsListResultItemVacationUsageItem.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "year",
      "allowanceDays",
      "approvedDays",
      "requestedDays",
      "remainingAfterApproval",
    });

    return UsersVacationsListResultItemVacationUsageItem(
      year: rpcNumber.decode(readRpcField(object, "year")),
      allowanceDays: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "allowanceDays")),
      approvedDays: rpcNumber.decode(readRpcField(object, "approvedDays")),
      requestedDays: rpcNumber.decode(readRpcField(object, "requestedDays")),
      remainingAfterApproval: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "remainingAfterApproval")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "year": encodeRpcValue(year),
      "allowanceDays": encodeRpcValue(allowanceDays),
      "approvedDays": encodeRpcValue(approvedDays),
      "requestedDays": encodeRpcValue(requestedDays),
      "remainingAfterApproval": encodeRpcValue(remainingAfterApproval),
    };

  }

}

final class AdminDatabasesHostsCreateRequestConnectionDetails
    implements RpcValue {
  const AdminDatabasesHostsCreateRequestConnectionDetails({
    required this.host,
    required this.adminUsername,
    required this.adminPassword,
    this.port = const RpcOptional.absent(),
    this.adminDatabase = const RpcOptional.absent(),
  });

  static const codec =
      RpcCodec<AdminDatabasesHostsCreateRequestConnectionDetails>(
        AdminDatabasesHostsCreateRequestConnectionDetails.fromWire,
      );

  final String host;
  final String adminUsername;
  final String adminPassword;
  final RpcOptional<num> port;
  final RpcOptional<String> adminDatabase;

  factory AdminDatabasesHostsCreateRequestConnectionDetails.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "host",
      "adminUsername",
      "adminPassword",
      "port",
      "adminDatabase",
    });

    return AdminDatabasesHostsCreateRequestConnectionDetails(
      host: rpcString.decode(readRpcField(object, "host")),
      adminUsername: rpcString.decode(readRpcField(object, "adminUsername")),
      adminPassword: rpcString.decode(readRpcField(object, "adminPassword")),
      port: readRpcOptionalField(object, "port", rpcNumber.decode),
      adminDatabase: readRpcOptionalField(
        object,
        "adminDatabase",
        rpcString.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "host": encodeRpcValue(host),
      "adminUsername": encodeRpcValue(adminUsername),
      "adminPassword": encodeRpcValue(adminPassword),
      if (!port.isAbsent) "port": encodeRpcValue(port),
      if (!adminDatabase.isAbsent)
        "adminDatabase": encodeRpcValue(adminDatabase),
    };

  }

}

final class AdminDatabasesHostsCreateRequestBackupDetails implements RpcValue {
  const AdminDatabasesHostsCreateRequestBackupDetails({
    this.enabled = const RpcOptional.absent(),
    this.bucket = const RpcOptional.absent(),
    this.region = const RpcOptional.absent(),
    this.endpoint = const RpcOptional.absent(),
    this.publicBaseUrl = const RpcOptional.absent(),
    this.forcePathStyle = const RpcOptional.absent(),
    this.accessKeyId = const RpcOptional.absent(),
    this.secretAccessKey = const RpcOptional.absent(),
    this.sessionToken = const RpcOptional.absent(),
    this.keyPrefix = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesHostsCreateRequestBackupDetails>(
    AdminDatabasesHostsCreateRequestBackupDetails.fromWire,
  );

  final RpcOptional<bool> enabled;
  final RpcOptional<String?> bucket;
  final RpcOptional<String?> region;
  final RpcOptional<String?> endpoint;
  final RpcOptional<String?> publicBaseUrl;
  final RpcOptional<bool> forcePathStyle;
  final RpcOptional<String?> accessKeyId;
  final RpcOptional<String?> secretAccessKey;
  final RpcOptional<String?> sessionToken;
  final RpcOptional<String?> keyPrefix;

  factory AdminDatabasesHostsCreateRequestBackupDetails.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "enabled",
      "bucket",
      "region",
      "endpoint",
      "publicBaseUrl",
      "forcePathStyle",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "keyPrefix",
    });

    return AdminDatabasesHostsCreateRequestBackupDetails(
      enabled: readRpcOptionalField(object, "enabled", rpcBoolean.decode),
      bucket: readRpcOptionalField(
        object,
        "bucket",
        rpcNullable(rpcString).decode,
      ),
      region: readRpcOptionalField(
        object,
        "region",
        rpcNullable(rpcString).decode,
      ),
      endpoint: readRpcOptionalField(
        object,
        "endpoint",
        rpcNullable(rpcString).decode,
      ),
      publicBaseUrl: readRpcOptionalField(
        object,
        "publicBaseUrl",
        rpcNullable(rpcString).decode,
      ),
      forcePathStyle: readRpcOptionalField(
        object,
        "forcePathStyle",
        rpcBoolean.decode,
      ),
      accessKeyId: readRpcOptionalField(
        object,
        "accessKeyId",
        rpcNullable(rpcString).decode,
      ),
      secretAccessKey: readRpcOptionalField(
        object,
        "secretAccessKey",
        rpcNullable(rpcString).decode,
      ),
      sessionToken: readRpcOptionalField(
        object,
        "sessionToken",
        rpcNullable(rpcString).decode,
      ),
      keyPrefix: readRpcOptionalField(
        object,
        "keyPrefix",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!enabled.isAbsent) "enabled": encodeRpcValue(enabled),
      if (!bucket.isAbsent) "bucket": encodeRpcValue(bucket),
      if (!region.isAbsent) "region": encodeRpcValue(region),
      if (!endpoint.isAbsent) "endpoint": encodeRpcValue(endpoint),
      if (!publicBaseUrl.isAbsent)
        "publicBaseUrl": encodeRpcValue(publicBaseUrl),
      if (!forcePathStyle.isAbsent)
        "forcePathStyle": encodeRpcValue(forcePathStyle),
      if (!accessKeyId.isAbsent) "accessKeyId": encodeRpcValue(accessKeyId),
      if (!secretAccessKey.isAbsent)
        "secretAccessKey": encodeRpcValue(secretAccessKey),
      if (!sessionToken.isAbsent) "sessionToken": encodeRpcValue(sessionToken),
      if (!keyPrefix.isAbsent) "keyPrefix": encodeRpcValue(keyPrefix),
    };

  }

}

final class AdminDatabasesHostsUpdateRequestData implements RpcValue {
  const AdminDatabasesHostsUpdateRequestData({
    this.name = const RpcOptional.absent(),
    this.connectionDetails = const RpcOptional.absent(),
    this.backupDetails = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminDatabasesHostsUpdateRequestData>(
    AdminDatabasesHostsUpdateRequestData.fromWire,
  );

  final RpcOptional<String?> name;
  final RpcOptional<AdminDatabasesHostsCreateRequestConnectionDetails?>
  connectionDetails;
  final RpcOptional<AdminDatabasesHostsCreateRequestBackupDetails?>
  backupDetails;

  factory AdminDatabasesHostsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "connectionDetails",
      "backupDetails",
    });

    return AdminDatabasesHostsUpdateRequestData(
      name: readRpcOptionalField(object, "name", rpcNullable(rpcString).decode),
      connectionDetails: readRpcOptionalField(
        object,
        "connectionDetails",
        rpcNullable(AdminDatabasesHostsCreateRequestConnectionDetails.codec)
            .decode,
      ),
      backupDetails: readRpcOptionalField(
        object,
        "backupDetails",
        rpcNullable(AdminDatabasesHostsCreateRequestBackupDetails.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!name.isAbsent) "name": encodeRpcValue(name),
      if (!connectionDetails.isAbsent)
        "connectionDetails": encodeRpcValue(connectionDetails),
      if (!backupDetails.isAbsent)
        "backupDetails": encodeRpcValue(backupDetails),
    };

  }

}

final class AdminDatabasesUpdateRetentionRequestData implements RpcValue {
  const AdminDatabasesUpdateRetentionRequestData({
    required this.retentionDaily,
    required this.retentionWeekly,
    required this.retentionMonthly,
    required this.retentionYearly,
  });

  static const codec = RpcCodec<AdminDatabasesUpdateRetentionRequestData>(
    AdminDatabasesUpdateRetentionRequestData.fromWire,
  );

  final num retentionDaily;
  final num retentionWeekly;
  final num retentionMonthly;
  final num retentionYearly;

  factory AdminDatabasesUpdateRetentionRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "retentionDaily",
      "retentionWeekly",
      "retentionMonthly",
      "retentionYearly",
    });

    return AdminDatabasesUpdateRetentionRequestData(
      retentionDaily: rpcNumber.decode(readRpcField(object, "retentionDaily")),
      retentionWeekly: rpcNumber.decode(
        readRpcField(object, "retentionWeekly"),
      ),
      retentionMonthly: rpcNumber.decode(
        readRpcField(object, "retentionMonthly"),
      ),
      retentionYearly: rpcNumber.decode(
        readRpcField(object, "retentionYearly"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "retentionDaily": encodeRpcValue(retentionDaily),
      "retentionWeekly": encodeRpcValue(retentionWeekly),
      "retentionMonthly": encodeRpcValue(retentionMonthly),
      "retentionYearly": encodeRpcValue(retentionYearly),
    };

  }

}

final class AdminTenantsCreateRequestConnectionDetails implements RpcValue {
  const AdminTenantsCreateRequestConnectionDetails({
    this.postgresDSN = const RpcOptional.absent(),
    this.postgresDatabaseId = const RpcOptional.absent(),
    this.objectStorage = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsCreateRequestConnectionDetails>(
    AdminTenantsCreateRequestConnectionDetails.fromWire,
  );

  final RpcOptional<String?> postgresDSN;
  final RpcOptional<String?> postgresDatabaseId;
  final RpcOptional<AdminTenantsCreateRequestConnectionDetSchemaDae779de?>
  objectStorage;

  factory AdminTenantsCreateRequestConnectionDetails.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "postgresDSN",
      "postgresDatabaseId",
      "objectStorage",
    });

    return AdminTenantsCreateRequestConnectionDetails(
      postgresDSN: readRpcOptionalField(
        object,
        "postgresDSN",
        rpcNullable(rpcString).decode,
      ),
      postgresDatabaseId: readRpcOptionalField(
        object,
        "postgresDatabaseId",
        rpcNullable(rpcString).decode,
      ),
      objectStorage: readRpcOptionalField(
        object,
        "objectStorage",
        rpcNullable(AdminTenantsCreateRequestConnectionDetSchemaDae779de.codec)
            .decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!postgresDSN.isAbsent) "postgresDSN": encodeRpcValue(postgresDSN),
      if (!postgresDatabaseId.isAbsent)
        "postgresDatabaseId": encodeRpcValue(postgresDatabaseId),
      if (!objectStorage.isAbsent)
        "objectStorage": encodeRpcValue(objectStorage),
    };

  }

}

final class AdminTenantsUpdateRequestData implements RpcValue {
  const AdminTenantsUpdateRequestData({
    this.contactDetails = const RpcOptional.absent(),
    this.connectionDetails = const RpcOptional.absent(),
    this.options = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsUpdateRequestData>(
    AdminTenantsUpdateRequestData.fromWire,
  );

  final RpcOptional<AdminTenantsGetResultContactDetails> contactDetails;
  final RpcOptional<AdminTenantsCreateRequestConnectionDetails>
  connectionDetails;
  final RpcOptional<AdminTenantsGetResultOptions> options;

  factory AdminTenantsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "contact_details",
      "connection_details",
      "options",
    });

    return AdminTenantsUpdateRequestData(
      contactDetails: readRpcOptionalField(
        object,
        "contact_details",
        AdminTenantsGetResultContactDetails.codec.decode,
      ),
      connectionDetails: readRpcOptionalField(
        object,
        "connection_details",
        AdminTenantsCreateRequestConnectionDetails.codec.decode,
      ),
      options: readRpcOptionalField(
        object,
        "options",
        AdminTenantsGetResultOptions.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!contactDetails.isAbsent)
        "contact_details": encodeRpcValue(contactDetails),
      if (!connectionDetails.isAbsent)
        "connection_details": encodeRpcValue(connectionDetails),
      if (!options.isAbsent) "options": encodeRpcValue(options),
    };

  }

}

final class AuthPasskeysLoginRequestCredential implements RpcValue {
  const AuthPasskeysLoginRequestCredential({
    required this.id,
    required this.rawId,
    required this.type,
    required this.response,
  });

  static const codec = RpcCodec<AuthPasskeysLoginRequestCredential>(
    AuthPasskeysLoginRequestCredential.fromWire,
  );

  final String id;
  final String rawId;
  final String type;
  final AuthPasskeysLoginRequestCredentialResponse response;

  factory AuthPasskeysLoginRequestCredential.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "rawId",
      "type",
      "response",
    });

    return AuthPasskeysLoginRequestCredential(
      id: rpcString.decode(readRpcField(object, "id")),
      rawId: rpcString.decode(readRpcField(object, "rawId")),
      type: rpcLiteral<String>("public-key")
          .decode(readRpcField(object, "type")),
      response: AuthPasskeysLoginRequestCredentialResponse.codec.decode(
        readRpcField(object, "response"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "rawId": encodeRpcValue(rawId),
      "type": encodeRpcValue(type),
      "response": encodeRpcValue(response),
    };

  }

}

final class AuthPasskeysLoginOptionsResultOptions implements RpcValue {
  const AuthPasskeysLoginOptionsResultOptions({
    required this.challenge,
    required this.rpId,
    required this.allowCredentials,
    required this.timeout,
    required this.userVerification,
  });

  static const codec = RpcCodec<AuthPasskeysLoginOptionsResultOptions>(
    AuthPasskeysLoginOptionsResultOptions.fromWire,
  );

  final String challenge;
  final String rpId;
  final List<AuthPasskeysLoginOptionsResultOptionsASchema257eefa0>
  allowCredentials;
  final num timeout;
  final String userVerification;

  factory AuthPasskeysLoginOptionsResultOptions.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "challenge",
      "rpId",
      "allowCredentials",
      "timeout",
      "userVerification",
    });

    return AuthPasskeysLoginOptionsResultOptions(
      challenge: rpcString.decode(readRpcField(object, "challenge")),
      rpId: rpcString.decode(readRpcField(object, "rpId")),
      allowCredentials: rpcArray(
        AuthPasskeysLoginOptionsResultOptionsASchema257eefa0.codec,
      ).decode(readRpcField(object, "allowCredentials")),
      timeout: rpcNumber.decode(readRpcField(object, "timeout")),
      userVerification: rpcLiteral<String>("required")
          .decode(readRpcField(object, "userVerification")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challenge": encodeRpcValue(challenge),
      "rpId": encodeRpcValue(rpId),
      "allowCredentials": encodeRpcValue(allowCredentials),
      "timeout": encodeRpcValue(timeout),
      "userVerification": encodeRpcValue(userVerification),
    };

  }

}

final class AuthPasskeysRegisterRequestCredential implements RpcValue {
  const AuthPasskeysRegisterRequestCredential({
    required this.id,
    required this.rawId,
    required this.type,
    required this.response,
    this.transports = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AuthPasskeysRegisterRequestCredential>(
    AuthPasskeysRegisterRequestCredential.fromWire,
  );

  final String id;
  final String rawId;
  final String type;
  final AuthPasskeysRegisterRequestCredentialResponse response;
  final RpcOptional<List<String>> transports;

  factory AuthPasskeysRegisterRequestCredential.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "id",
      "rawId",
      "type",
      "response",
      "transports",
    });

    return AuthPasskeysRegisterRequestCredential(
      id: rpcString.decode(readRpcField(object, "id")),
      rawId: rpcString.decode(readRpcField(object, "rawId")),
      type: rpcLiteral<String>("public-key")
          .decode(readRpcField(object, "type")),
      response: AuthPasskeysRegisterRequestCredentialResponse.codec.decode(
        readRpcField(object, "response"),
      ),
      transports: readRpcOptionalField(
        object,
        "transports",
        rpcArray(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "rawId": encodeRpcValue(rawId),
      "type": encodeRpcValue(type),
      "response": encodeRpcValue(response),
      if (!transports.isAbsent) "transports": encodeRpcValue(transports),
    };

  }

}

final class AuthPasskeysRegisterOptionsResultOptions implements RpcValue {
  const AuthPasskeysRegisterOptionsResultOptions({
    required this.challenge,
    required this.rp,
    required this.user,
    required this.pubKeyCredParams,
    required this.timeout,
    required this.attestation,
    required this.authenticatorSelection,
    required this.excludeCredentials,
  });

  static const codec = RpcCodec<AuthPasskeysRegisterOptionsResultOptions>(
    AuthPasskeysRegisterOptionsResultOptions.fromWire,
  );

  final String challenge;
  final AdminLlmProvidersModelsResultItem rp;
  final AuthPasskeysRegisterOptionsResultOptionsUser user;
  final List<AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77>
  pubKeyCredParams;
  final num timeout;
  final String attestation;
  final AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4
  authenticatorSelection;
  final List<AuthPasskeysLoginOptionsResultOptionsASchema257eefa0>
  excludeCredentials;

  factory AuthPasskeysRegisterOptionsResultOptions.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "challenge",
      "rp",
      "user",
      "pubKeyCredParams",
      "timeout",
      "attestation",
      "authenticatorSelection",
      "excludeCredentials",
    });

    return AuthPasskeysRegisterOptionsResultOptions(
      challenge: rpcString.decode(readRpcField(object, "challenge")),
      rp: AdminLlmProvidersModelsResultItem.codec.decode(
        readRpcField(object, "rp"),
      ),
      user: AuthPasskeysRegisterOptionsResultOptionsUser.codec.decode(
        readRpcField(object, "user"),
      ),
      pubKeyCredParams: rpcArray(
        AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77.codec,
      ).decode(readRpcField(object, "pubKeyCredParams")),
      timeout: rpcNumber.decode(readRpcField(object, "timeout")),
      attestation: rpcLiteral<String>("none")
          .decode(readRpcField(object, "attestation")),
      authenticatorSelection:
          AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4.codec.decode(
            readRpcField(object, "authenticatorSelection"),
          ),
      excludeCredentials: rpcArray(
        AuthPasskeysLoginOptionsResultOptionsASchema257eefa0.codec,
      ).decode(readRpcField(object, "excludeCredentials")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "challenge": encodeRpcValue(challenge),
      "rp": encodeRpcValue(rp),
      "user": encodeRpcValue(user),
      "pubKeyCredParams": encodeRpcValue(pubKeyCredParams),
      "timeout": encodeRpcValue(timeout),
      "attestation": encodeRpcValue(attestation),
      "authenticatorSelection": encodeRpcValue(authenticatorSelection),
      "excludeCredentials": encodeRpcValue(excludeCredentials),
    };

  }

}

final class ClientScriptsUpdateRequestData implements RpcValue {
  const ClientScriptsUpdateRequestData({
    this.name = const RpcOptional.absent(),
    this.description = const RpcOptional.absent(),
    this.code = const RpcOptional.absent(),
    this.enabled = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ClientScriptsUpdateRequestData>(
    ClientScriptsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> name;
  final RpcOptional<String?> description;
  final RpcOptional<String> code;
  final RpcOptional<bool> enabled;

  factory ClientScriptsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "description",
      "code",
      "enabled",
    });

    return ClientScriptsUpdateRequestData(
      name: readRpcOptionalField(object, "name", rpcString.decode),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
      code: readRpcOptionalField(object, "code", rpcString.decode),
      enabled: readRpcOptionalField(object, "enabled", rpcBoolean.decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!name.isAbsent) "name": encodeRpcValue(name),
      if (!description.isAbsent) "description": encodeRpcValue(description),
      if (!code.isAbsent) "code": encodeRpcValue(code),
      if (!enabled.isAbsent) "enabled": encodeRpcValue(enabled),
    };

  }

}

final class CustomersUpdateRequestData implements RpcValue {
  const CustomersUpdateRequestData({
    this.salutation = const RpcOptional.absent(),
    this.name = const RpcOptional.absent(),
    this.address = const RpcOptional.absent(),
    this.phoneNumbers = const RpcOptional.absent(),
    this.emailAddresses = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<CustomersUpdateRequestData>(
    CustomersUpdateRequestData.fromWire,
  );

  final RpcOptional<String?> salutation;
  final RpcOptional<String> name;
  final RpcOptional<ProjectAddress?> address;
  final RpcOptional<List<CustomerPhoneNumbersItem>> phoneNumbers;
  final RpcOptional<List<CustomerEmailAddressesItem>> emailAddresses;

  factory CustomersUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "salutation",
      "name",
      "address",
      "phoneNumbers",
      "emailAddresses",
    });

    return CustomersUpdateRequestData(
      salutation: readRpcOptionalField(
        object,
        "salutation",
        rpcNullable(rpcString).decode,
      ),
      name: readRpcOptionalField(object, "name", rpcString.decode),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(ProjectAddress.codec).decode,
      ),
      phoneNumbers: readRpcOptionalField(
        object,
        "phoneNumbers",
        rpcArray(CustomerPhoneNumbersItem.codec).decode,
      ),
      emailAddresses: readRpcOptionalField(
        object,
        "emailAddresses",
        rpcArray(CustomerEmailAddressesItem.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!salutation.isAbsent) "salutation": encodeRpcValue(salutation),
      if (!name.isAbsent) "name": encodeRpcValue(name),
      if (!address.isAbsent) "address": encodeRpcValue(address),
      if (!phoneNumbers.isAbsent) "phoneNumbers": encodeRpcValue(phoneNumbers),
      if (!emailAddresses.isAbsent)
        "emailAddresses": encodeRpcValue(emailAddresses),
    };

  }

}

final class DeliveryNotesCreateRequestRecordsItem implements RpcValue {
  const DeliveryNotesCreateRequestRecordsItem({
    required this.productId,
    required this.quantity,
    this.unit = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<DeliveryNotesCreateRequestRecordsItem>(
    DeliveryNotesCreateRequestRecordsItem.fromWire,
  );

  final String productId;
  final num quantity;
  final RpcOptional<String?> unit;
  final RpcOptional<String?> comment;

  factory DeliveryNotesCreateRequestRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "quantity",
      "unit",
      "comment",
    });

    return DeliveryNotesCreateRequestRecordsItem(
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      unit: readRpcOptionalField(object, "unit", rpcNullable(rpcString).decode),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      if (!unit.isAbsent) "unit": encodeRpcValue(unit),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class DeliveryNotesCreateRequestSpecialRecordsItem implements RpcValue {
  const DeliveryNotesCreateRequestSpecialRecordsItem({
    required this.name,
    required this.unit,
    required this.amount,
    this.pricePerUnit,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<DeliveryNotesCreateRequestSpecialRecordsItem>(
    DeliveryNotesCreateRequestSpecialRecordsItem.fromWire,
  );

  final String name;
  final String unit;
  final num amount;
  final num? pricePerUnit;
  final RpcOptional<String?> comment;

  factory DeliveryNotesCreateRequestSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "unit",
      "amount",
      "pricePerUnit",
      "comment",
    });

    return DeliveryNotesCreateRequestSpecialRecordsItem(
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      pricePerUnit: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "pricePerUnit")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      "pricePerUnit": encodeRpcValue(pricePerUnit),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class DeliveryNotesUpdateRequestData implements RpcValue {
  const DeliveryNotesUpdateRequestData({
    this.projectId = const RpcOptional.absent(),
    this.effectiveTimestamp = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
    this.records = const RpcOptional.absent(),
    this.specialRecords = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<DeliveryNotesUpdateRequestData>(
    DeliveryNotesUpdateRequestData.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<DateTime?> effectiveTimestamp;
  final RpcOptional<String?> comment;
  final RpcOptional<List<DeliveryNotesCreateRequestRecordsItem>?> records;
  final RpcOptional<List<DeliveryNotesCreateRequestSpecialRecordsItem>?>
  specialRecords;

  factory DeliveryNotesUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "effectiveTimestamp",
      "comment",
      "records",
      "specialRecords",
    });

    return DeliveryNotesUpdateRequestData(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      effectiveTimestamp: readRpcOptionalField(
        object,
        "effectiveTimestamp",
        rpcNullable(rpcDate).decode,
      ),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
      records: readRpcOptionalField(
        object,
        "records",
        rpcNullable(rpcArray(DeliveryNotesCreateRequestRecordsItem.codec))
            .decode,
      ),
      specialRecords: readRpcOptionalField(
        object,
        "specialRecords",
        rpcNullable(
          rpcArray(DeliveryNotesCreateRequestSpecialRecordsItem.codec),
        ).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!effectiveTimestamp.isAbsent)
        "effectiveTimestamp": encodeRpcValue(effectiveTimestamp),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
      if (!records.isAbsent) "records": encodeRpcValue(records),
      if (!specialRecords.isAbsent)
        "specialRecords": encodeRpcValue(specialRecords),
    };

  }

}

final class OfficeExportsCreateUploadResultUploadHeaders implements RpcValue {
  const OfficeExportsCreateUploadResultUploadHeaders(this.values);

  static const codec = RpcCodec<OfficeExportsCreateUploadResultUploadHeaders>(
    OfficeExportsCreateUploadResultUploadHeaders.fromWire,
  );

  final Map<String, String> values;

  factory OfficeExportsCreateUploadResultUploadHeaders.fromWire(Object? value) {
    final decoded = readRpcRecord(value, rpcString.decode);

    return OfficeExportsCreateUploadResultUploadHeaders(decoded);
  }

  @override
  JsonMap toWire() {
    return {
      for (final entry in values.entries)
        entry.key: encodeRpcValue(entry.value),
    };

  }

}

final class ProductsPriceRecordsUpdateRequestData implements RpcValue {
  const ProductsPriceRecordsUpdateRequestData({
    this.productId = const RpcOptional.absent(),
    this.vendorId = const RpcOptional.absent(),
    this.pricePerBaseUnit = const RpcOptional.absent(),
    this.timestamp = const RpcOptional.absent(),
    this.isRealPurchase = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsPriceRecordsUpdateRequestData>(
    ProductsPriceRecordsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> productId;
  final RpcOptional<String?> vendorId;
  final RpcOptional<num> pricePerBaseUnit;
  final RpcOptional<DateTime> timestamp;
  final RpcOptional<bool> isRealPurchase;
  final RpcOptional<String?> comment;

  factory ProductsPriceRecordsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "vendorId",
      "pricePerBaseUnit",
      "timestamp",
      "isRealPurchase",
      "comment",
    });

    return ProductsPriceRecordsUpdateRequestData(
      productId: readRpcOptionalField(object, "productId", rpcString.decode),
      vendorId: readRpcOptionalField(
        object,
        "vendorId",
        rpcNullable(rpcString).decode,
      ),
      pricePerBaseUnit: readRpcOptionalField(
        object,
        "pricePerBaseUnit",
        rpcNumber.decode,
      ),
      timestamp: readRpcOptionalField(object, "timestamp", rpcDate.decode),
      isRealPurchase: readRpcOptionalField(
        object,
        "isRealPurchase",
        rpcBoolean.decode,
      ),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!productId.isAbsent) "productId": encodeRpcValue(productId),
      if (!vendorId.isAbsent) "vendorId": encodeRpcValue(vendorId),
      if (!pricePerBaseUnit.isAbsent)
        "pricePerBaseUnit": encodeRpcValue(pricePerBaseUnit),
      if (!timestamp.isAbsent) "timestamp": encodeRpcValue(timestamp),
      if (!isRealPurchase.isAbsent)
        "isRealPurchase": encodeRpcValue(isRealPurchase),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ProductsUpdateRequestData implements RpcValue {
  const ProductsUpdateRequestData({
    this.customId = const RpcOptional.absent(),
    this.name = const RpcOptional.absent(),
    this.brand = const RpcOptional.absent(),
    this.description = const RpcOptional.absent(),
    this.regieReportName = const RpcOptional.absent(),
    this.baseUnit = const RpcOptional.absent(),
    this.otherUnits = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsUpdateRequestData>(
    ProductsUpdateRequestData.fromWire,
  );

  final RpcOptional<num> customId;
  final RpcOptional<String> name;
  final RpcOptional<String?> brand;
  final RpcOptional<String?> description;
  final RpcOptional<String?> regieReportName;
  final RpcOptional<String> baseUnit;
  final RpcOptional<ApplyPriceImportRowOtherUnits> otherUnits;

  factory ProductsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "customId",
      "name",
      "brand",
      "description",
      "regieReportName",
      "baseUnit",
      "otherUnits",
    });

    return ProductsUpdateRequestData(
      customId: readRpcOptionalField(object, "customId", rpcNumber.decode),
      name: readRpcOptionalField(object, "name", rpcString.decode),
      brand: readRpcOptionalField(
        object,
        "brand",
        rpcNullable(rpcString).decode,
      ),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
      regieReportName: readRpcOptionalField(
        object,
        "regieReportName",
        rpcNullable(rpcString).decode,
      ),
      baseUnit: readRpcOptionalField(object, "baseUnit", rpcString.decode),
      otherUnits: readRpcOptionalField(
        object,
        "otherUnits",
        ApplyPriceImportRowOtherUnits.codec.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!customId.isAbsent) "customId": encodeRpcValue(customId),
      if (!name.isAbsent) "name": encodeRpcValue(name),
      if (!brand.isAbsent) "brand": encodeRpcValue(brand),
      if (!description.isAbsent) "description": encodeRpcValue(description),
      if (!regieReportName.isAbsent)
        "regieReportName": encodeRpcValue(regieReportName),
      if (!baseUnit.isAbsent) "baseUnit": encodeRpcValue(baseUnit),
      if (!otherUnits.isAbsent) "otherUnits": encodeRpcValue(otherUnits),
    };

  }

}

final class ProductsVendorsUpdateRequestData implements RpcValue {
  const ProductsVendorsUpdateRequestData({
    this.name = const RpcOptional.absent(),
    this.description = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProductsVendorsUpdateRequestData>(
    ProductsVendorsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> name;
  final RpcOptional<String?> description;

  factory ProductsVendorsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {"name", "description"});

    return ProductsVendorsUpdateRequestData(
      name: readRpcOptionalField(object, "name", rpcString.decode),
      description: readRpcOptionalField(
        object,
        "description",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!name.isAbsent) "name": encodeRpcValue(name),
      if (!description.isAbsent) "description": encodeRpcValue(description),
    };

  }

}

final class ProjectsContactsSetRequestContactsItem implements RpcValue {
  const ProjectsContactsSetRequestContactsItem({
    required this.contactId,
    this.label = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsContactsSetRequestContactsItem>(
    ProjectsContactsSetRequestContactsItem.fromWire,
  );

  final String contactId;
  final RpcOptional<String?> label;

  factory ProjectsContactsSetRequestContactsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"contactId", "label"});

    return ProjectsContactsSetRequestContactsItem(
      contactId: rpcString.decode(readRpcField(object, "contactId")),
      label: readRpcOptionalField(
        object,
        "label",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "contactId": encodeRpcValue(contactId),
      if (!label.isAbsent) "label": encodeRpcValue(label),
    };

  }

}

enum ProjectsCostsEntriesCreateRequestType implements RpcValue {
  offer("offer"),
  invoice("invoice");

  const ProjectsCostsEntriesCreateRequestType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<ProjectsCostsEntriesCreateRequestType>(
    ProjectsCostsEntriesCreateRequestType.fromWire,
  );

  factory ProjectsCostsEntriesCreateRequestType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ProjectsCostsEntriesUpdateRequestData implements RpcValue {
  const ProjectsCostsEntriesUpdateRequestData({
    required this.amount,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsCostsEntriesUpdateRequestData>(
    ProjectsCostsEntriesUpdateRequestData.fromWire,
  );

  final num amount;
  final RpcOptional<String?> comment;

  factory ProjectsCostsEntriesUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {"amount", "comment"});

    return ProjectsCostsEntriesUpdateRequestData(
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "amount": encodeRpcValue(amount),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ProjectsDailyReportsCreateRequestWorkHoursItem implements RpcValue {
  const ProjectsDailyReportsCreateRequestWorkHoursItem({
    required this.hours,
    this.costPerHour,
    this.userId = const RpcOptional.absent(),
    this.contractType = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsCreateRequestWorkHoursItem>(
    ProjectsDailyReportsCreateRequestWorkHoursItem.fromWire,
  );

  final num hours;
  final num? costPerHour;
  final RpcOptional<String?> userId;
  final RpcOptional<UserContractType?> contractType;

  factory ProjectsDailyReportsCreateRequestWorkHoursItem.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "hours",
      "costPerHour",
      "userId",
      "contractType",
    });

    return ProjectsDailyReportsCreateRequestWorkHoursItem(
      hours: rpcNumber.decode(readRpcField(object, "hours")),
      costPerHour: rpcNullable(rpcNumber)
          .decode(readRpcField(object, "costPerHour")),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
      contractType: readRpcOptionalField(
        object,
        "contractType",
        rpcNullable(UserContractType.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "hours": encodeRpcValue(hours),
      "costPerHour": encodeRpcValue(costPerHour),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
      if (!contractType.isAbsent) "contractType": encodeRpcValue(contractType),
    };

  }

}

final class ProjectsDailyReportsUpdateRequestData implements RpcValue {
  const ProjectsDailyReportsUpdateRequestData({
    this.day = const RpcOptional.absent(),
    this.summary = const RpcOptional.absent(),
    this.weather = const RpcOptional.absent(),
    this.workHours = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDailyReportsUpdateRequestData>(
    ProjectsDailyReportsUpdateRequestData.fromWire,
  );

  final RpcOptional<Object?> day;
  final RpcOptional<String?> summary;
  final RpcOptional<ProjectsDailyReportsGetResultWeather?> weather;
  final RpcOptional<List<ProjectsDailyReportsCreateRequestWorkHoursItem>?>
  workHours;

  factory ProjectsDailyReportsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "day",
      "summary",
      "weather",
      "workHours",
    });

    return ProjectsDailyReportsUpdateRequestData(
      day: readRpcOptionalField(object, "day", rpcUnknown.decode),
      summary: readRpcOptionalField(
        object,
        "summary",
        rpcNullable(rpcString).decode,
      ),
      weather: readRpcOptionalField(
        object,
        "weather",
        rpcNullable(ProjectsDailyReportsGetResultWeather.codec).decode,
      ),
      workHours: readRpcOptionalField(
        object,
        "workHours",
        rpcNullable(
          rpcArray(ProjectsDailyReportsCreateRequestWorkHoursItem.codec),
        ).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!day.isAbsent) "day": encodeRpcValue(day),
      if (!summary.isAbsent) "summary": encodeRpcValue(summary),
      if (!weather.isAbsent) "weather": encodeRpcValue(weather),
      if (!workHours.isAbsent) "workHours": encodeRpcValue(workHours),
    };

  }

}

final class ProjectsDeploymentsUpdateRequestData implements RpcValue {
  const ProjectsDeploymentsUpdateRequestData({
    this.projectId = const RpcOptional.absent(),
    this.userId = const RpcOptional.absent(),
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
    this.note = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsDeploymentsUpdateRequestData>(
    ProjectsDeploymentsUpdateRequestData.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<String?> userId;
  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;
  final RpcOptional<String?> note;

  factory ProjectsDeploymentsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "userId",
      "from",
      "to",
      "note",
    });

    return ProjectsDeploymentsUpdateRequestData(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
      note: readRpcOptionalField(object, "note", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
      if (!note.isAbsent) "note": encodeRpcValue(note),
    };

  }

}

final class ProjectsUnavailabilityUpdateRequestData implements RpcValue {
  const ProjectsUnavailabilityUpdateRequestData({
    this.projectId = const RpcOptional.absent(),
    this.from = const RpcOptional.absent(),
    this.to = const RpcOptional.absent(),
    this.reason = const RpcOptional.absent(),
    this.note = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsUnavailabilityUpdateRequestData>(
    ProjectsUnavailabilityUpdateRequestData.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<Object?> from;
  final RpcOptional<Object?> to;
  final RpcOptional<String?> reason;
  final RpcOptional<String?> note;

  factory ProjectsUnavailabilityUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "from",
      "to",
      "reason",
      "note",
    });

    return ProjectsUnavailabilityUpdateRequestData(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      from: readRpcOptionalField(object, "from", rpcUnknown.decode),
      to: readRpcOptionalField(object, "to", rpcUnknown.decode),
      reason: readRpcOptionalField(
        object,
        "reason",
        rpcNullable(rpcString).decode,
      ),
      note: readRpcOptionalField(object, "note", rpcNullable(rpcString).decode),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!from.isAbsent) "from": encodeRpcValue(from),
      if (!to.isAbsent) "to": encodeRpcValue(to),
      if (!reason.isAbsent) "reason": encodeRpcValue(reason),
      if (!note.isAbsent) "note": encodeRpcValue(note),
    };

  }

}

final class ProjectsUpdateRequestData implements RpcValue {
  const ProjectsUpdateRequestData({
    this.title = const RpcOptional.absent(),
    this.address = const RpcOptional.absent(),
    this.customerId = const RpcOptional.absent(),
    this.responsibleProjectLeaderUserId = const RpcOptional.absent(),
    this.orderReceivedAt = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ProjectsUpdateRequestData>(
    ProjectsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> title;
  final RpcOptional<ProjectAddress?> address;
  final RpcOptional<String?> customerId;
  final RpcOptional<String?> responsibleProjectLeaderUserId;
  final RpcOptional<DateTime?> orderReceivedAt;

  factory ProjectsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "title",
      "address",
      "customerId",
      "responsibleProjectLeaderUserId",
      "orderReceivedAt",
    });

    return ProjectsUpdateRequestData(
      title: readRpcOptionalField(object, "title", rpcString.decode),
      address: readRpcOptionalField(
        object,
        "address",
        rpcNullable(ProjectAddress.codec).decode,
      ),
      customerId: readRpcOptionalField(
        object,
        "customerId",
        rpcNullable(rpcString).decode,
      ),
      responsibleProjectLeaderUserId: readRpcOptionalField(
        object,
        "responsibleProjectLeaderUserId",
        rpcNullable(rpcString).decode,
      ),
      orderReceivedAt: readRpcOptionalField(
        object,
        "orderReceivedAt",
        rpcNullable(rpcDate).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!title.isAbsent) "title": encodeRpcValue(title),
      if (!address.isAbsent) "address": encodeRpcValue(address),
      if (!customerId.isAbsent) "customerId": encodeRpcValue(customerId),
      if (!responsibleProjectLeaderUserId.isAbsent)
        "responsibleProjectLeaderUserId": encodeRpcValue(
          responsibleProjectLeaderUserId,
        ),
      if (!orderReceivedAt.isAbsent)
        "orderReceivedAt": encodeRpcValue(orderReceivedAt),
    };

  }

}

final class RegieReportsCreateRequestProductsItem implements RpcValue {
  const RegieReportsCreateRequestProductsItem({
    required this.productId,
    required this.quantity,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsCreateRequestProductsItem>(
    RegieReportsCreateRequestProductsItem.fromWire,
  );

  final String productId;
  final num quantity;
  final RpcOptional<String?> comment;

  factory RegieReportsCreateRequestProductsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "productId",
      "quantity",
      "comment",
    });

    return RegieReportsCreateRequestProductsItem(
      productId: rpcString.decode(readRpcField(object, "productId")),
      quantity: rpcNumber.decode(readRpcField(object, "quantity")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "productId": encodeRpcValue(productId),
      "quantity": encodeRpcValue(quantity),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportsCreateRequestSpecialRecordsItem implements RpcValue {
  const RegieReportsCreateRequestSpecialRecordsItem({
    required this.name,
    required this.unit,
    required this.amount,
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsCreateRequestSpecialRecordsItem>(
    RegieReportsCreateRequestSpecialRecordsItem.fromWire,
  );

  final String name;
  final String unit;
  final num amount;
  final RpcOptional<String?> comment;

  factory RegieReportsCreateRequestSpecialRecordsItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "name",
      "unit",
      "amount",
      "comment",
    });

    return RegieReportsCreateRequestSpecialRecordsItem(
      name: rpcString.decode(readRpcField(object, "name")),
      unit: rpcString.decode(readRpcField(object, "unit")),
      amount: rpcNumber.decode(readRpcField(object, "amount")),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "name": encodeRpcValue(name),
      "unit": encodeRpcValue(unit),
      "amount": encodeRpcValue(amount),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class RegieReportsCreateRequestWorkHoursItem implements RpcValue {
  const RegieReportsCreateRequestWorkHoursItem({
    required this.day,
    required this.hours,
    this.userId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsCreateRequestWorkHoursItem>(
    RegieReportsCreateRequestWorkHoursItem.fromWire,
  );

  final String day;
  final num hours;
  final RpcOptional<String?> userId;

  factory RegieReportsCreateRequestWorkHoursItem.fromWire(Object? value) {
    final object = readRpcObject(value, const {"day", "hours", "userId"});

    return RegieReportsCreateRequestWorkHoursItem(
      day: rpcString.decode(readRpcField(object, "day")),
      hours: rpcNumber.decode(readRpcField(object, "hours")),
      userId: readRpcOptionalField(
        object,
        "userId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "day": encodeRpcValue(day),
      "hours": encodeRpcValue(hours),
      if (!userId.isAbsent) "userId": encodeRpcValue(userId),
    };

  }

}

final class RegieReportsUpdateRequestData implements RpcValue {
  const RegieReportsUpdateRequestData({
    this.day = const RpcOptional.absent(),
    this.summary = const RpcOptional.absent(),
    this.products = const RpcOptional.absent(),
    this.specialRecords = const RpcOptional.absent(),
    this.workHours = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<RegieReportsUpdateRequestData>(
    RegieReportsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> day;
  final RpcOptional<String?> summary;
  final RpcOptional<List<RegieReportsCreateRequestProductsItem>?> products;
  final RpcOptional<List<RegieReportsCreateRequestSpecialRecordsItem>?>
  specialRecords;
  final RpcOptional<List<RegieReportsCreateRequestWorkHoursItem>?> workHours;

  factory RegieReportsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "day",
      "summary",
      "products",
      "specialRecords",
      "workHours",
    });

    return RegieReportsUpdateRequestData(
      day: readRpcOptionalField(object, "day", rpcString.decode),
      summary: readRpcOptionalField(
        object,
        "summary",
        rpcNullable(rpcString).decode,
      ),
      products: readRpcOptionalField(
        object,
        "products",
        rpcNullable(rpcArray(RegieReportsCreateRequestProductsItem.codec))
            .decode,
      ),
      specialRecords: readRpcOptionalField(
        object,
        "specialRecords",
        rpcNullable(rpcArray(RegieReportsCreateRequestSpecialRecordsItem.codec))
            .decode,
      ),
      workHours: readRpcOptionalField(
        object,
        "workHours",
        rpcNullable(rpcArray(RegieReportsCreateRequestWorkHoursItem.codec))
            .decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!day.isAbsent) "day": encodeRpcValue(day),
      if (!summary.isAbsent) "summary": encodeRpcValue(summary),
      if (!products.isAbsent) "products": encodeRpcValue(products),
      if (!specialRecords.isAbsent)
        "specialRecords": encodeRpcValue(specialRecords),
      if (!workHours.isAbsent) "workHours": encodeRpcValue(workHours),
    };

  }

}

enum SettingsCostsDeleteRequestType implements RpcValue {
  fgk("fgk"),
  mgk("mgk"),
  ngk("ngk");

  const SettingsCostsDeleteRequestType(this.wireValue);

  final String wireValue;

  static const codec = RpcCodec<SettingsCostsDeleteRequestType>(
    SettingsCostsDeleteRequestType.fromWire,
  );

  factory SettingsCostsDeleteRequestType.fromWire(Object? value) {
    for (final option in values) {
      if (option.wireValue == value) {
        return option;
      }

    }

    throw const FormatException('INVALID_RPC_ENUM');
  }

  @override
  String toWire() {
    return wireValue;
  }

}

final class ToolsTrackRequestData implements RpcValue {
  const ToolsTrackRequestData({
    this.projectId = const RpcOptional.absent(),
    this.responsibleUserId = const RpcOptional.absent(),
    this.deadlineAt = const RpcOptional.absent(),
    this.comment = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsTrackRequestData>(
    ToolsTrackRequestData.fromWire,
  );

  final RpcOptional<String?> projectId;
  final RpcOptional<String?> responsibleUserId;
  final RpcOptional<Object?> deadlineAt;
  final RpcOptional<String?> comment;

  factory ToolsTrackRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "projectId",
      "responsibleUserId",
      "deadlineAt",
      "comment",
    });

    return ToolsTrackRequestData(
      projectId: readRpcOptionalField(
        object,
        "projectId",
        rpcNullable(rpcString).decode,
      ),
      responsibleUserId: readRpcOptionalField(
        object,
        "responsibleUserId",
        rpcNullable(rpcString).decode,
      ),
      deadlineAt: readRpcOptionalField(object, "deadlineAt", rpcUnknown.decode),
      comment: readRpcOptionalField(
        object,
        "comment",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!projectId.isAbsent) "projectId": encodeRpcValue(projectId),
      if (!responsibleUserId.isAbsent)
        "responsibleUserId": encodeRpcValue(responsibleUserId),
      if (!deadlineAt.isAbsent) "deadlineAt": encodeRpcValue(deadlineAt),
      if (!comment.isAbsent) "comment": encodeRpcValue(comment),
    };

  }

}

final class ToolsUpdateRequestData implements RpcValue {
  const ToolsUpdateRequestData({
    this.brand = const RpcOptional.absent(),
    this.category = const RpcOptional.absent(),
    this.label = const RpcOptional.absent(),
    this.purchasePrice = const RpcOptional.absent(),
    this.usageCostPerDay = const RpcOptional.absent(),
    this.status = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<ToolsUpdateRequestData>(
    ToolsUpdateRequestData.fromWire,
  );

  final RpcOptional<String> brand;
  final RpcOptional<String> category;
  final RpcOptional<String?> label;
  final RpcOptional<num?> purchasePrice;
  final RpcOptional<num?> usageCostPerDay;
  final RpcOptional<ToolStatus?> status;

  factory ToolsUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "brand",
      "category",
      "label",
      "purchasePrice",
      "usageCostPerDay",
      "status",
    });

    return ToolsUpdateRequestData(
      brand: readRpcOptionalField(object, "brand", rpcString.decode),
      category: readRpcOptionalField(object, "category", rpcString.decode),
      label: readRpcOptionalField(
        object,
        "label",
        rpcNullable(rpcString).decode,
      ),
      purchasePrice: readRpcOptionalField(
        object,
        "purchasePrice",
        rpcNullable(rpcNumber).decode,
      ),
      usageCostPerDay: readRpcOptionalField(
        object,
        "usageCostPerDay",
        rpcNullable(rpcNumber).decode,
      ),
      status: readRpcOptionalField(
        object,
        "status",
        rpcNullable(ToolStatus.codec).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!brand.isAbsent) "brand": encodeRpcValue(brand),
      if (!category.isAbsent) "category": encodeRpcValue(category),
      if (!label.isAbsent) "label": encodeRpcValue(label),
      if (!purchasePrice.isAbsent)
        "purchasePrice": encodeRpcValue(purchasePrice),
      if (!usageCostPerDay.isAbsent)
        "usageCostPerDay": encodeRpcValue(usageCostPerDay),
      if (!status.isAbsent) "status": encodeRpcValue(status),
    };

  }

}

final class UsersRolesSetRequestAssignments implements RpcValue {
  const UsersRolesSetRequestAssignments({
    required this.admin,
    required this.llm,
    required this.viewUsers,
    required this.manageUsers,
    required this.deleteUsers,
    required this.viewProjects,
    required this.manageProjects,
    required this.deleteProjects,
    required this.viewProjectDeployments,
    required this.manageProjectDeployments,
    required this.deleteProjectDeployments,
    required this.viewUserVacations,
    required this.manageUserVacations,
    required this.deleteUserVacations,
    required this.viewTools,
    required this.manageTools,
    required this.deleteTools,
    required this.viewToolTrackings,
    required this.manageToolTrackings,
    required this.deleteToolTrackings,
    required this.viewToolInventories,
    required this.manageToolInventories,
    required this.deleteToolInventories,
    required this.viewProducts,
    required this.manageProducts,
    required this.deleteProducts,
    required this.viewDeliveryNotes,
    required this.manageDeliveryNotes,
    required this.deleteDeliveryNotes,
    required this.viewProductVendors,
    required this.manageProductVendors,
    required this.deleteProductVendors,
    required this.viewProductPriceRecords,
    required this.manageProductPriceRecords,
    required this.deleteProductPriceRecords,
    required this.viewCustomers,
    required this.manageCustomers,
    required this.deleteCustomers,
    required this.viewContacts,
    required this.manageContacts,
    required this.deleteContacts,
    required this.viewDailyProjectReports,
    required this.manageDailyProjectReports,
    required this.deleteDailyProjectReports,
    required this.viewRegieReports,
    required this.manageRegieReports,
    required this.deleteRegieReports,
    required this.viewClientScripts,
    required this.manageClientScripts,
    required this.deleteClientScripts,
  });

  static const codec = RpcCodec<UsersRolesSetRequestAssignments>(
    UsersRolesSetRequestAssignments.fromWire,
  );

  final RpcOptional<bool?> admin;
  final RpcOptional<bool?> llm;
  final RpcOptional<bool?> viewUsers;
  final RpcOptional<bool?> manageUsers;
  final RpcOptional<bool?> deleteUsers;
  final RpcOptional<bool?> viewProjects;
  final RpcOptional<bool?> manageProjects;
  final RpcOptional<bool?> deleteProjects;
  final RpcOptional<bool?> viewProjectDeployments;
  final RpcOptional<bool?> manageProjectDeployments;
  final RpcOptional<bool?> deleteProjectDeployments;
  final RpcOptional<bool?> viewUserVacations;
  final RpcOptional<bool?> manageUserVacations;
  final RpcOptional<bool?> deleteUserVacations;
  final RpcOptional<bool?> viewTools;
  final RpcOptional<bool?> manageTools;
  final RpcOptional<bool?> deleteTools;
  final RpcOptional<bool?> viewToolTrackings;
  final RpcOptional<bool?> manageToolTrackings;
  final RpcOptional<bool?> deleteToolTrackings;
  final RpcOptional<bool?> viewToolInventories;
  final RpcOptional<bool?> manageToolInventories;
  final RpcOptional<bool?> deleteToolInventories;
  final RpcOptional<bool?> viewProducts;
  final RpcOptional<bool?> manageProducts;
  final RpcOptional<bool?> deleteProducts;
  final RpcOptional<bool?> viewDeliveryNotes;
  final RpcOptional<bool?> manageDeliveryNotes;
  final RpcOptional<bool?> deleteDeliveryNotes;
  final RpcOptional<bool?> viewProductVendors;
  final RpcOptional<bool?> manageProductVendors;
  final RpcOptional<bool?> deleteProductVendors;
  final RpcOptional<bool?> viewProductPriceRecords;
  final RpcOptional<bool?> manageProductPriceRecords;
  final RpcOptional<bool?> deleteProductPriceRecords;
  final RpcOptional<bool?> viewCustomers;
  final RpcOptional<bool?> manageCustomers;
  final RpcOptional<bool?> deleteCustomers;
  final RpcOptional<bool?> viewContacts;
  final RpcOptional<bool?> manageContacts;
  final RpcOptional<bool?> deleteContacts;
  final RpcOptional<bool?> viewDailyProjectReports;
  final RpcOptional<bool?> manageDailyProjectReports;
  final RpcOptional<bool?> deleteDailyProjectReports;
  final RpcOptional<bool?> viewRegieReports;
  final RpcOptional<bool?> manageRegieReports;
  final RpcOptional<bool?> deleteRegieReports;
  final RpcOptional<bool?> viewClientScripts;
  final RpcOptional<bool?> manageClientScripts;
  final RpcOptional<bool?> deleteClientScripts;

  factory UsersRolesSetRequestAssignments.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      ":admin",
      ":llm",
      "view:users",
      "manage:users",
      "delete:users",
      "view:projects",
      "manage:projects",
      "delete:projects",
      "view:projectDeployments",
      "manage:projectDeployments",
      "delete:projectDeployments",
      "view:userVacations",
      "manage:userVacations",
      "delete:userVacations",
      "view:tools",
      "manage:tools",
      "delete:tools",
      "view:toolTrackings",
      "manage:toolTrackings",
      "delete:toolTrackings",
      "view:toolInventories",
      "manage:toolInventories",
      "delete:toolInventories",
      "view:products",
      "manage:products",
      "delete:products",
      "view:deliveryNotes",
      "manage:deliveryNotes",
      "delete:deliveryNotes",
      "view:productVendors",
      "manage:productVendors",
      "delete:productVendors",
      "view:productPriceRecords",
      "manage:productPriceRecords",
      "delete:productPriceRecords",
      "view:customers",
      "manage:customers",
      "delete:customers",
      "view:contacts",
      "manage:contacts",
      "delete:contacts",
      "view:dailyProjectReports",
      "manage:dailyProjectReports",
      "delete:dailyProjectReports",
      "view:regieReports",
      "manage:regieReports",
      "delete:regieReports",
      "view:clientScripts",
      "manage:clientScripts",
      "delete:clientScripts",
    });

    return UsersRolesSetRequestAssignments(
      admin: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, ":admin")),
      llm: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, ":llm")),
      viewUsers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:users")),
      manageUsers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:users")),
      deleteUsers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:users")),
      viewProjects: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:projects")),
      manageProjects: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:projects")),
      deleteProjects: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:projects")),
      viewProjectDeployments: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:projectDeployments")),
      manageProjectDeployments: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:projectDeployments")),
      deleteProjectDeployments: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:projectDeployments")),
      viewUserVacations: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:userVacations")),
      manageUserVacations: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:userVacations")),
      deleteUserVacations: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:userVacations")),
      viewTools: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:tools")),
      manageTools: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:tools")),
      deleteTools: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:tools")),
      viewToolTrackings: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:toolTrackings")),
      manageToolTrackings: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:toolTrackings")),
      deleteToolTrackings: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:toolTrackings")),
      viewToolInventories: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:toolInventories")),
      manageToolInventories: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:toolInventories")),
      deleteToolInventories: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:toolInventories")),
      viewProducts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:products")),
      manageProducts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:products")),
      deleteProducts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:products")),
      viewDeliveryNotes: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:deliveryNotes")),
      manageDeliveryNotes: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:deliveryNotes")),
      deleteDeliveryNotes: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:deliveryNotes")),
      viewProductVendors: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:productVendors")),
      manageProductVendors: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:productVendors")),
      deleteProductVendors: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:productVendors")),
      viewProductPriceRecords: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:productPriceRecords")),
      manageProductPriceRecords: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:productPriceRecords")),
      deleteProductPriceRecords: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:productPriceRecords")),
      viewCustomers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:customers")),
      manageCustomers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:customers")),
      deleteCustomers: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:customers")),
      viewContacts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:contacts")),
      manageContacts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:contacts")),
      deleteContacts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:contacts")),
      viewDailyProjectReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:dailyProjectReports")),
      manageDailyProjectReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:dailyProjectReports")),
      deleteDailyProjectReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:dailyProjectReports")),
      viewRegieReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:regieReports")),
      manageRegieReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:regieReports")),
      deleteRegieReports: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:regieReports")),
      viewClientScripts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "view:clientScripts")),
      manageClientScripts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "manage:clientScripts")),
      deleteClientScripts: rpcMaybe(rpcNullable(rpcBoolean))
          .decode(readRpcField(object, "delete:clientScripts")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      ":admin": encodeRpcValue(admin),
      ":llm": encodeRpcValue(llm),
      "view:users": encodeRpcValue(viewUsers),
      "manage:users": encodeRpcValue(manageUsers),
      "delete:users": encodeRpcValue(deleteUsers),
      "view:projects": encodeRpcValue(viewProjects),
      "manage:projects": encodeRpcValue(manageProjects),
      "delete:projects": encodeRpcValue(deleteProjects),
      "view:projectDeployments": encodeRpcValue(viewProjectDeployments),
      "manage:projectDeployments": encodeRpcValue(manageProjectDeployments),
      "delete:projectDeployments": encodeRpcValue(deleteProjectDeployments),
      "view:userVacations": encodeRpcValue(viewUserVacations),
      "manage:userVacations": encodeRpcValue(manageUserVacations),
      "delete:userVacations": encodeRpcValue(deleteUserVacations),
      "view:tools": encodeRpcValue(viewTools),
      "manage:tools": encodeRpcValue(manageTools),
      "delete:tools": encodeRpcValue(deleteTools),
      "view:toolTrackings": encodeRpcValue(viewToolTrackings),
      "manage:toolTrackings": encodeRpcValue(manageToolTrackings),
      "delete:toolTrackings": encodeRpcValue(deleteToolTrackings),
      "view:toolInventories": encodeRpcValue(viewToolInventories),
      "manage:toolInventories": encodeRpcValue(manageToolInventories),
      "delete:toolInventories": encodeRpcValue(deleteToolInventories),
      "view:products": encodeRpcValue(viewProducts),
      "manage:products": encodeRpcValue(manageProducts),
      "delete:products": encodeRpcValue(deleteProducts),
      "view:deliveryNotes": encodeRpcValue(viewDeliveryNotes),
      "manage:deliveryNotes": encodeRpcValue(manageDeliveryNotes),
      "delete:deliveryNotes": encodeRpcValue(deleteDeliveryNotes),
      "view:productVendors": encodeRpcValue(viewProductVendors),
      "manage:productVendors": encodeRpcValue(manageProductVendors),
      "delete:productVendors": encodeRpcValue(deleteProductVendors),
      "view:productPriceRecords": encodeRpcValue(viewProductPriceRecords),
      "manage:productPriceRecords": encodeRpcValue(manageProductPriceRecords),
      "delete:productPriceRecords": encodeRpcValue(deleteProductPriceRecords),
      "view:customers": encodeRpcValue(viewCustomers),
      "manage:customers": encodeRpcValue(manageCustomers),
      "delete:customers": encodeRpcValue(deleteCustomers),
      "view:contacts": encodeRpcValue(viewContacts),
      "manage:contacts": encodeRpcValue(manageContacts),
      "delete:contacts": encodeRpcValue(deleteContacts),
      "view:dailyProjectReports": encodeRpcValue(viewDailyProjectReports),
      "manage:dailyProjectReports": encodeRpcValue(manageDailyProjectReports),
      "delete:dailyProjectReports": encodeRpcValue(deleteDailyProjectReports),
      "view:regieReports": encodeRpcValue(viewRegieReports),
      "manage:regieReports": encodeRpcValue(manageRegieReports),
      "delete:regieReports": encodeRpcValue(deleteRegieReports),
      "view:clientScripts": encodeRpcValue(viewClientScripts),
      "manage:clientScripts": encodeRpcValue(manageClientScripts),
      "delete:clientScripts": encodeRpcValue(deleteClientScripts),
    };

  }

}

final class UsersUpdateRequestData implements RpcValue {
  const UsersUpdateRequestData({
    this.username = const RpcOptional.absent(),
    this.firstName = const RpcOptional.absent(),
    this.lastName = const RpcOptional.absent(),
    this.email = const RpcOptional.absent(),
    this.phone = const RpcOptional.absent(),
    this.contractType = const RpcOptional.absent(),
    this.costPerHour = const RpcOptional.absent(),
    this.vacationDaysPerYear = const RpcOptional.absent(),
    this.supervisorUserId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<UsersUpdateRequestData>(
    UsersUpdateRequestData.fromWire,
  );

  final RpcOptional<String> username;
  final RpcOptional<String> firstName;
  final RpcOptional<String?> lastName;
  final RpcOptional<String?> email;
  final RpcOptional<String?> phone;
  final RpcOptional<UserContractType?> contractType;
  final RpcOptional<num?> costPerHour;
  final RpcOptional<num?> vacationDaysPerYear;
  final RpcOptional<String?> supervisorUserId;

  factory UsersUpdateRequestData.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "username",
      "firstName",
      "lastName",
      "email",
      "phone",
      "contractType",
      "costPerHour",
      "vacationDaysPerYear",
      "supervisorUserId",
    });

    return UsersUpdateRequestData(
      username: readRpcOptionalField(object, "username", rpcString.decode),
      firstName: readRpcOptionalField(object, "firstName", rpcString.decode),
      lastName: readRpcOptionalField(
        object,
        "lastName",
        rpcNullable(rpcString).decode,
      ),
      email: readRpcOptionalField(
        object,
        "email",
        rpcNullable(rpcString).decode,
      ),
      phone: readRpcOptionalField(
        object,
        "phone",
        rpcNullable(rpcString).decode,
      ),
      contractType: readRpcOptionalField(
        object,
        "contractType",
        rpcNullable(UserContractType.codec).decode,
      ),
      costPerHour: readRpcOptionalField(
        object,
        "costPerHour",
        rpcNullable(rpcNumber).decode,
      ),
      vacationDaysPerYear: readRpcOptionalField(
        object,
        "vacationDaysPerYear",
        rpcNullable(rpcNumber).decode,
      ),
      supervisorUserId: readRpcOptionalField(
        object,
        "supervisorUserId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!username.isAbsent) "username": encodeRpcValue(username),
      if (!firstName.isAbsent) "firstName": encodeRpcValue(firstName),
      if (!lastName.isAbsent) "lastName": encodeRpcValue(lastName),
      if (!email.isAbsent) "email": encodeRpcValue(email),
      if (!phone.isAbsent) "phone": encodeRpcValue(phone),
      if (!contractType.isAbsent) "contractType": encodeRpcValue(contractType),
      if (!costPerHour.isAbsent) "costPerHour": encodeRpcValue(costPerHour),
      if (!vacationDaysPerYear.isAbsent)
        "vacationDaysPerYear": encodeRpcValue(vacationDaysPerYear),
      if (!supervisorUserId.isAbsent)
        "supervisorUserId": encodeRpcValue(supervisorUserId),
    };

  }

}

final class AdminTenantsGetResultConnectionDetailsObjectStorage
    implements RpcValue {
  const AdminTenantsGetResultConnectionDetailsObjectStorage({
    required this.enabled,
    required this.provider,
    required this.forcePathStyle,
    required this.uploadUrlTtlSec,
    required this.downloadUrlTtlSec,
    this.bucket = const RpcOptional.absent(),
    this.region = const RpcOptional.absent(),
    this.endpoint = const RpcOptional.absent(),
    this.accessKeyId = const RpcOptional.absent(),
    this.secretAccessKey = const RpcOptional.absent(),
    this.sessionToken = const RpcOptional.absent(),
    this.publicBaseUrl = const RpcOptional.absent(),
    this.keyPrefix = const RpcOptional.absent(),
  });

  static const codec =
      RpcCodec<AdminTenantsGetResultConnectionDetailsObjectStorage>(
        AdminTenantsGetResultConnectionDetailsObjectStorage.fromWire,
      );

  final bool enabled;
  final String provider;
  final bool forcePathStyle;
  final num uploadUrlTtlSec;
  final num downloadUrlTtlSec;
  final RpcOptional<String?> bucket;
  final RpcOptional<String?> region;
  final RpcOptional<String?> endpoint;
  final RpcOptional<String?> accessKeyId;
  final RpcOptional<String?> secretAccessKey;
  final RpcOptional<String?> sessionToken;
  final RpcOptional<String?> publicBaseUrl;
  final RpcOptional<String?> keyPrefix;

  factory AdminTenantsGetResultConnectionDetailsObjectStorage.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "enabled",
      "provider",
      "forcePathStyle",
      "uploadUrlTtlSec",
      "downloadUrlTtlSec",
      "bucket",
      "region",
      "endpoint",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "publicBaseUrl",
      "keyPrefix",
    });

    return AdminTenantsGetResultConnectionDetailsObjectStorage(
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      provider: rpcLiteral<String>("s3")
          .decode(readRpcField(object, "provider")),
      forcePathStyle: rpcBoolean.decode(readRpcField(object, "forcePathStyle")),
      uploadUrlTtlSec: rpcNumber.decode(
        readRpcField(object, "uploadUrlTtlSec"),
      ),
      downloadUrlTtlSec: rpcNumber.decode(
        readRpcField(object, "downloadUrlTtlSec"),
      ),
      bucket: readRpcOptionalField(
        object,
        "bucket",
        rpcNullable(rpcString).decode,
      ),
      region: readRpcOptionalField(
        object,
        "region",
        rpcNullable(rpcString).decode,
      ),
      endpoint: readRpcOptionalField(
        object,
        "endpoint",
        rpcNullable(rpcString).decode,
      ),
      accessKeyId: readRpcOptionalField(
        object,
        "accessKeyId",
        rpcNullable(rpcString).decode,
      ),
      secretAccessKey: readRpcOptionalField(
        object,
        "secretAccessKey",
        rpcNullable(rpcString).decode,
      ),
      sessionToken: readRpcOptionalField(
        object,
        "sessionToken",
        rpcNullable(rpcString).decode,
      ),
      publicBaseUrl: readRpcOptionalField(
        object,
        "publicBaseUrl",
        rpcNullable(rpcString).decode,
      ),
      keyPrefix: readRpcOptionalField(
        object,
        "keyPrefix",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "enabled": encodeRpcValue(enabled),
      "provider": encodeRpcValue(provider),
      "forcePathStyle": encodeRpcValue(forcePathStyle),
      "uploadUrlTtlSec": encodeRpcValue(uploadUrlTtlSec),
      "downloadUrlTtlSec": encodeRpcValue(downloadUrlTtlSec),
      if (!bucket.isAbsent) "bucket": encodeRpcValue(bucket),
      if (!region.isAbsent) "region": encodeRpcValue(region),
      if (!endpoint.isAbsent) "endpoint": encodeRpcValue(endpoint),
      if (!accessKeyId.isAbsent) "accessKeyId": encodeRpcValue(accessKeyId),
      if (!secretAccessKey.isAbsent)
        "secretAccessKey": encodeRpcValue(secretAccessKey),
      if (!sessionToken.isAbsent) "sessionToken": encodeRpcValue(sessionToken),
      if (!publicBaseUrl.isAbsent)
        "publicBaseUrl": encodeRpcValue(publicBaseUrl),
      if (!keyPrefix.isAbsent) "keyPrefix": encodeRpcValue(keyPrefix),
    };

  }

}

final class AdminTenantsGetResultContactDetailsAddress implements RpcValue {
  const AdminTenantsGetResultContactDetailsAddress({
    this.city = const RpcOptional.absent(),
    this.zip = const RpcOptional.absent(),
    this.country = const RpcOptional.absent(),
    this.streetAddress = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsGetResultContactDetailsAddress>(
    AdminTenantsGetResultContactDetailsAddress.fromWire,
  );

  final RpcOptional<String?> city;
  final RpcOptional<String?> zip;
  final RpcOptional<String?> country;
  final RpcOptional<String?> streetAddress;

  factory AdminTenantsGetResultContactDetailsAddress.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "city",
      "zip",
      "country",
      "streetAddress",
    });

    return AdminTenantsGetResultContactDetailsAddress(
      city: readRpcOptionalField(object, "city", rpcNullable(rpcString).decode),
      zip: readRpcOptionalField(object, "zip", rpcNullable(rpcString).decode),
      country: readRpcOptionalField(
        object,
        "country",
        rpcNullable(rpcString).decode,
      ),
      streetAddress: readRpcOptionalField(
        object,
        "streetAddress",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!city.isAbsent) "city": encodeRpcValue(city),
      if (!zip.isAbsent) "zip": encodeRpcValue(zip),
      if (!country.isAbsent) "country": encodeRpcValue(country),
      if (!streetAddress.isAbsent)
        "streetAddress": encodeRpcValue(streetAddress),
    };

  }

}

final class AdminTenantsGetResultOptionsSso implements RpcValue {
  const AdminTenantsGetResultOptionsSso({required this.msEntraId});

  static const codec = RpcCodec<AdminTenantsGetResultOptionsSso>(
    AdminTenantsGetResultOptionsSso.fromWire,
  );

  final AdminTenantsGetResultOptionsSsoMsEntraId msEntraId;

  factory AdminTenantsGetResultOptionsSso.fromWire(Object? value) {
    final object = readRpcObject(value, const {"ms-entra-id"});

    return AdminTenantsGetResultOptionsSso(
      msEntraId: AdminTenantsGetResultOptionsSsoMsEntraId.codec.decode(
        readRpcField(object, "ms-entra-id"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {"ms-entra-id": encodeRpcValue(msEntraId)};
  }

}

final class ProjectsCostsGetResultCommonCostsFgk implements RpcValue {
  const ProjectsCostsGetResultCommonCostsFgk({
    required this.baseCost,
    required this.overheadCost,
    required this.totalCost,
  });

  static const codec = RpcCodec<ProjectsCostsGetResultCommonCostsFgk>(
    ProjectsCostsGetResultCommonCostsFgk.fromWire,
  );

  final num baseCost;
  final num overheadCost;
  final num totalCost;

  factory ProjectsCostsGetResultCommonCostsFgk.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "baseCost",
      "overheadCost",
      "totalCost",
    });

    return ProjectsCostsGetResultCommonCostsFgk(
      baseCost: rpcNumber.decode(readRpcField(object, "baseCost")),
      overheadCost: rpcNumber.decode(readRpcField(object, "overheadCost")),
      totalCost: rpcNumber.decode(readRpcField(object, "totalCost")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "baseCost": encodeRpcValue(baseCost),
      "overheadCost": encodeRpcValue(overheadCost),
      "totalCost": encodeRpcValue(totalCost),
    };

  }

}

final class AdminTenantsCreateRequestConnectionDetSchemaDae779de
    implements RpcValue {
  const AdminTenantsCreateRequestConnectionDetSchemaDae779de({
    this.enabled = const RpcOptional.absent(),
    this.provider = const RpcOptional.absent(),
    this.bucket = const RpcOptional.absent(),
    this.region = const RpcOptional.absent(),
    this.endpoint = const RpcOptional.absent(),
    this.forcePathStyle = const RpcOptional.absent(),
    this.accessKeyId = const RpcOptional.absent(),
    this.secretAccessKey = const RpcOptional.absent(),
    this.sessionToken = const RpcOptional.absent(),
    this.publicBaseUrl = const RpcOptional.absent(),
    this.keyPrefix = const RpcOptional.absent(),
    this.uploadUrlTtlSec = const RpcOptional.absent(),
    this.downloadUrlTtlSec = const RpcOptional.absent(),
  });

  static const codec =
      RpcCodec<AdminTenantsCreateRequestConnectionDetSchemaDae779de>(
        AdminTenantsCreateRequestConnectionDetSchemaDae779de.fromWire,
      );

  final RpcOptional<bool> enabled;
  final RpcOptional<String> provider;
  final RpcOptional<String?> bucket;
  final RpcOptional<String?> region;
  final RpcOptional<String?> endpoint;
  final RpcOptional<bool> forcePathStyle;
  final RpcOptional<String?> accessKeyId;
  final RpcOptional<String?> secretAccessKey;
  final RpcOptional<String?> sessionToken;
  final RpcOptional<String?> publicBaseUrl;
  final RpcOptional<String?> keyPrefix;
  final RpcOptional<num> uploadUrlTtlSec;
  final RpcOptional<num> downloadUrlTtlSec;

  factory AdminTenantsCreateRequestConnectionDetSchemaDae779de.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "enabled",
      "provider",
      "bucket",
      "region",
      "endpoint",
      "forcePathStyle",
      "accessKeyId",
      "secretAccessKey",
      "sessionToken",
      "publicBaseUrl",
      "keyPrefix",
      "uploadUrlTtlSec",
      "downloadUrlTtlSec",
    });

    return AdminTenantsCreateRequestConnectionDetSchemaDae779de(
      enabled: readRpcOptionalField(object, "enabled", rpcBoolean.decode),
      provider: readRpcOptionalField(
        object,
        "provider",
        rpcLiteral<String>("s3").decode,
      ),
      bucket: readRpcOptionalField(
        object,
        "bucket",
        rpcNullable(rpcString).decode,
      ),
      region: readRpcOptionalField(
        object,
        "region",
        rpcNullable(rpcString).decode,
      ),
      endpoint: readRpcOptionalField(
        object,
        "endpoint",
        rpcNullable(rpcString).decode,
      ),
      forcePathStyle: readRpcOptionalField(
        object,
        "forcePathStyle",
        rpcBoolean.decode,
      ),
      accessKeyId: readRpcOptionalField(
        object,
        "accessKeyId",
        rpcNullable(rpcString).decode,
      ),
      secretAccessKey: readRpcOptionalField(
        object,
        "secretAccessKey",
        rpcNullable(rpcString).decode,
      ),
      sessionToken: readRpcOptionalField(
        object,
        "sessionToken",
        rpcNullable(rpcString).decode,
      ),
      publicBaseUrl: readRpcOptionalField(
        object,
        "publicBaseUrl",
        rpcNullable(rpcString).decode,
      ),
      keyPrefix: readRpcOptionalField(
        object,
        "keyPrefix",
        rpcNullable(rpcString).decode,
      ),
      uploadUrlTtlSec: readRpcOptionalField(
        object,
        "uploadUrlTtlSec",
        rpcNumber.decode,
      ),
      downloadUrlTtlSec: readRpcOptionalField(
        object,
        "downloadUrlTtlSec",
        rpcNumber.decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      if (!enabled.isAbsent) "enabled": encodeRpcValue(enabled),
      if (!provider.isAbsent) "provider": encodeRpcValue(provider),
      if (!bucket.isAbsent) "bucket": encodeRpcValue(bucket),
      if (!region.isAbsent) "region": encodeRpcValue(region),
      if (!endpoint.isAbsent) "endpoint": encodeRpcValue(endpoint),
      if (!forcePathStyle.isAbsent)
        "forcePathStyle": encodeRpcValue(forcePathStyle),
      if (!accessKeyId.isAbsent) "accessKeyId": encodeRpcValue(accessKeyId),
      if (!secretAccessKey.isAbsent)
        "secretAccessKey": encodeRpcValue(secretAccessKey),
      if (!sessionToken.isAbsent) "sessionToken": encodeRpcValue(sessionToken),
      if (!publicBaseUrl.isAbsent)
        "publicBaseUrl": encodeRpcValue(publicBaseUrl),
      if (!keyPrefix.isAbsent) "keyPrefix": encodeRpcValue(keyPrefix),
      if (!uploadUrlTtlSec.isAbsent)
        "uploadUrlTtlSec": encodeRpcValue(uploadUrlTtlSec),
      if (!downloadUrlTtlSec.isAbsent)
        "downloadUrlTtlSec": encodeRpcValue(downloadUrlTtlSec),
    };

  }

}

final class AuthPasskeysLoginRequestCredentialResponse implements RpcValue {
  const AuthPasskeysLoginRequestCredentialResponse({
    required this.clientDataJSON,
    required this.authenticatorData,
    required this.signature,
    this.userHandle = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AuthPasskeysLoginRequestCredentialResponse>(
    AuthPasskeysLoginRequestCredentialResponse.fromWire,
  );

  final String clientDataJSON;
  final String authenticatorData;
  final String signature;
  final RpcOptional<String?> userHandle;

  factory AuthPasskeysLoginRequestCredentialResponse.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "clientDataJSON",
      "authenticatorData",
      "signature",
      "userHandle",
    });

    return AuthPasskeysLoginRequestCredentialResponse(
      clientDataJSON: rpcString.decode(readRpcField(object, "clientDataJSON")),
      authenticatorData: rpcString.decode(
        readRpcField(object, "authenticatorData"),
      ),
      signature: rpcString.decode(readRpcField(object, "signature")),
      userHandle: readRpcOptionalField(
        object,
        "userHandle",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "clientDataJSON": encodeRpcValue(clientDataJSON),
      "authenticatorData": encodeRpcValue(authenticatorData),
      "signature": encodeRpcValue(signature),
      if (!userHandle.isAbsent) "userHandle": encodeRpcValue(userHandle),
    };

  }

}

final class AuthPasskeysLoginOptionsResultOptionsASchema257eefa0
    implements RpcValue {
  const AuthPasskeysLoginOptionsResultOptionsASchema257eefa0({
    required this.id,
    required this.type,
    this.transports = const RpcOptional.absent(),
  });

  static const codec =
      RpcCodec<AuthPasskeysLoginOptionsResultOptionsASchema257eefa0>(
        AuthPasskeysLoginOptionsResultOptionsASchema257eefa0.fromWire,
      );

  final String id;
  final String type;
  final RpcOptional<List<String>> transports;

  factory AuthPasskeysLoginOptionsResultOptionsASchema257eefa0.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {"id", "type", "transports"});

    return AuthPasskeysLoginOptionsResultOptionsASchema257eefa0(
      id: rpcString.decode(readRpcField(object, "id")),
      type: rpcLiteral<String>("public-key")
          .decode(readRpcField(object, "type")),
      transports: readRpcOptionalField(
        object,
        "transports",
        rpcArray(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "type": encodeRpcValue(type),
      if (!transports.isAbsent) "transports": encodeRpcValue(transports),
    };

  }

}

final class AuthPasskeysRegisterRequestCredentialResponse implements RpcValue {
  const AuthPasskeysRegisterRequestCredentialResponse({
    required this.clientDataJSON,
    required this.attestationObject,
  });

  static const codec = RpcCodec<AuthPasskeysRegisterRequestCredentialResponse>(
    AuthPasskeysRegisterRequestCredentialResponse.fromWire,
  );

  final String clientDataJSON;
  final String attestationObject;

  factory AuthPasskeysRegisterRequestCredentialResponse.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "clientDataJSON",
      "attestationObject",
    });

    return AuthPasskeysRegisterRequestCredentialResponse(
      clientDataJSON: rpcString.decode(readRpcField(object, "clientDataJSON")),
      attestationObject: rpcString.decode(
        readRpcField(object, "attestationObject"),
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "clientDataJSON": encodeRpcValue(clientDataJSON),
      "attestationObject": encodeRpcValue(attestationObject),
    };

  }

}

final class AuthPasskeysRegisterOptionsResultOptionsUser implements RpcValue {
  const AuthPasskeysRegisterOptionsResultOptionsUser({
    required this.id,
    required this.name,
    required this.displayName,
  });

  static const codec = RpcCodec<AuthPasskeysRegisterOptionsResultOptionsUser>(
    AuthPasskeysRegisterOptionsResultOptionsUser.fromWire,
  );

  final String id;
  final String name;
  final String displayName;

  factory AuthPasskeysRegisterOptionsResultOptionsUser.fromWire(Object? value) {
    final object = readRpcObject(value, const {"id", "name", "displayName"});

    return AuthPasskeysRegisterOptionsResultOptionsUser(
      id: rpcString.decode(readRpcField(object, "id")),
      name: rpcString.decode(readRpcField(object, "name")),
      displayName: rpcString.decode(readRpcField(object, "displayName")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "id": encodeRpcValue(id),
      "name": encodeRpcValue(name),
      "displayName": encodeRpcValue(displayName),
    };

  }

}

final class AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77
    implements RpcValue {
  const AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77({
    required this.type,
    required this.alg,
  });

  static const codec =
      RpcCodec<AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77>(
        AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77.fromWire,
      );

  final String type;
  final num alg;

  factory AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {"type", "alg"});

    return AuthPasskeysRegisterOptionsResultOptioSchemaE7bb8e77(
      type: rpcLiteral<String>("public-key")
          .decode(readRpcField(object, "type")),
      alg: rpcNumber.decode(readRpcField(object, "alg")),
    );
  }

  @override
  JsonMap toWire() {
    return {"type": encodeRpcValue(type), "alg": encodeRpcValue(alg)};
  }

}

final class AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4
    implements RpcValue {
  const AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4({
    required this.residentKey,
    required this.requireResidentKey,
    required this.userVerification,
  });

  static const codec =
      RpcCodec<AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4>(
        AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4.fromWire,
      );

  final String residentKey;
  final bool requireResidentKey;
  final String userVerification;

  factory AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4.fromWire(
    Object? value,
  ) {
    final object = readRpcObject(value, const {
      "residentKey",
      "requireResidentKey",
      "userVerification",
    });

    return AuthPasskeysRegisterOptionsResultOptioSchema7eff83d4(
      residentKey: rpcLiteral<String>("required")
          .decode(readRpcField(object, "residentKey")),
      requireResidentKey: rpcLiteral<bool>(true)
          .decode(readRpcField(object, "requireResidentKey")),
      userVerification: rpcLiteral<String>("required")
          .decode(readRpcField(object, "userVerification")),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "residentKey": encodeRpcValue(residentKey),
      "requireResidentKey": encodeRpcValue(requireResidentKey),
      "userVerification": encodeRpcValue(userVerification),
    };

  }

}

final class AdminTenantsGetResultOptionsSsoMsEntraId implements RpcValue {
  const AdminTenantsGetResultOptionsSsoMsEntraId({
    required this.enabled,
    required this.importUserUsername,
    required this.importUserName,
    required this.importUserEmail,
    this.tenantId = const RpcOptional.absent(),
    this.clientId = const RpcOptional.absent(),
    this.objectId = const RpcOptional.absent(),
  });

  static const codec = RpcCodec<AdminTenantsGetResultOptionsSsoMsEntraId>(
    AdminTenantsGetResultOptionsSsoMsEntraId.fromWire,
  );

  final bool enabled;
  final bool importUserUsername;
  final bool importUserName;
  final bool importUserEmail;
  final RpcOptional<String?> tenantId;
  final RpcOptional<String?> clientId;
  final RpcOptional<String?> objectId;

  factory AdminTenantsGetResultOptionsSsoMsEntraId.fromWire(Object? value) {
    final object = readRpcObject(value, const {
      "enabled",
      "importUserUsername",
      "importUserName",
      "importUserEmail",
      "tenantId",
      "clientId",
      "objectId",
    });

    return AdminTenantsGetResultOptionsSsoMsEntraId(
      enabled: rpcBoolean.decode(readRpcField(object, "enabled")),
      importUserUsername: rpcBoolean.decode(
        readRpcField(object, "importUserUsername"),
      ),
      importUserName: rpcBoolean.decode(readRpcField(object, "importUserName")),
      importUserEmail: rpcBoolean.decode(
        readRpcField(object, "importUserEmail"),
      ),
      tenantId: readRpcOptionalField(
        object,
        "tenantId",
        rpcNullable(rpcString).decode,
      ),
      clientId: readRpcOptionalField(
        object,
        "clientId",
        rpcNullable(rpcString).decode,
      ),
      objectId: readRpcOptionalField(
        object,
        "objectId",
        rpcNullable(rpcString).decode,
      ),
    );
  }

  @override
  JsonMap toWire() {
    return {
      "enabled": encodeRpcValue(enabled),
      "importUserUsername": encodeRpcValue(importUserUsername),
      "importUserName": encodeRpcValue(importUserName),
      "importUserEmail": encodeRpcValue(importUserEmail),
      if (!tenantId.isAbsent) "tenantId": encodeRpcValue(tenantId),
      if (!clientId.isAbsent) "clientId": encodeRpcValue(clientId),
      if (!objectId.isAbsent) "objectId": encodeRpcValue(objectId),
    };

  }

}

typedef Id = String;

typedef AdminDatabasesBackupsDownloadUrlInput =
    AdminDatabasesBackupsDownloadUrlRequest;

typedef AdminDatabasesBackupsDownloadUrlOutput =
    AdminDatabasesBackupsDownloadUrlResult;

typedef AdminDatabasesBackupsListInput = AdminDatabasesBackupsListRequest;

typedef AdminDatabasesBackupsListOutput =
    List<AdminDatabasesBackupsListResultItem>;

typedef AdminDatabasesHostsListInput = RpcUndefined;

typedef AdminDatabasesHostsListOutput = List<AdminDatabasesHostsListResultItem>;

typedef AdminDatabasesListInput = RpcUndefined;

typedef AdminDatabasesListOutput = List<AdminDatabasesListResultItem>;

typedef AdminErrorsListInput = RpcOptional<AdminErrorsListRequest>;

typedef AdminErrorsListOutput = List<AdminErrorsListResultItem>;

typedef AdminLlmProvidersListInput = RpcUndefined;

typedef AdminLlmProvidersListOutput = List<AdminLlmProvidersListResultItem>;

typedef AdminLlmProvidersModelsInput = AdminLlmProvidersModelsRequest;

typedef AdminLlmProvidersModelsOutput = List<AdminLlmProvidersModelsResultItem>;

typedef AdminLlmScanSettingsGetInput = RpcUndefined;

typedef AdminLlmScanSettingsGetOutput = AdminLlmScanSettingsGetResult?;

typedef AdminLlmSettingsGetInput = RpcUndefined;

typedef AdminLlmSettingsGetOutput = AdminLlmScanSettingsGetResult?;

typedef AdminLlmTenantsListInput = RpcUndefined;

typedef AdminLlmTenantsListOutput = List<AdminLlmTenantsListResultItem>;

typedef AdminLlmUsageInput = RpcUndefined;

typedef AdminLlmUsageOutput = List<AdminLlmUsageResultItem>;

typedef AdminLlmUseCasesListInput = RpcUndefined;

typedef AdminLlmUseCasesListOutput = List<AdminLlmUseCasesListResultItem>;

typedef AdminTenantsGetInput = AdminTenantsGetRequest;

typedef AdminTenantsGetOutput = AdminTenantsGetResult;

typedef AdminTenantsListInput = RpcUndefined;

typedef AdminTenantsListOutput = List<AdminTenantsGetResult>;

typedef AdminUsersListInput = AdminUsersListRequest;

typedef AdminUsersListOutput = List<AdminUsersListResultItem>;

typedef AuthCheckInput = RpcUndefined;

typedef AuthCheckOutput = AuthCheckResult;

typedef AuthPasskeysListInput = RpcUndefined;

typedef AuthPasskeysListOutput = List<AuthPasskeysListResultItem>;

typedef AuthSessionInfoInput = RpcUndefined;

typedef AuthSessionInfoOutput = SessionInfo;

typedef ClientScriptsGetInput = ClientScriptsGetRequest;

typedef ClientScriptsGetOutput = ClientScriptsGetResult?;

typedef ClientScriptsListInput = RpcOptional<ClientScriptsListRequest>;

typedef ClientScriptsListOutput = List<ClientScriptsListResultItem>;

typedef ContactsCustomersListInput = ContactsCustomersListRequest;

typedef ContactsCustomersListOutput = List<Customer>;

typedef ContactsGetInput = ClientScriptsGetRequest;

typedef ContactsGetOutput = Contact;

typedef ContactsListInput = ContactsListRequest;

typedef ContactsListOutput = List<Contact>;

typedef ContactsProjectsListInput = ContactsCustomersListRequest;

typedef ContactsProjectsListOutput = List<Project>;

typedef CustomersContactsListInput = CustomersContactsListRequest;

typedef CustomersContactsListOutput = List<Contact>;

typedef CustomersGetInput = ClientScriptsGetRequest;

typedef CustomersGetOutput = Customer;

typedef CustomersListInput = ContactsListRequest;

typedef CustomersListOutput = List<Customer>;

typedef DeliveryNotesCostsGetInput = ClientScriptsGetRequest;

typedef DeliveryNotesCostsGetOutput = DeliveryNotesCostsGetResult;

typedef DeliveryNotesGetInput = DeliveryNotesGetRequest;

typedef DeliveryNotesGetOutput = DeliveryNote;

typedef DeliveryNotesListInput = DeliveryNotesListRequest;

typedef DeliveryNotesListOutput = List<DeliveryNote>;

typedef DeliveryNotesScanListInput = RpcUndefined;

typedef DeliveryNotesScanListOutput = List<DeliveryNotesScanListResultItem>;

typedef DeliveryNotesScanStatusInput = DeliveryNotesScanStatusRequest;

typedef DeliveryNotesScanStatusOutput = DeliveryNotesScanStatusResult;

typedef LlmAdminUsageInput = RpcUndefined;

typedef LlmAdminUsageOutput = List<AdminLlmUsageResultItem>;

typedef LlmChatsGetInput = LlmChatsGetRequest;

typedef LlmChatsGetOutput = LlmChatsGetResult;

typedef LlmChatsListInput = RpcUndefined;

typedef LlmChatsListOutput = List<ChatSummary>;

typedef LlmStatusInput = RpcUndefined;

typedef LlmStatusOutput = LlmStatusResult;

typedef OfficeExportsOfficeConfigInput = OfficeExportsOfficeConfigRequest;

typedef OfficeExportsOfficeConfigOutput = OfficeExportsOfficeConfigResult;

typedef PersonalizationActionsListInput =
    RpcOptional<PersonalizationActionsListRequest>;

typedef PersonalizationActionsListOutput =
    List<PersonalizationActionsListResultItem>;

typedef PersonalizationActivityListInput =
    RpcOptional<PersonalizationActivityListRequest>;

typedef PersonalizationActivityListOutput = List<ResourceActivity>;

typedef PersonalizationVisitsListInput =
    RpcOptional<PersonalizationActionsListRequest>;

typedef PersonalizationVisitsListOutput =
    List<PersonalizationVisitsListResultItem>;

typedef PingInput = RpcUndefined;

typedef PingOutput = String;

typedef ProductsBrandsListInput = RpcUndefined;

typedef ProductsBrandsListOutput = List<String>;

typedef ProductsCategoriesListInput = RpcUndefined;

typedef ProductsCategoriesListOutput = List<String>;

typedef ProductsGetInput = ClientScriptsGetRequest;

typedef ProductsGetOutput = Product;

typedef ProductsListInput = ProductsListRequest;

typedef ProductsListOutput = List<Product>;

typedef ProductsPriceRecordsListInput = ProductsPriceRecordsListRequest;

typedef ProductsPriceRecordsListOutput =
    List<ProductsPriceRecordsListResultItem>;

typedef ProductsSuggestNextCustomIdInput = RpcUndefined;

typedef ProductsSuggestNextCustomIdOutput = num;

typedef ProductsUnitsListInput = RpcUndefined;

typedef ProductsUnitsListOutput = List<String>;

typedef ProductsVendorsGetInput = ClientScriptsGetRequest;

typedef ProductsVendorsGetOutput = ProductVendor;

typedef ProductsVendorsListInput = ContactsListRequest;

typedef ProductsVendorsListOutput = List<ProductVendor>;

typedef ProjectsContactsListInput = ProjectsContactsListRequest;

typedef ProjectsContactsListOutput = List<ProjectsContactsListResultItem>;

typedef ProjectsCostsFilterOptionsInput = RpcUndefined;

typedef ProjectsCostsFilterOptionsOutput = ProjectsCostsFilterOptionsResult;

typedef ProjectsCostsGetInput = ProjectsCostsGetRequest;

typedef ProjectsCostsGetOutput = ProjectsCostsGetResult;

typedef ProjectsCostsOverviewInput = RpcOptional<ProjectsCostsOverviewRequest>;

typedef ProjectsCostsOverviewOutput = List<ProjectsCostsOverviewResultItem>;

typedef ProjectsDailyReportsGetInput = ProjectsDailyReportsGetRequest;

typedef ProjectsDailyReportsGetOutput = ProjectsDailyReportsGetResult;

typedef ProjectsDailyReportsListInput = ProjectsDailyReportsListRequest;

typedef ProjectsDailyReportsListOutput = List<ProjectsDailyReportsGetResult>;

typedef ProjectsDeploymentsListInput = ProjectsDeploymentsListRequest;

typedef ProjectsDeploymentsListOutput = List<Deployment>;

typedef ProjectsFilesDrawioConfigInput = ProjectsFilesDrawioConfigRequest;

typedef ProjectsFilesDrawioConfigOutput = ProjectsFilesDrawioConfigResult;

typedef ProjectsFilesFoldersListInput = ProjectsFilesFoldersListRequest;

typedef ProjectsFilesFoldersListOutput =
    List<ProjectsFilesFoldersListResultItem>;

typedef ProjectsFilesListInput = ProjectsContactsListRequest;

typedef ProjectsFilesListOutput = List<ProjectsFilesListResultItem>;

typedef ProjectsFilesOfficeConfigInput = ProjectsFilesDrawioConfigRequest;

typedef ProjectsFilesOfficeConfigOutput = OfficeExportsOfficeConfigResult;

typedef ProjectsFilesSearchInput = ProjectsFilesSearchRequest;

typedef ProjectsFilesSearchOutput = List<ProjectsFilesSearchResultItem>;

typedef ProjectsGetInput = ClientScriptsGetRequest;

typedef ProjectsGetOutput = Project;

typedef ProjectsListInput = ProjectsListRequest;

typedef ProjectsListOutput = List<Project>;

typedef ProjectsUnavailabilityListInput = ProjectsUnavailabilityListRequest;

typedef ProjectsUnavailabilityListOutput =
    List<ProjectsUnavailabilityListResultItem>;

typedef RegieReportsCostsGetInput = ClientScriptsGetRequest;

typedef RegieReportsCostsGetOutput = RegieReportsCostsGetResult;

typedef RegieReportsGetInput = ClientScriptsGetRequest;

typedef RegieReportsGetOutput = RegieReport;

typedef RegieReportsListInput = RegieReportsListRequest;

typedef RegieReportsListOutput = List<RegieReport>;

typedef RemarksListInput = RemarksListRequest;

typedef RemarksListOutput = List<RemarksListResultItem>;

typedef SettingsCostsGetInput = RpcUndefined;

typedef SettingsCostsGetOutput = SettingsCostsGetResult;

typedef SettingsGlobalGetInput = SettingsGlobalGetRequest;

typedef SettingsGlobalGetOutput = SettingsGlobalGetResult;

typedef SettingsPublicGlobalGetInput = SettingsGlobalGetRequest;

typedef SettingsPublicGlobalGetOutput = SettingsGlobalGetResult;

typedef SettingsTenantLogoGetInput = RpcUndefined;

typedef SettingsTenantLogoGetOutput = SettingsTenantLogoGetResult;

typedef SettingsTenantNameGetInput = RpcUndefined;

typedef SettingsTenantNameGetOutput = SettingsTenantNameGetResult;

typedef ToolsBrandsInput = RpcUndefined;

typedef ToolsBrandsOutput = List<String>;

typedef ToolsCategoriesInput = RpcUndefined;

typedef ToolsCategoriesOutput = List<String>;

typedef ToolsGetInput = ClientScriptsGetRequest;

typedef ToolsGetOutput = Tool;

typedef ToolsInventoriesListInput = ToolsInventoriesListRequest;

typedef ToolsInventoriesListOutput = List<ToolsInventoriesListResultItem>;

typedef ToolsInventoriesOverviewInput = ToolsInventoriesOverviewRequest;

typedef ToolsInventoriesOverviewOutput =
    List<ToolsInventoriesOverviewResultItem>;

typedef ToolsListInput = ToolsListRequest;

typedef ToolsListOutput = List<Tool>;

typedef ToolsSuggestNextCustomIdInput = RpcUndefined;

typedef ToolsSuggestNextCustomIdOutput = num;

typedef ToolsTrackingsListInput = ToolsTrackingsListRequest;

typedef ToolsTrackingsListOutput = List<ToolsTrackingsListResultItem>;

typedef ToolsTrackingsTransfersListInput = ToolsTrackingsTransfersListRequest;

typedef ToolsTrackingsTransfersListOutput =
    List<ToolsTrackingsTransfersListResultItem>;

typedef UsersGetInput = ClientScriptsGetRequest;

typedef UsersGetOutput = User;

typedef UsersListInput = UsersListRequest;

typedef UsersListOutput = List<User>;

typedef UsersRolesGetInput = UsersRolesGetRequest;

typedef UsersRolesGetOutput = List<UsersRolesGetResultItem>;

typedef UsersRolesListInput = RpcUndefined;

typedef UsersRolesListOutput = List<UsersRolesGetResultItem>;

typedef UsersSupervisorsGetDefaultInput = RpcUndefined;

typedef UsersSupervisorsGetDefaultOutput = UsersSupervisorsGetDefaultResult;

typedef UsersVacationsListInput = UsersVacationsListRequest;

typedef UsersVacationsListOutput = List<UsersVacationsListResultItem>;

typedef AdminDatabasesBackupsCreateNowInput =
    AdminDatabasesBackupsCreateNowRequest;

typedef AdminDatabasesBackupsCreateNowOutput =
    AdminDatabasesBackupsListResultItem;

typedef AdminDatabasesBackupsRestoreInput = AdminDatabasesBackupsRestoreRequest;

typedef AdminDatabasesBackupsRestoreOutput = AdminDatabasesBackupsRestoreResult;

typedef AdminDatabasesBackupsUploadInput = AdminDatabasesBackupsUploadRequest;

typedef AdminDatabasesBackupsUploadOutput = AdminDatabasesBackupsListResultItem;

typedef AdminDatabasesCreateInput = AdminDatabasesCreateRequest;

typedef AdminDatabasesCreateOutput = AdminDatabasesCreateResult;

typedef AdminDatabasesForkFromBackupInput = AdminDatabasesForkFromBackupRequest;

typedef AdminDatabasesForkFromBackupOutput = AdminDatabasesForkFromBackupResult;

typedef AdminDatabasesHostsCreateInput = AdminDatabasesHostsCreateRequest;

typedef AdminDatabasesHostsCreateOutput = AdminDatabasesHostsListResultItem;

typedef AdminDatabasesHostsDeleteInput = AdminDatabasesHostsDeleteRequest;

typedef AdminDatabasesHostsDeleteOutput = AuthCheckResult;

typedef AdminDatabasesHostsUpdateInput = AdminDatabasesHostsUpdateRequest;

typedef AdminDatabasesHostsUpdateOutput = AdminDatabasesHostsListResultItem;

typedef AdminDatabasesRotateCredentialsInput =
    AdminDatabasesRotateCredentialsRequest;

typedef AdminDatabasesRotateCredentialsOutput =
    AdminDatabasesRotateCredentialsResult;

typedef AdminDatabasesUpdateRetentionInput =
    AdminDatabasesUpdateRetentionRequest;

typedef AdminDatabasesUpdateRetentionOutput =
    AdminDatabasesUpdateRetentionResult;

typedef AdminLlmProvidersDeleteInput = AdminLlmProvidersModelsRequest;

typedef AdminLlmProvidersDeleteOutput = AuthCheckResult;

typedef AdminLlmProvidersUpdateInput = AdminLlmProvidersUpdateRequest;

typedef AdminLlmProvidersUpdateOutput = AdminLlmProvidersListResultItem;

typedef AdminLlmScanSettingsUpdateInput = AdminLlmScanSettingsUpdateRequest;

typedef AdminLlmScanSettingsUpdateOutput = AdminLlmScanSettingsGetResult;

typedef AdminLlmSettingsUpdateInput = AdminLlmScanSettingsUpdateRequest;

typedef AdminLlmSettingsUpdateOutput = AdminLlmScanSettingsGetResult;

typedef AdminLlmTenantsUpdateInput = AdminLlmTenantsUpdateRequest;

typedef AdminLlmTenantsUpdateOutput = AdminLlmTenantsListResultItem;

typedef AdminLlmUseCasesUpdateInput = AdminLlmUseCasesUpdateRequest;

typedef AdminLlmUseCasesUpdateOutput = AdminLlmUseCasesListResultItem;

typedef AdminLoginInput = AdminLoginRequest;

typedef AdminLoginOutput = AdminLoginResult;

typedef AdminTenantsActivateInput = AdminTenantsGetRequest;

typedef AdminTenantsActivateOutput = AuthCheckResult;

typedef AdminTenantsCreateInput = AdminTenantsCreateRequest;

typedef AdminTenantsCreateOutput = AdminTenantsCreateResult;

typedef AdminTenantsDeactivateInput = AdminTenantsGetRequest;

typedef AdminTenantsDeactivateOutput = AuthCheckResult;

typedef AdminTenantsDeleteInput = AdminTenantsGetRequest;

typedef AdminTenantsDeleteOutput = AuthCheckResult;

typedef AdminTenantsDeleteForeverInput = AdminTenantsGetRequest;

typedef AdminTenantsDeleteForeverOutput = AuthCheckResult;

typedef AdminTenantsLockInput = AdminTenantsGetRequest;

typedef AdminTenantsLockOutput = AuthCheckResult;

typedef AdminTenantsUndeleteInput = AdminTenantsGetRequest;

typedef AdminTenantsUndeleteOutput = AuthCheckResult;

typedef AdminTenantsUnlockInput = AdminTenantsGetRequest;

typedef AdminTenantsUnlockOutput = AuthCheckResult;

typedef AdminTenantsUpdateInput = AdminTenantsUpdateRequest;

typedef AdminTenantsUpdateOutput = AuthCheckResult;

typedef AdminUsersCreateInput = AdminUsersCreateRequest;

typedef AdminUsersCreateOutput = AdminUsersCreateResult;

typedef AdminUsersResetPasswordInput = AdminUsersResetPasswordRequest;

typedef AdminUsersResetPasswordOutput = AdminUsersResetPasswordResult;

typedef AdminUsersSetAdminInput = AdminUsersSetAdminRequest;

typedef AdminUsersSetAdminOutput = AuthCheckResult;

typedef AuthLoginInput = AuthLoginRequest;

typedef AuthLoginOutput = AdminLoginResult;

typedef AuthLogoutInput = RpcUndefined;

typedef AuthLogoutOutput = AuthCheckResult;

typedef AuthPasskeysDeleteInput = ClientScriptsGetRequest;

typedef AuthPasskeysDeleteOutput = AuthCheckResult;

typedef AuthPasskeysLoginInput = AuthPasskeysLoginRequest;

typedef AuthPasskeysLoginOutput = AdminLoginResult;

typedef AuthPasskeysLoginOptionsInput =
    RpcOptional<AuthPasskeysLoginOptionsRequest>;

typedef AuthPasskeysLoginOptionsOutput = AuthPasskeysLoginOptionsResult;

typedef AuthPasskeysRegisterInput = AuthPasskeysRegisterRequest;

typedef AuthPasskeysRegisterOutput = AuthCheckResult;

typedef AuthPasskeysRegisterOptionsInput = RpcUndefined;

typedef AuthPasskeysRegisterOptionsOutput = AuthPasskeysRegisterOptionsResult;

typedef AuthSetPasswordInput = AuthSetPasswordRequest;

typedef AuthSetPasswordOutput = AuthCheckResult;

typedef ClientScriptsCreateInput = ClientScriptsCreateRequest;

typedef ClientScriptsCreateOutput = ClientScriptsGetResult;

typedef ClientScriptsDeleteInput = ClientScriptsGetRequest;

typedef ClientScriptsDeleteOutput = AuthCheckResult;

typedef ClientScriptsUpdateInput = ClientScriptsUpdateRequest;

typedef ClientScriptsUpdateOutput = ClientScriptsGetResult?;

typedef ContactsCreateInput = ContactsCreateRequest;

typedef ContactsCreateOutput = ClientScriptsGetRequest;

typedef ContactsDeleteInput = ClientScriptsGetRequest;

typedef ContactsDeleteOutput = AuthCheckResult;

typedef ContactsUpdateInput = ContactsUpdateRequest;

typedef ContactsUpdateOutput = AuthCheckResult;

typedef CustomersContactsAddInput = CustomersContactsAddRequest;

typedef CustomersContactsAddOutput = AuthCheckResult;

typedef CustomersContactsRemoveInput = CustomersContactsAddRequest;

typedef CustomersContactsRemoveOutput = AuthCheckResult;

typedef CustomersContactsSetInput = CustomersContactsSetRequest;

typedef CustomersContactsSetOutput = AuthCheckResult;

typedef CustomersCreateInput = CustomersCreateRequest;

typedef CustomersCreateOutput = ClientScriptsGetRequest;

typedef CustomersDeleteInput = ClientScriptsGetRequest;

typedef CustomersDeleteOutput = AuthCheckResult;

typedef CustomersUpdateInput = CustomersUpdateRequest;

typedef CustomersUpdateOutput = AuthCheckResult;

typedef DeliveryNotesCreateInput = DeliveryNotesCreateRequest;

typedef DeliveryNotesCreateOutput = ClientScriptsGetRequest;

typedef DeliveryNotesDeleteInput = ClientScriptsGetRequest;

typedef DeliveryNotesDeleteOutput = AuthCheckResult;

typedef DeliveryNotesScanCompleteInput = DeliveryNotesScanStatusRequest;

typedef DeliveryNotesScanCompleteOutput = DeliveryNotesScanCompleteResult;

typedef DeliveryNotesScanCreateUploadInput =
    DeliveryNotesScanCreateUploadRequest;

typedef DeliveryNotesScanCreateUploadOutput =
    DeliveryNotesScanCreateUploadResult;

typedef DeliveryNotesScanParseInput = ParseScanInput;

typedef DeliveryNotesScanParseOutput = DeliveryNotesScanCompleteResult;

typedef DeliveryNotesScanStartInput = DeliveryNotesScanStartRequest;

typedef DeliveryNotesScanStartOutput = DeliveryNotesScanStatusRequest;

typedef DeliveryNotesUpdateInput = DeliveryNotesUpdateRequest;

typedef DeliveryNotesUpdateOutput = AuthCheckResult;

typedef ErrorReportsReportInput = ErrorReportsReportRequest;

typedef ErrorReportsReportOutput = AuthCheckResult;

typedef LlmChatsCreateInput = LlmChatsCreateRequest;

typedef LlmChatsCreateOutput = ChatSummary;

typedef LlmChatsDeleteInput = LlmChatsGetRequest;

typedef LlmChatsDeleteOutput = AuthCheckResult;

typedef LlmMessagesSendInput = LlmMessagesSendRequest;

typedef LlmMessagesSendOutput = LlmChatsGetResult;

typedef LlmProposalsReviewInput = LlmProposalsReviewRequest;

typedef LlmProposalsReviewOutput = AuthCheckResult;

typedef OfficeExportsCreateUploadInput = DeliveryNotesScanCreateUploadRequest;

typedef OfficeExportsCreateUploadOutput = OfficeExportsCreateUploadResult;

typedef PersonalizationActionsAppendInput = PersonalizationActionsAppendRequest;

typedef PersonalizationActionsAppendOutput = AuthCheckResult;

typedef PersonalizationVisitsAppendInput = PersonalizationVisitsAppendRequest;

typedef PersonalizationVisitsAppendOutput = AuthCheckResult;

typedef ProductsCategoriesSetInput = ProductsCategoriesSetRequest;

typedef ProductsCategoriesSetOutput = AuthCheckResult;

typedef ProductsCategoriesTagInput = ProductsCategoriesTagRequest;

typedef ProductsCategoriesTagOutput = AuthCheckResult;

typedef ProductsCategoriesUntagInput = ProductsCategoriesTagRequest;

typedef ProductsCategoriesUntagOutput = AuthCheckResult;

typedef ProductsCreateInput = ProductsCreateRequest;

typedef ProductsCreateOutput = ClientScriptsGetRequest;

typedef ProductsDeleteInput = ClientScriptsGetRequest;

typedef ProductsDeleteOutput = AuthCheckResult;

typedef ProductsPriceImportsApplyInput = ProductsPriceImportsApplyRequest;

typedef ProductsPriceImportsApplyOutput = ProductsPriceImportsApplyResult;

typedef ProductsPriceRecordsCreateInput = ProductsPriceRecordsCreateRequest;

typedef ProductsPriceRecordsCreateOutput = ClientScriptsGetRequest;

typedef ProductsPriceRecordsDeleteInput = ClientScriptsGetRequest;

typedef ProductsPriceRecordsDeleteOutput = AuthCheckResult;

typedef ProductsPriceRecordsUpdateInput = ProductsPriceRecordsUpdateRequest;

typedef ProductsPriceRecordsUpdateOutput = AuthCheckResult;

typedef ProductsUpdateInput = ProductsUpdateRequest;

typedef ProductsUpdateOutput = AuthCheckResult;

typedef ProductsVendorsCreateInput = ProductsVendorsCreateRequest;

typedef ProductsVendorsCreateOutput = ClientScriptsGetRequest;

typedef ProductsVendorsDeleteInput = ClientScriptsGetRequest;

typedef ProductsVendorsDeleteOutput = AuthCheckResult;

typedef ProductsVendorsUpdateInput = ProductsVendorsUpdateRequest;

typedef ProductsVendorsUpdateOutput = AuthCheckResult;

typedef ProjectsContactsAddInput = ProjectsContactsAddRequest;

typedef ProjectsContactsAddOutput = AuthCheckResult;

typedef ProjectsContactsRemoveInput = ProjectsContactsAddRequest;

typedef ProjectsContactsRemoveOutput = AuthCheckResult;

typedef ProjectsContactsSetInput = ProjectsContactsSetRequest;

typedef ProjectsContactsSetOutput = AuthCheckResult;

typedef ProjectsCostsEntriesCreateInput = ProjectsCostsEntriesCreateRequest;

typedef ProjectsCostsEntriesCreateOutput = AuthCheckResult;

typedef ProjectsCostsEntriesDeleteInput = ProjectsCostsEntriesDeleteRequest;

typedef ProjectsCostsEntriesDeleteOutput = AuthCheckResult;

typedef ProjectsCostsEntriesUpdateInput = ProjectsCostsEntriesUpdateRequest;

typedef ProjectsCostsEntriesUpdateOutput = AuthCheckResult;

typedef ProjectsCreateInput = ProjectsCreateRequest;

typedef ProjectsCreateOutput = ClientScriptsGetRequest;

typedef ProjectsDailyReportsCreateInput = ProjectsDailyReportsCreateRequest;

typedef ProjectsDailyReportsCreateOutput = AuthCheckResult;

typedef ProjectsDailyReportsDeleteInput = ProjectsDailyReportsGetRequest;

typedef ProjectsDailyReportsDeleteOutput = AuthCheckResult;

typedef ProjectsDailyReportsPhotosAddInput =
    ProjectsDailyReportsPhotosAddRequest;

typedef ProjectsDailyReportsPhotosAddOutput = AuthCheckResult;

typedef ProjectsDailyReportsPhotosRemoveInput =
    ProjectsDailyReportsPhotosAddRequest;

typedef ProjectsDailyReportsPhotosRemoveOutput = AuthCheckResult;

typedef ProjectsDailyReportsUpdateInput = ProjectsDailyReportsUpdateRequest;

typedef ProjectsDailyReportsUpdateOutput = AuthCheckResult;

typedef ProjectsDeleteInput = ClientScriptsGetRequest;

typedef ProjectsDeleteOutput = AuthCheckResult;

typedef ProjectsDeploymentsCreateInput = ProjectsDeploymentsCreateRequest;

typedef ProjectsDeploymentsCreateOutput = ClientScriptsGetRequest;

typedef ProjectsDeploymentsDeleteInput = ClientScriptsGetRequest;

typedef ProjectsDeploymentsDeleteOutput = AuthCheckResult;

typedef ProjectsDeploymentsUpdateInput = ProjectsDeploymentsUpdateRequest;

typedef ProjectsDeploymentsUpdateOutput = AuthCheckResult;

typedef ProjectsFilesCompleteUploadInput = ProjectsFilesCompleteUploadRequest;

typedef ProjectsFilesCompleteUploadOutput = AuthCheckResult;

typedef ProjectsFilesCreateUploadInput = ProjectsFilesCreateUploadRequest;

typedef ProjectsFilesCreateUploadOutput = ProjectsFilesCreateUploadResult;

typedef ProjectsFilesDeleteInput = ProjectsFilesDeleteRequest;

typedef ProjectsFilesDeleteOutput = AuthCheckResult;

typedef ProjectsFilesDrawioSaveInput = ProjectsFilesDrawioSaveRequest;

typedef ProjectsFilesDrawioSaveOutput = ProjectsFilesDrawioSaveResult;

typedef ProjectsFilesFoldersCreateInput = ProjectsFilesFoldersCreateRequest;

typedef ProjectsFilesFoldersCreateOutput = ProjectsFilesFoldersCreateResult;

typedef ProjectsFilesFoldersDeleteInput = ProjectsFilesFoldersDeleteRequest;

typedef ProjectsFilesFoldersDeleteOutput = AuthCheckResult;

typedef ProjectsFilesFoldersMoveInput = ProjectsFilesFoldersMoveRequest;

typedef ProjectsFilesFoldersMoveOutput = AuthCheckResult;

typedef ProjectsFilesFoldersRenameInput = ProjectsFilesFoldersRenameRequest;

typedef ProjectsFilesFoldersRenameOutput = AuthCheckResult;

typedef ProjectsFilesMoveInput = ProjectsFilesMoveRequest;

typedef ProjectsFilesMoveOutput = AuthCheckResult;

typedef ProjectsFilesRenameInput = ProjectsFilesRenameRequest;

typedef ProjectsFilesRenameOutput = AuthCheckResult;

typedef ProjectsFinishInput = ClientScriptsGetRequest;

typedef ProjectsFinishOutput = AuthCheckResult;

typedef ProjectsResumeInput = ClientScriptsGetRequest;

typedef ProjectsResumeOutput = AuthCheckResult;

typedef ProjectsUnavailabilityCreateInput = ProjectsUnavailabilityCreateRequest;

typedef ProjectsUnavailabilityCreateOutput = ClientScriptsGetRequest;

typedef ProjectsUnavailabilityDeleteInput = ClientScriptsGetRequest;

typedef ProjectsUnavailabilityDeleteOutput = AuthCheckResult;

typedef ProjectsUnavailabilityUpdateInput = ProjectsUnavailabilityUpdateRequest;

typedef ProjectsUnavailabilityUpdateOutput = AuthCheckResult;

typedef ProjectsUpdateInput = ProjectsUpdateRequest;

typedef ProjectsUpdateOutput = AuthCheckResult;

typedef RegieReportsCreateInput = RegieReportsCreateRequest;

typedef RegieReportsCreateOutput = ClientScriptsGetRequest;

typedef RegieReportsDeleteInput = ClientScriptsGetRequest;

typedef RegieReportsDeleteOutput = AuthCheckResult;

typedef RegieReportsUpdateInput = RegieReportsUpdateRequest;

typedef RegieReportsUpdateOutput = AuthCheckResult;

typedef RemarksCreateInput = RemarksCreateRequest;

typedef RemarksCreateOutput = ClientScriptsGetRequest;

typedef RemarksDeleteInput = ClientScriptsGetRequest;

typedef RemarksDeleteOutput = AuthCheckResult;

typedef RemarksUpdateInput = RemarksUpdateRequest;

typedef RemarksUpdateOutput = AuthCheckResult;

typedef SettingsCostsDeleteInput = SettingsCostsDeleteRequest;

typedef SettingsCostsDeleteOutput = AuthCheckResult;

typedef SettingsCostsSetInput = SettingsCostsSetRequest;

typedef SettingsCostsSetOutput = AuthCheckResult;

typedef SettingsCostsUpdateInput = SettingsCostsUpdateRequest;

typedef SettingsCostsUpdateOutput = AuthCheckResult;

typedef SettingsGlobalDeleteInput = SettingsGlobalGetRequest;

typedef SettingsGlobalDeleteOutput = AuthCheckResult;

typedef SettingsGlobalSetInput = SettingsGlobalGetResult;

typedef SettingsGlobalSetOutput = AuthCheckResult;

typedef SettingsLanguageSetInput = SettingsLanguageSetRequest;

typedef SettingsLanguageSetOutput = AuthCheckResult;

typedef SettingsPublicGlobalDeleteInput = SettingsGlobalGetRequest;

typedef SettingsPublicGlobalDeleteOutput = AuthCheckResult;

typedef SettingsPublicGlobalSetInput = SettingsGlobalGetResult;

typedef SettingsPublicGlobalSetOutput = AuthCheckResult;

typedef SettingsTenantLogoCompleteUploadInput =
    SettingsTenantLogoCompleteUploadRequest;

typedef SettingsTenantLogoCompleteUploadOutput = AuthCheckResult;

typedef SettingsTenantLogoCreateUploadInput =
    SettingsTenantLogoCreateUploadRequest;

typedef SettingsTenantLogoCreateUploadOutput =
    SettingsTenantLogoCreateUploadResult;

typedef SettingsTenantNameSetInput = SettingsTenantNameSetRequest;

typedef SettingsTenantNameSetOutput = AuthCheckResult;

typedef ToolsArchiveInput = ClientScriptsGetRequest;

typedef ToolsArchiveOutput = AuthCheckResult;

typedef ToolsCreateInput = ToolsCreateRequest;

typedef ToolsCreateOutput = ClientScriptsGetRequest;

typedef ToolsDeleteInput = ClientScriptsGetRequest;

typedef ToolsDeleteOutput = AuthCheckResult;

typedef ToolsInventoriesCreateInput = ToolsInventoriesCreateRequest;

typedef ToolsInventoriesCreateOutput = ClientScriptsGetRequest;

typedef ToolsInventoriesDeleteInput = ClientScriptsGetRequest;

typedef ToolsInventoriesDeleteOutput = AuthCheckResult;

typedef ToolsTrackInput = ToolsTrackRequest;

typedef ToolsTrackOutput = ToolsTrackResult;

typedef ToolsTrackingsTransfersAcceptInput =
    ToolsTrackingsTransfersAcceptRequest;

typedef ToolsTrackingsTransfersAcceptOutput = AuthCheckResult;

typedef ToolsTrackingsTransfersDenyInput = ClientScriptsGetRequest;

typedef ToolsTrackingsTransfersDenyOutput = AuthCheckResult;

typedef ToolsTrackingsTransfersRequestInput =
    ToolsTrackingsTransfersRequestRequest;

typedef ToolsTrackingsTransfersRequestOutput = ClientScriptsGetRequest;

typedef ToolsUnarchiveInput = ClientScriptsGetRequest;

typedef ToolsUnarchiveOutput = AuthCheckResult;

typedef ToolsUntrackInput = ClientScriptsGetRequest;

typedef ToolsUntrackOutput = AuthCheckResult;

typedef ToolsUpdateInput = ToolsUpdateRequest;

typedef ToolsUpdateOutput = AuthCheckResult;

typedef UsersActivateInput = ClientScriptsGetRequest;

typedef UsersActivateOutput = AuthCheckResult;

typedef UsersArchiveInput = ClientScriptsGetRequest;

typedef UsersArchiveOutput = AuthCheckResult;

typedef UsersCreateInput = UsersCreateRequest;

typedef UsersCreateOutput = ClientScriptsGetRequest;

typedef UsersDeactivateInput = ClientScriptsGetRequest;

typedef UsersDeactivateOutput = AuthCheckResult;

typedef UsersDeleteInput = ClientScriptsGetRequest;

typedef UsersDeleteOutput = AuthCheckResult;

typedef UsersRolesSetInput = UsersRolesSetRequest;

typedef UsersRolesSetOutput = AuthCheckResult;

typedef UsersSupervisorsSetDefaultInput = UsersSupervisorsGetDefaultResult;

typedef UsersSupervisorsSetDefaultOutput = AuthCheckResult;

typedef UsersUnarchiveInput = ClientScriptsGetRequest;

typedef UsersUnarchiveOutput = AuthCheckResult;

typedef UsersUpdateInput = UsersUpdateRequest;

typedef UsersUpdateOutput = AuthCheckResult;

typedef UsersVacationsApproveInput = ClientScriptsGetRequest;

typedef UsersVacationsApproveOutput = AuthCheckResult;

typedef UsersVacationsCreateInput = UsersVacationsCreateRequest;

typedef UsersVacationsCreateOutput = UsersVacationsCreateResult;

typedef UsersVacationsDeleteInput = ClientScriptsGetRequest;

typedef UsersVacationsDeleteOutput = AuthCheckResult;

typedef UsersVacationsDenyInput = UsersVacationsDenyRequest;

typedef UsersVacationsDenyOutput = AuthCheckResult;
