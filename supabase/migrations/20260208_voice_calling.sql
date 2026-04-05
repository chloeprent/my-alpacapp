-- =============================================
-- AI Voice Calling System (Vapi + Gemini Flash)
-- =============================================

-- Vapi configuration (single-row, id=1 pattern)
CREATE TABLE IF NOT EXISTS vapi_config (
  id integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  api_key text,
  phone_number_id text,
  is_active boolean DEFAULT false,
  test_mode boolean DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Seed the single config row
INSERT INTO vapi_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Voice assistants (configurable AI personas/prompts)
CREATE TABLE IF NOT EXISTS voice_assistants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  system_prompt text NOT NULL,
  first_message text DEFAULT 'Hello! Thanks for calling. How can I help you today?',
  model_provider text DEFAULT 'google',
  model_name text DEFAULT 'gemini-2.0-flash',
  voice_provider text DEFAULT '11labs',
  voice_id text DEFAULT 'sarah',
  temperature numeric(3,2) DEFAULT 0.7,
  max_duration_seconds integer DEFAULT 600,
  is_active boolean DEFAULT true,
  is_default boolean DEFAULT false,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Voice call logs
CREATE TABLE IF NOT EXISTS voice_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vapi_call_id text UNIQUE,
  assistant_id uuid REFERENCES voice_assistants(id),
  caller_phone text,
  person_id uuid REFERENCES people(id),
  status text DEFAULT 'queued',
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  cost_cents numeric(10,2),
  transcript jsonb,
  summary text,
  recording_url text,
  ended_reason text,
  metadata jsonb DEFAULT '{}',
  created_at timestamptz DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_voice_calls_vapi_call_id ON voice_calls(vapi_call_id);
CREATE INDEX IF NOT EXISTS idx_voice_calls_status ON voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_voice_calls_created_at ON voice_calls(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_calls_person_id ON voice_calls(person_id);
CREATE INDEX IF NOT EXISTS idx_voice_assistants_is_default ON voice_assistants(is_default) WHERE is_default = true;

-- RLS policies
ALTER TABLE vapi_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_assistants ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;

-- Service role can do everything (edge functions use service key)
CREATE POLICY "service_role_all" ON vapi_config FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON voice_assistants FOR ALL TO service_role USING (true);
CREATE POLICY "service_role_all" ON voice_calls FOR ALL TO service_role USING (true);

-- Authenticated users can read config and assistants (admin UI)
CREATE POLICY "authenticated_read_config" ON vapi_config FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_manage_config" ON vapi_config FOR ALL TO authenticated USING (true);
CREATE POLICY "authenticated_read_assistants" ON voice_assistants FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_manage_assistants" ON voice_assistants FOR ALL TO authenticated USING (true);
CREATE POLICY "authenticated_read_calls" ON voice_calls FOR SELECT TO authenticated USING (true);
CREATE POLICY "authenticated_manage_calls" ON voice_calls FOR ALL TO authenticated USING (true);
