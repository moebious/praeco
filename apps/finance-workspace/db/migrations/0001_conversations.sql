CREATE TABLE praeco_workspace.conversations (
  id UUID PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  specialist_id TEXT NOT NULL,
  profile_version INTEGER NOT NULL,
  title TEXT NOT NULL,
  preview TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT conversations_specialist_check CHECK (specialist_id IN ('vera', 'kael', 'nova')),
  CONSTRAINT conversations_title_check CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT conversations_profile_version_check CHECK (profile_version > 0)
);

CREATE UNIQUE INDEX conversations_owner_specialist_unique
  ON praeco_workspace.conversations (tenant_id, owner_user_id, specialist_id);
