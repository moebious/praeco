ALTER TABLE praeco_workspace.chat_access
  ADD COLUMN binding_id UUID;

UPDATE praeco_workspace.chat_access
SET binding_id = gen_random_uuid()
WHERE binding_id IS NULL;

ALTER TABLE praeco_workspace.chat_access
  ALTER COLUMN binding_id SET NOT NULL;

CREATE UNIQUE INDEX chat_access_binding_id_unique
  ON praeco_workspace.chat_access (binding_id);
