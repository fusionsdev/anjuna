# Operator runbook: alert notifications (Telegram now, LINE later)

- **Date:** 2026-11-10 · **Scope:** Wave 5 (T20, W01-4) ·
  **ADR:** `docs/adr/0007-alert-channels.md`
- **Who runs this:** the owner, per tenant (aduplift first, maimax when its
  go-live gates open). Every command here is copy-pasteable from the repo
  root with `bun`/`bunx` on PATH; none is safe to run from an agent session
  (real external calls and secrets are owner-gated).

## 1. Prerequisites

- Repository checked out; tenant configured in `tenants/<name>.config.ts`
  (app domain per tenant: `app.aduplift.ai`, `app.maimax.com`).
- The core Worker of the tenant is deployed (Wave 4 gate) with
  `TELEGRAM_BOT_TOKEN` as below. Until the token exists the alerts cron
  still runs — it computes reports, writes nothing to Telegram, and logs
  `telegram_not_configured` once per isolate instead of failing.
- The rules themselves (conversion stalled, brands without postbacks,
  submit error rate, reject rate, click risk, bot hits) come from the
  existing `*/15` alerts cron; delivery uses the `MultiNotifier` replacing
  `ConsoleNotifier`.

## 2. Create the Telegram bot

1. In Telegram, open [@BotFather](https://t.me/BotFather) → `/newbot`.
2. Choose a name (display) and a username ending in `bot` (e.g.
   `anjuna_alerts_bot`).
3. BotFather answers with the bot token: `<bot-id>:<random-40-hex>`.
   **The token is a secret** — paste it once into `wrangler secret put`
   (step 4). Never commit it, never paste it in a chat, log or ticket
   (acceptance E5: no token appears in any log or D1 row).
4. Set the token as a core Worker secret, per tenant:

```sh
# aduplift
echo "<bot-token>" | bunx wrangler secret put TELEGRAM_BOT_TOKEN \
  --config workers/core/wrangler.deploy.aduplift.jsonc

# maimax
echo "<bot-token>" | bunx wrangler secret put TELEGRAM_BOT_TOKEN \
  --config workers/core/wrangler.deploy.maimax.jsonc
```

(Maimax uses the `maimax` Cloudflare token in that GitHub Environment; set
the secret once per tenant account.)

## 3. Get the chat id

**Owner DM (one-to-one with the bot):**

1. In Telegram, write `/start` to your bot (this unlocks the bot sending
   to you).
2. Fetch the id:

```sh
curl "https://api.telegram.org/bot<bot-token>/getUpdates"
```

The field `result[0].message.chat.id` holds the chat id — a positive
integer like `123456789`. If the result is empty, send another message to
the bot first and call `getUpdates` again.

**Team group:**

1. Add the bot to the group (group privacy mode "off" is not required for
   the *bot* to send).
2. Send one message in the group.
3. Same `getUpdates` call: the group chat id is negative, like
   `-1002345678901` (supergroups) — use the full value including the minus
   sign. Put both ids in the panel Settings (next step); the group id
   never goes into `.dev.vars` or wrangler.jsonc.

## 4. Configure the channel in the panel

Panel → **ตั้งค่า → ช่องทางแจ้งเตือน** (owner only; employee gets 403 on
save — acceptance E6):

- Telegram card: status chip, chat/target list — add the owner DM id and
  the group id from step 3.
- Rules matrix: tick which alert rules reach Telegram, set repeat interval
  (default 6 h) and quiet hours (default none, Asia/Bangkok).
- Digest toggle: daily summary at 09:00 Thailand time (`0 2 * * * UTC`),
  spend / leads / CPL / sold / profit / top fix item.
- Press **ส่งข้อความทดสอบ**; the button returns the provider status code —
  expect `200 {"ok":true}` with the message visible in both chats.
  Failures: `401 Unauthorized` = wrong token; `400 chat not found` =
  wrong chat id; `403 bot is not a member` (groups) = add the bot; `429` =
  rate limit (below).

Each settings save writes exactly one `audit_log` row (factory D1).

## 5. Read the delivery history

Two places, same rows:

- Panel → **การแจ้งเตือน → ประวัติการส่ง** (last 100 rows: time, channel,
  rule, brand, status, response code, retry button on failures).
- D1 directly (Q1):

```sh
CONFIG=workers/core/wrangler.deploy.aduplift.jsonc
bunx wrangler d1 execute aduplift-leads --remote --config "$CONFIG" \
  --command "SELECT sent_at, channel, target, alert_key, status, \
response_code FROM notification_log ORDER BY sent_at DESC LIMIT 10"
```

Rows appear only when a rule transitions state or a repeat window opens
(`alert_state` drives dedupe: an acknowledged alert stays silent until it
clears and fires again).

## 6. Telegram limits (free tier)

From the official Bots FAQ ([1] in References), "Broadcasting to Users":

| Path | Limit |
| --- | --- |
| One chat | ~1 message per second; short bursts, then 429 with `retry_after` |
| A group | 20 messages per minute |
| All chats (bot) | ~30 messages per second free, irrelevant at our volumes |

At this repo's volumes (a handful of brands, 15-minute cron, 6-hour
repeats, 10-minute AdsBot cooldown) we sit far below these — the design
target is a few messages a day. The notifier sends with
`parse_mode: "HTML"`, honours `retry_after` once, and logs every attempt
in `notification_log` with the provider's `response_code` — grep for
status `429` to confirm.

## 7. Quiet hours and repeats, in one place

- **Repeat every N hours** (default 6): while the alert block stays open,
  the cron resends after `last_sent + N`. A block that flickers
  ok→warn→ok→warn does not repeat — only a *transition* sends immediately.
- **Quiet hours per channel** (default none): during the window, sends
  hold; the block is not lost — it sends after the window if still open.
- **Acknowledged** (ประวัติการส่ง → รับทราบ, or the panel Alerts page): the
  alert stops repeating and cannot re-send until the block returns to ok
  and later leaves ok again.
- **AdsBot fast path** ignores the cron: any AdsBot hit (or any page
  served with http_status ≠ 200 to AdsBot) notifies within one cron tick
  or faster through the traffic tail (ADR-0006), with a 10-minute cooldown
  per brand.

## 8. LINE — marked "later" (do not run today)

Decision D3: Telegram ships in release 1; `LineNotifier` is a follow-up PR
once the owner has an Official Account. Steps recorded now so the card in
the panel (marked เร็ว ๆ นี้) has its operator path ready:

1. **Create the LINE Official Account** at [2] in References (Messaging
   API channel). Note: LINE Notify was shut down on **2025-03-31** —
   accounts that still used it migrated; new builds use the Messaging API.
2. **Get the channel access token**: LINE Developers Console → the OA →
   Messaging API → Channel access token → Issue. Store it like the
   Telegram token: `bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
   --config ...` (optional field in `workers/core/src/env.ts`, added by
   the LINE PR).
3. **Get the target id**: for a 1:1 chat, `userId` shows in the console
   (Basic settings → Your user ID) or via a webhook event; for a group,
   add the bot to the group and read `source.groupId` from a webhook
   event (requires the webhook endpoint the LINE PR adds).
4. **Send** (what `LineNotifier` will do):
   `POST https://api.line.me/v2/bot/message/push` with
   `Authorization: Bearer <token>`, body
   `{"to": "<userId|groupId>", "messages": [{"type": "flex", ...one
   button "เปิดใน panel"...}]}` — plain `fetch`, allowed by
   `global_fetch_strictly_public`.
5. **Quota**: the push quota depends on the OA's contract (the free tier
   on some OAs is 200 push messages/month; reply messages are free and
   unlimited). With our cooldown, repeats ≥ 6 h and the daily digest, we
   consume at most a handful of push messages per day — enable
   Settings → ช่องทางแจ้งเตือน → digest instead of per-event pushes if the
   quota is tight. Current quota numbers: LINE Developers → Messaging
   API → Quota overview of your channel; a 429 from the API means the
   monthly push limit was reached.

Message content contract (both channels, B6): level emoji + Thai rule
text + brand, one key number, `ตรวจพบ HH:MM`, deep link
`https://app.<tenant>/alerts?key=<alert_key>`; no PII, no lead data, no
tokens.

## 9. Troubleshooting

- **No Telegram messages at all** — first check `wrangler secret list`
  (TELEGRAM_BOT_TOKEN set), that core was redeployed after the secret was
  added, and that `notify.telegram.enabled` is true with a non-empty chat
  id list.
- **`401` in ประวัติการส่ง** — the token rotated or went into the wrong
  namespace — re-run the step 2 `wrangler secret put`.
- **`400 Bad Request: chat not found`** — the chat id is stale (a group
  migrated to supergroup and its id changed) — re-fetch via `getUpdates`.
- **`429` in ประวัติการส่ง** — the bot hit a group's 20/min cap; raise
  the repeat interval on noisy rules, keep quiet hours for the digest
  channel.
- **Test button returns 5xx** — check the core logs
  (`wrangler tail --config ...`): the error name only, never the token,
  is logged.

## References

- [1] Telegram Bots FAQ — limits:
  <https://core.telegram.org/bots/faq>
- [2] LINE Developers Console (create the Official Account):
  <https://developers.line.biz/console/>
