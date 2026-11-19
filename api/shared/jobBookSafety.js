// Safety folder in a project's Job Book. JHA and incident-report PDFs are
// archived per user (ewt-pdfs/<userId>/…, what Manage Users shows); this drops
// a second copy at job-books/<code>/Safety/<name> so the same PDF also shows
// under the job. Names are deterministic per record, so re-sending a report
// replaces its copy instead of piling up duplicates.
const { getJobBooksContainer, safeName, safeFileName } = require('./blob');
const { readDoc, findProject } = require('./projects');

const SAFETY_FOLDER = 'Safety';
const day = (d) => (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(d || '')) ? String(d) : 'undated');

// "JHA 2026-11-18 - Tony Blood.pdf" — one JHA per foreman per job per day.
function jhaFileName(date, who) {
  return safeFileName('JHA ' + day(date) + ' - ' + (String(who || '').trim() || 'unknown')) + '.pdf';
}
// "Incident 2026-11-18 - Injury - a1b2.pdf" — the id tail keeps two incidents
// of the same type on the same day apart.
function incidentFileName(date, type, id) {
  const t = String(type || '').split(',')[0].trim().slice(0, 40) || 'Incident';
  const tail = String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(-4);
  return safeFileName('Incident ' + day(date) + ' - ' + t + (tail ? ' - ' + tail : '')) + '.pdf';
}

function safetyPath(projectCode, fileName) {
  return safeName(projectCode) + '/' + SAFETY_FOLDER + '/' + fileName;
}

// Copy a PDF into the job's Safety folder. Only for codes that are real
// projects (off-site incidents have none). Never throws — a failed copy must
// not fail the send. Returns the blob path, or '' when nothing was saved.
async function putSafetyCopy(log, records, projectCode, fileName, buffer) {
  try {
    if (!projectCode || !fileName || !buffer || !buffer.length) return '';
    const p = findProject(await readDoc(records), projectCode);
    if (!p) return '';
    const container = await getJobBooksContainer();
    const path = safetyPath(p.code, fileName);
    await container.getBlockBlobClient(path).uploadData(buffer, { blobHTTPHeaders: { blobContentType: 'application/pdf' } });
    return path;
  } catch (e) {
    if (log && log.warn) log.warn('job book safety copy failed: ' + (e.message || e));
    return '';
  }
}

module.exports = { SAFETY_FOLDER, jhaFileName, incidentFileName, safetyPath, putSafetyCopy };
