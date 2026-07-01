// Azure Function: OCR a trucking ticket image via Anthropic Claude vision.
// Ported verbatim (prompt + logic) from the original Netlify function.
//
// Auth: requires an authenticated SWA user (route protected in staticwebapp.config.json).
// Expects POST JSON: { image: "<base64 JPEG, with or without data: prefix>" }
// Returns: { ok: true, parsed: { commodityType, fields, typeSpecific, extras, notes } }
// Requires app settings: ANTHROPIC_API_KEY (required), OCR_MODEL (optional).
const { getPrincipal } = require('../shared/auth');

const MODEL = process.env.OCR_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

const PROMPT = `You are extracting data from a photo of a trucking ticket for a construction company. Tickets vary by commodity type (what's being hauled) and have different layouts.

Return STRICT JSON ONLY — no markdown fences, no commentary before or after.

STEP 1: Classify the commodity type. Look at the ticket and pick ONE of:
- "dirt"       — dirt, fill, native material, topsoil, select fill, common borrow
- "flex_base"  — flexible base aggregate, Class 2 AB, Class 6 AB, crushed road base, recycled base
- "lime"       — hydrated lime, quicklime, kiln dust, lime slurry (anything labeled "lime")
- "other"      — sand, asphalt, concrete, rock, ag rock, or anything not above

STEP 2: Extract the BASE fields (common to all ticket types). Each as { value, confidence }:
- pitTicketNo   (the unique ticket number, often top-left or boxed)
- truckNum
- poNum         (P.O. #)
- jobNum        (Job #)
- customer      (who the load is for — often "Earth Basics" or similar)
- truckingCo    (the trucking company on the ticket header — e.g. "Alliance Trucking")
- shippedFrom   (origin pit / quarry / plant)
- shippedTo     (destination — job site / address)
- date          (YYYY-MM-DD)
- commodity     (the commodity text as written on the ticket, e.g. "Hydrated Lime", "Class 2 AB", "Rock")
- timeIn        (HH:MM 24-hour)
- timeOut       (HH:MM 24-hour)
- lunch         (lunch break in minutes, as a number string)
- totalHours    (HH:MM or decimal hours)
- tons          (decimal)
- yards         (decimal)

STEP 3: Extract TYPE-SPECIFIC fields based on the commodity type you picked. Each as { value, confidence }. Only include fields that are actually present on the ticket.

If "dirt":
  - soilType         (clay, sandy, native, topsoil — if specified)
  - moistureContent  (if shown)

If "flex_base":
  - materialGrade    (e.g. "Class 2 AB", "Class 6")
  - sourceQuarry     (quarry name distinct from shippedFrom, if separately labeled)
  - gradation        (gradation spec or sieve info)

If "lime":
  - limeType          (hydrated, quicklime, kiln dust, slurry)
  - moisturePercent   (% moisture)
  - netWeight         (net weight separately listed — value + unit if present)
  - applicationRate   (lb/sy if shown)
  - billOfLading      (BOL #)

If "other": no type-specific fields, return empty object.

STEP 4: Extract EXTRAS — ANY other labeled field/value pair on the ticket that you didn't already capture above. This is important: we want to learn what other fields appear on different ticket formats.

Examples of extras you might see: "Hazmat Class: 8", "Plant ID: 04", "Driver: J. Smith", "Trailer #: T-401", "Density: 1.85", "Source #", "Sampler ID", "R-Value", "Sand Equiv". Include EVERY labeled value not already in BASE or TYPE-SPECIFIC.

Use the label as it appears on the ticket as the key. Don't invent fields that aren't there.

OUTPUT FORMAT (strict JSON, no extra prose):

{
  "commodityType": "dirt|flex_base|lime|other",
  "commodityTypeConfidence": "high|medium|low",
  "fields": {
    "pitTicketNo": { "value": "...", "confidence": "..." },
    "truckNum":    { "value": "...", "confidence": "..." },
    "poNum":       { "value": "...", "confidence": "..." },
    "jobNum":      { "value": "...", "confidence": "..." },
    "customer":    { "value": "...", "confidence": "..." },
    "truckingCo":  { "value": "...", "confidence": "..." },
    "shippedFrom": { "value": "...", "confidence": "..." },
    "shippedTo":   { "value": "...", "confidence": "..." },
    "date":        { "value": "YYYY-MM-DD", "confidence": "..." },
    "commodity":   { "value": "...", "confidence": "..." },
    "timeIn":      { "value": "HH:MM", "confidence": "..." },
    "timeOut":     { "value": "HH:MM", "confidence": "..." },
    "lunch":       { "value": "minutes-as-number", "confidence": "..." },
    "totalHours":  { "value": "HH:MM or decimal", "confidence": "..." },
    "tons":        { "value": "decimal", "confidence": "..." },
    "yards":       { "value": "decimal", "confidence": "..." }
  },
  "typeSpecific": {
    "<key>": { "value": "...", "confidence": "..." }
  },
  "extras": {
    "<Field Label As Shown>": { "value": "...", "confidence": "..." }
  },
  "notes": "any concerns or things to flag, otherwise empty string"
}

RULES:
- Confidence "high" = clearly legible. "medium" = some interpretation. "low" = had to guess.
- If a BASE field is BLANK on the ticket (not filled in), return empty string value with "high" confidence.
- For dates like "5/19/26": interpret year as 2026 (current decade); output YYYY-MM-DD.
- For times: if AM/PM ambiguous, prefer the interpretation that makes work-day sense (08-17 range).
- TruckingCo = the company name on the ticket form / letterhead.
- Customer = the recipient of the load (often "Earth Basics" for these tickets).
- For commodity text in BASE fields: use the exact label from the ticket. Normalize only obvious typos.
- typeSpecific and extras may be empty {} but must be present in the JSON.

Return ONLY the JSON object.`;

module.exports = async function (context, req) {
  // Route is already auth-protected; double-check to be safe.
  if (!getPrincipal(req)) {
    return respond(context, 401, { ok: false, error: 'Not authenticated.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return respond(context, 500, {
      ok: false,
      error: 'Server not configured: ANTHROPIC_API_KEY missing. Set it in the Static Web App configuration.',
    });
  }

  let imageBase64;
  try {
    let body = req.body;
    if (typeof body === 'string') body = JSON.parse(body);
    imageBase64 = body && body.image;
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return respond(context, 400, { ok: false, error: 'Body must be {"image": "<base64 string>"}.' });
    }
    if (imageBase64.startsWith('data:')) {
      const comma = imageBase64.indexOf(',');
      if (comma === -1) return respond(context, 400, { ok: false, error: 'Malformed data URL.' });
      imageBase64 = imageBase64.slice(comma + 1);
    }
    if (imageBase64.length < 100) {
      return respond(context, 400, { ok: false, error: 'Image data looks too small.' });
    }
  } catch (e) {
    return respond(context, 400, { ok: false, error: 'Bad request: ' + (e.message || 'invalid JSON') });
  }

  let apiRes;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: PROMPT },
          ],
        }],
      }),
    });
  } catch (e) {
    return respond(context, 502, { ok: false, error: 'Could not reach Anthropic API: ' + (e.message || e) });
  }

  if (!apiRes.ok) {
    let detail = '';
    try { detail = await apiRes.text(); } catch (_) {}
    return respond(context, 502, { ok: false, error: 'Anthropic API returned ' + apiRes.status, detail: detail.slice(0, 500) });
  }

  let data;
  try { data = await apiRes.json(); }
  catch (e) { return respond(context, 502, { ok: false, error: 'Could not parse Anthropic response.' }); }

  const text = (data && data.content && data.content[0] && data.content[0].text) || '';
  if (!text) {
    return respond(context, 502, { ok: false, error: 'Empty response from model.', detail: JSON.stringify(data).slice(0, 500) });
  }

  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { return respond(context, 502, { ok: false, error: 'Model response was not valid JSON.', raw: text.slice(0, 1000) }); }

  if (!parsed.fields) parsed.fields = {};
  if (!parsed.typeSpecific) parsed.typeSpecific = {};
  if (!parsed.extras) parsed.extras = {};
  if (!parsed.commodityType) parsed.commodityType = 'other';

  return respond(context, 200, { ok: true, parsed, usage: data.usage || null });
};

function respond(context, status, body) {
  context.res = {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    body: JSON.stringify(body),
  };
}
