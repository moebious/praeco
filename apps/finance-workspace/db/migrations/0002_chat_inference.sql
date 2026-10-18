CREATE TABLE praeco_workspace.chat_access (
  conversation_id UUID PRIMARY KEY REFERENCES praeco_workspace.conversations(id) ON DELETE CASCADE,
  session_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  budget_usd NUMERIC(20,9) NOT NULL DEFAULT 0.05 CHECK (budget_usd > 0 AND budget_usd <= 0.05),
  max_calls INTEGER NOT NULL DEFAULT 20 CHECK (max_calls BETWEEN 1 AND 20)
);

CREATE TABLE praeco_workspace.chat_usage (
  id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES praeco_workspace.chat_access(conversation_id) ON DELETE CASCADE,
  request_key TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'OpenRouter',
  status TEXT NOT NULL CHECK (status IN ('reserved', 'completed', 'unknown')),
  reserved_usd NUMERIC(20,9) NOT NULL CHECK (reserved_usd >= 0),
  actual_usd NUMERIC(20,9) CHECK (actual_usd >= 0),
  input_tokens INTEGER,
  output_tokens INTEGER,
  reported_usage JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chat_usage_completion_check CHECK (status <> 'completed' OR actual_usd IS NOT NULL),
  CONSTRAINT chat_usage_request_unique UNIQUE (conversation_id, request_key)
);
