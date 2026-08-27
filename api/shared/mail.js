// Microsoft Graph mail via client credentials (Application permission
// Mail.Send, granted by IT). Sends FROM the signed-in user's own mailbox so
// replies go back to the foreman and the message lands in their Sent folder.
//
// Returns { ok:true, sent:true } or { ok:false, reason, detail? } — never throws,
// so callers can fall back to the device share sheet.
const TENANT_ID = process.env.AAD_TENANT_ID || 'f95ee318-b7d4-49aa-b795-b188b614caca';

async function sendGraphMail(context, { fromEmail, subject, text, recipients, fileName, pdfB64, contentType }) {
  const clientId = process.env.AAD_CLIENT_ID;
  const clientSecret = process.env.AAD_CLIENT_SECRET;
  if (!clientId || !clientSecret) return { ok: false, reason: 'mail-not-configured' };

  let token;
  try {
    const tr = await fetch('https://login.microsoftonline.com/' + TENANT_ID + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default',
      }),
    });
    const td = await tr.json();
    token = td.access_token;
    if (!token) throw new Error(td.error_description || 'no token');
  } catch (e) {
    context.log.error('graph token', e);
    return { ok: false, reason: 'mail-permission' };
  }

  try {
    const gr = await fetch('https://graph.microsoft.com/v1.0/users/' + encodeURIComponent(fromEmail) + '/sendMail', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: subject,
          body: { contentType: 'Text', content: text },
          toRecipients: recipients.map((r) => ({ emailAddress: { address: r } })),
          attachments: pdfB64 ? [{
            '@odata.type': '#microsoft.graph.fileAttachment',
            name: fileName,
            contentType: contentType || 'application/pdf',
            contentBytes: pdfB64,
          }] : [],
        },
        saveToSentItems: true,
      }),
    });
    if (gr.status === 202) return { ok: true, sent: true };
    const detail = (await gr.text().catch(() => '')).slice(0, 400);
    context.log.error('graph sendMail ' + gr.status + ' ' + detail);
    if (gr.status === 403 || gr.status === 401) return { ok: false, reason: 'mail-permission' };
    return { ok: false, reason: 'mail-failed', detail: detail };
  } catch (e) {
    context.log.error('graph send', e);
    return { ok: false, reason: 'mail-failed' };
  }
}

module.exports = { sendGraphMail };
