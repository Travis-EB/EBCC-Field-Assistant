// Blob storage for EWT PDFs. Files live in the private 'ewt-pdfs' container,
// pathed by owner id; access always flows through the authenticated API.
const { BlobServiceClient } = require('@azure/storage-blob');

let _container = null;

async function getEwtContainer() {
  if (_container) return _container;
  const conn = process.env.BLOB_CONN;
  if (!conn) throw new Error('BLOB_CONN app setting is not configured.');
  const svc = BlobServiceClient.fromConnectionString(conn);
  const c = svc.getContainerClient('ewt-pdfs');
  await c.createIfNotExists();
  _container = c;
  return c;
}

function safeName(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
}

module.exports = { getEwtContainer, safeName };
