/* ---------- LifeBud link (v46) ----------
   A small numbers-only summary other apps can read: paycheck buckets, goals, Review count, subscriptions,
   spending limits, bills and your live account balances (from Accounts). No store names. */
const LB = {timer: null, last: "", day: "", balAt: 0};
function lbNextDue(last, freq){
  const t = todayIso(); let d = toD(last);
  const step = () => {
    if (freq === "Monthly") d.setMonth(d.getMonth() + 1);
    else if (freq === "Every 2 weeks") d.setDate(d.getDate() + 14);
    else if (freq === "Weekly") d.setDate(d.getDate() + 7);
    else if (freq === "Every 3 months") d.setMonth(d.getMonth() + 3);
    else d.setFullYear(d.getFullYear() + 1);
  };
  for (let i = 0; i < 400; i++){ step(); if (iso(d) >= t) break; }
  return iso(d);
}
function lbAccounts(){
  const b = (typeof plan === "function" && plan().balances) || {};
  const nm = x => typeof x === "string" ? x : ((x && x.name) || "");
  return Object.values(b).filter(a => a && typeof a.cur === "number").map(a => ({inst: nm(a.inst), name: a.name || "", mask: a.mask || "", type: a.type || "", subtype: a.subtype || "", current: a.cur,
    available: typeof a.avail === "number" ? a.avail : null, limit: typeof a.limit === "number" ? a.limit : null}));
}
function lbSummary(){
  const list = periodList(); if (!list.length) return null;
  const p = list[list.length - 1], c = calc(p), end = periodEnd(p), today = todayIso();
  const led = savingsLedger(p), gs = goalProgress();
  const ms = S.settings.goalMilestones || {}, cutoff = addDays(today, -7), recent = [];
  gs.forEach(g => [25, 50, 75, 100].forEach(m => { const d = (ms[g.id] || {})[m]; if (d && d >= cutoff) recent.push({name: g.name, pct: m, date: d}); }));
  const subs = findSubscriptions().map(s => ({name: s.name, price: s.price, freq: s.freq, next: lbNextDue(s.last, s.freq), yearly: s.perYear}));
  const upcoming = subs.filter(s => s.next <= addDays(today, 30)).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 12);
  const changes = []; subs.forEach(s => { const pc = priceChange(s.name); if (pc && pc.date >= addDays(today, -60)) changes.push({name: s.name, from: pc.from, to: pc.to, date: pc.date}); });
  const daily = {}, from = addDays(today, -35);
  list.forEach(per => (S.periods[per].txns || []).forEach(t => { if ((t.fund === "personal" || t.fund === "gas" || t.fund === "debt") && +t.amount > 0 && t.date >= from && t.date <= today) daily[t.date] = r2((daily[t.date] || 0) + (+t.amount)); }));
  const cats = {}; (S.periods[p].txns || []).forEach(t => { if (t.fund === "personal" && +t.amount > 0){ const k = category(t); cats[k] = r2((cats[k] || 0) + (+t.amount)); } });
  const topCats = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, amount]) => ({name, amount}));
  const pend = pending();
  let budgets = [], bills = [];
  try{ budgets = limitRows(p).map(b => { const left = r2(b.limit - b.spent), r = b.limit ? b.spent / b.limit : 0; return {name: b.name, limit: b.limit, spent: b.spent, left, level: r > 1 ? "over" : r >= 0.8 ? "warn" : "ok"}; }); }catch(e){}
  try{ bills = plan().bills.map(b => ({b, next: nextBillDue(b)})).filter(x => x.next).sort((a, b) => a.next.localeCompare(b.next)).slice(0, 15)
    .map(({b, next}) => ({name: b.name, amount: +b.amount || 0, next, status: next < today ? "overdue" : "due", lastPaid: ((b.paid || []).slice().sort().pop()) || null})); }catch(e){}
  return {
    v: 1, app: "payday", version: APP_VERSION, url: location.origin + location.pathname,
    period: {start: p, end, nextPayday: addDays(end, 1), pay: c.pay, extra: c.extra},
    personal: {budget: c.personalBudget, spent: c.personalSpent, left: c.personalLeft, carry: c.carry, owedIn: c.owedIn, rolledIn: c.rolledIn},
    gas: {budget: c.gasBudget, spent: c.gasSpent, left: c.gasLeft},
    debt: {budget: c.debtBudget, spent: c.debtSpent, left: r2(c.debtBudget - c.debtSpent)},
    savings: {owed: c.savings, moved: c.savingsMoved, toMove: led ? led.left : r2(c.savings - c.savingsMoved), pool: savingsPool()},
    review: {pending: pend.length, oldest: pend.length ? pend.map(i => i.date).filter(Boolean).sort()[0] || null : null},
    goals: gs.map(g => ({name: g.name, target: g.target, saved: g.saved, eta: g.eta ? iso(g.eta).slice(0, 7) : null})),
    milestones: recent,
    subs: {upcoming, changes, count: subs.length, yearly: r2(subs.reduce((a, s) => a + s.yearly, 0))},
    budgets, bills, topCats, daily, dailyFrom: from > list[0] ? from : list[0],
    accounts: lbAccounts()
  };
}
async function lbPublish(force){
  if (typeof DEMO !== "undefined" && DEMO) return;
  if (!store.cloud || !FB.db || !S.ready) return;
  if (plaidUrl() && FB.user && typeof plaidCall === "function" && (force || Date.now() - LB.balAt > 30 * 60 * 1000)){
    LB.balAt = Date.now();
    try{ const j = await plaidCall("items"); if (j && Array.isArray(j.items)){ PL.items = j.items; cacheBalances(); } }catch(e){ /* balances are optional */ }
  }
  let s; try{ s = lbSummary(); }catch(e){ return; }
  if (!s) return;
  const json = JSON.stringify(s), day = todayIso();
  if (!force && json === LB.last && LB.day === day) return;
  try{
    await FB.db.collection("users").doc(store.cloud.uid).collection("summary").doc("lifebud").set({json, at: Date.now(), v: 1});
    LB.last = json; LB.day = day;
  }catch(e){ /* quiet: the summary is optional */ }
}
function lbSchedule(){ if (!store.cloud) return; clearTimeout(LB.timer); LB.timer = setTimeout(() => lbPublish(false), 4000); }
function lbCode(){
  const cfg = fbConfig(), u = FB.auth && FB.auth.currentUser;
  if (!cfg || !u || !u.refreshToken) return "";
  return "LBPD1." + btoa(JSON.stringify({k: cfg.apiKey, p: cfg.projectId, u: u.uid, r: u.refreshToken}));
}
function lbGoFromUrl(){
  const m = /^#go=(\w+)/.exec(location.hash); if (!m) return;
  const map = {home: "home", review: "review", accounts: "accounts", subs: "plan", trends: "trends", settings: "settings", bills: "plan", budgets: "plan", plan: "plan"}, view = map[m[1]];
  history.replaceState(null, "", location.pathname);
  if (!view) return;
  let tries = 0; const t = setInterval(() => { if (S.ready || ++tries > 40){ clearInterval(t); if (S.ready) go(view); } }, 250);
}
