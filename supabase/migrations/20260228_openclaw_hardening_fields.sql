-- OpenClaw hardening + Discord partitioning controls
ALTER TABLE public.openclaw_config
  ADD COLUMN IF NOT EXISTS discord_staff_guild_ids text,
  ADD COLUMN IF NOT EXISTS discord_staff_channel_ids text,
  ADD COLUMN IF NOT EXISTS discord_resident_guild_ids text,
  ADD COLUMN IF NOT EXISTS discord_resident_channel_ids text,
  ADD COLUMN IF NOT EXISTS resident_mode_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS resident_allowed_commands text,
  ADD COLUMN IF NOT EXISTS discord_dm_policy text DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS telegram_dm_policy text DEFAULT 'open',
  ADD COLUMN IF NOT EXISTS allow_insecure_auth boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_host_header_origin_fallback boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS disable_device_auth boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS record_payment_staff_only boolean DEFAULT true;
