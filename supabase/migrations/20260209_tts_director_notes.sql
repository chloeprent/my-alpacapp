-- Add tts_director_notes JSONB column to spirit_whisper_config
-- Stores custom Audio Profile + Scene + Director's Notes per chapter
-- Format: { "audio_profile": "...", "scenes": { "1": "...", "2": "...", "3": "...", "4": "..." } }
ALTER TABLE spirit_whisper_config ADD COLUMN IF NOT EXISTS tts_director_notes jsonb DEFAULT NULL;
