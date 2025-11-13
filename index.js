import express from 'express';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import { parsePhoneNumberFromString } from 'libphonenumber-js';

dotenv.config();

console.log('[gads-elevenlabs-caller] build:', new Date().toISOString());
console.log('[env] XI_API_KEY present:', !!process.env.XI_API_KEY);
console.log('[env] ELEVENLABS_AGENT_ID:', process.env.ELEVENLABS_AGENT_ID);
console.log('[env] ELEVENLABS_AGENT_PHONE_NUMBER_ID:', process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID);

const {
  XI_API_KEY,
  ELEVENLABS_AGENT_ID,
  ELEVENLABS_AGENT_PHONE_NUMBER_ID,
  WEBHOOK_SHARED_SECRET,
  STATUS_CALLBACK_URL,
  ELEVENLABS_POSTCALL_SECRET,
  RESEND_API_KEY,
  EMAIL_FROM,
  EMAIL_TO = 'yonimm2@gmail.com',
  PORT = '3000',
} = process.env;

if (!WEBHOOK_SHARED_SECRET) {
  console.warn('WEBHOOK_SHARED_SECRET is not configured.');
}

const ELEVENLABS_OUTBOUND_ENDPOINT =
  'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';
const OUTBOUND_DELAY_MS = 45_000;
const RESEND_EMAIL_ENDPOINT = 'https://api.resend.com/emails';
const ELEVENLABS_CONVERSATION_BASE =
  'https://api.elevenlabs.io/v1/convai/conversations';

const app = express();

function rawBodySaver(req, _res, buf) {
  if (buf && buf.length) {
    req.rawBody = buf.toString('utf8');
  }
}

// Parse form-encoded BEFORE JSON; restrict text parser to text/plain only
app.use(express.urlencoded({ extended: true, verify: rawBodySaver }));
app.use(express.json({ limit: '1mb', verify: rawBodySaver }));
app.use(express.text({ type: 'text/plain', limit: '1mb', verify: rawBodySaver }));

app.get('/health', (_, res) => res.json({ ok: true }));
app.get('/envcheck', (_, res) => {
  const { XI_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_AGENT_PHONE_NUMBER_ID } = process.env;
  res.json({
    XI_API_KEY: !!XI_API_KEY,
    ELEVENLABS_AGENT_ID,
    ELEVENLABS_AGENT_PHONE_NUMBER_ID,
  });
});

app.post('/echo', (req, res) => {
  res.json({ headers: req.headers, body: req.body });
});

function extractLeadData(payload = {}) {
  const out = { Name: '', leadPhone: '' };

  const ucd = Array.isArray(payload.user_column_data) ? payload.user_column_data : null;
  if (ucd) {
    for (const column of ucd) {
      const id = (column?.column_id || '').toString().toLowerCase();
      const value =
        column?.string_value ||
        (Array.isArray(column?.stringValues) ? column.stringValues.join(' ') : '') ||
        '';
      const trimmed = value.trim();
      if (!trimmed) {
        continue;
      }
      if (!out.Name && (id.includes('name') || id === 'full_name')) {
        out.Name = trimmed;
      }
      if (!out.leadPhone && id.includes('phone')) {
        out.leadPhone = trimmed;
      }
    }
  }

  const body = payload && typeof payload === 'object' ? payload : {};
  const getValue = (key) => {
    const raw = body[key];
    if (Array.isArray(raw)) {
      return (raw[0] || '').toString().trim();
    }
    return (raw || '').toString().trim();
  };

  const flatNameKeys = [
    'name',
    'full_name',
    'fullname',
    'your-name',
    'yourname',
    'first_name',
    'last_name',
    'lastname',
  ];
  for (const key of flatNameKeys) {
    if (!out.Name) {
      const v = getValue(key);
      if (v) {
        out.Name = v;
      }
    }
  }

  const flatPhoneKeys = ['phone', 'phone_number', 'phonenumber', 'tel', 'your-phone', 'yourphone'];
  for (const key of flatPhoneKeys) {
    if (!out.leadPhone) {
      const v = getValue(key);
      if (v) {
        out.leadPhone = v;
      }
    }
  }

  const formFields =
    body.form_fields && typeof body.form_fields === 'object' ? body.form_fields : null;
  if (formFields) {
    if (!out.Name) {
      out.Name =
        [formFields.name, formFields.full_name, formFields.fullname]
          .filter(Boolean)
          .map(String)
          .map((s) => s.trim())
          .find(Boolean) || out.Name;
    }
    if (!out.leadPhone) {
      out.leadPhone =
        [formFields.phone, formFields.phone_number, formFields.tel]
          .filter(Boolean)
          .map(String)
          .map((s) => s.trim())
          .find(Boolean) || out.leadPhone;
    }
  }

  if (!out.Name) {
    out.Name = getValue('form_fields[name]') || out.Name;
  }
  if (!out.leadPhone) {
    out.leadPhone =
      getValue('form_fields[phone]') || getValue('form_fields[phone_number]') || out.leadPhone;
  }

  if (!out.Name) {
    const first = getValue('first_name');
    const last = getValue('last_name') || getValue('lastname');
    const combo = [first, last].filter(Boolean).join(' ').trim();
    if (combo) {
      out.Name = combo;
    }
  }

  return { Name: (out.Name || '').trim(), leadPhone: (out.leadPhone || '').trim() };
}

function normalizeToE164(raw, defaultRegion = 'US') {
  if (!raw) {
    return null;
  }
  try {
    let parsed = parsePhoneNumberFromString(raw);
    if (!parsed) {
      parsed = parsePhoneNumberFromString(raw, defaultRegion);
    }
    if (parsed?.isValid()) {
      return parsed.number;
    }
  } catch (error) {
    // ignore parsing errors and fall back to manual handling
  }
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith('1')) {
    return `+${digits}`;
  }
  return null;
}

async function sendElevenLabsOutboundCall(elevenLabsPayload) {
  console.log('[EL OUTBOUND] endpoint:', ELEVENLABS_OUTBOUND_ENDPOINT);
  console.log('[EL OUTBOUND] env:', {
    XI_API_KEY_present: !!process.env.XI_API_KEY,
    ELEVENLABS_AGENT_ID: process.env.ELEVENLABS_AGENT_ID,
    ELEVENLABS_AGENT_PHONE_NUMBER_ID: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
  });
  console.log('[EL OUTBOUND] request payload:', JSON.stringify(elevenLabsPayload, null, 2));

  let response;
  try {
    response = await fetch(ELEVENLABS_OUTBOUND_ENDPOINT, {
      method: 'POST',
      headers: { 'xi-api-key': XI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(elevenLabsPayload),
    });
  } catch (error) {
    console.error('[EL OUTBOUND] fetch threw:', (error && error.stack) || error);
    throw error;
  }

  let rawText = '';
  try {
    rawText = await response.text();
  } catch (error) {
    rawText = `<failed to read body: ${error}>`;
  }

  let parsedJson = null;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    // raw may not be JSON; ignore parse errors
  }

  console.log('[EL OUTBOUND] status:', response.status);
  console.log('[EL OUTBOUND] raw:', rawText);
  console.log('[EL OUTBOUND] json:', parsedJson);

  return {
    ok: response.ok,
    status: response.status,
    rawText,
    parsedJson,
  };
}

const SIGNATURE_MAX_AGE_SECONDS = 30 * 60;

function parseSignatureHeader(signatureHeader) {
  const result = { timestamp: null, values: {} };
  if (!signatureHeader || typeof signatureHeader !== 'string') {
    return result;
  }
  const parts = signatureHeader.split(',').map((p) => p.trim()).filter(Boolean);
  for (const part of parts) {
    const [key, ...valueParts] = part.split('=');
    if (!key || !valueParts.length) {
      continue;
    }
    const value = valueParts.join('=').trim();
    if (key === 't') {
      result.timestamp = value;
    } else {
      result.values[key] = value;
    }
  }
  return result;
}

function timingSafeEqualString(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyElevenLabsSignature(rawBody, signatureHeader, secret) {
  if (!secret) {
    return true;
  }
  if (!signatureHeader) {
    console.warn('[EL WEBHOOK] Missing signature header.');
    return false;
  }

  const { timestamp, values } = parseSignatureHeader(signatureHeader);
  const raw = typeof rawBody === 'string' ? rawBody : '';

  if (timestamp) {
    const parsedTimestamp = Number(timestamp);
    if (!Number.isFinite(parsedTimestamp)) {
      console.warn('[EL WEBHOOK] Invalid timestamp in signature header.');
      return false;
    }
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (parsedTimestamp < nowSeconds - SIGNATURE_MAX_AGE_SECONDS) {
      console.warn('[EL WEBHOOK] Signature timestamp too old.', {
        timestamp: parsedTimestamp,
        nowSeconds,
      });
      return false;
    }
    if (parsedTimestamp > nowSeconds + SIGNATURE_MAX_AGE_SECONDS) {
      console.warn('[EL WEBHOOK] Signature timestamp too far in the future.', {
        timestamp: parsedTimestamp,
        nowSeconds,
      });
      return false;
    }

    const payloadToSign = `${timestamp}.${raw}`;
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payloadToSign, 'utf8');
    const expectedHex = hmac.digest('hex');

    const candidateSignatures = [];
    if (values.v0) candidateSignatures.push(values.v0);
    if (values.v1) candidateSignatures.push(values.v1);

    for (const candidate of candidateSignatures) {
      if (timingSafeEqualString(candidate, `v0=${expectedHex}`) || timingSafeEqualString(candidate, expectedHex)) {
        return true;
      }
    }

    // Fallback: compare hex directly without prefix (in case header contained bare hash)
    if (values.v0 && timingSafeEqualString(values.v0.replace(/^v0=/, ''), expectedHex)) {
      return true;
    }

    console.warn('[EL WEBHOOK] Signature verification failed for timestamped payload.');
    return false;
  }

  // Backwards compatibility: older signatures may be raw HMAC of the body.
  const provided = signatureHeader.trim();
  if (!provided) {
    return false;
  }
  const legacyHmac = crypto.createHmac('sha256', secret);
  legacyHmac.update(raw, 'utf8');
  const expectedLegacyHex = legacyHmac.digest('hex');
  if (timingSafeEqualString(provided, expectedLegacyHex)) {
    return true;
  }

  const legacyBase64 = crypto.createHmac('sha256', secret);
  legacyBase64.update(raw, 'utf8');
  const expectedLegacyBase64 = legacyBase64.digest('base64');
  if (timingSafeEqualString(provided, expectedLegacyBase64)) {
    return true;
  }

  console.warn('[EL WEBHOOK] Signature verification failed.', {
    provided,
  });
  return false;
}

function escapeHtml(input) {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return null;
  }
  const totalSeconds = Math.max(0, Math.round(seconds));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins === 0) {
    return `${secs}s`;
  }
  return `${mins}m ${secs}s`;
}

async function sendSummaryEmail({ subject, text, html }) {
  if (!RESEND_API_KEY || !EMAIL_FROM || !EMAIL_TO) {
    console.warn('[EMAIL] Missing configuration, skipping email send.', {
      RESEND_API_KEY_present: !!RESEND_API_KEY,
      EMAIL_FROM,
      EMAIL_TO,
    });
    throw new Error('Email configuration incomplete.');
  }

  const recipients = EMAIL_TO.split(',').map((value) => value.trim()).filter(Boolean);
  if (!recipients.length) {
    throw new Error('EMAIL_TO has no valid recipients.');
  }

  const payload = {
    from: EMAIL_FROM,
    to: recipients,
    subject,
    text,
    html,
  };

  const response = await fetch(RESEND_EMAIL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.text();
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // ignore parse errors
  }

  console.log('[EMAIL] Resend response status:', response.status);
  console.log('[EMAIL] Resend response payload:', parsed || raw);

  if (!response.ok) {
    throw new Error(`Failed to send email via Resend: ${response.status} ${raw}`);
  }

  return parsed;
}

async function fetchConversationDetails(conversationId) {
  if (!conversationId) {
    throw new Error('conversationId is required to fetch details.');
  }
  if (!XI_API_KEY) {
    throw new Error('XI_API_KEY missing; cannot fetch conversation details.');
  }

  const url = `${ELEVENLABS_CONVERSATION_BASE}/${encodeURIComponent(conversationId)}`;
  console.log('[EL WEBHOOK] Fetching conversation details from ElevenLabs.', { url });

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'xi-api-key': XI_API_KEY,
    },
  });

  const rawText = await response.text();
  let parsedJson = null;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    console.warn('[EL WEBHOOK] Failed to parse conversation details JSON.', error);
  }

  console.log('[EL WEBHOOK] Conversation fetch status:', response.status);

  if (!response.ok) {
    throw new Error(
      `ElevenLabs conversation fetch failed (${response.status}): ${rawText?.slice(0, 2000)}`,
    );
  }

  return parsedJson || rawText;
}

app.post('/gads/lead', (req, res) => {
  const contentType = req.headers['content-type'] || '';
  const bodyType = typeof req.body;
  let bodyPreview;

  if (bodyType === 'string') {
    bodyPreview = req.body.slice(0, 300);
  } else {
    try {
      const serialized = JSON.stringify(req.body);
      bodyPreview =
        typeof serialized === 'string' ? serialized.slice(0, 300) : '[unserializable body]';
    } catch (error) {
      bodyPreview = '[unserializable body]';
    }
  }

  console.log('Incoming content-type:', contentType);
  console.log('Incoming body type:', bodyType);
  console.log('Incoming body preview:', bodyPreview);

  res.status(200).json({ success: true });

  setImmediate(async () => {
    try {
      const providedKey = req.query?.key;
      if (!WEBHOOK_SHARED_SECRET) {
        console.warn('[LEAD] WEBHOOK_SHARED_SECRET missing; skipping lead processing.');
        return;
      }
      if (providedKey !== WEBHOOK_SHARED_SECRET) {
        console.warn('[LEAD] Invalid shared secret provided; skipping lead processing.');
        return;
      }

      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const logBody =
        body && typeof body === 'object' && !Array.isArray(body) ? body : {};
      console.log('Incoming keys:', Object.keys(logBody));
      console.log('Body snapshot:', JSON.stringify(body || {}, null, 2));

      const { Name, leadPhone } = extractLeadData(body);
      const normalizedPhone = normalizeToE164(leadPhone, 'US');
      console.log('Extracted fields:', { Name, leadPhone, normalizedPhone });

      if (!normalizedPhone) {
        console.warn('Lead received with invalid or missing phone number.', {
          Name,
          leadPhone,
        });
        return;
      }

      if (!XI_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
        console.error('Lead webhook missing ElevenLabs configuration variables.');
        return;
      }

      const safeName = (Name || '').trim();
      const dynamicVariables = {
        Name: safeName || 'Prospect',
      };

      const elevenLabsPayload = {
        agent_id: ELEVENLABS_AGENT_ID,
        agent_phone_number_id: ELEVENLABS_AGENT_PHONE_NUMBER_ID,
        to_number: normalizedPhone,
        conversation_initiation_client_data: {
          dynamic_variables: dynamicVariables,
          source_info: { source: 'twilio', version: '1.0.0' },
        },
      };

      console.log('[EL OUTBOUND] scheduling outbound call.', {
        delayMs: OUTBOUND_DELAY_MS,
        etaIso: new Date(Date.now() + OUTBOUND_DELAY_MS).toISOString(),
        Name: dynamicVariables.Name,
        normalizedPhone,
      });

      setTimeout(() => {
        sendElevenLabsOutboundCall(elevenLabsPayload)
          .then(({ ok, status, rawText, parsedJson }) => {
            if (ok) {
              console.log('[EL OUTBOUND] delayed call succeeded.', {
                status,
                parsedJson,
              });
            } else {
              console.error('[EL OUTBOUND] delayed call failed.', {
                status,
                raw: rawText?.slice(0, 2000) || null,
              });
            }
          })
          .catch((error) => {
            console.error('[EL OUTBOUND] delayed call threw.', (error && error.stack) || error);
          });
      }, OUTBOUND_DELAY_MS);
    } catch (error) {
      console.error('[LEAD] Failed to process webhook after responding.', error);
    }
  });
});

app.post('/elevenlabs/postcall', async (req, res) => {
  try {
    const rawBody = req.rawBody || JSON.stringify(req.body || {});
    const signatureHeader = req.headers['elevenlabs-signature'];
    if (ELEVENLABS_POSTCALL_SECRET) {
      const valid = verifyElevenLabsSignature(rawBody, signatureHeader, ELEVENLABS_POSTCALL_SECRET);
      if (!valid) {
        return res.status(401).json({ success: false, message: 'Invalid webhook signature.' });
      }
    }

    const event = req.body || {};
    console.log('[EL WEBHOOK] Received event type:', event?.type || event?.event_type);
    console.log('[EL WEBHOOK] Body snapshot:', JSON.stringify(event, null, 2));

    const eventType = event?.type || event?.event_type || 'unknown';
    const normalizedEventType = typeof eventType === 'string' ? eventType.toLowerCase() : 'unknown';
    const data = event?.data || {};
    const conversationId =
      data?.conversation_id ||
      data?.conversationId ||
      data?.call_id ||
      data?.callId ||
      event?.conversation_id ||
      null;

    if (normalizedEventType === 'post_call_audio') {
      console.log('[EL WEBHOOK] post_call_audio event received – audio payload logged only.');
      return res.status(200).json({ success: true, message: 'Audio webhook acknowledged.' });
    }

    if (normalizedEventType === 'call_initiation_failure') {
      console.warn('[EL WEBHOOK] call_initiation_failure received.', {
        failure_reason: data?.failure_reason,
        provider_type: data?.metadata?.type,
      });
      return res.status(200).json({ success: true, message: 'Call initiation failure logged.' });
    }

    if (normalizedEventType !== 'post_call_transcription') {
      console.warn('[EL WEBHOOK] Unknown webhook type received.', { eventType });
      return res.status(200).json({ success: true, message: 'Event ignored.' });
    }

    let conversationDetails = null;
    if (conversationId) {
      if (!XI_API_KEY) {
        console.warn('[EL WEBHOOK] XI_API_KEY missing—skipping conversation fetch.');
      } else {
        try {
          const fetched = await fetchConversationDetails(conversationId);
          if (fetched && typeof fetched === 'object') {
            conversationDetails = fetched;
          } else {
            console.warn('[EL WEBHOOK] Conversation fetch returned non-object payload.');
          }
        } catch (error) {
          console.error('[EL WEBHOOK] Failed to fetch conversation details.', error);
        }
      }
    }

    const analysis = data?.analysis || {};
    const conversationAnalysis =
      conversationDetails && typeof conversationDetails === 'object'
        ? conversationDetails.analysis || {}
        : {};
    const summaryCandidates = [
      conversationAnalysis?.transcript_summary,
      conversationAnalysis?.summary,
      analysis?.summary,
      analysis?.call_summary,
      analysis?.callSummary,
      analysis?.data_collection_results?.call_summary?.value,
      analysis?.data_collection_results?.summary?.value,
      data?.summary,
      data?.call_summary,
    ];

    const primarySummary =
      summaryCandidates.find((value) => typeof value === 'string' && value.trim()) ||
      '[No summary field found in webhook payload.]';

    let keyInsights =
      analysis?.key_insights ||
      analysis?.keyInsights ||
      analysis?.data_collection_results?.key_insights?.value ||
      analysis?.data_collection_results?.key_insights ||
      data?.key_insights ||
      data?.keyInsights ||
      null;

    if (
      !keyInsights &&
      conversationAnalysis?.data_collection_results &&
      conversationAnalysis.data_collection_results.key_insights
    ) {
      const insight = conversationAnalysis.data_collection_results.key_insights;
      keyInsights = insight?.value || insight;
    }

    const conversationStatus =
      (conversationDetails && typeof conversationDetails === 'object' && conversationDetails.status) ||
      data?.status ||
      null;
    const callDurationSecs =
      (conversationDetails &&
        typeof conversationDetails === 'object' &&
        conversationDetails?.metadata?.call_duration_secs) ??
      data?.metadata?.call_duration_secs ??
      null;
    const formattedDuration = formatDuration(callDurationSecs);

    const transcriptArray =
      conversationDetails && Array.isArray(conversationDetails.transcript)
        ? conversationDetails.transcript
        : [];
    const transcriptMax = 8;
    const transcriptPreview = transcriptArray.slice(0, transcriptMax).map((turn) => {
      const role = (turn?.role || 'unknown').toString().toUpperCase();
      const timestamp =
        typeof turn?.time_in_call_secs === 'number'
          ? `${Math.max(0, Math.round(turn.time_in_call_secs))}s`
          : null;
      const message =
        (turn?.message && String(turn.message).trim()) ||
        (turn?.multivoice_message?.text && String(turn.multivoice_message.text).trim()) ||
        '[no message provided]';
      return { role, timestamp, message };
    });
    const transcriptAdditionalCount =
      transcriptArray.length > transcriptMax ? transcriptArray.length - transcriptMax : 0;
    const transcriptTextLines = transcriptPreview.map((turn) => {
      const parts = [];
      if (turn.timestamp) parts.push(`[${turn.timestamp}]`);
      parts.push(`${turn.role}:`);
      parts.push(turn.message);
      return parts.join(' ');
    });
    if (transcriptAdditionalCount) {
      transcriptTextLines.push(`... (+${transcriptAdditionalCount} more turns)`);
    }
    const transcriptTextSection = transcriptTextLines.length ? transcriptTextLines.join('\n') : null;

    const transcriptHtmlItems = transcriptPreview
      .map(
        (turn) =>
          `<li><strong>${escapeHtml(turn.role)}</strong>${
            turn.timestamp ? ` <em>${escapeHtml(turn.timestamp)}</em>` : ''
          }: ${escapeHtml(turn.message)}</li>`,
      )
      .join('');
    const transcriptHtmlSection = transcriptHtmlItems
      ? `<h3>Transcript preview</h3><ol>${transcriptHtmlItems}</ol>${
          transcriptAdditionalCount
            ? `<p><em>… plus ${escapeHtml(String(transcriptAdditionalCount))} additional turn(s)</em></p>`
            : ''
        }`
      : '';

    const rawJson = JSON.stringify(event, null, 2);
    const subject = `ElevenLabs call summary${conversationId ? ` (${conversationId})` : ''}`;
    const textParts = [
      `Event type: ${eventType}`,
      conversationId ? `Conversation ID: ${conversationId}` : null,
      conversationStatus ? `Call status: ${conversationStatus}` : null,
      formattedDuration ? `Call duration: ${formattedDuration}` : null,
      '',
      'Summary:',
      primarySummary,
    ].filter(Boolean);

    if (keyInsights) {
      textParts.push(
        '',
        'Key insights:',
        typeof keyInsights === 'string' ? keyInsights : JSON.stringify(keyInsights, null, 2),
      );
    }

    if (transcriptTextSection) {
      textParts.push('', 'Transcript preview:', transcriptTextSection);
    }

    textParts.push('', 'Full payload:', rawJson);
    const textBody = textParts.join('\n');

    const metadataList = [
      `<li><strong>Event type:</strong> ${escapeHtml(eventType)}</li>`,
      conversationId
        ? `<li><strong>Conversation ID:</strong> ${escapeHtml(conversationId)}</li>`
        : '',
      conversationStatus
        ? `<li><strong>Call status:</strong> ${escapeHtml(conversationStatus)}</li>`
        : '',
      formattedDuration
        ? `<li><strong>Call duration:</strong> ${escapeHtml(formattedDuration)}</li>`
        : '',
    ]
      .filter(Boolean)
      .join('');

    const htmlSummary = escapeHtml(primarySummary).replace(/\r?\n/g, '<br>');
    const htmlKeyInsights =
      keyInsights && typeof keyInsights === 'string'
        ? `<h3>Key insights</h3><p>${escapeHtml(keyInsights).replace(/\r?\n/g, '<br>')}</p>`
        : keyInsights
        ? `<h3>Key insights</h3><pre>${escapeHtml(JSON.stringify(keyInsights, null, 2))}</pre>`
        : '';
    const htmlBody = `
      <h2>ElevenLabs Call Summary</h2>
      <ul>${metadataList}</ul>
      <h3>Summary</h3>
      <p>${htmlSummary}</p>
      ${htmlKeyInsights}
      ${transcriptHtmlSection}
      <h3>Raw event payload</h3>
      <pre>${escapeHtml(rawJson)}</pre>
    `;

    try {
      await sendSummaryEmail({ subject, text: textBody, html: htmlBody });
      console.log('[EL WEBHOOK] Summary email dispatched.');
    } catch (emailError) {
      console.error('[EL WEBHOOK] Failed to send summary email.', emailError);
      return res.status(500).json({
        success: false,
        message: 'Failed to send summary email.',
        error: String(emailError),
      });
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[EL WEBHOOK] Failed to process post-call webhook.', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.get('/test-call', async (req, res) => {
  try {
    const toParam = req.query?.to;
    const nameParam = req.query?.name;

    const toValue = Array.isArray(toParam) ? toParam[0] : toParam;
    const nameValue = Array.isArray(nameParam) ? nameParam[0] : nameParam;

    if (!toValue) {
      return res.status(400).json({ success: false, message: 'Missing "to" query parameter.' });
    }

    const normalizedPhone = normalizeToE164(String(toValue), 'US');
    if (!normalizedPhone) {
      console.warn('Test call invoked with invalid or missing phone number.', { to: toValue });
      return res.status(400).json({ success: false, message: 'Invalid phone number.' });
    }

    if (!XI_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
      console.error('Test call missing ElevenLabs configuration variables.');
      return res.status(500).json({ success: false, message: 'ElevenLabs not configured.' });
    }

    const Name = typeof nameValue === 'string' ? nameValue : '';
    const safeName = (Name || '').trim();
    const dynamicVariables = {
      Name: safeName || 'Prospect',
    };

    const elevenLabsPayload = {
      agent_id: ELEVENLABS_AGENT_ID,
      agent_phone_number_id: ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      to_number: normalizedPhone,
      conversation_initiation_client_data: {
        dynamic_variables: dynamicVariables,
        source_info: { source: 'twilio', version: '1.0.0' },
      },
    };

    let callResult;
    try {
      callResult = await sendElevenLabsOutboundCall(elevenLabsPayload);
    } catch (error) {
      return res
        .status(500)
        .json({ success: false, message: 'Fetch error to ElevenLabs', error: String(error) });
    }

    const { ok, status, parsedJson, rawText } = callResult;

    console.log('ElevenLabs outbound call response.', {
      status,
      body: parsedJson,
      Name,
      to: normalizedPhone,
    });

    if (!ok) {
      return res.status(500).json({
        success: false,
        message: 'ElevenLabs outbound call failed.',
        status,
        elevenlabs_raw: rawText?.slice(0, 2000) || null,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Outbound call requested via ElevenLabs.',
      elevenLabsResponse: parsedJson || rawText,
    });
  } catch (error) {
    console.error('Failed to process test call.', error);
    return res.status(500).json({ success: false, message: 'Internal server error.' });
  }
});

app.post('/twilio/status', (req, res) => {
  const { CallSid, CallStatus } = req.body || {};
  console.log('Received Twilio status callback.', { CallSid, CallStatus });
  return res.status(200).json({ received: true });
});

app.listen(Number(PORT), () => {
  console.log(`Server listening on port ${PORT}`);
});
