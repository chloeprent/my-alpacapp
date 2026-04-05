-- Add api_addendum column to pai_config for the PAI API channel
-- Parallel to chat_addendum and email_addendum
ALTER TABLE pai_config ADD COLUMN IF NOT EXISTS api_addendum text DEFAULT '';

UPDATE pai_config SET api_addendum = 'You are responding via the PAI HTTP API channel. Keep responses concise and structured. Return factual data when possible. Avoid markdown formatting — use plain text since the consumer may not render markdown.' WHERE id = 1;
