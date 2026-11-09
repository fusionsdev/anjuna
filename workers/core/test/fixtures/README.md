# Panel fixtures

Run `node workers/core/test/fixtures/compute-expected.mjs` from the repo root.
Add `--check` to detect a stale expected file without writing it.

- `traffic-events.ndjson`: 40 strict `TrafficTailEvent` envelopes, four
  synthetic `.example` brands, all ten analytics event types and all 24 UTC
  buckets from 2026-11-09 13:00 through 2026-11-10 12:00.
- `traffic-events.context.json`: synthetic D1 seed fields keyed by event ID,
  and the frozen clock (12:30 UTC). Never forward this sidecar to the tail.
- `traffic-events.expected.json`: exact `TrafficRealtimeResponse` for that
  clock. Previous-day rows are absent, so all nine deltas are null (zero or
  unavailable baseline), not invented zero-percent changes.
- Bot counts seed one `bot_hits` hit for each of the six bot envelopes.
  AdsBot has three hits, Googlebot two, other-bot one. Current-hour AdsBot
  count is one; the other two current-hour counts are zero.
- The AdsBot 500 stays in the tail. Report `adsbot_last` fields for status,
  duration and gate outcome are null because D1 does not persist them.
- There are 12 landings, four starts, four leads, four validation errors,
  four redirect errors, one suspicious session, five landings without gclid
  (41.666666666666664%), three gate drops and 10% non-US events (CA/GB/DE/TH).
  A gate drops when its host/session has no later landing or form start.
- Breakdowns count every event, sort by count descending then key ascending,
  and keep ten rows. Source has 12 distinct values to exercise truncation;
  percentages use all 40 events, including the omitted two source rows.

## Alert scenarios

Every JSON in `alert-reports/` is a strict `AlertsReportResponse`.
`all-ok` has every rule ok. `one-warn` has submit errors at 15/100.
`one-alert` has submit errors at 30/100. Replay `one-warn` then
`warn-to-alert` (12:15 UTC) to exercise escalation of the same rule/brand.
`acknowledged` is the report at 12:20 UTC; the condition remains alert.
Load `acknowledged.state.json` alongside it for the strict `AlertStateRow`
with acknowledgment metadata. The report contract has no acknowledgment
fields; this fixture does not invent them or change the measured severity.

The UA text fixture is in `apps/web/test/fixtures/adsbot-user-agents.txt`.
It cites Google's current docs and keeps their Chrome version placeholder.
These are synthetic test inputs, not verified crawler identities.
