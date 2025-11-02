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
  - `POST /gads/lead` → main webhook (supports Google Ads JSON + Elementor form-encoded)
  - `POST /twilio/status` → optional Twilio status callback (logs CallSid/Status)
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
PORT=3000
```

- Keep `PORT=3000` unless you need another local port.
- `WEBHOOK_SHARED_SECRET` must match the `?key=` query parameter Google Ads sends.
- `ELEVENLABS_AGENT_PHONE_NUMBER_ID` is an ElevenLabs internal ID (not a literal `+1…` number).

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

A successful run shows HTTP 200 responses and `[EL OUTBOUND] status: 200` with a `callSid`.

If you want to persist logs:
```bash
npm start 2>&1 | tee /tmp/gads_server.log
```

---

## 4. External Access (Ngrok) & Google Ads

Expose the server:
```bash
ngrok http 3000
```

Take the HTTPS forwarding URL (e.g. `https://reformed-tena-unreplete.ngrok-free.dev`) and configure Google Ads:
```
https://<ngrok-host>/gads/lead?key=J8w3Fhs92nXqP0tL
```

Test both JSON + form payloads via the ngrok URL. Verified at 2025‑11‑02 23:35 UTC—they returned HTTP 200 and ElevenLabs responded with `success:true`.

---

## 5. Observability Notes

- Every ElevenLabs request logs: endpoint, env presence, payload, status, raw text, parsed JSON.
- On failure, look for `[EL OUTBOUND] status` ≠ 200. The raw JSON usually contains a helpful `detail[...]` message (examples: invalid version string, wrong phone-number ID).
- If you hit Twilio status callbacks, point them to `/twilio/status` or set `STATUS_CALLBACK_URL` to another endpoint.
- Quiet-hours logic is not implemented; logs show when invalid phones are ignored rather than failing the webhook.

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

- ✅ Form + JSON leads both reach ElevenLabs (HTTP 200, callSid returned).
- ✅ `normalizeToE164` converts `305-813-9811` to `+13058139811`.
- ✅ Dynamic variable `Name` is passed, satisfying ElevenLabs agent templates.
- ✅ `source_info.version` uses `1.0.0` so the Convai API accepts the payload.
- ✅ Diagnostics (`/health`, `/echo`, `/envcheck`) work locally and through ngrok.

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
Watch the logs; send curl tests or Google Ads leads. ElevenLabs is now returning 200 responses, so outbound calls should fire immediately. If anything breaks, check `[EL OUTBOUND] raw` first—the API spells out exactly what it disliked.
