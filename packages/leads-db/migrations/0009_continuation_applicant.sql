-- B-01: a duplicate submit hands off the CURRENT validated applicant (V1 handleLead duplicate branch).
-- NULL for accepted submits, where the stored row is this submit. Cleared when the token is claimed;
-- the mailing cron clears expired snapshots. Accepted continuations still persist only token hashes.
ALTER TABLE continuations ADD COLUMN applicant_json TEXT;
