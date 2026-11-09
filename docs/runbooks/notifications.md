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
- No global `wrangler` install is needed: every command below is
  `bunx wrangler ...` run from the repo root. It is the version pinned in
  this repo, not whatever a global install would resolve to.
- All command blocks are POSIX `sh`/bash. On PowerShell, either use Git
  Bash / WSL, or convert the `\` line continuations to a single line.
  Blocks that need bash built-ins (`read -s`, `unset`) are labelled.
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
   **The token is a secret** — feed it only to `wrangler secret put`
   below. Never commit it, never paste it in a chat, log or ticket,
   and never as literal text inside a shell command (acceptance E5:
   no token appears in any log or D1 row).
4. Set the token as a core Worker secret, per tenant. `secret put`
   reads the value from an interactive prompt — the prompt does not
   echo, so the value leaves no copy in shell history, the process
   list, or any log:

```sh
# aduplift — run, then paste the token at the hidden prompt
bunx wrangler secret put TELEGRAM_BOT_TOKEN \
  --config workers/core/wrangler.deploy.aduplift.jsonc

# maimax — same prompt, maimax config
bunx wrangler secret put TELEGRAM_BOT_TOKEN \
  --config workers/core/wrangler.deploy.maimax.jsonc
```

(Maimax uses the `maimax` Cloudflare token in that GitHub Environment; set
the secret once per tenant account.)

## 3. Get the chat id

`getUpdates` returns a queue, not a snapshot: it replays every update the
bot has not confirmed yet, oldest first. `result[0]` is therefore the
*oldest* pending update and may be a DM you sent ten minutes ago, not the
group message you just sent. Read the `chat.type` and the group title of
each entry, and pass `offset` to consume the queue.

**Owner DM (one-to-one with the bot):**

1. In Telegram, write `/start` to your bot (this unlocks the bot sending
   to you).
2. Fetch the queue. The token is read without echo and handed to `curl`
   through its config on stdin (`-K -`), so it never appears in argv, the
   process list, or shell history:

   ```bash
   # bash — token stays out of argv and history; writes updates.json
   read -r -s -p "bot token: " TG_TOKEN; echo
   curl -s -K - -o updates.json <<EOF
   url = "https://api.telegram.org/bot${TG_TOKEN}/getUpdates"
   EOF
   ```

Open `updates.json` in an editor (or pipe the curl output to `bunx
prettier --parser json`) and read the `chat` objects. Delete the file and
`unset TG_TOKEN` afterwards; it holds no token, but it does hold your
chat ids.

The field `result[].message.chat.id` holds the chat id for a DM — a
positive integer like `123456789`. If the result is empty, send another
message to the bot first and call `getUpdates` again.

**Team group:**

1. Add the bot to the group. Group privacy mode does not need to be
   disabled for the *bot to send*, but with privacy mode **on** the bot
   only receives commands addressed to it — so post
   `/start@<bot_username>` in the group, not a plain message.
2. Read the answer and pick the entry whose `message.chat.type` is
   `group` or `supergroup` and whose `message.chat.title` is the group you
   used. Do not take `result[0]`: it is the oldest pending update.
3. The group chat id is negative, like `-1002345678901` (supergroups) —
   use the full value including the minus sign. Put both ids in the panel
   Settings (next step); the group id never goes into `.dev.vars` or
   wrangler.jsonc.
4. Once both ids are recorded, drain the queue so the next lookup starts
   clean: re-run `getUpdates` with `offset` set to the highest
   `update_id` you saw plus one:

   ```bash
   # bash — same secret-safe form, offset consumes the queue
   OFFSET=0   # replace with <highest update_id> + 1
   curl -s -K - -o updates.json <<EOF
   url = "https://api.telegram.org/bot${TG_TOKEN}/getUpdates?offset=${OFFSET}"
   EOF
   ```

   Telegram then drops every update up to that id and the next call returns
   only new ones.
5. `unset TG_TOKEN` when done.

Why the ids differ: a DM id is a user id (positive); a group id is a chat
id (negative). A bot cannot open a DM with a user who has not written to
it first, which is what step 1 of the DM block unlocks.

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

- **Repeat every N hours** (default 6, per rule): while the alert block
  stays open at the same level, the cron resends after `last_sent + N`.
- **Every transition sends immediately.** That means leaving `ok` for
  warn or alert, and also **escalation warn→alert** — a block that goes
  worse does not wait for the repeat window. Severity only ratchets up:
  warn→alert notifies at once even if a warn message went out a minute
  ago, subject to routing rules and quiet hours.
- **ok→warn→ok→warn sends every time.** Each re-entry into a non-ok
  level is a transition, so a flickering block produces one message per
  wobble, not one per repeat window. If that is too noisy, raise the
  repeat interval (it does not suppress transitions) or open quiet hours.
- **Quiet hours per channel** (default none): during the window, sends
  hold; the block is not lost — it sends after the window if still open.
  A transition inside quiet hours is deferred, never dropped.
- **Acknowledged** (ประวัติการส่ง → รับทราบ, or the panel Alerts page): the
  alert stops repeating and cannot re-send until the block returns to ok
  and later leaves ok again. Acknowledgement silences the *current*
  episode, including its repeats; it does not silence the next one.
- **AdsBot fast path** ignores the cron: any AdsBot hit (or any page
  served with http_status ≠ 200 to AdsBot) notifies within one cron tick
  or faster through the traffic tail (ADR-0006), with a 10-minute cooldown
  per brand.

## 8. LINE — marked "later" (do not run today)

Decision D3: Telegram ships in release 1; `LineNotifier` is a follow-up PR
once the owner has an Official Account. Steps recorded now so the card in
the panel (marked เร็ว ๆ นี้) has its operator path ready:

1. **Create the LINE Official Account, then enable Messaging API.** In the
   [LINE Official Account Manager](https://manager.line.biz/) create the
   OA, then open **Settings → Messaging API** and choose a provider
   (create one if this is the first channel). Messaging API channels are
   no longer created directly in the Developers Console — the OA turns
   one on. Note: LINE Notify was shut down on **2025-03-31**; new builds
   use the Messaging API.
2. **Get the channel access token.** After step 1 enables Messaging API,
   the [LINE Developers Console](https://developers.line.biz/console/)
   now lists the channel under that provider: open it → **Messaging API**
   tab → **Channel access token (long-lived)** → **Issue**. Store it like
   the Telegram token, per tenant, letting the prompt read it:

   ```sh
   # aduplift — paste the token at the hidden prompt
   bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN \
     --config workers/core/wrangler.deploy.aduplift.jsonc

   # maimax
   bunx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN \
     --config workers/core/wrangler.deploy.maimax.jsonc
   ```

   (`LINE_CHANNEL_ACCESS_TOKEN` is an optional field in
   `workers/core/src/env.ts`, added by the LINE PR.)
3. **Get the target id**: for a 1:1 chat, `userId` shows in the console
   (Basic settings → Your user ID) or via a webhook event; for a group,
   add the bot to the group and read `source.groupId` from a webhook
   event (requires the webhook endpoint the LINE PR adds).
4. **Send** — what `LineNotifier` will do. Pseudocode, not a
   copy-pasteable command; the `...` are body fields the LINE PR fills in.
   It is a plain `fetch`, allowed by `global_fetch_strictly_public`:

   ```text
   POST https://api.line.me/v2/bot/message/push
   Authorization: Bearer <channel access token>
   Content-Type: application/json

   {"to": "<userId|groupId>",
    "messages": [{"type": "flex", "altText": "<rule> · <brand>", ...}]}
   ```

5. **Quota and rate limits are different limits.** The push quota depends
   on the OA's contract and is counted **per recipient**, not per message:
   one alert to a group of 5 counts as 5 pushes (some free-tier OAs allow
   200 pushes/month; reply messages are free and unlimited). With our
   cooldown, repeats ≥ 6 h and the daily digest, a 2-person target costs a
   few pushes a day — but size the maths by the number of people in every
   chat you add, and prefer Settings → ช่องทางแจ้งเตือน → digest over
   per-event pushes if it gets tight. Current numbers live in LINE
   Developers → Messaging API → **Quota overview** of the channel. A
   `429` is not always the monthly quota: read the error body — the
   monthly-limit error is distinct from a per-second rate limit, and the
   response says which. Response details: [3] in References.

Message content contract (both channels, B6): level emoji + Thai rule
text + brand, one key number, `ตรวจพบ HH:MM`, deep link
`https://app.<tenant>/alerts?key=<alert_key>`; no PII, no lead data, no
tokens.

## 9. Troubleshooting

- **No Telegram messages at all** — first check the secret is set on the
  right tenant account, that core was redeployed after the secret was
  added, and that `notify.telegram.enabled` is true with a non-empty chat
  id list. `wrangler secret list` needs the same tenant config as every
  other command, so name it explicitly:

   ```sh
   # aduplift — repeat with wrangler.deploy.maimax.jsonc for the other tenant
   bunx wrangler secret list \
     --config workers/core/wrangler.deploy.aduplift.jsonc
   ```

- **`401` in ประวัติการส่ง** — the token rotated or went into the wrong
  namespace — re-run the step 4 `wrangler secret put` for that tenant.
- **`400 Bad Request: chat not found`** — the chat id is stale (a group
  migrated to supergroup and its id changed) — re-fetch via `getUpdates`.
- **`429` in ประวัติการส่ง** — the bot hit a group's 20/min cap; raise
  the repeat interval on noisy rules, keep quiet hours for the digest
  channel.
- **Test button returns 5xx** — read the core logs with the tenant
  config: the error name only, never the token, is logged:

  ```sh
  bunx wrangler tail \
    --config workers/core/wrangler.deploy.aduplift.jsonc
  ```

## References

- [1] Telegram Bots FAQ — limits, and what messages a bot receives
  (privacy mode): <https://core.telegram.org/bots/faq>
- [2] LINE Official Account Manager — create the OA, then enable
  Messaging API: <https://manager.line.biz/>
- [3] LINE Messaging API — getting started (channel + access token) and
  error/status codes:
  <https://developers.line.biz/en/docs/messaging-api/getting-started/>,
  <https://developers.line.biz/en/reference/messaging-api/#error-responses>
