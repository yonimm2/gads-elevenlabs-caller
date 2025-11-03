# Google Ads → ElevenLabs Outbound Caller

Express webhook that receives Google Ads lead-form submissions (and Elementor-style form posts), normalizes the phone to E.164, and asks ElevenLabs Convai to launch a Twilio outbound call. This document captures the exact working state as of **2025-11-02 23:35 UTC** so you can pause the Codex CLI now and resume later without losing context.

---

## 1. Current Project Snapshot

- **Location:** `~/gads-elevenlabs-caller`
- **Entry point:** `index.js`
- **Key routes:**
  - `GET /health` → `{ "ok": true }`
  - `POST /echo` → echoes parsed headers + body (handy for form parsing)
  - `GET /envcheck` → reports presence of essential ElevenLabs env vars (booleans)
  - `POST /gads/lead` → main webhook (supports Google Ads JSON + Elementor form-encoded) and schedules the ElevenLabs outbound call 45 seconds after receipt
  - `POST /twilio/status` → optional Twilio status callback (logs CallSid/Status)
  - `POST /elevenlabs/postcall` → ElevenLabs post-call webhook (verifies signature, emails summaries)
- **Logging:** extremely verbose. Each request logs:
  - Content type, request snapshot (`Incoming body preview`, `Body snapshot`)
  - Extracted `Name`, `leadPhone`, and normalized E.164 number
  - ElevenLabs payload + env presence
  - ElevenLabs HTTP status, raw response text, and parsed JSON
- **Normalization:** `normalizeToE164` uses `libphonenumber-js`, with US fallback (`+1`).
- **Fix applied:** ElevenLabs requires `conversation_initiation_client_data.source_info.version` to match regex `^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?$`. We now send `"1.0.0"` (the previous `server-webhook-1.0` caused 422 errors).

---

## 2. Environment Variables (`.env`)

The live `.env` file already exists. Sensitive values are redacted here—verify locally before committing anywhere.

```env
XI_API_KEY=sk_...                    # ElevenLabs API key (Convai/outbound enabled)
ELEVENLABS_AGENT_ID=agent_8701k7p39yq6ewa84fk5s29gjjbs
ELEVENLABS_AGENT_PHONE_NUMBER_ID=phnum_7801k8b0s90debd86acb7zw83k49
WEBHOOK_SHARED_SECRET=J8w3Fhs92nXqP0tL
STATUS_CALLBACK_URL=                 # optional Twilio status webhook target
ELEVENLABS_POSTCALL_SECRET=          # webhook secret from ElevenLabs post-call settings
RESEND_API_KEY=                      # Resend API key for email notifications
EMAIL_FROM=notifications@example.com
EMAIL_TO=you@example.com[,teammate@example.com] # defaults to yonimm2@gmail.com if unset
PORT=3000
```

- Keep `PORT=3000` unless you need another local port.
- `WEBHOOK_SHARED_SECRET` must match the `?key=` query parameter Google Ads sends.
- `ELEVENLABS_AGENT_PHONE_NUMBER_ID` is an ElevenLabs internal ID (not a literal `+1…` number).
- `ELEVENLABS_POSTCALL_SECRET` should be copied from the ElevenLabs Agents console when enabling the post-call webhook. Leave blank to skip signature verification (not recommended).
- Email notifications use the Resend API—set `EMAIL_FROM` to your verified sender and `EMAIL_TO` to a comma-separated list of recipients.

---

## 3. Restarting After a Pause

```bash
cd ~/gads-elevenlabs-caller
npm install            # ensures node_modules exist
npm start              # runs node index.js
```

Leave this terminal running to capture logs. Open a second terminal for manual tests.

### Quick smoke checks

```bash
# health + parsing
curl -s http://localhost:3000/health
curl -s -X POST http://localhost:3000/echo \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "name=TEST&phone=305-813-9811"

# Google Ads JSON
curl -i -X POST "http://localhost:3000/gads/lead?key=J8w3Fhs92nXqP0tL" \
  -H "Content-Type: application/json" \
  -d '{"user_column_data":[{"column_id":"FULL_NAME","string_value":"Test Lead"},{"column_id":"PHONE_NUMBER","string_value":"305-813-9811"}]}'

# Elementor form post
curl -i -X POST "http://localhost:3000/gads/lead?key=J8w3Fhs92nXqP0tL" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data "name=TEST&phone=305-813-9811"
```

A successful run shows HTTP 200 responses immediately, then ~45 seconds later `[EL OUTBOUND] status: 200` with a `callSid`.

If you want to persist logs:
```bash
npm start 2>&1 | tee /tmp/gads_server.log
```

---

## 4. Deployment on Render & Google Ads

The webhook now runs as a Render Web Service instead of an ngrok tunnel. Use these deployment settings to mirror the working setup:

- **Environment:** Node
- **Region:** US (any)
- **Branch:** `main` (or whichever branch you deploy)
- **Build command:** `npm install`
- **Start command:** `npm start`

### Environment variables on Render

Copy the `.env` values into Render (`Dashboard → Services → <service> → Environment`):

| Key | Value |
| --- | ----- |
| `XI_API_KEY` | (production key) |
| `ELEVENLABS_AGENT_ID` | `agent_8701k7p39yq6ewa84fk5s29gjjbs` |
| `ELEVENLABS_AGENT_PHONE_NUMBER_ID` | `phnum_7801k8b0s90debd86acb7zw83k49` |
| `WEBHOOK_SHARED_SECRET` | `J8w3Fhs92nXqP0tL` |
| `STATUS_CALLBACK_URL` | (optional) |

Render injects `PORT` automatically. Leave `PORT` unset in the dashboard so the app binds to the value Render supplies. Locally you can still keep `PORT=3000` for convenience.

### Smoke testing on Render

1. Deploy or redeploy after code/env changes.
2. Tail logs in Render; successful runs show `[EL OUTBOUND] status: 200` with a `callSid`.
3. Hit `https://<render-service>.onrender.com/health` (or `/envcheck`) to confirm the service is live.
4. Send test payloads to `/gads/lead?key=...` using the Render URL; expect HTTP 200 responses.

### Hooking up Google Ads

Use the Render HTTPS URL (e.g. `https://gads-elevenlabs-caller.onrender.com`) when configuring the Google Ads webhook:
```
https://<render-service>.onrender.com/gads/lead?key=J8w3Fhs92nXqP0tL
```

Google Ads lead-form tests (both JSON and Elementor-style form posts) succeed against the Render endpoint as of 2025‑11‑02 23:35 UTC.

### Hooking up the ElevenLabs post-call webhook

1. In the ElevenLabs Agents dashboard, enable a post-call webhook and point it to:
   ```
   https://<render-service>.onrender.com/elevenlabs/postcall
   ```
2. Copy the webhook secret ElevenLabs generates into `ELEVENLABS_POSTCALL_SECRET`.
3. Set `RESEND_API_KEY`, `EMAIL_FROM`, and `EMAIL_TO` so the server can send summary emails via Resend.
4. After a call completes, ElevenLabs delivers the analysis payload to this endpoint; the server verifies the signature (when configured), fetches the conversation details (status, duration, transcript), and emails the summary + raw JSON to the configured recipients.
5. The handler expects `ElevenLabs-Signature` in the newer `t=timestamp,v0=hash` format; timestamps older/newer than ±30 minutes are rejected, so ensure your server clock is accurate.

---

## 5. Observability Notes

- Every ElevenLabs request logs: endpoint, env presence, payload, status, raw text, parsed JSON.
- `/gads/lead` logs the scheduled ETA (`[EL OUTBOUND] scheduling outbound call`) and the eventual delayed result.
- `/elevenlabs/postcall` logs the incoming event type, fetches conversation metadata from ElevenLabs, and records whether the email dispatch succeeded. Audio (`post_call_audio`) and initiation-failure events are acknowledged but skipped for email.
- On failure, look for `[EL OUTBOUND] status` ≠ 200. The raw JSON usually contains a helpful `detail[...]` message (examples: invalid version string, wrong phone-number ID).
- If you hit Twilio status callbacks, point them to `/twilio/status` or set `STATUS_CALLBACK_URL` to another endpoint.
- Quiet-hours logic is not implemented; logs show when invalid phones are ignored rather than failing the webhook.
- ElevenLabs plans to add `has_audio`, `has_user_audio`, `has_response_audio` fields to transcription payloads; the handler tolerates additional fields automatically.

---

## 6. Project Structure (essentials)

```
index.js          # Express app, logging, ElevenLabs integration
.env              # Environment variables (already populated)
package.json      # npm scripts + dependencies
README.md         # this document
```

No database or persistence layer. Leads are processed synchronously.

---

## 7. Known Good State & Next Steps

- ✅ Render deployment is hands-off now; lead submissions trigger outbound calls automatically after a 45-second buffer.
- ✅ Post-call webhook emails ElevenLabs summaries to the configured recipients (via Resend).
- ✅ Conversation details API is queried so emails include call status, duration, and a transcript preview.
- ✅ Form + JSON leads both reach ElevenLabs (HTTP 200, callSid returned).
- ✅ `normalizeToE164` converts `305-813-9811` to `+13058139811`.
- ✅ Dynamic variable `Name` is passed, satisfying ElevenLabs agent templates.
- ✅ `source_info.version` uses `1.0.0` so the Convai API accepts the payload.
- ✅ Diagnostics (`/health`, `/echo`, `/envcheck`) work locally and on the Render deployment.

### Possible future improvements
- Add persistence/queueing or quiet-hours suppression if you want delayed calling.
- Reduce logging verbosity in production (currently everything is printed for debugging).
- Wire `STATUS_CALLBACK_URL` to `/twilio/status` for Twilio lifecycle monitoring.
- Add automated tests or linting if refactoring.

---

### TL;DR
To pick up later:
```bash
cd ~/gads-elevenlabs-caller
npm install
npm start
```
Watch the logs; send curl tests or Google Ads leads. ElevenLabs is now returning 200 responses—expect the outbound call to fire about 45 seconds after the lead lands. Configure the post-call webhook + Resend creds to receive emailed summaries enriched with status/duration/transcript previews. If anything breaks, check `[EL OUTBOUND] raw` first—the API spells out exactly what it disliked.
