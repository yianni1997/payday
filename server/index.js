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

const acct = a => ({ id: a.account_id, name: a.name, official: a.official_name || '', mask: a.mask || '', type: a.type, subtype: a.subtype || '' });

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
  const origin = req.get('origin') || '';
  if (!ORIGIN || origin !== ORIGIN) return res.status(403).json({ error: 'Not allowed.' });
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
    if (!m) return res.status(401).json({ error: 'Sign in with Google first.' });
    const user = await admin.auth().verifyIdToken(m[1]).catch(() => null);
    if (!user) return res.status(401).json({ error: 'Your sign-in expired. Reopen the app and try again.' });
    if (!EMAIL || !user.email_verified || String(user.email).toLowerCase() !== EMAIL) {
      return res.status(403).json({ error: 'This server only answers its owner.' });
    }
    const uid = user.uid;
    const { action, ...p } = req.body || {};

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
