// Worker thread that opens a report PDF and cuts page ranges out of it.
//
// Parsing runs here, off the function's main thread, for one reason: a huge or
// malformed PDF can keep the parser busy for minutes, and a parse on the main
// thread cannot be interrupted. The caller (geotech.openPdf) gives each
// request a deadline and terminates this worker when it is missed, so the
// office gets "took too long to open" instead of a request that dies at the
// platform's 45-second limit with no explanation.
//
// @cantoo/pdf-lib is the maintained fork of pdf-lib; unlike the original it
// can open sealed PDFs.
const { parentPort } = require('worker_threads');
const { PDFDocument } = require('@cantoo/pdf-lib');

let src = null;

// Engineers usually seal a signed report: the PDF opens without a password
// but is encrypted to stop editing. Its pages have to be decrypted (empty
// password) before they are copied out, or every page range comes out as
// unreadable noise. A PDF that really needs a password to open cannot be read.
async function load(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (!/encrypted/i.test(String((e && e.message) || ''))) throw e;
    try {
      return await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    } catch (e2) {
      const err = new Error('This PDF needs a password to open.');
      err.code = 'PDF_PASSWORD';
      throw err;
    }
  }
}

parentPort.on('message', async (m) => {
  try {
    if (m.op === 'load') {
      src = await load(new Uint8Array(m.buffer));
      parentPort.postMessage({ id: m.id, pages: src.getPageCount() });
    } else if (m.op === 'extract') {
      if (!src) throw new Error('No PDF is open.');
      const out = await PDFDocument.create();
      const idx = [];
      for (let i = m.from - 1; i <= m.to - 1; i++) idx.push(i);
      (await out.copyPages(src, idx)).forEach((p) => out.addPage(p));
      const bytes = await out.save();
      parentPort.postMessage({ id: m.id, bytes });
    }
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: String((e && e.message) || e).slice(0, 300), code: (e && e.code) || '' });
  }
});
