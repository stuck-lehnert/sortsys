ALTER TABLE llm_messages
  DROP CONSTRAINT llm_messages_chat_id_fkey,
  ADD CONSTRAINT llm_messages_chat_id_fkey
    FOREIGN KEY (chat_id)
    REFERENCES llm_chats (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE;

ALTER TABLE llm_change_proposals
  DROP CONSTRAINT llm_change_proposals_chat_id_fkey,
  ADD CONSTRAINT llm_change_proposals_chat_id_fkey
    FOREIGN KEY (chat_id)
    REFERENCES llm_chats (id)
    ON UPDATE CASCADE
    ON DELETE CASCADE,
  DROP CONSTRAINT llm_change_proposals_assistant_message_id_fkey,
  ADD CONSTRAINT llm_change_proposals_assistant_message_id_fkey
    FOREIGN KEY (assistant_message_id)
    REFERENCES llm_messages (id)
    ON UPDATE CASCADE
    ON DELETE SET NULL;

ALTER TABLE llm_chats
  ALTER COLUMN id SET DEFAULT id64 ();

ALTER TABLE llm_messages
  ALTER COLUMN id SET DEFAULT id64 ();

ALTER TABLE llm_change_proposals
  ALTER COLUMN id SET DEFAULT id64 ();

-- Replace IDs created by the former BIGSERIAL defaults. Cascading foreign keys
-- keep messages and proposals attached to their chats while the IDs change.
UPDATE llm_chats
SET id = id64 ();

UPDATE llm_messages
SET id = id64 ();

UPDATE llm_change_proposals
SET id = id64 ();
