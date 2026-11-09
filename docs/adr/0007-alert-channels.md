# ADR-0007: Notifications leave through a Notifier chain (Telegram, then LINE)

- **Status:** Proposed (panel redesign 2026-11-10)
- **Date:** 2026-11-10
- **Brief refs:** panel redesign `PLAN.md` §B (alert delivery), §C12, §D lane
  W01 task W01-4, §E acceptance E5, decision D3 (Telegram in release 1, LINE
  as a follow-up); existing alerts machinery in `packages/insights/src/alerts.ts`,
  `workers/core/src/cron.ts`
- **Spec:** `docs/runbooks/notifications.md` (operator steps),
  `packages/leads-db/migrations/0029_alert_state.sql`,
  `0030_notification_log.sql` (schema, lane W01)

## Context

Alerts already run on the `*/15` cron in `workers/core/src/cron.ts:62-78` and
are evaluated by a pluggable `Notifier`
(`packages/insights/src/alerts.ts:346-363`), today `ConsoleNotifier`: alerts
only reach stdout. The T9 rules (conversion stalls, brands without postbacks,
submit error rate, reject rate, FUS-372 click risk, bot_hits) evaluate
against the `AlertsReportResponse` the panel already parses.

The owner asked for delivery to chat channels: Telegram now, LINE later.
LINE Notify closed on 2025-03-31, so the LINE path is the Messaging API
(`POST https://api.line.me/v2/bot/message/push` with a channel access token),
which needs an owned Official Account the owner has not created yet. Channel
mechanics must not leak lead PII (B6: title with level emoji, brand, Thai
rule text, key number, timestamp, deep link — no tokens).

## Decision

1. **One outbound contract: the `Notifier` chain.** A `MultiNotifier` in
   `packages/insights/src/notify/` implements the existing `Notifier`
   interface and replaces `ConsoleNotifier` in cron `CronDeps.notifier`.
   Inside, one channel module per provider (`telegram.ts`, later `line.ts`)
   behind the same `send(target, message)` shape. Rules logic (routing,
   dedupe, quiet hours, digest) lives in `multi.ts`, never in a provider
   module.
2. **Telegram ships with release 1; LINE ships later.** `TelegramNotifier.send`
   posts HTML `parse_mode` to `https://api.telegram.org/bot<token>/sendMessage`
   with one inline button ("เปิดใน panel") deep-linking
   `https://app.<tenant>/alerts?key=<alert_key>`. `LineNotifier` follows once
   the owner has an Official Account and channel token (decision D3); it
   will use Messaging API push with a Flex Message and the same interface,
   so no call site changes.
3. **Both are plain `fetch` from core.** Allowed by
   `global_fetch_strictly_public`; no third-party SDK, no extra binding.
   429 and 5xx get one retry honouring `retry_after`.
4. **State is D1-only and tenant-local.** `alert_state(alert_key, state,
   first_seen, last_sent, acknowledged_by, acknowledged_at, closed_at)`
   holds routing state; `notification_log(id, channel, target, alert_key,
   status, response_code, body_hash, sent_at)` is the delivery history the
   panel's "ประวัติการส่ง" tab reads. Nothing lives in a cache, KV or R2
   (ADR-0001; `body_hash` keys redelivery, no message bodies).
5. **Secrets are Worker secrets; configuration lives in `panel_settings`.**
   `TELEGRAM_BOT_TOKEN` (later `LINE_CHANNEL_ACCESS_TOKEN`) sit in core's
   `env.ts` as optional fields — absent means the cron skips sending and
   warns once. Non-secret config (`notify.telegram`, `notify.line`,
   `notify.routing`, `notify.digest`: chat ids, enabled rules, repeat
   intervals, quiet hours, digest time) lives in `panel_settings`, edited by
   owner-only panel handlers with zod + `audit_log`, read through `FACTORY`
   on each cron run. No secret is ever written to D1 or a log line.
6. **Sending rules (PLAN §B3) are level-transition driven.** Send on
   ok→warn/alert transition and on escalation (warn→alert); repeat every
   N hours while a block stays open (default 6, per rule); never resend an
   acknowledged alert until it clears and returns; quiet hours per channel
   (default none, Asia/Bangkok); optional daily digest at 09:00
   Asia/Bangkok carrying the 5 KPI numbers.
7. **Fast path through the same notifier.** AdsBot and non-200 page events
   arriving via `TrafficTail` (ADR-0006) post through the notifier with a
   10-minute cooldown; they are a subset of the same `notification_log`
   trail, not a second pipeline.
8. **Message content carries no PII.** One line with level emoji + rule
   text + brand, one key number, `ตรวจพบ HH:MM`, deep link. No lead data,
   no tokens, no IP, no email field exists in the allowed message schema.

## Consequences

- Dedupe survives cron restarts because it lives in D1; a wiped
  `alert_state` row costs at most one duplicate message, never a missed one.
- `notification_log` grows by one row per attempt and is the single place to
  answer "was it sent, to whom, did the provider accept it" — the panel
  never needs provider API access for history.
- Provider outage or rate limit (Telegram: 30 msg/s per bot, 20/min per
  group; LINE: push quota per plan, ~200 messages/month free on some OAs) is
  absorbed by cooldown, repeat intervals and the digest rather than a queue
  — the mention is lost beyond retries, but the log row records the failure
  status.
- Quiet hours and acknowledgment are per-channel conscious: acknowledged
  alerts are silent until they clear, so an alert the owner closed cannot
  nag.
- A leaked `alert_key` in a message deep link reveals only a rule state key,
  not lead data; panel access is still authenticated.
- New channels (SMS, email relay) subclass the same chain without touching
  rules code.
