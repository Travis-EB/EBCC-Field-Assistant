// Finding the borings on a boring location plan image, for the job map.
//
// Once an admin has pinned the plan to the map, every boring's position
// follows from where its symbol sits on the drawing. The browser sends
// pictures of the drawing and Claude answers with pixel positions:
//
//   coarse  one picture of the whole plan + the boring numbers
//           -> roughly where each one is (only used for numbers the PDF's own
//              text layer did not already locate)
//   refine  up to 8 close-ups, one boring each
//           -> the centre of that boring's SYMBOL in the close-up
//
// The answer is only ever a suggestion: anything not found, or found with low
// confidence, is left for the admin to tap in by hand.
//
// Raw fetch, like the rest of this API. The first request shape asks for
// server-side fallbacks (another model answers if the first declines) and
// schema-constrained output; if the API rejects a shape with a 400 the next,
// plainer one is tried, so a parameter this account cannot use never blocks it.
const API = 'https://api.anthropic.com/v1/messages';
const VERSION = '2026-10-21';
const MODEL = process.env.GEOTECH_MODEL || 'claude-opus-5-5';

const SYSTEM = [
  'You find exploration points (soil borings, test pits, hand augers) on the boring location plan from a geotechnical report. A crew uses your answer to put each boring on a site map, so a wrong position is worse than no position.',
  '',
  'Each exploration is drawn as a small symbol — often a circle, a circle with a cross or a quartered fill, a triangle, or a target — with its number written beside it. Report the pixel position of the CENTRE OF THE SYMBOL, not of the label text. x is pixels from the left edge of the image, y is pixels from the top edge.',
  '',
  'Set found to false when you cannot see a symbol for that number in the image: the number may appear only in a legend, a table or a note, or not at all. Do not guess a position.',
  '',
  'confidence: "high" when the symbol and its label are both clear and plainly belong together; "medium" when it is likely right but the drawing is crowded or faint; "low" when you are unsure which symbol belongs to the label.',
].join('\n');

const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const SCHEMA = obj({
  results: {
    type: 'array',
    items: obj({ n: { type: 'integer' }, id: { type: 'string' }, found: { type: 'boolean' }, x: { type: 'number' }, y: { type: 'number' }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] } }),
  },
});
const JSON_ONLY = '\n\nReply with ONE JSON object and nothing else (no prose, no code fence), exactly matching this JSON Schema:\n' + JSON.stringify(SCHEMA);

const img = (data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } });

function coarseContent(image, ids) {
  return [
    img(image.data),
    { type: 'text', text: 'This is the whole plan, ' + image.w + ' x ' + image.h + ' pixels. Find these explorations: ' + ids.join(', ') + '.\n' +
      'Give one result per exploration with n = 0 and its approximate symbol position in this image. Each will be checked again on a close-up, so approximate is fine — but still say found = false for one that is not drawn on the plan.' },
  ];
}
function refineContent(crops) {
  const content = [];
  crops.forEach((c, i) => {
    content.push({ type: 'text', text: 'Close-up ' + (i + 1) + ': ' + c.w + ' x ' + c.h + ' pixels. Find ' + c.id + '.' });
    content.push(img(c.data));
  });
  content.push({ type: 'text', text: 'Give exactly one result per close-up: n = the close-up number, id = the exploration asked for, and the centre of its symbol in that close-up.' });
  return content;
}

function readText(message) {
  const text = (Array.isArray(message.content) ? message.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  try { return JSON.parse(text); } catch (e) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(text.slice(a, b + 1)); } catch (e2) {} }
  }
  return null;
}

// -> { results: [{ n, id, found, x, y, confidence }] }; throws with a readable message.
async function locate(content, deadline) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY app setting is not configured.');
  const base = { model: MODEL, max_tokens: 6000, messages: [{ role: 'user', content }] };
  const shapes = [
    { beta: 'server-side-fallback-2026-07-01', body: Object.assign({}, base, { system: SYSTEM, fallbacks: 'default', output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } } }) },
    { beta: '', body: Object.assign({}, base, { system: SYSTEM, output_config: { format: { type: 'json_schema', schema: SCHEMA } } }) },
    { beta: '', body: Object.assign({}, base, { system: SYSTEM + JSON_ONLY }) },
  ];
  let lastError = 'no answer';
  for (const shape of shapes) {
    const left = deadline - Date.now();
    if (left < 4000) break;
    const headers = { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': VERSION };
    if (shape.beta) headers['anthropic-beta'] = shape.beta;
    let r;
    try { r = await fetch(API, { method: 'POST', headers, body: JSON.stringify(shape.body), signal: AbortSignal.timeout(left) }); }
    catch (e) { throw new Error(e && e.name === 'TimeoutError' ? 'the AI took too long to answer' : 'could not reach the AI service'); }
    if (r.status === 400) {   // this shape is not accepted here — try the plainer one
      try { const j = JSON.parse(await r.text()); lastError = (j && j.error && j.error.message) || 'bad request'; } catch (e) { lastError = 'bad request'; }
      continue;
    }
    if (!r.ok) {
      let detail = '';
      try { const j = JSON.parse(await r.text()); detail = (j && j.error && j.error.message) || ''; } catch (e) {}
      throw new Error('Claude API ' + r.status + (detail ? ': ' + detail : ''));
    }
    const message = await r.json();
    if (message.stop_reason === 'refusal') throw new Error('the AI declined to read this drawing');
    const data = readText(message);
    if (!data || !Array.isArray(data.results)) throw new Error(message.stop_reason === 'max_tokens' ? 'the answer was cut off' : 'the answer could not be read');
    return {
      results: data.results.slice(0, 120).map((x) => ({
        n: Math.round(Number(x && x.n)) || 0, id: String((x && x.id) || '').slice(0, 40), found: !!(x && x.found),
        x: Number(x && x.x), y: Number(x && x.y), confidence: ['high', 'medium', 'low'].includes(x && x.confidence) ? x.confidence : 'low',
      })).filter((x) => !x.found || (isFinite(x.x) && isFinite(x.y))),
    };
  }
  throw new Error('Claude API 400: ' + lastError);
}

module.exports = { MODEL, SYSTEM, SCHEMA, coarseContent, refineContent, locate };
