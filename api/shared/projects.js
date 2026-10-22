// Shared project-list document helpers, used by /api/projects and the
// per-project board/records endpoints. The whole project list is ONE doc in
// the records container under ownerId '__shared__', so it never collides
// with per-user record queries. Writes are etag-checked replaces with retry.
const DOC_ID = 'projects';
const DOC_PK = '__shared__';

async function readDoc(records) {
  try {
    const { resource } = await records.item(DOC_ID, DOC_PK).read();
    return resource || null;
  } catch (e) {
    if (e.code !== 404) throw e;
    return null;
  }
}

function findProject(doc, code) {
  const c = String(code || '').toLowerCase();
  return ((doc && doc.data) || []).find((x) => x && String(x.code).toLowerCase() === c) || null;
}

// Apply `fn(project)` to one project with an etag-checked replace, retrying
// when another writer got in first. Returns the project, or null if absent.
async function updateProject(records, code, fn) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const doc = await readDoc(records);
    if (!doc) return null;
    const p = findProject(doc, code);
    if (!p) return null;
    fn(p);
    try {
      await records.item(DOC_ID, DOC_PK).replace(doc, { accessCondition: { type: 'IfMatch', condition: doc._etag } });
      return p;
    } catch (e) {
      if (e.code !== 412) throw e; // 412 = raced another writer — retry
    }
  }
  throw new Error('projects doc contention');
}

module.exports = { DOC_ID, DOC_PK, readDoc, findProject, updateProject };
