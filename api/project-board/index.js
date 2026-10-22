// /api/project-board — the per-job "diary": action items, notes, meeting
// minutes / look-aheads, and contacts. One shared doc per project in the
// records container (id 'board:<code>', ownerId '__shared__'), separate from
// the projects doc so long minutes bodies and frequent checkbox taps never
// contend with schedule edits.
//
// GET  ?code=            -> { board } (empty default when nothing saved yet)
// POST { code, mode, … } -> { ok, board, added? }   every mode is a server-side
//      delta applied under an etag-checked replace, so two people editing at
//      once can't clobber each other.
//   admin only : upsertTask {task} · addTemplate {phase} · deleteTask {id}
//                setNotes {notes} · upsertMinutes {entry} · deleteMinutes {id}
//                setContacts {contacts[]}
//   any user   : toggleTask {id, done}   (records who / when)
const { getContainers, getPrincipal, ensureUser, isAdmin, json } = require('../shared/auth');
const { safeName } = require('../shared/blob');
const { readDoc, findProject } = require('../shared/projects');
const { BOARD_TEMPLATES, BOARD_PHASES } = require('../shared/boardTemplates');

const DOC_PK = '__shared__';
const DATE_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CAP = { tasks: 300, minutes: 100, contacts: 50, notes: 16000, minutesBody: 6000, bytes: 1.4 * 1024 * 1024 };
const ADMIN_MODES = new Set(['upsertTask', 'addTemplate', 'deleteTask', 'setNotes', 'upsertMinutes', 'deleteMinutes', 'setContacts']);

const boardId = (code) => 'board:' + safeName(String(code).toLowerCase());
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const who = (me) => ({ email: me.email, name: me.name || me.email });
const newId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-3);

function emptyBoard(code) {
  return {
    id: boardId(code), ownerId: DOC_PK, type: 'project_board', code,
    tasks: [], notes: '', notesBy: '', notesAt: '', minutes: [], contacts: [],
    summary: { open: 0, done: 0, updatedAt: '' }, updatedAt: '',
  };
}
function publicBoard(doc) {
  const out = {};
  Object.keys(doc).forEach((k) => { if (k[0] !== '_' && k !== 'ownerId') out[k] = doc[k]; });
  return out;
}
function recompute(doc, now) {
  const open = doc.tasks.filter((t) => !t.done).length;
  doc.summary = { open, done: doc.tasks.length - open, updatedAt: now };
  doc.updatedAt = now;
}
function cleanAssignee(a) {
  if (!a || typeof a !== 'object') return null;
  const email = str(a.email, 120).toLowerCase();
  if (!EMAIL_RE.test(email)) return null;
  return { email, name: str(a.name, 80) || email };
}

// Returns { error, status } on a bad request, otherwise { added? }.
function apply(doc, body, me, now) {
  const mode = String(body.mode || '');
  if (mode === 'upsertTask') {
    const t = body.task && typeof body.task === 'object' ? body.task : {};
    const text = str(t.text, 200);
    if (!text) return { error: 'Action item text is required.', status: 400 };
    const due = str(t.due, 10);
    if (due && !DATE_RE.test(due)) return { error: 'Bad due date.', status: 400 };
    const phase = BOARD_PHASES.includes(t.phase) ? t.phase : 'General';
    const assignee = cleanAssignee(t.assignee);
    const cur = t.id ? doc.tasks.find((x) => x.id === String(t.id)) : null;
    if (cur) {
      Object.assign(cur, { text, phase, assignee, due, updatedAt: now });
    } else {
      if (doc.tasks.length >= CAP.tasks) return { error: 'Too many action items (max ' + CAP.tasks + ').', status: 400 };
      doc.tasks.push({ id: newId(), text, phase, assignee, due, done: false, doneBy: null, doneAt: '', createdBy: who(me), createdAt: now, updatedAt: now });
    }
    return {};
  }
  if (mode === 'addTemplate') {
    const phase = String(body.phase || '');
    const items = BOARD_TEMPLATES[phase];
    if (!items) return { error: 'Unknown template.', status: 400 };
    const have = new Set(doc.tasks.map((x) => x.phase + '|' + x.text.toLowerCase()));
    let added = 0;
    items.forEach((text) => {
      if (have.has(phase + '|' + text.toLowerCase()) || doc.tasks.length >= CAP.tasks) return;
      doc.tasks.push({ id: newId(), text, phase, assignee: null, due: '', done: false, doneBy: null, doneAt: '', createdBy: who(me), createdAt: now, updatedAt: now });
      added++;
    });
    return { added };
  }
  if (mode === 'deleteTask') {
    const id = str(body.id, 40);
    doc.tasks = doc.tasks.filter((x) => x.id !== id);
    return {};
  }
  if (mode === 'toggleTask') {
    const id = str(body.id, 40);
    const t = doc.tasks.find((x) => x.id === id);
    if (!t) return { error: 'Action item not found.', status: 404 };
    const done = !!body.done;
    t.done = done; t.doneBy = done ? who(me) : null; t.doneAt = done ? now : ''; t.updatedAt = now;
    return {};
  }
  if (mode === 'setNotes') {
    doc.notes = str(body.notes, CAP.notes);
    doc.notesBy = who(me).name; doc.notesAt = now;
    return {};
  }
  if (mode === 'upsertMinutes') {
    const e = body.entry && typeof body.entry === 'object' ? body.entry : {};
    const date = str(e.date, 10);
    if (!DATE_RE.test(date)) return { error: 'Pick a date.', status: 400 };
    const kind = e.kind === 'lookahead' ? 'lookahead' : 'minutes';
    const title = str(e.title, 120) || (kind === 'lookahead' ? '3-week look-ahead' : 'Meeting minutes');
    const text = str(e.body, CAP.minutesBody);
    if (!text) return { error: 'Add some notes first.', status: 400 };
    const cur = e.id ? doc.minutes.find((x) => x.id === String(e.id)) : null;
    if (cur) Object.assign(cur, { kind, date, title, body: text, updatedAt: now });
    else {
      if (doc.minutes.length >= CAP.minutes) return { error: 'Too many entries — delete old minutes first.', status: 400 };
      doc.minutes.push({ id: newId(), kind, date, title, body: text, createdBy: who(me), createdAt: now, updatedAt: now });
    }
    return {};
  }
  if (mode === 'deleteMinutes') {
    const id = str(body.id, 40);
    doc.minutes = doc.minutes.filter((x) => x.id !== id);
    return {};
  }
  if (mode === 'setContacts') {
    const raw = Array.isArray(body.contacts) ? body.contacts.slice(0, CAP.contacts) : [];
    doc.contacts = raw.filter((c) => c && typeof c === 'object').map((c) => ({
      id: str(c.id, 40) || newId(),
      role: str(c.role, 40), name: str(c.name, 80), company: str(c.company, 80),
      phone: str(c.phone, 30), email: str(c.email, 120).toLowerCase(), note: str(c.note, 200),
    })).filter((c) => c.name || c.company || c.phone || c.email);
    return {};
  }
  return { error: 'Unknown mode.', status: 400 };
}

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });
  let me;
  try { me = await ensureUser(principal, principal.email); }
  catch (e) { context.log.error('project-board ensureUser', e); return json(context, 500, { error: 'Server error.' }); }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const method = (req.method || 'GET').toUpperCase();
  const { records } = await getContainers();

  try {
    if (method === 'GET') {
      const code = String((req.query && req.query.code) || '').trim();
      if (!code) return json(context, 400, { error: 'code required.' });
      const projects = await readDoc(records);
      const p = findProject(projects, code);
      if (!p) return json(context, 404, { error: 'Project not found.' });
      let doc = null;
      try { doc = (await records.item(boardId(p.code), DOC_PK).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
      return json(context, 200, { board: publicBoard(doc || emptyBoard(p.code)) });
    }

    if (method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = null; } }
      if (!body || typeof body !== 'object') return json(context, 400, { error: 'Bad request.' });
      const code = String(body.code || '').trim();
      if (!code) return json(context, 400, { error: 'code required.' });
      const mode = String(body.mode || '');
      if (ADMIN_MODES.has(mode) && !isAdmin(me)) return json(context, 403, { error: 'Admin only.' });
      const projects = await readDoc(records);
      const p = findProject(projects, code);
      if (!p) return json(context, 404, { error: 'Project not found.' });

      for (let attempt = 0; attempt < 5; attempt++) {
        let doc = null;
        try { doc = (await records.item(boardId(p.code), DOC_PK).read()).resource; } catch (e) { if (e.code !== 404) throw e; }
        const fresh = !doc;
        if (fresh) doc = emptyBoard(p.code);
        const now = new Date().toISOString();
        const res = apply(doc, body, me, now);
        if (res.error) return json(context, res.status || 400, { error: res.error });
        recompute(doc, now);
        if (JSON.stringify(doc).length > CAP.bytes) return json(context, 409, { error: 'This job\'s board is full — delete old minutes to make room.' });
        try {
          if (fresh) await records.items.create(doc);
          else await records.item(doc.id, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
          const out = { ok: true, board: publicBoard(doc) };
          if (res.added != null) out.added = res.added;
          return json(context, 200, out);
        } catch (e) {
          if (e.code !== 412 && e.code !== 409) throw e; // raced another writer — retry
        }
      }
      return json(context, 503, { error: 'Busy — try again.' });
    }

    return json(context, 405, { error: 'Method not allowed.' });
  } catch (e) {
    context.log.error('project-board', e);
    return json(context, 500, { error: 'Server error.' });
  }
};
