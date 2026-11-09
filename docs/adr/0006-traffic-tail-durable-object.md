# ADR-0006: The real-time traffic tail is one Durable Object in core over SSE

- **Status:** Proposed (panel redesign 2026-11-10)
- **Date:** 2026-11-10
- **Brief refs:** panel redesign `PLAN.md` §A8 (real-time traffic tab),
  §D lane W01 task W01-1, §E acceptance E4 and E8, decision D4 (release 1 =
  stream + KPI + AdsBot only); port sources `aurum-observe-admin` and
  `aurum-event-tail` (read only)
- **Spec:** `docs/superpowers/plans/2026-11-09-panel-design-diff.md`
  (Traffic tab), `workers/core/src/analytics.ts` (the insert this hooks into)

## Context

The traffic_events table is written by `workers/core/src/analytics.ts`
(~line 155) on every telemetry forward — landing_viewed, form_started,
lead_submitted, redirect_failed and six more kinds. The panel reads it only
through polling reports (`GET /admin/traffic/...`), so the new real-time tab
cannot show an event seconds after it happens.

The redesign needs: an event visible in the panel within 2 s (E4), a filter
by brand, an envelope that carries no PII, and nothing that ever changes
what a site serves (AGENTS.md rule 3). No Durable Object, no SSE and no push
path exist in the repo today.

AURUM already proved the pattern in read-only port sources:
`aurum-event-tail/src/event-tail-do.ts` (251 lines) is a Durable Object with
an in-memory ring, a 15 s ping, a 500-id dedupe and a strict Zod envelope
that rejects email/ip/gclid; `aurum-observe-admin/public/realtime-client.js`
consumes it with EventSource. It was never deployed by AURUM, so it ports
cleanly.

## Alternatives considered (rejected)

- **Poll D1 every 5 s.** No new machinery, lowest risk. It costs a
  `SELECT ... WHERE created_at > ?` per panel connection every 5 s against
  the leads database even when nothing arrives, still misses the "within
  2 s" bar on a quiet system, and pushes polling load onto D1 per open panel
  tab. D1 is the only datastore (ADR-0001) and already serves every report;
  adding a per-second poll surface there is the wrong trade.
- **WebSocket.** Bidirectional when the panel only needs to read. A DO
  WebSocket keeps an open socket per tab, needs its own hibernation and
  reconnect logic, and makes the panel proxy (`apps/web/src/server`) hold a
  two-way stream where one-way SSE with `retry: 3000` does the same job with
  a normal request/response path and browser auto-reconnect.
- **Cloudflare Queues.** Durable delivery we do not need: the tail is an
  observation window, not a stream of record — traffic_events in D1 already
  is. Queues add a second consumer path, per-account consumer wiring, and a
  delay of seconds to "react to backpressure" logic that exists only to feed
  a live view.
- **Keep AURUM's separate event service.** Two Workers, two certificates,
  two deploy steps per tenant for one feature. The tail belongs to core,
  which already receives the telemetry event and owns every traffic read.

## Decision

1. **One `TrafficTail` Durable Object in core.** One instance per tenant
   account (`idFromName("tail")`). It holds an in-memory ring of the last
   500 events, deduplicates by `event_id` (500-id window), and streams to
   panel clients as `text/event-stream` with `retry: 3000` and a ping every
   15 s, filtered by a brand list from the query.
2. **Core pushes after insert.** The telemetry handler in `analytics.ts`
   calls the DO (binding `TRAFFIC_TAIL`) after the traffic_events insert
   succeeds. A DO failure must not fail telemetry: the response to the
   visitor stays a bare 204 whatever breaks upstream of it.
3. **The envelope is strict and carries no PII.** Zod strict object ported
   from `aurum-event-tail/src/envelope.ts`: event kind, `session_ref` =
   first 16 hex chars of sha256(session_id) (never the raw id), brand,
   hostname, timestamps and non-identifying form fields. No email, IP,
   gclid or lead id field exists to fill. The DO rejects an oversized or
   unknown-field envelope.
4. **Ingest is internal; egress is the panel proxy.**
   `POST /internal/traffic-tail/push` on core (or the direct binding) is not
   exposed to brand Workers' clients; the panel connects through
   `GET /api/traffic/tail`, an owner/employee-authenticated proxy with a 5 s
   connect timeout that answers 503 when core is unreachable. No auth
   header reaches the browser client.
5. **Display only.** The tail, its classification fields
   (`user_agent_family`, `country`, `region`) and anything the panel derives
   from them are read-only consumers. No response from any brand Worker, the
   form or core varies by UA, country, ASN, referrer or gclid (E8).
   Classification is stored and streamed only.
6. **No backfill, no persistence.** The ring is memory. A DO restart or a
   panel reconnect starts from "now"; the panel backfills totals from
   `GET /api/traffic/realtime`, not from replayed events. traffic_events in
   D1 stays the only durable record.

## Consequences

- Memory ring 500: bursty traffic older than ~500 events vanishes from the
  live view even while the KPI numbers stay correct (they come from D1).
  That is acceptable for a watch view; the recent-200 table covers history.
- No backfill: a dropped stream (crash, desktop sleep) loses the events
  between disconnect and reconnect. The client shows the gap via the
  last-event timestamp instead of reconstructing it.
- No PII in the envelope: the panel can show a session chain but never a
  lead's email or IP, by construction.
- Classification stored, never used to vary a response:
  `user_agent_family`/`country` power the AdsBot banner and the ประเทศ/รัฐ
  breakdown. A test keeps the telemetry response bytes identical for a
  browser UA and an AdsBot UA.
- One DO per account keeps tenants isolated with zero shared state (same
  model as ADR-0003's per-tenant installs) and bounds billing; the DO idles
  most of the day because push only happens on traffic.
- A DO outage degrades the real-time tab to poll-refresh; reports, alerts
  and the funnel are unaffected.
