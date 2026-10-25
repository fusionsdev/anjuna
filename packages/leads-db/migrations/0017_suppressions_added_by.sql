-- FUS-382 task 11: actor of a manually added suppression (actor_id of the owner who
-- added it). Nullable: listmonk sync rows have no actor, and the sync upsert never writes
-- this column, so a manual row keeps its actor when the sync later touches it.
ALTER TABLE suppressions ADD COLUMN added_by TEXT;
