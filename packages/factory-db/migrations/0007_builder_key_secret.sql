-- Builder keys are shown again in the control panel (owner ruling 2026-10-19), so the plaintext lives beside the hash.
ALTER TABLE builder_keys ADD COLUMN secret TEXT;
