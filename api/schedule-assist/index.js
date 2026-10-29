// POST /api/schedule-assist — the Active Jobs assistant. A project manager
// says (or types) who and what is going to a job; this turns it into schedule
// entries for ONE project. ADMIN ONLY. It never writes anything: the client
// shows the proposal for review and saves it through /api/projects setSchedule.
//
// Body:  { text, today: 'YYYY-MM-DD', code?: '<job the PM is looking at>', machineNames?: [] }
// Reply: { ok:true, project:{code,name}|null, entries:[{kind,name,qty,start,end,note,linkName}],
//          questions:[], summary }
//
// Calls the Anthropic Messages API directly (same convention as ocr-truck-ticket)
// with a JSON-schema structured output, so the reply is always well-formed.
// Requires app setting ANTHROPIC_API_KEY (already used by OCR).
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { readDoc } = require('../shared/projects');

const MODEL = process.env.ASSIST_MODEL || 'claude-opus-5-5';
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    projectCode: { type: 'string', description: 'Job code from the PROJECTS list, or "" when no job can be identified.' },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', enum: ['machine', 'person'] },
          name: { type: 'string', description: 'Machine name (catalog spelling when it matches) or the person\'s name.' },
          qty: { type: 'integer', minimum: 1, maximum: 99, description: 'Unit count for machines; always 1 for a person.' },
          start: { type: 'string', description: 'YYYY-MM-DD' },
          end: { type: 'string', description: 'YYYY-MM-DD, or "" when ongoing / not stated.' },
          note: { type: 'string', description: 'Shift, unit number or other detail the PM gave; else "".' },
          linkName: { type: 'string', description: 'Person only: the machine name they run or ride on, exactly as it appears in a machine entry; else "".' },
        },
        required: ['kind', 'name', 'qty', 'start', 'end', 'note', 'linkName'],
      },
    },
    questions: { type: 'array', items: { type: 'string' }, description: 'Anything the PM should confirm or fill in.' },
    summary: { type: 'string', description: 'One plain sentence of what was understood.' },
  },
  required: ['projectCode', 'entries', 'questions', 'summary'],
};

const RULES = `You turn a construction project manager's spoken or typed note into schedule entries for the EBCC Field Assistant. The company does earthwork (scrapers, dozers, excavators, water trucks, rollers, graders, haul trucks, crews).

Rules:
- Pick ONE job from PROJECTS by name or job number. Prefer active jobs. If the PM named no job and a CURRENT JOB is given, use it. If no job can be identified, set projectCode to "" and ask in questions.
- Machines: one entry per machine type with qty = how many ("two 657s" = one entry, qty 2). When the spoken machine clearly matches a MACHINE CATALOG name (e.g. "657" or "657 scraper" -> "Scraper: CAT657", "D6" -> the D6 dozer entry), use that exact catalog spelling; otherwise write a short clean name.
- People: one entry per person, qty 1. When a spoken name clearly matches someone in PEOPLE, use that spelling; otherwise keep the name as said. If the PM says a person runs or rides on a machine that is also in this note, set linkName to that machine entry's name.
- Dates: resolve everything against TODAY. A weekday name means the next one on or after today. "next week" means the coming Monday. "for N weeks" means end = start + 7N - 1 days; "for N days" means end = start + N - 1. "through Friday" ends that Friday. With no start stated, start today. With no end stated, end is "". Entries share the job's dates unless the PM gives a person or machine its own.
- Never invent people, machines, quantities or dates that were not said. Put anything uncertain in questions instead of guessing.
- summary: one plain sentence a foreman could read back.`;

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { ok: false, error: 'Not authenticated.' });
  let me;
  try { me = await ensureUser(principal, principal.email); }
  catch (e) { context.log.error('schedule-assist ensureUser', e); return json(context, 500, { ok: false, error: 'Server error.' }); }
  if (me.role === 'disabled') return json(context, 403, { ok: false, error: 'Account disabled.' });
  if (!isAdmin(me)) return json(context, 403, { ok: false, error: 'Admin only.' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return json(context, 503, { ok: false, error: 'The assistant is not set up: ANTHROPIC_API_KEY is missing in the Static Web App configuration.' });

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== 'object') return json(context, 400, { ok: false, error: 'Bad request.' });
  const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 2000);
  if (text.length < 3) return json(context, 400, { ok: false, error: 'Say or type what is going to the job first.' });
  const today = DATE_RE.test(String(body.today || '')) ? String(body.today) : new Date().toISOString().slice(0, 10);
  const hintCode = String(body.code || '').trim().slice(0, 40);
  const machineNames = Array.from(new Set((Array.isArray(body.machineNames) ? body.machineNames : [])
    .map((n) => String(n || '').trim().slice(0, 80)).filter(Boolean))).slice(0, 400);

  // ---- Context: projects (shared doc) + people (user directory) ----
  let projects = [], people = [];
  try {
    const { records, users } = await getContainers();
    const doc = await readDoc(records);
    projects = ((doc && doc.data) || []).filter((p) => p && p.code && p.name).map((p) => ({
      code: String(p.code), name: String(p.name), state: p.state || '', active: !!p.active,
      machines: Array.isArray(p.schedule) ? p.schedule.filter((e) => e && e.kind !== 'person').map((e) => e.name) : [],
    }));
    const { resources } = await users.items.query("SELECT c.name, c.email FROM c WHERE c.role != 'disabled'").fetchAll();
    people = resources.map((u) => String(u.name || u.email || '')).filter(Boolean).sort();
  } catch (e) {
    context.log.error('schedule-assist context', e);
    return json(context, 500, { ok: false, error: 'Could not load the project list.' });
  }
  if (!projects.length) return json(context, 400, { ok: false, error: 'There are no projects yet — create one in Job Books first.' });

  const byCode = new Map(projects.map((p) => [p.code.toLowerCase(), p]));
  const hint = hintCode && byCode.get(hintCode.toLowerCase());
  const active = projects.filter((p) => p.active), inactive = projects.filter((p) => !p.active);
  const projLine = (p) => p.code + ' | ' + p.name + (p.state ? ' | ' + p.state : '') + (p.machines.length ? ' | on site: ' + Array.from(new Set(p.machines)).slice(0, 12).join(', ') : '');
  const system = RULES + '\n\nTODAY: ' + today + ' (' + ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][new Date(today + 'T12:00:00Z').getUTCDay()] + ')' +
    (hint ? '\nCURRENT JOB: ' + hint.code + ' | ' + hint.name : '') +
    '\n\nPROJECTS (code | name | state | machines already on site)\nActive:\n' + (active.map(projLine).join('\n') || '(none)') +
    '\nNot active:\n' + (inactive.slice(0, 150).map(projLine).join('\n') || '(none)') +
    '\n\nPEOPLE:\n' + (people.join('\n') || '(none)') +
    '\n\nMACHINE CATALOG:\n' + (machineNames.join('\n') || '(none)');

  // ---- Model call (structured output) ----
  let apiRes;
  try {
    apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        system,
        messages: [{ role: 'user', content: text }],
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      }),
    });
  } catch (e) {
    return json(context, 502, { ok: false, error: 'Could not reach the assistant: ' + (e.message || e) });
  }
  if (!apiRes.ok) {
    let detail = '';
    try { detail = await apiRes.text(); } catch (_) {}
    context.log.warn('schedule-assist API ' + apiRes.status + ': ' + detail.slice(0, 500));
    const friendly = apiRes.status === 401 ? 'The assistant\'s API key was rejected.' : apiRes.status === 429 ? 'The assistant is busy — try again in a moment.' : 'The assistant returned an error (' + apiRes.status + ').';
    return json(context, 502, { ok: false, error: friendly, detail: detail.slice(0, 300) });
  }
  let data;
  try { data = await apiRes.json(); } catch (e) { return json(context, 502, { ok: false, error: 'Could not read the assistant\'s reply.' }); }
  if (data && data.stop_reason === 'refusal') return json(context, 502, { ok: false, error: 'The assistant declined that request.' });
  if (data && data.stop_reason === 'max_tokens') return json(context, 502, { ok: false, error: 'That note was too long for one go — split it up.' });
  const raw = ((data && data.content) || []).filter((b) => b && b.type === 'text').map((b) => b.text).join('');
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { return json(context, 502, { ok: false, error: 'The assistant\'s reply was not readable — try again.' }); }

  // ---- Sanitize exactly like setSchedule will ----
  const entries = [];
  for (const it of (Array.isArray(parsed.entries) ? parsed.entries : []).slice(0, 60)) {
    if (!it || typeof it !== 'object') continue;
    const kind = it.kind === 'person' ? 'person' : 'machine';
    const name = String(it.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const start = DATE_RE.test(String(it.start || '')) ? String(it.start) : today;
    let end = DATE_RE.test(String(it.end || '')) ? String(it.end) : '';
    if (end && end < start) end = '';
    if (!name) continue;
    entries.push({
      kind, name,
      qty: kind === 'person' ? 1 : Math.min(99, Math.max(1, parseInt(it.qty, 10) || 1)),
      start, end,
      note: String(it.note || '').trim().slice(0, 200),
      linkName: kind === 'person' ? String(it.linkName || '').trim().slice(0, 80) : '',
    });
  }
  const proj = byCode.get(String(parsed.projectCode || '').toLowerCase()) || null;
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : []).map((q) => String(q || '').trim().slice(0, 300)).filter(Boolean).slice(0, 8);
  if (!proj) questions.unshift('Which job is this for? Pick it below.');
  if (!entries.length) questions.push('No people or machines were understood — try naming them, e.g. "two 657 scrapers and a D6".');
  return json(context, 200, {
    ok: true,
    project: proj ? { code: proj.code, name: proj.name } : null,
    entries, questions,
    summary: String(parsed.summary || '').trim().slice(0, 400),
    usage: data.usage ? { input: data.usage.input_tokens, output: data.usage.output_tokens } : undefined,
  });
};
