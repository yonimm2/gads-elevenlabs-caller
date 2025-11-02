import express from 'express';
import dotenv from 'dotenv';
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
  PORT = '3000',
} = process.env;

if (!WEBHOOK_SHARED_SECRET) {
  console.warn('WEBHOOK_SHARED_SECRET is not configured.');
}

const ELEVENLABS_OUTBOUND_ENDPOINT =
  'https://api.elevenlabs.io/v1/convai/twilio/outbound-call';

const app = express();

// Parse form-encoded BEFORE JSON; restrict text parser to text/plain only
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));

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

app.post('/gads/lead', async (req, res) => {
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

  try {
    const providedKey = req.query?.key;
    if (!WEBHOOK_SHARED_SECRET || providedKey !== WEBHOOK_SHARED_SECRET) {
      console.warn('Rejected lead webhook due to invalid shared secret.');
      return res.status(401).json({ success: false, message: 'Invalid shared secret.' });
    }

    const body = req.body;
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
      return res.status(200).json({ success: true, message: 'Lead processed without call.' });
    }

    if (!XI_API_KEY || !ELEVENLABS_AGENT_ID || !ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
      console.error('Lead webhook missing ElevenLabs configuration variables.');
      return res.status(500).json({ success: false, message: 'ElevenLabs not configured.' });
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
    } catch (e) {
      console.error('[EL OUTBOUND] fetch threw:', (e && e.stack) || e);
      return res
        .status(500)
        .json({ success: false, message: 'Fetch error to ElevenLabs', error: String(e) });
    }

    let rawText = '';
    try {
      rawText = await response.text();
    } catch (e) {
      rawText = `<failed to read body: ${e}>`;
    }

    let parsedJson = null;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (e) {
      // raw may not be JSON; ignore parse errors
    }

    console.log('[EL OUTBOUND] status:', response.status);
    console.log('[EL OUTBOUND] raw:', rawText);
    console.log('[EL OUTBOUND] json:', parsedJson);

    if (!response.ok) {
      return res.status(500).json({
        success: false,
        message: 'ElevenLabs outbound call failed.',
        status: response.status,
        elevenlabs_raw: rawText?.slice(0, 2000) || null,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Outbound call requested via ElevenLabs.',
      elevenLabsResponse: parsedJson || rawText,
    });
  } catch (error) {
    console.error('Failed to process lead webhook.', error);
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

    console.log('Sending ElevenLabs payload.', elevenLabsPayload);
    console.log('[EL OUTBOUND] endpoint:', ELEVENLABS_OUTBOUND_ENDPOINT);
    console.log('[EL OUTBOUND] env:', {
      XI_API_KEY_present: !!process.env.XI_API_KEY,
      ELEVENLABS_AGENT_ID: process.env.ELEVENLABS_AGENT_ID,
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: process.env.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
    });
    console.log('[EL OUTBOUND] payload:', JSON.stringify(elevenLabsPayload, null, 2));

    const response = await fetch(ELEVENLABS_OUTBOUND_ENDPOINT, {
      method: 'POST',
      headers: {
        'xi-api-key': XI_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(elevenLabsPayload),
    });

    let rawText = '';
    try { rawText = await response.text(); } catch(e) { rawText = '<failed read>'; }

    let parsedJson = null;
    try { parsedJson = JSON.parse(rawText); } catch {}

    console.log('[EL OUTBOUND] status:', response.status);
    console.log('[EL OUTBOUND] raw:', rawText);
    console.log('[EL OUTBOUND] json:', parsedJson);

    let responseBody = null;
    try {
      responseBody = parsedJson || JSON.parse(rawText);
    } catch (parseError) {
      console.warn('Failed to parse ElevenLabs response body as JSON.');
    }

    console.log('ElevenLabs outbound call response.', {
      status: response.status,
      body: responseBody,
      Name,
      to: normalizedPhone,
    });

    if (!response.ok) {
      return res
        .status(500)
        .json({ success: false, message: 'ElevenLabs outbound call failed.' });
    }

    return res.status(200).json({
      success: true,
      message: 'Outbound call requested via ElevenLabs.',
      elevenLabsResponse: responseBody,
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
