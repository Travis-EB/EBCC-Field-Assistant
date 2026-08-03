// Blob storage helpers. Containers are private; all access flows through the
// authenticated API. 'ewt-pdfs' holds ticket PDFs (pathed by owner id);
// 'job-books' holds shared project files (pathed by project code).
const { BlobServiceClient } = require('@azure/storage-blob');

const _containers = {};

async function getContainer(name) {
  if (_containers[name]) return _containers[name];
  const conn = process.env.BLOB_CONN;
  if (!conn) throw new Error('BLOB_CONN app setting is not configured.');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const c = svc.getContainerClient(name);
  await c.createIfNotExists();
  _containers[name] = c;
  return c;
}

function getEwtContainer() { return getContainer('ewt-pdfs'); }
function getJobBooksContainer() { return getContainer('job-books'); }

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

// Friendlier sanitize for user-facing file names (keeps spaces and parens)
function safeFileName(s) {
  return String(s || '').replace(/[\\/:*?"<>|#%&{}$!'@+`=]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

module.exports = { getContainer, getEwtContainer, getJobBooksContainer, safeName, safeFileName };
