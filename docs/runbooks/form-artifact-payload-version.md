# Form artifact payload-version metadata

`form_artifacts.git_sha` and its R2 key identify the uploaded form bundle (for example,
`form@8ba11d3`). They do not identify the lead payload schema. Lifecycle selection requires
the separately verified `payload_version` column to match the core tenant payload (currently
`2026-01`).

## Owner-only legacy backfill

The Task 7 panel BFF exposes the one-shot Owner-only metadata operation for legacy artifact
rows. An operator must provide:

1. the exact `form_artifact_id`; and
2. the payload version verified against the artifact and the core submit contract (for example,
   `2026-01`).

The operation is set-once: a row whose `payload_version` is already non-null is rejected, even
when a caller supplies a different value. Rows with a null value remain ineligible for lifecycle
install, rollback, or upgrade selection until this verification is complete. The database
trigger also prevents changing an established value.

Before any owner-gated rollout, exercise the operation with a dry run or local D1 test and
record the artifact id, verified version, expected conflict on replay, and the resulting
selection/preflight evidence in the change record. Do not execute this backfill remotely during
T12b implementation; no Cloudflare deployment or remote migration is part of this task.
