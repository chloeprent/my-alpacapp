-- Migration: Add email_forwarding_config table for managing inbound email forwarding rules
-- This table stores configuration for routing inbound emails received via Resend webhook

CREATE TABLE IF NOT EXISTS email_forwarding_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  address_prefix TEXT NOT NULL, -- e.g., 'team', 'haydn', 'rahulio'
  forward_to TEXT NOT NULL, -- destination email address
  label TEXT, -- optional friendly label
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Ensure no duplicate prefix + forward_to combinations
  CONSTRAINT unique_prefix_forward_to UNIQUE (address_prefix, forward_to)
);

-- Add index for faster lookups by prefix
CREATE INDEX IF NOT EXISTS idx_email_forwarding_prefix ON email_forwarding_config(address_prefix);

-- Add index for active rules
CREATE INDEX IF NOT EXISTS idx_email_forwarding_active ON email_forwarding_config(is_active) WHERE is_active = true;

-- Enable RLS
ALTER TABLE email_forwarding_config ENABLE ROW LEVEL SECURITY;

-- Policy: Admin users can read all forwarding rules
CREATE POLICY "Admin users can read email forwarding rules"
  ON email_forwarding_config
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'admin'
    )
  );

-- Policy: Admin users can insert forwarding rules
CREATE POLICY "Admin users can insert email forwarding rules"
  ON email_forwarding_config
  FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'admin'
    )
  );

-- Policy: Admin users can update forwarding rules
CREATE POLICY "Admin users can update email forwarding rules"
  ON email_forwarding_config
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'admin'
    )
  );

-- Policy: Admin users can delete forwarding rules
CREATE POLICY "Admin users can delete email forwarding rules"
  ON email_forwarding_config
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role = 'admin'
    )
  );

-- Insert default forwarding rules based on CLAUDE.md documentation
INSERT INTO email_forwarding_config (address_prefix, forward_to, label, is_active) VALUES
  ('haydn', 'hUSERNAME@gmail.com', 'Haydn personal', true),
  ('rahulio', 'rahulioson@gmail.com', 'Rahulio personal', true),
  ('sonia', 'sonia245g@gmail.com', 'Sonia personal', true),
  ('team', 'admin@YOUR_DOMAIN', 'Main inbox', true)
ON CONFLICT (address_prefix, forward_to) DO NOTHING;

-- Add comment to table
COMMENT ON TABLE email_forwarding_config IS 'Configuration for routing inbound emails received at @YOUR_DOMAIN to specific destinations';
