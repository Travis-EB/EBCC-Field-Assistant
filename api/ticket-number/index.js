// POST /api/ticket-number — reserve the next Extra Work Ticket number.
//
// Company-wide sequence starting at 21100, +1 per ticket, unique across all
// users/devices. The counter lives as a single doc in the records container
// (ownerId '__meta__', so it never appears in any user's record queries).
// Concurrency is handled with etag-checked replaces + retry: two foremen
// reserving at the same instant get consecutive, never duplicate, numbers.
const { getContainers, getPrincipal, ensureUser, json } = require('../shared/auth');

const START = 21100;
const COUNTER_ID = 'counter:ewt';
const COUNTER_PK = '__meta__';

module.exports = async function (context, req) {
  const principal = getPrincipal(req);
  if (!principal) return json(context, 401, { error: 'Not authenticated.' });

  let me;
  try {
    me = await ensureUser(principal, principal.email);
  } catch (e) {
    context.log.error('ticket-number ensureUser', e);
    return json(context, 500, { error: 'Server error.' });
  }
  if (me.role === 'disabled') return json(context, 403, { error: 'Account disabled.' });

  const { records } = await getContainers();

  for (let attempt = 0; attempt < 6; attempt++) {
    let doc = null;
    try {
      const resp = await records.item(COUNTER_ID, COUNTER_PK).read();
      doc = resp.resource || null;
    } catch (e) {
      if (e.code !== 404) {
        context.log.error('ticket-number read', e);
        return json(context, 500, { error: 'Server error.' });
      }
    }

    try {
      if (!doc) {
        // First ticket ever: create the counter with START already consumed.
        await records.items.create({ id: COUNTER_ID, ownerId: COUNTER_PK, type: 'counter', value: START });
        return json(context, 200, { number: START });
      }
      const next = (typeof doc.value === 'number' && isFinite(doc.value) ? doc.value : START - 1) + 1;
      doc.value = next;
      await records.item(COUNTER_ID, COUNTER_PK).replace(doc, {
        accessCondition: { type: 'IfMatch', condition: doc._etag },
      });
      return json(context, 200, { number: next });
    } catch (e) {
      // 412 = etag mismatch (someone else took the number), 409 = create race.
      if (e.code === 412 || e.code === 409) continue;
      context.log.error('ticket-number write', e);
      return json(context, 500, { error: 'Server error.' });
    }
  }
  return json(context, 500, { error: 'Counter busy — try again.' });
};
