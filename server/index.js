// Payday server: a tiny private go-between for Plaid. Runs as ONE Google Cloud function.
// It holds your Plaid keys (the app never sees them) and only answers YOU (your Google sign-in).
const functions = require('@google-cloud/functions-framework');
const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

const ENV = process.env.PLAID_ENV === 'sandbox' ? 'sandbox' : 'production';
const BASE = ENV === 'sandbox' ? 'https://sandbox.plaid.com' : 'https://production.plaid.com';
const ORIGIN = (process.env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
const EMAIL = (process.env.ALLOWED_EMAIL || '').toLowerCase();
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CRON_SECRET = process.env.CRON_SECRET || '';
const webpush = require('web-push');

// ---------- rate limits (per server instance) and failed sign-in logging ----------
const hits = new Map();
function limited(key, max){
  const now = Date.now(), list = (hits.get(key) || []).filter(t => now - t < 60000);
  list.push(now); hits.set(key, list);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k);
  return list.length > max;
}
// Shows up in Google Cloud > Logging. Filter for "payday_security".
const warn = (event, req, extra = {}) => console.warn(JSON.stringify({ tag: 'payday_security', event, ip: req.ip || req.get('x-forwarded-for') || '', origin: req.get('origin') || '', ...extra }));

// ---------- web push (alerts on your phone) ----------
async function vapid(){
  const ref = db.collection('paydayConfig').doc('vapid');
  let d = (await ref.get()).data();
  if (!d){ const k = webpush.generateVAPIDKeys(); d = { publicKey: k.publicKey, privateKey: k.privateKey }; await ref.set(d); }
  webpush.setVapidDetails('mailto:' + (EMAIL || 'owner@example.com'), d.publicKey, d.privateKey);
  return d;
}
async function pushTo(uid, payload){
  await vapid();
  const subs = await db.collection('pushSubs').where('uid', '==', uid).get();
  let sent = 0;
  for (const d of subs.docs){
    try { await webpush.sendNotification(d.data().sub, JSON.stringify(payload)); sent++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await d.ref.delete(); else console.warn('push failed', e.statusCode || e.message); }
  }
  return sent;
}
const subId = endpoint => require('crypto').createHash('sha256').update(String(endpoint)).digest('hex').slice(0, 40);

// ---------- automatic pulls: new posted charges go to users/<you>/docs/autopull ----------
async function autoPullItem(docRef, it){
  let cursor = it.cursor || null, first = !cursor, added = [], more = true, accounts = {}, guard = 0;
  while (more && guard++ < 20){
    const j = await plaid('/transactions/sync', { access_token: it.accessToken, cursor: cursor || undefined, count: 500 });
    (j.accounts || []).forEach(a => { accounts[a.account_id] = a; });
    added = added.concat(j.added || []); cursor = j.next_cursor; more = j.has_more;
  }
  await docRef.update({ cursor, syncedAt: Date.now() });
  // The very first sync returns months of history; only keep the last 3 days so nothing old floods Review.
  const since = new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10);
  return added.filter(t => !t.pending && (!first || t.date >= since)).map(t => {
    const a = accounts[t.account_id] || {};
    return { id: t.transaction_id, accountId: t.account_id, type: a.type || '', subtype: a.subtype || '', inst: it.institution, date: t.date, desc: (t.merchant_name || t.name || 'Charge').trim(), flow: -t.amount };
  });
}
async function autoPullAll(){
  const snap = await db.collection('plaidItems').get(), byUid = {};
  for (const d of snap.docs){
    const it = d.data();
    try { (byUid[it.uid] = byUid[it.uid] || []).push(...await autoPullItem(d.ref, it)); }
    catch (e) { console.warn('auto pull failed', it.institution, e.code || e.message); if (e.code === 'ITEM_LOGIN_REQUIRED') await pushTo(it.uid, { title: it.institution + ' needs you to sign in again', body: 'Open Payday > Accounts > Log in again.', tag: 'payday-login', url: './?go=pull' }).catch(() => {}); }
  }
  let total = 0;
  for (const [uid, items] of Object.entries(byUid)){
    if (!items.length) continue;
    total += items.length;
    await db.collection('users').doc(uid).collection('docs').doc('autopull').set({ items: admin.firestore.FieldValue.arrayUnion(...items), _u: Date.now() }, { merge: true });
    const spent = items.filter(t => t.flow < 0).reduce((a, t) => a - t.flow, 0);
    const top = items.slice().sort((a, b) => a.flow - b.flow)[0];
    // One charge: add buttons so you can file it from the alert (Android/desktop show them).
    const one = items.length === 1 && top.flow < 0;
    const gasy = /shell|exxon|mobil|sunoco|speedway|citgo|valero|sheetz|getty|lukoil|circle k|fuel|bp\b|wawa gas|gulf|hess|marathon|chevron|texaco/i.test(top.desc);
    await pushTo(uid, {
      title: `${items.length} new charge${items.length === 1 ? '' : 's'}${spent ? ', $' + spent.toFixed(2) : ''}`,
      body: items.length === 1 ? `${top.desc} ${top.flow < 0 ? '$' + (-top.flow).toFixed(2) : '+$' + top.flow.toFixed(2)}.${one ? ' Where does it go?' : ' Tap to review.'}` : `Biggest: ${top.desc} $${Math.abs(top.flow).toFixed(2)}. Tap to review.`,
      actions: one ? (gasy ? [{ action: 'gas', title: 'Gas' }, { action: 'personal', title: 'Personal' }] : [{ action: 'personal', title: 'Personal' }, { action: 'review', title: 'Something else' }]) : [],
      pick: one ? { d: top.date, a: (-top.flow).toFixed(2), n: top.desc.slice(0, 30) } : null,
    }).catch(e => console.warn('push', e.message));
  }
  return total;
}

async function plaid(path, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: process.env.PLAID_CLIENT_ID, secret: process.env.PLAID_SECRET, ...body }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error_message || 'Plaid error ' + r.status);
    e.code = j.error_code || 'PLAID_ERROR';
    throw e;
  }
  return j;
}

async function getItem(uid, itemId) {
  const d = await db.collection('plaidItems').doc(uid + '_' + itemId).get();
  if (!d.exists || d.data().uid !== uid) throw Object.assign(new Error('Unknown connection.'), { http: 404 });
  return d.data();
}

const num = v => (typeof v === 'number' ? v : null);
// Balances power Net worth and the low-checking warning in the app (v42+).
const acct = a => ({
  id: a.account_id, name: a.name, official: a.official_name || '', mask: a.mask || '', type: a.type, subtype: a.subtype || '',
  current: num(a.balances && a.balances.current), available: num(a.balances && a.balances.available), limit: num(a.balances && a.balances.limit),
});

async function fetchTx(token, start, end) {
  let all = [], accounts = [], total = 0;
  do {
    const j = await plaid('/transactions/get', {
      access_token: token, start_date: start, end_date: end,
      options: { count: 500, offset: all.length },
    });
    accounts = j.accounts; total = j.total_transactions;
    if (!j.transactions.length) break;
    all = all.concat(j.transactions);
  } while (all.length < total);
  return { accounts, tx: all };
}

functions.http('payday', async (req, res) => {
  // Cloud Scheduler calls this every few hours with ?cron=<CRON_SECRET> (SETUP-PLAID.txt, part D).
  const cron = req.query.cron || req.get('x-payday-cron');
  if (cron !== undefined){
    if (!CRON_SECRET || cron !== CRON_SECRET){ warn('bad_cron_secret', req); return res.status(403).send('no'); }
    try { const n = await autoPullAll(); return res.json({ ok: true, added: n }); }
    catch (e) { console.error('auto pull', e); return res.status(500).json({ error: e.message }); }
  }
  const origin = req.get('origin') || '';
  if (!ORIGIN || origin !== ORIGIN){ warn('bad_origin', req); return res.status(403).json({ error: 'Not allowed.' }); }
  if (limited('ip:' + (req.ip || ''), 120)){ warn('rate_limited_ip', req); return res.status(429).json({ error: 'Too many requests. Wait a minute.' }); }
  res.set({
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  });
  if (req.method === 'OPTIONS') return res.status(204).send('');
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only.' });

  try {
    const m = /^Bearer (.+)$/.exec(req.get('Authorization') || '');
    if (!m){ warn('no_token', req); return res.status(401).json({ error: 'Sign in with Google first.' }); }
    const user = await admin.auth().verifyIdToken(m[1]).catch(() => null);
    if (!user){ warn('bad_token', req); return res.status(401).json({ error: 'Your sign-in expired. Reopen the app and try again.' }); }
    if (!EMAIL || !user.email_verified || String(user.email).toLowerCase() !== EMAIL) {
      warn('not_owner', req, { email: user.email || '' });
      return res.status(403).json({ error: 'This server only answers its owner.' });
    }
    const uid = user.uid;
    if (limited('uid:' + uid, 40)){ warn('rate_limited_user', req); return res.status(429).json({ error: 'Too many requests. Wait a minute.' }); }
    const { action, ...p } = req.body || {};

    if (action === 'vapid') return res.json({ key: (await vapid()).publicKey });
    if (action === 'subscribe') {
      const sub = p.sub || {};
      if (!sub.endpoint || !/^https:\/\//.test(sub.endpoint)) return res.status(400).json({ error: 'Bad subscription.' });
      await db.collection('pushSubs').doc(subId(sub.endpoint)).set({ uid, sub, device: String(p.device || '').slice(0, 40), at: Date.now() });
      return res.json({ ok: true });
    }
    if (action === 'unsubscribe') { await db.collection('pushSubs').doc(subId(p.endpoint)).delete().catch(() => {}); return res.json({ ok: true }); }
    if (action === 'push_test') { const n = await pushTo(uid, { title: 'Payday alerts work', body: 'You’ll get one like this when new charges come in.', tag: 'payday-test', url: './' }); return res.json({ sent: n }); }

    if (action === 'link_token') {
      const body = { user: { client_user_id: uid }, client_name: 'Payday', country_codes: ['US'], language: 'en' };
      if (p.redirect && String(p.redirect).startsWith(ORIGIN)) body.redirect_uri = p.redirect;
      if (p.itemId) body.access_token = (await getItem(uid, p.itemId)).accessToken; // re-login mode
      else { body.products = ['transactions']; body.transactions = { days_requested: 90 }; }
      const j = await plaid('/link/token/create', body);
      return res.json({ link_token: j.link_token });
    }

    if (action === 'exchange') {
      const ex = await plaid('/item/public_token/exchange', { public_token: String(p.public_token || '') });
      let name = 'Bank';
      try {
        const it = await plaid('/item/get', { access_token: ex.access_token });
        const inst = await plaid('/institutions/get_by_id', { institution_id: it.item.institution_id, country_codes: ['US'] });
        name = inst.institution.name;
      } catch (_) {}
      await db.collection('plaidItems').doc(uid + '_' + ex.item_id).set({
        uid, itemId: ex.item_id, accessToken: ex.access_token, institution: name, createdAt: Date.now(),
      });
      return res.json({ itemId: ex.item_id, institution: name });
    }

    if (action === 'items') {
      const snap = await db.collection('plaidItems').where('uid', '==', uid).get();
      const items = await Promise.all(snap.docs.map(async d => {
        const it = d.data();
        try {
          const a = await plaid('/accounts/get', { access_token: it.accessToken });
          return { itemId: it.itemId, institution: it.institution, accounts: a.accounts.map(acct), error: null };
        } catch (e) {
          return { itemId: it.itemId, institution: it.institution, accounts: [], error: { code: e.code, message: e.message } };
        }
      }));
      return res.json({ items });
    }

    if (action === 'sync') {
      if (!DATE.test(p.start || '') || !DATE.test(p.end || '')) return res.status(400).json({ error: 'Bad dates.' });
      const snap = await db.collection('plaidItems').where('uid', '==', uid).get();
      const items = await Promise.all(snap.docs.map(async d => {
        const it = d.data();
        try {
          const { accounts, tx } = await fetchTx(it.accessToken, p.start, p.end);
          return {
            itemId: it.itemId, institution: it.institution, accounts: accounts.map(acct), error: null,
            transactions: tx.map(t => ({
              id: t.transaction_id, accountId: t.account_id, date: t.date, name: t.name || '',
              merchant: t.merchant_name || '', amount: t.amount, pending: !!t.pending,
            })),
          };
        } catch (e) {
          return { itemId: it.itemId, institution: it.institution, accounts: [], transactions: [], error: { code: e.code, message: e.message } };
        }
      }));
      return res.json({ items });
    }

    if (action === 'remove') {
      const it = await getItem(uid, String(p.itemId || ''));
      try { await plaid('/item/remove', { access_token: it.accessToken }); } catch (_) {}
      await db.collection('plaidItems').doc(uid + '_' + it.itemId).delete();
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: 'Unknown request.' });
  } catch (e) {
    return res.status(e.http || 500).json({ error: e.message || 'Server error.' });
  }
});
