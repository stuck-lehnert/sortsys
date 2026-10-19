import '../../api/generated/models.g.dart' as models;

abstract interface class ContactWriteAccess {
  String get scope;

  void checkCurrent();

  void checkCreate(models.ContactsCreateInput input);

  void checkUpdate(models.ContactsUpdateInput input);

  Future<models.ContactsCreateOutput> createContact(
    models.ContactsCreateInput input,
  );

  Future<models.ContactsUpdateOutput> updateContact(
    models.ContactsUpdateInput input,
  );

  Future<models.Contact?> getContact(String id);
}
