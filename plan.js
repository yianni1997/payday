"use strict";
// Plan, safe to spend, smart search, privacy and v43 features. Loads after app.js; the start-up code is at the bottom.
/* ======================================================================
   v42: Plan (bills, yearly costs, limits, debts, net worth, IOUs, watch list,
   gas log, what-if), safe to spend, smart search, privacy and lock.
   Everything here is stored in one synced doc called "plan".
   ====================================================================== */
const PLAN_DEF = {bills: [], sinks: [], debts: [], assets: [], ious: [], watch: [], gas: [], limits: {}, nw: [], balances: {}, opts: {}};
function plan(){
  if (!S.plan) S.plan = clone(PLAN_DEF);
  for (const k of Object.keys(PLAN_DEF)) if (S.plan[k] === undefined || S.plan[k] === null) S.plan[k] = clone(PLAN_DEF[k]);
  return S.plan;
}
function savePlan(){ return store.save("plan", plan()); }

/* ---------- dates ---------- */
function addMonthsIso(s, n){
  const d = toD(s), day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + n);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate())); return iso(d);
}
const FREQ = {monthly: "Every month", biweekly: "Every 2 weeks", weekly: "Every week", quarterly: "Every 3 months", halfyear: "Every 6 months", yearly: "Every year", once: "Once"};
// The i-th due date, always counted from the first one so a bill on the 31st stays on the last day of short months.
function nthDate(b, i){
  const a = b.due, f = b.freq || "monthly";
  if (f === "once") return i === 0 ? a : null;
  if (f === "weekly") return addDays(a, 7 * i);
  if (f === "biweekly") return addDays(a, 14 * i);
  return addMonthsIso(a, i * ({quarterly: 3, halfyear: 6, yearly: 12}[f] || 1));
}
function billDates(b, from, to){
  const out = []; if (!b || !b.due) return out;
  for (let i = 0; i < 800; i++){ const d = nthDate(b, i); if (!d || d > to) break; if (d >= from) out.push(d); }
  return out;
}
function nextPayday(){ const l = periodList(); return l.length ? addDays(l[l.length - 1], 14) : null; }
const daysBetween = (a, b) => Math.round((toD(b) - toD(a)) / 864e5);
const dueWords = d => { const n = daysBetween(todayIso(), d); return n < 0 ? `${-n} day${n === -1 ? "" : "s"} late` : n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`; };

/* ---------- bills ---------- */
function billWords(b){ return String(b.match || (b.name || "").split(/\s+/)[0] || "").toLowerCase().split(",").map(w => w.trim()).filter(w => w.length >= 2); }
// Paid if you marked it, or a charge with the bill's words shows up around the due date.
function billPaid(b, d){
  if ((b.paid || []).includes(d)) return true;
  const words = billWords(b); if (!words.length) return false;
  const lo = addDays(d, -7), hi = addDays(d, 4), amt = +b.amount || 0;
  const near = v => !amt || Math.abs(Math.abs(v) - amt) <= Math.max(2, amt * 0.25);
  const hit = (txt, v) => words.some(w => txt.toLowerCase().includes(w)) && near(v);
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])) if (t.date >= lo && t.date <= hi && hit((t.desc || "") + " " + (t.orig || ""), +t.amount)) return true;
  for (const i of S.inbox.items) if (i.status === "pending" && i.flow < 0 && i.date >= lo && i.date <= hi && hit((i.desc || "") + " " + (i.orig || ""), i.flow)) return true;
  return false;
}
function upcomingBills(to, from){
  const out = [];
  for (const b of plan().bills) for (const d of billDates(b, from || addDays(todayIso(), -5), to)) out.push({b, d, paid: billPaid(b, d)});
  return out.sort((x, y) => x.d.localeCompare(y.d));
}
function nextBillDue(b){ const t = addDays(todayIso(), -5); for (let i = 0; i < 800; i++){ const d = nthDate(b, i); if (!d) return null; if (d >= t && !billPaid(b, d)) return d; if (d > addDays(todayIso(), 800)) return null; } return null; }

/* ---------- yearly costs (save a bit each paycheck) ---------- */
// Paychecks left to save in: this one, plus every payday up to the due date.
function paychecksUntil(due){ const pay = nextPayday() || todayIso(); return due < pay ? 1 : 2 + Math.floor(daysBetween(pay, due) / 14); }
function sinkShare(s, p){
  if (p && s.setFor === p) return 0;
  const need = Math.max(0, (+s.amount || 0) - (+s.saved || 0));
  return r2(need / paychecksUntil(s.due || todayIso()));
}
function sinksDue(p){ return plan().opts.sinksFromPersonal === false ? 0 : r2(plan().sinks.reduce((a, s) => a + sinkShare(s, p), 0)); }

/* ---------- safe to spend ---------- */
function safeInfo(){
  const l = periodList(); if (!l.length) return null;
  const p = l[l.length - 1], c = calc(p), t = todayIso(), end = periodEnd(p), pay = nextPayday();
  const ended = t > end;
  const daysLeft = ended ? 0 : daysBetween(t, end) + 1;
  const bills = upcomingBills(end).filter(x => !x.paid && (x.b.fund || "personal") === "personal");
  const billsDue = r2(bills.reduce((a, x) => a + (+x.b.amount || 0), 0));
  const sd = sinksDue(p);
  const safe = r2(c.personalLeft - billsDue - sd);
  const total = daysBetween(p, end) + 1, elapsed = Math.min(total, Math.max(1, daysBetween(p, t) + 1));
  const avail = r2(c.personalBudget + c.rolledIn - c.owedIn);
  const expected = r2(avail * elapsed / total), diff = r2(expected - c.personalSpent);
  return {p, c, end, pay, ended, daysLeft, bills, billsDue, sinksDue: sd, safe, perDay: daysLeft ? r2(safe / daysLeft) : safe, avail, expected, diff, elapsed, total};
}
function noSpendInfo(){
  const l = periodList(); if (!l.length) return null;
  const days = new Set();
  for (const p of l) for (const t of (S.periods[p].txns || [])) if (t.fund === "personal" && +t.amount > 0) days.add(t.date);
  for (const i of S.inbox.items) if (i.status === "pending" && i.flow < 0) days.add(i.date);
  let d = todayIso(), streak = 0;
  while (!days.has(d) && streak < 400 && d >= l[0]){ streak++; d = addDays(d, -1); }
  const p = l[l.length - 1], last = minIso(todayIso(), periodEnd(p)); let inPay = 0;
  for (let x = p; x <= last; x = addDays(x, 1)) if (!days.has(x)) inPay++;
  return {streak, inPay};
}
// Category with the biggest change compared to the same point in the last paycheck.
function biggestChange(){
  const l = periodList(); if (l.length < 2) return null;
  const p = l[l.length - 1], q = l[l.length - 2], el = daysBetween(p, minIso(todayIso(), periodEnd(p)));
  const tot = (per, upto) => { const m = {}; (S.periods[per].txns || []).filter(t => t.fund === "personal" && t.date <= upto && !t.oneoff).forEach(t => { const k = category(t); m[k] = (m[k] || 0) + (+t.amount || 0); }); return m; };
  const a = tot(p, todayIso()), b = tot(q, addDays(q, el)); let best = null;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])){ const d = r2((a[k] || 0) - (b[k] || 0)); if (!best || Math.abs(d) > Math.abs(best.d)) best = {k, d}; }
  return best && Math.abs(best.d) >= 5 ? best : null;
}
function roundUps(p){ return r2((S.periods[p].txns || []).filter(t => t.fund === "personal" && +t.amount > 0).reduce((a, t) => { const v = +t.amount; return a + (Math.ceil(v - 1e-9) - v); }, 0)); }

/* ---------- spending limits ---------- */
function limitRows(p){
  const L = plan().limits || {}, tot = {};
  (S.periods[p].txns || []).filter(t => t.fund === "personal").forEach(t => { const k = rawCategory(t); tot[k] = (tot[k] || 0) + (+t.amount || 0); });
  return Object.entries(L).filter(([, v]) => +v > 0).map(([k, v]) => ({k, name: catName(k), limit: +v, spent: Math.max(0, r2(tot[k] || 0))})).sort((a, b) => b.spent / b.limit - a.spent / a.limit);
}

/* ---------- debts ---------- */
function debtSim(debts, monthly, strategy){
  const ds = debts.map(d => ({name: d.id || d.name, bal: +d.balance || 0, apr: (+d.apr || 0) / 100, min: +d.min || 0})).filter(d => d.bal > 0.005);
  const sorter = strategy === "snowball" ? (a, b) => a.bal - b.bal : (a, b) => b.apr - a.apr || a.bal - b.bal;
  let m = 0, interest = 0; const done = {};
  while (ds.some(d => d.bal > 0.005) && m < 600){
    m++;
    for (const d of ds) if (d.bal > 0.005){ const i = d.bal * d.apr / 12; d.bal += i; interest += i; }
    let budget = Math.max(0, monthly);
    for (const d of ds) if (d.bal > 0.005){ const pay = Math.min(d.bal, d.min); d.bal -= pay; budget -= pay; }
    for (const d of ds.filter(x => x.bal > 0.005).sort(sorter)){ if (budget <= 0) break; const pay = Math.min(d.bal, budget); d.bal -= pay; budget -= pay; }
    for (const d of ds) if (d.bal <= 0.005 && !done[d.name]) done[d.name] = m;
  }
  return {months: m, interest: r2(interest), done, stuck: ds.some(d => d.bal > 0.005)};
}
function debtMonthly(){
  const o = plan().opts, mins = r2(plan().debts.reduce((a, d) => a + (+d.min || 0), 0));
  if (+o.debtMonthly > 0) return +o.debtMonthly;
  const l = periodList(), pay = l.length ? +S.periods[l[l.length - 1]].amount || 0 : 0;
  return Math.max(mins, r2(pay * S.settings.debtPct * 26 / 12));
}
const monthsOut = n => { const d = toD(todayIso()); d.setDate(1); d.setMonth(d.getMonth() + n); return d.toLocaleDateString("en-US", {month: "short", year: "numeric"}); };

/* ---------- net worth ---------- */
function cacheBalances(){
  if (!Array.isArray(PL.items)) return;
  const b = {...plan().balances}; let changed = false;
  for (const it of PL.items) for (const a of (it.accounts || [])) {
    if (typeof a.current !== "number" && typeof a.available !== "number") continue;
    const v = {name: a.name, mask: a.mask || "", inst: it.institution, type: a.type, subtype: a.subtype || "", cur: a.current, avail: a.available, limit: a.limit, at: todayIso()};
    if (JSON.stringify(b[a.id]) !== JSON.stringify(v)){ b[a.id] = v; changed = true; }
  }
  if (changed){ plan().balances = b; savePlan(); }
}
const isOwed = a => a.type === "credit" || a.type === "loan";
function netWorth(){
  const P = plan(), rows = [];
  for (const [id, a] of Object.entries(P.balances || {})){ if (typeof a.cur !== "number") continue; rows.push({name: a.name + (a.mask ? " ••" + a.mask : ""), v: isOwed(a) ? -a.cur : a.cur, from: "bank", id}); }
  for (const a of P.assets) rows.push({name: a.name, v: a.kind === "owe" ? -(+a.value || 0) : +a.value || 0, from: "manual", id: a.id});
  for (const d of P.debts) if (d.inNW !== false) rows.push({name: d.name, v: -(+d.balance || 0), from: "debt", id: d.id});
  return {rows, total: r2(rows.reduce((a, r) => a + r.v, 0)), have: r2(rows.filter(r => r.v > 0).reduce((a, r) => a + r.v, 0)), owe: r2(-rows.filter(r => r.v < 0).reduce((a, r) => a + r.v, 0))};
}
function recordNW(){
  const N = netWorth(), P = plan(); if (!N.rows.length) return;
  const last = P.nw[P.nw.length - 1], t = todayIso();
  if (last && last.d === t){ if (last.v !== N.total){ last.v = N.total; savePlan(); } return; }
  if (last && last.v === N.total && daysBetween(last.d, t) < 7) return;
  P.nw.push({d: t, v: N.total}); if (P.nw.length > 500) P.nw = P.nw.slice(-500); savePlan();
}
function checkingInfo(){
  const accts = Object.values(plan().balances || {}).filter(a => a.type === "depository" && /checking/i.test(a.subtype + " " + a.name));
  if (!accts.length) return null;
  const bal = r2(accts.reduce((s, a) => s + (typeof a.avail === "number" ? a.avail : a.cur || 0), 0));
  const pay = nextPayday() || todayIso();
  const bills = upcomingBills(addDays(pay, -1), todayIso()).filter(x => !x.paid);
  const due = r2(bills.reduce((s, x) => s + (+x.b.amount || 0), 0));
  const lc = plan().opts.lowCheck, floor = lc === "" || lc === undefined || lc === null ? 100 : +lc;
  return {bal, due, after: r2(bal - due), floor, low: bal - due < floor, at: accts.map(a => a.at).sort().pop(), bills};
}

/* ---------- IOUs and the watch list ---------- */
// Money coming in with the same amount, on or after the date you added it.
// who: for IOUs, only count transfers (Venmo, Zelle...) or money with the person's name, not store refunds.
function moneyInMatches(amount, since, who){
  const out = [], amt = Math.abs(+amount || 0); if (!amt) return out;
  const ok = v => Math.abs(Math.abs(v) - amt) < 0.015;
  const first = String(who || "").trim().split(/\s+/)[0].toLowerCase();
  const fits = d => !who || /venmo|zelle|cash ?app|paypal|transfer|apple cash/i.test(d || "") || (first.length > 1 && String(d || "").toLowerCase().includes(first));
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])) if (t.date >= since && ((t.fund === "income" && ok(t.amount)) || (+t.amount < 0 && ok(t.amount))) && fits((t.desc || "") + " " + (t.orig || ""))) out.push({date: t.date, desc: t.desc});
  for (const i of S.inbox.items) if (i.status === "pending" && i.flow > 0 && i.date >= since && ok(i.flow) && fits((i.desc || "") + " " + (i.orig || ""))) out.push({date: i.date, desc: i.desc, review: true});
  return out;
}
function watchArrived(w){ return (w.kind === "refund" || w.dir === "me") ? moneyInMatches(w.amount, w.made || w.date || "0000")[0] || null : null; }
const WATCH_KIND = {refund: ["Refund I’m waiting for", "Expect by"], trial: ["Free trial ending", "Trial ends"], "return": ["Return window closing", "Return by"]};

/* ---------- gas log ---------- */
function gasStats(){
  const g = plan().gas.slice().sort((a, b) => a.date.localeCompare(b.date));
  let miles = 0, gal = 0, cost = 0;
  for (let i = 1; i < g.length; i++){ const a = +g[i - 1].odo, b = +g[i].odo; if (a > 0 && b > a){ miles += b - a; gal += +g[i].gallons || 0; cost += +g[i].total || 0; } }
  const allGal = g.reduce((s, x) => s + (+x.gallons || 0), 0), allCost = g.reduce((s, x) => s + (+x.total || 0), 0);
  const l = periodList(), done = l.slice(0, -1).slice(-6);
  const avgGas = done.length ? r2(done.reduce((s, p) => s + calc(p).gasSpent, 0) / done.length) : null;
  return {n: g.length, mpg: gal ? Math.round(miles / gal * 10) / 10 : null, ppg: allGal ? Math.round(allCost / allGal * 1000) / 1000 : null, cpm: miles ? Math.round(cost / miles * 1000) / 1000 : null, miles, avgGas, nAvg: done.length};
}

/* ---------- what-if ---------- */
function whatIf(over, n){
  const real = S.settings, l = periodList().slice(-n);
  const base = l.map(p => calc(p)); let alt;
  S.settings = {...real, ...over};
  try{ alt = l.map(p => calc(p)); } finally { S.settings = real; }
  return l.map((p, i) => ({p, a: base[i], b: alt[i]}));
}

/* ---------- calendar file ---------- */
function icsText(){
  const P = plan(), stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const money = n => "$" + (+n || 0).toFixed(2); // the real amount, even with Hide amounts on
  const d8 = s => s.replace(/-/g, ""), escI = s => String(s).replace(/([,;\\])/g, "\\$1").replace(/\n/g, "\\n");
  const RR = {monthly: "FREQ=MONTHLY", weekly: "FREQ=WEEKLY", biweekly: "FREQ=WEEKLY;INTERVAL=2", quarterly: "FREQ=MONTHLY;INTERVAL=3", halfyear: "FREQ=MONTHLY;INTERVAL=6", yearly: "FREQ=YEARLY"};
  const ev = (id, date, title, rr, note) => ["BEGIN:VEVENT", "UID:" + id + "@payday", "DTSTAMP:" + stamp, "DTSTART;VALUE=DATE:" + d8(date), "DTEND;VALUE=DATE:" + d8(addDays(date, 1)), "SUMMARY:" + escI(title), rr ? "RRULE:" + rr : "", note ? "DESCRIPTION:" + escI(note) : "", "BEGIN:VALARM", "ACTION:DISPLAY", "DESCRIPTION:" + escI(title), "TRIGGER:-PT15H", "END:VALARM", "END:VEVENT"].filter(Boolean);
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Payday//EN", "CALSCALE:GREGORIAN", "X-WR-CALNAME:Payday"];
  const pay = nextPayday(); if (pay) out.push(...ev("payday", pay, "Payday", "FREQ=WEEKLY;INTERVAL=2", "Start the new paycheck in Payday."));
  for (const b of P.bills) if (b.due) out.push(...ev("bill-" + b.id, b.due, `${b.name} ${money(b.amount)}`, RR[b.freq || "monthly"] || "", "Bill from Payday"));
  for (const s of P.sinks) if (s.due) out.push(...ev("sink-" + s.id, s.due, `${s.name} ${money(s.amount)} due`, s.freq && s.freq !== "once" ? RR[s.freq] : "", "Yearly cost from Payday"));
  for (const w of P.watch) if (!w.done && w.date) out.push(...ev("watch-" + w.id, w.date, `${WATCH_KIND[w.kind] ? WATCH_KIND[w.kind][1] : "Reminder"}: ${w.name}`, "", w.note || ""));
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}

/* ---------- smart search: "doordash over $20 since august" ---------- */
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIdx = s => ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"].indexOf(s.slice(0, 3));
const QSTOP = new Set(["spent","spend","spending","on","at","in","for","the","charges","charge","how","much","did","i","my","all","show","me","what","was","were","from","to","and","a","an","of","with"]);
function parseQuery(raw){
  const F = {}, notes = []; let s = " " + String(raw || "").toLowerCase() + " ";
  const t = todayIso(), y = +t.slice(0, 4), mo = +t.slice(5, 7);
  const take = (re, fn) => { s = s.replace(re, (...m) => { fn(m); return " "; }); };
  const monthRange = (m, yr) => { const from = `${yr}-${pad(m + 1)}-01`; return [from, iso(new Date(yr, m + 1, 0))]; };
  const latestYear = (m, day) => { const d = `${y}-${pad(m + 1)}-${pad(day || 1)}`; return d > t ? y - 1 : y; };
  take(/\b(?:amount|amt):\s*(<=?|>=?|=)?\s*\$?(\d+(?:\.\d+)?)/g, m => { const v = +m[2], op = m[1] || "="; if (op[0] === ">") F.min = v; else if (op[0] === "<") F.max = v; else { F.min = v; F.max = v; } notes.push(op[0] === ">" ? `$${v} or more` : op[0] === "<" ? `$${v} or less` : `exactly $${v}`); });
  take(/(?:\b(?:over|above|more than|at least)\s+|>=?\s*)\$?(\d+(?:\.\d+)?)/g, m => { F.min = +m[1]; notes.push(`$${m[1]} or more`); });
  take(/(?:\b(?:under|below|less than|at most)\s+|<=?\s*)\$?(\d+(?:\.\d+)?)/g, m => { F.max = +m[1]; notes.push(`$${m[1]} or less`); });
  take(/\b(?:cat|category):("[^"]+"|[^\s]+)/g, m => { F.cat = m[1].replace(/"/g, ""); notes.push(`category ${F.cat}`); });
  take(/\bfund:([a-z]+)/g, m => { const f = {personal:"personal", gas:"gas", debt:"debt", income:"income", extra:"income", savings:"savings", skip:"skip"}[m[1]]; if (f){ F.fund = f; notes.push(`${FUNDS[f].label} fund`); } });
  take(/(?:\btag:|(?:^|\s)#)([\w-]+)/g, m => { F.tag = m[1]; notes.push(`#${m[1]}`); });
  take(/\b(?:acct|account|src):([a-z_]+)/g, m => { const k = Object.keys(SOURCES).find(k => k.includes(m[1]) || SOURCES[k].toLowerCase().includes(m[1])); if (k){ F.src = k; notes.push(SOURCES[k]); } });
  take(/\b(?:before|until):(\d{4}-\d{2}-\d{2})/g, m => { F.to = m[1]; notes.push(`until ${short(m[1])}`); });
  take(/\b(?:after|since|from):(\d{4}-\d{2}-\d{2})/g, m => { F.from = m[1]; notes.push(`since ${short(m[1])}`); });
  take(/\btoday\b/g, () => { F.from = F.to = t; notes.push("today"); });
  take(/\byesterday\b/g, () => { F.from = F.to = addDays(t, -1); notes.push("yesterday"); });
  take(/\bthis week\b/g, () => { const d = toD(t); F.from = addDays(t, -d.getDay()); F.to = t; notes.push("this week"); });
  take(/\blast week\b/g, () => { const d = toD(t), s0 = addDays(t, -d.getDay()); F.from = addDays(s0, -7); F.to = addDays(s0, -1); notes.push("last week"); });
  take(/\bthis month\b/g, () => { [F.from, F.to] = monthRange(mo - 1, y); notes.push("this month"); });
  take(/\blast month\b/g, () => { const m = mo === 1 ? 11 : mo - 2, yr = mo === 1 ? y - 1 : y; [F.from, F.to] = monthRange(m, yr); notes.push("last month"); });
  take(/\bthis year\b/g, () => { F.from = `${y}-01-01`; F.to = `${y}-12-31`; notes.push(String(y)); });
  take(/\blast year\b/g, () => { F.from = `${y - 1}-01-01`; F.to = `${y - 1}-12-31`; notes.push(String(y - 1)); });
  take(/\b(?:last|past)\s+(\d+)\s+days?\b/g, m => { F.from = addDays(t, -(+m[1] - 1)); F.to = t; notes.push(`last ${m[1]} days`); });
  take(/\bthis paycheck\b/g, () => { const l = periodList(); if (l.length){ const p = l[l.length - 1]; F.from = p; F.to = periodEnd(p); notes.push("this paycheck"); } });
  take(/\blast paycheck\b/g, () => { const l = periodList(); if (l.length > 1){ const p = l[l.length - 2]; F.from = p; F.to = periodEnd(p); notes.push("last paycheck"); } });
  take(new RegExp("\\b(?:since|after|from)\\s+" + MONTH_RE + "(?:\\s+(\\d{1,2}))?(?:,?\\s+(\\d{4}))?\\b", "g"), m => { const i = monthIdx(m[1]), day = +m[2] || 1, yr = +m[3] || latestYear(i, day); F.from = `${yr}-${pad(i + 1)}-${pad(day)}`; notes.push(`since ${short(F.from)}${m[3] ? " " + yr : ""}`); });
  take(new RegExp("\\b(?:before|until)\\s+" + MONTH_RE + "(?:\\s+(\\d{1,2}))?(?:,?\\s+(\\d{4}))?\\b", "g"), m => { const i = monthIdx(m[1]), day = +m[2] || 1, yr = +m[3] || latestYear(i, day); F.to = addDays(`${yr}-${pad(i + 1)}-${pad(day)}`, -1); notes.push(`before ${short(addDays(F.to, 1))}`); });
  take(new RegExp("\\b(?:in|during)\\s+" + MONTH_RE + "(?:\\s+(\\d{4}))?\\b", "g"), m => { const i = monthIdx(m[1]), yr = +m[2] || latestYear(i, 1); [F.from, F.to] = monthRange(i, yr); notes.push(monthName(`${yr}-${pad(i + 1)}`)); });
  const words = s.split(/\s+/).map(w => w.replace(/^[^\w$.&'-]+|[^\w.&'-]+$/g, "")).filter(w => w && !QSTOP.has(w));
  return {F, words, notes};
}
function passQF(r, F){
  if (F.tag && !(r.tags || []).includes(F.tag)) return false;
  if (F.from && r.date < F.from) return false;
  if (F.to && r.date > F.to) return false;
  if (F.fund && r.fund !== F.fund) return false;
  if (F.src && r.src !== F.src) return false;
  if (F.cat && String(r.cat).toLowerCase() !== String(catName(F.cat)).toLowerCase() && String(r.cat).toLowerCase() !== String(F.cat).toLowerCase()) return false;
  if (F.min && Math.abs(r.amount) < +F.min) return false;
  if (F.max && Math.abs(r.amount) > +F.max) return false;
  return true;
}
function wordsMatch(r, words, text){
  return words.every(w => text.includes(w) || String(r.cat || "").toLowerCase() === w || (/^\$?\d+(\.\d+)?$/.test(w) && String(Math.abs(r.amount).toFixed(2)).includes(w.replace("$", ""))));
}

/* ---------- home screen pieces ---------- */
function safeCard(){
  const I = safeInfo(); if (!I) return "";
  const ns = noSpendInfo(), bc = biggestChange();
  const payIn = I.pay ? daysBetween(todayIso(), I.pay) : null;
  const paceTxt = I.ended ? "This paycheck has ended." : Math.abs(I.diff) < 1 ? "Right on pace." : I.diff > 0 ? `${money(I.diff)} under pace. Nice.` : `${money(-I.diff)} over pace for day ${I.elapsed} of ${I.total}.`;
  const spentPct = I.avail > 0 ? Math.min(100, Math.max(0, (I.c.personalSpent) / I.avail * 100)) : 0, expPct = Math.min(100, I.elapsed / I.total * 100);
  const chips = [];
  if (ns && ns.streak >= 2) chips.push(`🔥 ${ns.streak} no-spend days in a row`);
  else if (ns && ns.inPay) chips.push(`${ns.inPay} no-spend day${ns.inPay === 1 ? "" : "s"} this paycheck`);
  if (bc) chips.push(`${esc(bc.k)} ${bc.d > 0 ? "+" : "−"}${money0(Math.abs(bc.d))} vs this point last paycheck`);
  return `<section class="safe" role="button" tabindex="0" data-tab="plan" aria-label="Safe to spend. Open Plan">
    <div class="row" style="justify-content:space-between;flex-wrap:nowrap"><b>Safe to spend${I.ended ? "" : " each day"}</b><span class="small muted">${payIn !== null ? (payIn <= 0 ? "Payday is here" : `Payday in ${payIn} day${payIn === 1 ? "" : "s"}, ${esc(short(I.pay))}`) : ""}</span></div>
    <div class="safe-big num ${I.safe < 0 ? "neg" : ""}">${money(I.ended ? I.safe : I.perDay)}${I.ended ? "" : "<small>/day</small>"}</div>
    <div class="small muted num">${money(I.safe)} left${I.billsDue ? ` after ${money(I.billsDue)} in bills` : ""}${I.sinksDue ? `${I.billsDue ? " and" : " after"} ${money(I.sinksDue)} for yearly costs` : ""}${I.ended ? "" : `, ${I.daysLeft} day${I.daysLeft === 1 ? "" : "s"} to go`}</div>
    ${I.ended ? "" : `<div class="pace" aria-hidden="true"><i style="width:${spentPct}%"></i><b style="left:${expPct}%"></b></div>`}
    <div class="small" style="margin-top:6px">${paceTxt}</div>
    ${chips.length ? `<div class="row" style="gap:6px;margin-top:8px">${chips.map(c => `<span class="chip">${c}</span>`).join("")}</div>` : ""}
  </section>`;
}
function limitBars(rows){
  return rows.map(r => { const over = r.spent > r.limit, pct = Math.min(100, r.spent / r.limit * 100); return `<div class="lim"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><span>${esc(r.name)}</span><span class="num small"><b ${over ? 'style="color:var(--neg)"' : ""}>${money0(r.spent)}</b> of ${money0(r.limit)}${over ? " • over" : ` • ${money0(r.limit - r.spent)} left`}</span></div><div class="bar"><i style="width:${pct}%;background:${over ? "var(--neg)" : pct > 80 ? "var(--gas)" : "var(--personal)"}"></i></div></div>`; }).join("");
}
function limitsCard(p){
  const rows = limitRows(p); if (!rows.length) return "";
  return `<div class="limits"><div class="row" style="justify-content:space-between;margin-bottom:4px"><b>Spending limits</b><button class="btn ghost sm" data-act="pl-lim-edit" style="min-height:32px;padding:4px 12px">Edit</button></div>${limitBars(rows)}</div>`;
}
function planBanners(){
  const out = [], t = todayIso();
  const soon = upcomingBills(addDays(t, 3), addDays(t, -5)).filter(x => !x.paid);
  if (soon.length) out.push(`<button class="banner" data-tab="plan"><span class="dot" style="background:var(--debt)"></span><span><b>${soon.length === 1 ? `${esc(soon[0].b.name)} ${money(soon[0].b.amount)} due ${dueWords(soon[0].d)}` : `${soon.length} bills due soon, ${money(soon.reduce((a, x) => a + (+x.b.amount || 0), 0))}`}</b><span class="small muted">${soon.length > 1 ? soon.map(x => `${esc(x.b.name)} ${dueWords(x.d)}`).join(", ") : "Tap Paid on the Plan page once it’s paid"}</span></span><span class="go">See</span></button>`);
  const W = plan().watch.filter(w => !w.done && w.date && (w.kind === "refund" ? (w.date <= t || watchArrived(w)) : daysBetween(t, w.date) <= (w.kind === "trial" ? 2 : 3)));
  for (const w of W.slice(0, 2)){
    const arr = watchArrived(w);
    out.push(`<button class="banner" data-tab="plan"><span class="dot" style="background:var(--income)"></span><span><b>${w.kind === "refund" ? (arr ? `Your ${esc(w.name)} refund came in` : `${esc(w.name)} refund is late`) : w.kind === "trial" ? `${esc(w.name)} trial ends ${dueWords(w.date)}` : `Last day to return ${esc(w.name)} is ${dueWords(w.date)}`}</b><span class="small muted">${arr ? `${esc(arr.desc)} on ${esc(short(arr.date))}. Tap to mark it done.` : w.kind === "trial" ? `Cancel before it charges${w.amount ? " " + money(w.amount) : ""}.` : w.kind === "refund" ? `Expected by ${esc(short(w.date))}${w.amount ? ", " + money(w.amount) : ""}.` : esc(w.note || "")}</span></span><span class="go">See</span></button>`);
  }
  const C = checkingInfo();
  if (C && C.low) out.push(`<button class="banner" data-tab="plan" style="border-color:var(--debt)"><span class="dot" style="background:var(--debt)"></span><span><b>Checking could get low before payday</b><span class="small muted">${money(C.bal)} in checking${C.due ? ` minus ${money(C.due)} in bills` : ""} leaves ${money(C.after)}. Balance from ${esc(short(C.at))}.</span></span><span class="go">See</span></button>`);
  for (const it of (Array.isArray(PL.items) ? PL.items : []).filter(x => x.error && x.error.code === "ITEM_LOGIN_REQUIRED")) out.push(`<button class="banner" data-act="plaid-relogin" data-id="${esc(it.itemId)}"><span class="dot" style="background:var(--gas)"></span><span><b>${esc(it.institution)} needs you to sign in again</b><span class="small muted">Until then, pulls skip it. Do this from Chrome.</span></span><span class="go">Sign in</span></button>`);
  return out;
}
let plQuiet = false;
function plaidQuietLoad(){
  if (plQuiet || !plaidUrl() || !FB.user || PL.items !== null || PL.busy) return;
  plQuiet = true;
  plaidCall("items").then(j => { if (PL.items === null){ PL.items = j.items; cacheBalances(); if (S.view === "home" && !isTyping() && !$("#sheetRoot").innerHTML) render(); } }).catch(() => {});
}

/* ---------- add/edit sheet for every Plan list ---------- */
const PSCHEMA = {
  bills: {one: "bill", fields: [["name", "Name", "text", "", "e.g. Verizon"], ["amount", "Amount", "money"], ["freq", "How often", "select", FREQ], ["due", "Next due date", "date"], ["fund", "Paid from", "select", {personal: "Personal money", debt: "Debt fund", other: "Somewhere else (not Personal)"}], ["match", "Words on the bank charge", "text", "Payday marks it paid when a charge with these words shows up. Separate with commas. Blank uses the first word of the name.", "e.g. verizon"]]},
  sinks: {one: "yearly cost", fields: [["name", "Name", "text", "", "e.g. Car registration"], ["amount", "Cost", "money"], ["due", "Next due date", "date"], ["freq", "Repeats", "select", {yearly: "Every year", halfyear: "Every 6 months", quarterly: "Every 3 months", once: "Just once"}], ["saved", "Already set aside", "money", "Leave blank if nothing yet."]]},
  debts: {one: "debt", fields: [["name", "Name", "text", "", "e.g. Chase Amazon card"], ["balance", "Balance now", "money"], ["apr", "Interest rate (APR %)", "number", "From your statement. 0 for an interest-free loan."], ["min", "Minimum payment per month", "money"], ["inNW", "Count in net worth", "check", "Turn off if a connected bank already shows this balance."]]},
  assets: {one: "item", fields: [["name", "Name", "text", "", "e.g. Car, 401(k), loan from Mom"], ["kind", "Type", "select", {asset: "Something I own", owe: "Something I owe"}], ["value", "Value", "money", "A rough number is fine. Update it now and then."]]},
  ious: {one: "IOU", fields: [["who", "Who", "text", "", "e.g. Mike"], ["dir", "Which way", "select", {me: "They owe me", them: "I owe them"}], ["amount", "Amount", "money"], ["note", "What for", "text", "", "e.g. half of dinner"], ["date", "Date", "date"]]},
  watch: {one: "reminder", fields: [["kind", "Type", "select", {refund: "Refund I’m waiting for", trial: "Free trial ending", "return": "Return window closing"}], ["name", "What", "text", "", "e.g. Amazon headphones"], ["amount", "Amount", "money", "For a refund, Payday spots it when this exact amount comes back."], ["date", "Date", "date", "Refund: when you expect it. Trial: the day it ends. Return: the last day."], ["note", "Note", "text"]]},
  gas: {one: "fill-up", fields: [["date", "Date", "date"], ["gallons", "Gallons", "number"], ["total", "Total paid", "money"], ["odo", "Odometer (miles)", "number", "Needed for miles per gallon. Fill the tank all the way each time for the best numbers."]]},
};
const PREQ = {bills: ["name", "amount", "due"], sinks: ["name", "amount", "due"], debts: ["name", "balance"], assets: ["name", "value"], ious: ["who", "amount"], watch: ["name", "date"], gas: ["date", "total"]};
function plEditSheet(kind, id){
  const sc = PSCHEMA[kind], P = plan(), cur = id ? P[kind].find(x => x.id === id) : null;
  const t = todayIso(), def = {freq: kind === "sinks" ? "yearly" : "monthly", fund: "personal", kind: "refund", dir: "me", inNW: true, date: t, due: kind === "sinks" ? addMonthsIso(t, 6) : t};
  const v = cur || def;
  // For a select, the 4th item is its options; otherwise it's the hint under the box.
  const field = ([k, label, type, hint, ph]) => {
    const val = v[k] ?? "";
    let input;
    if (type === "select") input = `<select class="input" id="pf-${k}">${Object.entries(hint).map(([o, l]) => `<option value="${esc(o)}" ${String(val) === o ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
    else if (type === "check") input = `<label class="row" style="gap:10px;flex-wrap:nowrap;cursor:pointer"><input type="checkbox" id="pf-${k}" style="width:22px;height:22px" ${val !== false ? "checked" : ""}><span class="small">${esc(hint || "")}</span></label>`;
    else input = `<input class="input ${type === "money" || type === "number" ? "num" : ""}" id="pf-${k}" ${type === "date" ? 'type="date"' : type === "money" || type === "number" ? 'inputmode="decimal"' : ""} value="${esc(val)}" placeholder="${esc(ph || (type === "money" ? "$" : ""))}" autocomplete="off">`;
    return `<label class="field"><span>${esc(label)}</span>${input}${type !== "select" && type !== "check" && hint ? `<small>${esc(hint)}</small>` : ""}</label>`;
  };
  openSheet(`<h2>${cur ? "Edit" : "Add a"} ${esc(sc.one)}</h2>${sc.fields.map(field).join("")}
    <div class="row" style="justify-content:space-between;margin-top:6px">${cur ? `<button class="btn danger" data-act="pl-del" data-kind="${kind}" data-id="${esc(cur.id)}">Delete</button>` : "<span></span>"}<span class="row"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="pl-save" data-kind="${kind}" data-id="${esc(cur ? cur.id : "")}">Save</button></span></div>`);
}
function plSave(kind, id){
  const sc = PSCHEMA[kind], P = plan(), o = {};
  for (const [k, label, type] of sc.fields){
    const el = $("#pf-" + k); if (!el) continue;
    if (type === "check") o[k] = el.checked;
    else if (type === "money"){ const s = el.value.trim(); o[k] = s === "" ? "" : r2(parseAmt(s)); if (s !== "" && isNaN(o[k])){ toast(`Use a number for ${label.toLowerCase()}.`); return false; } }
    else if (type === "number"){ const s = el.value.trim().replace(/,/g, ""); o[k] = s === "" ? "" : parseFloat(s); if (s !== "" && isNaN(o[k])){ toast(`Use a number for ${label.toLowerCase()}.`); return false; } }
    else o[k] = el.value.trim();
  }
  for (const k of PREQ[kind]) if (o[k] === "" || o[k] === undefined){ toast(`Add the ${sc.fields.find(f => f[0] === k)[1].toLowerCase()}.`); return false; }
  if (id){ const cur = P[kind].find(x => x.id === id); if (cur) Object.assign(cur, o); }
  else P[kind].push({id: uid(), made: todayIso(), ...o});
  savePlan(); return true;
}
function limitsSheet(){
  const L = plan().limits || {};
  openSheet(`<h2>Spending limits</h2><p class="muted" style="margin:-6px 0 12px">A cap per paycheck for any category inside Personal money. Leave blank for no limit.</p>
    <div class="list" style="padding:0 12px">${allCategories().map(c => `<label class="row" style="justify-content:space-between;flex-wrap:nowrap;padding:8px 0;border-top:1px solid var(--line)"><span>${esc(catName(c))}</span><input class="input num" data-lim="${esc(c)}" inputmode="decimal" placeholder="No limit" value="${L[c] ? esc(L[c]) : ""}" style="width:120px;min-height:40px"></label>`).join("")}</div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="pl-lim-save">Save</button></div>`);
}

/* ---------- Plan page ---------- */
const PLAN_VIEWS = ["plan", "debt", "networth", "gas", "whatif"];
function planTop(title, back){ return `<div class="topbar"><h1 style="display:flex;align-items:center;gap:12px">${back ? `<button class="iconbtn" data-tab="plan" aria-label="Back to Plan">${ICONS.left}</button>` : ""}${esc(title)}</h1></div>`; }
function emptyLine(txt){ return `<p class="small muted" style="margin:6px 0 0">${txt}</p>`; }
function viewPlan(){
  const P = plan(), l = periodList(), p = l[l.length - 1], t = todayIso(), I = safeInfo();
  recordNW();
  // safe to spend breakdown
  const safe = I ? `<div class="panel"><h2 style="margin-bottom:6px">Safe to spend</h2>
    <div class="safe-big num ${I.safe < 0 ? "neg" : ""}" style="margin:2px 0 8px">${money(I.ended ? I.safe : I.perDay)}${I.ended ? "" : "<small>/day</small>"}</div>
    <div class="cat" style="grid-template-columns:1fr auto"><span>Personal money left</span><span class="num">${money(I.c.personalLeft)}</span></div>
    ${I.bills.map(x => `<div class="cat" style="grid-template-columns:1fr auto"><span class="muted">− ${esc(x.b.name)}, due ${esc(short(x.d))}</span><span class="num muted">${money(x.b.amount)}</span></div>`).join("")}
    ${I.sinksDue ? `<div class="cat" style="grid-template-columns:1fr auto"><span class="muted">− Yearly costs, this paycheck’s share</span><span class="num muted">${money(I.sinksDue)}</span></div>` : ""}
    <div class="cat" style="grid-template-columns:1fr auto;border-top:1px solid var(--line);margin-top:4px;padding-top:8px"><b>Safe to spend${I.ended ? "" : `, over ${I.daysLeft} day${I.daysLeft === 1 ? "" : "s"}`}</b><b class="num">${money(I.safe)}</b></div>
    <p class="small muted" style="margin:8px 0 0">By day ${I.elapsed} of ${I.total} you’d expect to have spent ${money(I.expected)}. You’ve spent ${money(I.c.personalSpent)}.${I.pay ? ` Next payday: ${esc(longDay(I.pay))}.` : ""}</p></div>` : "";
  // bills
  const C = checkingInfo();
  const billRows = P.bills.slice().map(b => ({b, next: nextBillDue(b)})).sort((a, b) => (a.next || "9999").localeCompare(b.next || "9999")).map(({b, next}) => {
    const lastPaid = (() => { for (const d of billDates(b, addDays(t, -40), t).reverse()) if (billPaid(b, d)) return d; return null; })();
    const st = !next ? `<span class="chip">Done</span>` : daysBetween(t, next) < 0 ? `<span class="chip" style="background:var(--debt);color:#fff">${dueWords(next)}</span>` : daysBetween(t, next) <= 3 ? `<span class="chip" style="background:var(--gas);color:#161616">Due ${dueWords(next)}</span>` : `<span class="chip">Due ${esc(short(next))}</span>`;
    return `<div class="tx" style="cursor:default"><span class="mid"><button class="linkish" data-act="pl-edit" data-kind="bills" data-id="${esc(b.id)}">${esc(b.name)}<span class="pen">✎</span></button><span class="c" style="display:block">${esc(FREQ[b.freq || "monthly"])}${(b.fund || "personal") !== "personal" ? ` • ${b.fund === "debt" ? "Debt fund" : "Not from Personal"}` : ""}${lastPaid ? ` • paid ${esc(short(lastPaid))} ✓` : ""}</span><span style="display:block;margin-top:4px">${st}</span></span><span style="text-align:right"><span class="a num" style="display:block">${money(b.amount)}</span>${next ? `<button class="btn ghost sm" style="margin-top:6px" data-act="pl-bill-paid" data-id="${esc(b.id)}" data-d="${next}">Paid</button>` : ""}</span></div>`;
  }).join("");
  const pay = nextPayday(), beforePay = pay ? upcomingBills(addDays(pay, -1), t).filter(x => !x.paid) : [];
  const bills = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Bills</h2><button class="btn sm" data-act="pl-add" data-kind="bills">Add a bill</button></div>
    ${P.bills.length ? `<p class="small muted" style="margin:4px 0 10px">${beforePay.length ? `${money(beforePay.reduce((a, x) => a + (+x.b.amount || 0), 0))} still due before payday on ${esc(short(pay))}.` : "Nothing else due before payday."}</p><div class="list">${billRows}</div>` : emptyLine("Rent, phone, insurance, card autopays. Payday shows which paycheck pays each one and takes them out of Safe to spend.")}
    ${C ? `<div class="notice" style="${C.low ? "color:var(--neg)" : ""}">Checking: ${money(C.bal)} (from ${esc(short(C.at))})${C.due ? `, minus ${money(C.due)} in bills before payday = <b>${money(C.after)}</b>` : ""}. ${C.low ? "That’s under" : "Warns you under"} <label style="display:inline">$<input class="input num" data-act="pl-opt" data-k="lowCheck" inputmode="decimal" value="${esc(C.floor)}" style="width:80px;min-height:32px;padding:2px 8px;display:inline-block" aria-label="Low checking warning amount"></label></div>` : (plaidUrl() ? `<p class="small muted" style="margin:10px 0 0">Open the Accounts tab once to load your checking balance. Then Payday warns you if bills could take it too low.</p>` : "")}</div>`;
  // yearly costs
  const sinks = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Yearly costs</h2><button class="btn sm" data-act="pl-add" data-kind="sinks">Add one</button></div>
    ${P.sinks.length ? `<p class="small muted" style="margin:4px 0 10px">Big costs that don’t come every month. Set aside a share each paycheck so they’re never a surprise.</p>
    <div class="list">${P.sinks.slice().sort((a, b) => (a.due || "").localeCompare(b.due || "")).map(s => { const sh = sinkShare(s, p), saved = +s.saved || 0, pct = Math.min(100, saved / Math.max(1, +s.amount) * 100), due = s.due && s.due <= addDays(t, 7);
      return `<div class="tx" style="cursor:default;align-items:flex-start"><span class="mid"><button class="linkish" data-act="pl-edit" data-kind="sinks" data-id="${esc(s.id)}">${esc(s.name)}<span class="pen">✎</span></button><span class="c" style="display:block">${money0(saved)} of ${money0(s.amount)} set aside • due ${esc(short(s.due))}</span><span class="goal" style="display:block;padding:0;border:0"><span class="bar" style="display:block"><i style="width:${pct}%"></i></span></span>
        <span class="c" style="display:block">${s.setFor === p ? "✓ Set aside this paycheck" : sh > 0 ? `${money(sh)} this paycheck` : "Fully set aside"}</span></span>
        <span class="row" style="gap:6px;flex-direction:column;align-items:flex-end">${sh > 0 ? `<button class="btn sm" data-act="pl-sink-set" data-id="${esc(s.id)}">Set aside ${money0(Math.ceil(sh))}</button>` : ""}${due || saved >= +s.amount ? `<button class="btn ghost sm" data-act="pl-sink-paid" data-id="${esc(s.id)}">Paid it</button>` : ""}</span></div>`; }).join("")}</div>
    <label class="row" style="gap:10px;flex-wrap:nowrap;margin-top:10px;cursor:pointer"><input type="checkbox" data-act="pl-opt" data-k="sinksFromPersonal" style="width:20px;height:20px" ${P.opts.sinksFromPersonal === false ? "" : "checked"}><span class="small">Take this paycheck’s share out of Safe to spend until I tap Set aside</span></label>` : emptyLine("Car registration, Christmas, Amazon Prime, insurance paid once a year. Payday works out how much to put away each paycheck.")}</div>`;
  // limits
  const lr = p ? limitRows(p) : [];
  const limits = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Spending limits</h2><button class="btn sm" data-act="pl-lim-edit">${lr.length ? "Edit" : "Set limits"}</button></div>
    ${lr.length ? `<div style="margin-top:8px">${limitBars(lr)}</div>` : emptyLine("Give a category a cap per paycheck, like Dining $80. Bars show on the Paycheck screen.")}</div>`;
  // watch list
  const W = P.watch.filter(w => !w.done).sort((a, b) => (a.date || "").localeCompare(b.date || ""));
  const doneW = P.watch.filter(w => w.done).length;
  const watch = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Refunds, trials and returns</h2><button class="btn sm" data-act="pl-add" data-kind="watch">Add</button></div>
    ${W.length ? `<div class="list" style="margin-top:10px">${W.map(w => { const arr = watchArrived(w), late = w.date && w.date < t;
      return `<div class="tx" style="cursor:default;align-items:flex-start"><span class="mid"><button class="linkish" data-act="pl-edit" data-kind="watch" data-id="${esc(w.id)}">${esc(w.name)}<span class="pen">✎</span></button><span class="c" style="display:block">${esc((WATCH_KIND[w.kind] || ["Reminder", "Date"])[1])} ${esc(short(w.date))} (${dueWords(w.date)})${w.note ? " • " + esc(w.note) : ""}</span>
        ${arr ? `<span class="c" style="display:block;color:var(--pos)">Looks like it came in: ${esc(arr.desc)}, ${esc(short(arr.date))}${arr.review ? " (in Review)" : ""}</span>` : late && w.kind === "refund" ? `<span class="c" style="display:block;color:var(--neg)">Not here yet. Worth following up.</span>` : ""}</span>
        <span style="text-align:right">${w.amount ? `<span class="a num" style="display:block">${money(w.amount)}</span>` : ""}<button class="btn ${arr ? "" : "ghost "}sm" style="margin-top:6px" data-act="pl-watch-done" data-id="${esc(w.id)}">${w.kind === "refund" ? "Got it" : w.kind === "trial" ? "Canceled" : "Done"}</button></span></div>`; }).join("")}</div>` : emptyLine("Track a refund you’re owed, a free trial before it charges, or the last day to return something. Payday reminds you and spots refunds when they arrive.")}
    ${doneW ? `<button class="btn ghost sm" style="margin-top:10px" data-act="pl-clear-done" data-kind="watch">Clear ${doneW} finished</button>` : ""}</div>`;
  // IOUs
  const open = P.ious.filter(x => !x.settled), owedMe = r2(open.filter(x => x.dir !== "them").reduce((a, x) => a + (+x.amount || 0), 0)), iOwe = r2(open.filter(x => x.dir === "them").reduce((a, x) => a + (+x.amount || 0), 0));
  const ious = `<div class="panel"><div class="row" style="justify-content:space-between"><h2>IOUs</h2><button class="btn sm" data-act="pl-add" data-kind="ious">Add</button></div>
    ${open.length ? `<p class="small muted" style="margin:4px 0 10px">${owedMe ? `People owe you <b style="color:var(--ink)">${money(owedMe)}</b>. ` : ""}${iOwe ? `You owe <b style="color:var(--ink)">${money(iOwe)}</b>.` : ""}</p>
    <div class="list">${open.sort((a, b) => (a.date || "").localeCompare(b.date || "")).map(x => { const arr = x.dir !== "them" ? moneyInMatches(x.amount, x.date || x.made || "0000", x.who || "?")[0] : null;
      return `<div class="tx" style="cursor:default;align-items:flex-start"><span class="mid"><button class="linkish" data-act="pl-edit" data-kind="ious" data-id="${esc(x.id)}">${x.dir === "them" ? `You owe ${esc(x.who)}` : `${esc(x.who)} owes you`}<span class="pen">✎</span></button><span class="c" style="display:block">${x.note ? esc(x.note) + " • " : ""}${x.date ? esc(short(x.date)) : ""}</span>${arr ? `<span class="c" style="display:block;color:var(--pos)">Maybe paid back: ${esc(arr.desc)}, ${esc(short(arr.date))}</span>` : ""}</span>
        <span style="text-align:right"><span class="a num ${x.dir !== "them" ? "inc" : ""}" style="display:block">${money(x.amount)}</span><button class="btn ghost sm" style="margin-top:6px" data-act="pl-iou-settle" data-id="${esc(x.id)}">Settled</button></span></div>`; }).join("")}</div>` : emptyLine("Split a dinner, lent someone gas money, owe a friend for tickets. Mark it settled when the Venmo or Zelle comes in.")}
    ${P.ious.some(x => x.settled) ? `<button class="btn ghost sm" style="margin-top:10px" data-act="pl-clear-done" data-kind="ious">Clear settled</button>` : ""}</div>`;
  // savings: interest + round-ups
  const pool = savingsPool(), pace = savingsPace(), apy = +P.opts.apy || 0, rr = apy / 100;
  const fv = rr ? r2(pool * Math.pow(1 + rr / 26, 26) + pace.amt * ((Math.pow(1 + rr / 26, 26) - 1) / (rr / 26))) : r2(pool + pace.amt * 26);
  const savings = `<div class="panel"><h2 style="margin-bottom:6px">Savings growth</h2>
    <label class="field" style="margin-bottom:8px"><span>Savings interest rate (APY %)</span><input class="input num" data-act="pl-opt" data-k="apy" inputmode="decimal" value="${apy || ""}" placeholder="e.g. 4.0" style="max-width:160px"></label>
    <p class="small" style="margin:0">${money0(pool)} in savings now${apy ? ` earns about <b>${money(pool * rr / 12)}</b> a month` : ""}. Adding ${money0(pace.amt)} a paycheck, in a year you’d have about <b>${money0(fv)}</b>${apy ? `, ${money0(fv - pool - pace.amt * 26)} of it from interest` : ""}.</p>
    ${p ? `<p class="small muted" style="margin:8px 0 0">Round-ups: rounding every Personal charge this paycheck up to the next dollar adds up to <b style="color:var(--ink)">${money(roundUps(p))}</b>. ${P.opts.roundups ? "It’s added to this paycheck’s savings to move." : "Move it with your savings if you like."}</p>
    <label class="row" style="gap:10px;flex-wrap:nowrap;margin-top:8px;cursor:pointer"><input type="checkbox" data-act="roundups-on" style="width:20px;height:20px" ${P.opts.roundups ? "checked" : ""}><span class="small">Add round-ups to savings automatically${P.opts.roundups && P.opts.roundupsFrom ? ` (since the ${esc(short(P.opts.roundupsFrom))} paycheck)` : ""}. They come out of Personal money.</span></label>` : ""}</div>`;
  const N = netWorth(), G = gasStats(), dbt = P.debts.filter(d => +d.balance > 0);
  const sim = dbt.length ? debtSim(dbt, debtMonthly(), P.opts.debtStrat || "avalanche") : null;
  const tiles = `<div class="tiles">
    <button class="tile" data-tab="debt"><b>Debt payoff</b><span class="num">${sim ? (sim.stuck ? "Payments too low" : `Debt-free ${esc(monthsOut(sim.months))}`) : "Add your debts"}</span></button>
    <button class="tile" data-tab="networth"><b>Net worth</b><span class="num">${N.rows.length ? money0(N.total) : "Add what you own and owe"}</span></button>
    <button class="tile" data-tab="gas"><b>Gas log</b><span class="num">${G.mpg ? `${G.mpg} mpg` : G.n ? `${G.n} fill-up${G.n === 1 ? "" : "s"}` : "Log a fill-up"}</span></button>
    <button class="tile" data-tab="whatif"><b>What if?</b><span>Try a different split</span></button>
    <button class="tile" data-tab="tax"><b>Tax helper</b><span>${(() => { const T = taxData(t.slice(0, 4)); return T.extra ? `${money0(T.setAside)} to set aside` : "Extra income and withholding"; })()}</span></button>
    <button class="tile" data-tab="recap"><b>Your year</b><span>${t.slice(0, 4)} recap</span></button>
  </div>`;
  return `<div class="topbar"><h1>Plan</h1><button class="btn ghost sm" data-act="pl-ics">Add to my calendar</button></div>
    ${safe}${tiles}${bills}${cardsPanel()}${sinks}${limits}${watch}${ious}${savings}${stubsPanel()}`;
}
function cardsPanel(){
  const C = plan().cards;
  return `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Card statements</h2><button class="btn sm" data-act="pl-add" data-kind="cards">Add a card</button></div>
    ${C.length ? `<div class="list" style="margin-top:10px">${C.map(c => { const Y = cardCycle(c);
      return `<div style="padding:12px 14px;border-top:1px solid var(--line)"><button class="linkish" data-act="pl-edit" data-kind="cards" data-id="${esc(c.id)}">${esc(c.name)}<span class="pen">✎</span></button>
        <div class="cat" style="grid-template-columns:1fr auto"><span class="small">Statement closed ${esc(short(Y.stmt.to))}, due <b>${esc(short(Y.stmt.due))}</b>${Y.stmt.due >= todayIso() ? ` (${dueWords(Y.stmt.due)})` : ""}${Y.stmt.pay ? `<span class="muted" style="display:block">Paid from the ${esc(short(Y.stmt.pay))} paycheck</span>` : ""}</span><b class="num">${money(Y.stmt.amt)}</b></div>
        <div class="cat" style="grid-template-columns:1fr auto"><span class="small muted">Building up now, closes ${esc(short(Y.cur.to))}, due ${esc(short(Y.cur.due))}${Y.cur.pay ? `, from the ${esc(short(Y.cur.pay))} paycheck` : ""}</span><span class="num muted">${money(Y.cur.amt)}</span></div></div>`; }).join("")}</div>
      <p class="small muted" style="margin:8px 0 0">Totals are the charges Payday has from that card. Your statement balance can differ if you carry a balance or have fees.</p>` : emptyLine("Add the Chase Amazon card or PayPal Mastercard with its closing and due days. Payday shows what each statement owes and which paycheck pays it.")}</div>`;
}
function stubsPanel(){
  const st = plan().stubs.slice().sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return `<div class="panel"><div class="row" style="justify-content:space-between"><h2>Pay stubs</h2><span class="row" style="gap:6px"><label class="btn sm" style="display:inline-flex;align-items:center;cursor:pointer">Add a PDF<input type="file" id="stubIn" accept="application/pdf,.pdf" style="position:absolute;width:1px;height:1px;opacity:0"></label><button class="btn ghost sm" data-act="pl-add" data-kind="stubs">Type one in</button></span></div>
    ${st.length ? `<div class="list" style="margin-top:10px">${st.slice(0, 8).map((s, i) => { const f = stubFlags(s, st[i + 1]); const m = s.net && periodList().find(q => Math.abs(daysBetween(q, s.date)) <= 3);
      return `<div style="padding:12px 14px;border-top:1px solid var(--line)"><div class="row" style="justify-content:space-between;flex-wrap:nowrap"><button class="linkish" data-act="pl-edit" data-kind="stubs" data-id="${esc(s.id)}">${esc(longDay(s.date))}<span class="pen">✎</span></button><b class="num">${s.net ? money(s.net) : ""}</b></div>
        <div class="small muted">${[s.gross ? `Gross ${money(s.gross)}` : "", (s.fed || s.state) ? `Taxes ${money((+s.fed || 0) + (+s.state || 0) + (+s.ss || 0) + (+s.med || 0))}` : "", s.ret ? `401(k) ${money(s.ret)}` : ""].filter(Boolean).join(" • ")}</div>
        ${f.map(x => `<div class="small" style="margin-top:4px">⚑ ${esc(x)}${/paycheck says/.test(x) && m ? ` <button class="btn ghost sm" style="min-height:28px;padding:2px 8px" data-act="stub-flag-net" data-p="${m}" data-v="${s.net}">Use ${money(s.net)}</button>` : ""}</div>`).join("")}</div>`; }).join("")}</div>` : emptyLine("Add your pay stub PDF and Payday reads gross pay, take-home and taxes. It flags raises, overtime and surprise deductions, and totals your withholding for tax time.")}</div>`;
}
function viewDebt(){
  const P = plan(), dbt = P.debts, st = P.opts.debtStrat || "avalanche", monthly = debtMonthly(), mins = r2(dbt.reduce((a, d) => a + (+d.min || 0), 0));
  const live = dbt.filter(d => +d.balance > 0);
  let body = "";
  if (live.length){
    const s = debtSim(live, monthly, st), other = debtSim(live, monthly, st === "avalanche" ? "snowball" : "avalanche"), more = debtSim(live, monthly + 50, st), minOnly = debtSim(live, mins, st);
    const tot = r2(live.reduce((a, d) => a + (+d.balance || 0), 0));
    body = `<div class="stats"><div class="stat"><div class="v num">${money0(tot)}</div><div class="k">Owed</div></div><div class="stat"><div class="v num">${s.stuck ? "Never" : esc(monthsOut(s.months))}</div><div class="k">Debt-free</div></div><div class="stat"><div class="v num">${s.stuck ? "—" : money0(s.interest)}</div><div class="k">Interest to pay</div></div></div>
      ${s.stuck ? `<div class="notice" style="color:var(--neg)">At ${money(monthly)} a month the interest keeps up with your payments, so the balance never reaches zero. Pay more than the interest to make progress.</div>` : ""}
      <div class="panel"><h3 style="margin-bottom:8px">Paid off, in order</h3>${live.slice().sort((a, b) => (s.done[a.id || a.name] || 999) - (s.done[b.id || b.name] || 999)).map(d => `<div class="cat" style="grid-template-columns:1fr auto"><span>${esc(d.name)} <span class="small muted">${money0(d.balance)} at ${+d.apr || 0}%</span></span><span class="num">${s.done[d.id || d.name] ? esc(monthsOut(s.done[d.id || d.name])) : "—"}</span></div>`).join("")}</div>
      <div class="panel"><h3 style="margin-bottom:6px">Ways to get there faster</h3>
        ${!more.stuck && !s.stuck ? `<p class="small" style="margin:0 0 6px">Pay <b>$50 more</b> a month: debt-free ${esc(monthsOut(more.months))} (${s.months - more.months} month${s.months - more.months === 1 ? "" : "s"} sooner) and save <b>${money0(s.interest - more.interest)}</b> in interest.</p>` : ""}
        ${!other.stuck && !s.stuck ? `<p class="small" style="margin:0 0 6px">The ${st === "avalanche" ? "smallest-balance-first (snowball)" : "highest-interest-first (avalanche)"} order would cost <b>${Math.abs(other.interest - s.interest) < 1 ? "about the same" : `${money0(Math.abs(other.interest - s.interest))} ${other.interest > s.interest ? "more" : "less"}`}</b> and finish ${other.months === s.months ? "the same month" : esc(monthsOut(other.months))}.</p>` : ""}
        ${!minOnly.stuck && mins < monthly ? `<p class="small muted" style="margin:0">Minimums only (${money0(mins)} a month) would take until ${esc(monthsOut(minOnly.months))} and cost ${money0(minOnly.interest)} in interest.</p>` : ""}</div>`;
  }
  return `${planTop("Debt payoff", true)}
    <div class="panel"><div class="row" style="justify-content:space-between"><h2>Your debts</h2><button class="btn sm" data-act="pl-add" data-kind="debts">Add a debt</button></div>
      ${dbt.length ? `<div class="list" style="margin-top:10px">${dbt.map(d => `<button class="tx" data-act="pl-edit" data-kind="debts" data-id="${esc(d.id)}"><span class="mid"><span class="d" style="display:block">${esc(d.name)}</span><span class="c">${+d.apr || 0}% APR • ${money(d.min || 0)} minimum</span></span><span class="a num">${money(d.balance)}</span></button>`).join("")}</div>` : emptyLine("Add each card or loan with its balance, interest rate and minimum payment.")}</div>
    ${dbt.length ? `<div class="panel"><div class="grid2"><label class="field"><span>Paying per month, total</span><input class="input num" data-act="pl-opt" data-k="debtMonthly" inputmode="decimal" value="${+P.opts.debtMonthly > 0 ? P.opts.debtMonthly : ""}" placeholder="${money(monthly)}"><small>Blank uses your Debt % (${money(r2(monthly))} a month) or your minimums, whichever is more.</small></label>
      <label class="field"><span>Which to pay off first</span><select class="input" data-act="pl-opt" data-k="debtStrat"><option value="avalanche" ${st === "avalanche" ? "selected" : ""}>Highest interest first (saves the most)</option><option value="snowball" ${st === "snowball" ? "selected" : ""}>Smallest balance first (quick wins)</option></select></label></div></div>` : ""}
    ${body}
    <p class="small muted">Estimates assume the rates stay the same and nothing new is charged. Update balances from your statements now and then.</p>`;
}
function lineChart(pts){
  if (pts.length < 2) return "";
  const W = 640, H = 200, vs = pts.map(p => p.v), mn = Math.min(...vs), mx = Math.max(...vs), span = mx - mn || 1;
  const x = i => 50 + i * (W - 60) / (pts.length - 1), y = v => H - 24 - (v - mn) / span * (H - 44);
  return `<div class="tablewrap"><svg class="chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Net worth over time">
    <text x="44" y="${y(mx) + 4}" text-anchor="end">${money0(mx)}</text><text x="44" y="${y(mn) + 4}" text-anchor="end">${money0(mn)}</text>
    <polyline fill="none" stroke="var(--savings)" stroke-width="3" stroke-linejoin="round" points="${pts.map((p, i) => `${x(i)},${y(p.v)}`).join(" ")}"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.v)}" r="3.5" fill="var(--savings)"><title>${esc(short(p.d))}: ${money0(p.v)}</title></circle>`).join("")}
    <text x="${x(0)}" y="${H - 6}" text-anchor="start">${esc(short(pts[0].d))}</text><text x="${x(pts.length - 1)}" y="${H - 6}" text-anchor="end">${esc(short(pts[pts.length - 1].d))}</text></svg></div>`;
}
function viewNetWorth(){
  recordNW();
  const P = plan(), N = netWorth(), H = P.nw;
  const first = H[0], chg = first && H.length > 1 ? r2(N.total - first.v) : null;
  const row = r => `<div class="cat" style="grid-template-columns:1fr auto"><span>${r.from === "manual" ? `<button class="linkish" style="font-weight:400" data-act="pl-edit" data-kind="assets" data-id="${esc(r.id)}">${esc(r.name)} <span class="pen">✎</span></button>` : r.from === "debt" ? `<button class="linkish" style="font-weight:400" data-tab="debt">${esc(r.name)} <span class="small muted">(debt payoff)</span></button>` : `${esc(r.name)} <span class="small muted">(bank)</span>`}</span><span class="num">${r.v < 0 ? "−" + money0(-r.v) : money0(r.v)}</span></div>`;
  const bankAt = Object.values(P.balances || {}).map(a => a.at).sort().pop();
  return `${planTop("Net worth", true)}
    <div class="stats"><div class="stat"><div class="v num" style="color:${N.total < 0 ? "var(--neg)" : "var(--pos)"}">${money0(N.total)}</div><div class="k">Net worth</div></div><div class="stat"><div class="v num">${money0(N.have)}</div><div class="k">You have</div></div><div class="stat"><div class="v num">${money0(N.owe)}</div><div class="k">You owe</div></div></div>
    ${H.length > 1 ? `<div class="panel"><h3>Over time</h3><p class="small muted" style="margin:2px 0 8px">${chg !== null ? `${chg >= 0 ? "Up" : "Down"} ${money0(Math.abs(chg))} since ${esc(short(first.d))}. ` : ""}A point is saved each time it changes.</p>${lineChart(H.slice(-60))}</div>` : ""}
    <div class="panel"><div class="row" style="justify-content:space-between"><h2>What’s counted</h2><button class="btn sm" data-act="pl-add" data-kind="assets">Add</button></div>
      ${N.rows.length ? `<div style="margin-top:8px">${N.rows.sort((a, b) => b.v - a.v).map(row).join("")}</div>` : emptyLine("Add what you own (car, retirement, cash) and what you owe. Connected bank balances are added automatically.")}
      <p class="small muted" style="margin:10px 0 0">${Object.keys(P.balances || {}).length ? `Bank balances from ${esc(short(bankAt))}. They refresh when you open Accounts.` : plaidUrl() ? "Open the Accounts tab to add your bank balances. Your server needs the v42 update (see SETUP-PLAID.txt)." : "Connect banks on the Accounts tab to add balances automatically."} The savings in Savings goals isn’t added on its own, so add your savings account here if a bank doesn’t already show it.</p></div>`;
}
function viewGas(){
  const P = plan(), G = gasStats(), st = S.settings, g = P.gas.slice().sort((a, b) => b.date.localeCompare(a.date));
  const sug = G.avgGas !== null && G.nAvg >= 3 && Math.abs(G.avgGas - st.gasBudget) >= 5 ? Math.ceil(G.avgGas / 5) * 5 : null;
  return `${planTop("Gas log", true)}
    <div class="stats"><div class="stat"><div class="v num">${G.mpg ?? "—"}</div><div class="k">Miles per gallon</div></div><div class="stat"><div class="v num">${G.ppg ? "$" + G.ppg.toFixed(2) : "—"}</div><div class="k">Per gallon</div></div><div class="stat"><div class="v num">${G.cpm ? "$" + G.cpm.toFixed(2) : "—"}</div><div class="k">Per mile</div></div></div>
    ${G.avgGas !== null ? `<div class="panel"><h3>Is ${money0(st.gasBudget)} a paycheck enough?</h3><p class="small" style="margin:6px 0 0">Your last ${G.nAvg} paychecks averaged <b>${money(G.avgGas)}</b> on gas. ${G.avgGas > st.gasBudget + 2 ? "That’s more than your budget, so the rest has been coming out of Personal money." : G.avgGas < st.gasBudget - 5 ? "That’s under budget." : "Right about on budget."}</p>
      ${sug ? `<button class="btn ghost sm" style="margin-top:10px" data-act="pl-gas-budget" data-v="${sug}">Set gas budget to ${money0(sug)}</button>` : ""}</div>` : ""}
    <div class="panel"><div class="row" style="justify-content:space-between"><h2>Fill-ups</h2><button class="btn sm" data-act="pl-add" data-kind="gas">Log a fill-up</button></div>
      ${g.length ? `<div class="list" style="margin-top:10px">${g.map(x => `<button class="tx" data-act="pl-edit" data-kind="gas" data-id="${esc(x.id)}"><span class="mid"><span class="d" style="display:block">${esc(longDay(x.date))}</span><span class="c">${x.gallons ? `${x.gallons} gal` : ""}${x.gallons && x.total ? ` • $${(x.total / x.gallons).toFixed(2)}/gal` : ""}${x.odo ? ` • ${Number(x.odo).toLocaleString("en-US")} mi` : ""}</span></span><span class="a num">${money(x.total)}</span></button>`).join("")}</div>` : emptyLine("At each fill-up, note the gallons, the total and your odometer. After two fill-ups you’ll see miles per gallon and cost per mile.")}</div>`;
}
function viewWhatIf(){
  const st = S.settings, W = S.wi || (S.wi = {personalPct: st.personalPct, savingsPct: st.savingsPct, debtPct: st.debtPct, gasBudget: st.gasBudget, leftoverSavePct: st.leftoverSavePct || 0, n: "6"});
  const l = periodList();
  if (!l.length) return `${planTop("What if?", true)}<div class="list"><div class="empty">Add a paycheck first.</div></div>`;
  const n = W.n === "all" ? l.length : Math.min(l.length, +W.n);
  const over = {personalPct: W.personalPct, savingsPct: W.savingsPct, debtPct: W.debtPct, gasBudget: W.gasBudget, leftoverSavePct: W.leftoverSavePct};
  const R = whatIf(over, n);
  const sum = (k, w) => r2(R.reduce((a, r) => a + r[w][k], 0));
  const overA = R.filter(r => r.a.personalLeft < 0).length, overB = R.filter(r => r.b.personalLeft < 0).length;
  const savA = sum("savings", "a"), savB = sum("savings", "b"), last = R[R.length - 1];
  const tot = W.personalPct + W.savingsPct + W.debtPct, pct = v => Math.round(v * 10000) / 100;
  const inp = (k, label, isPct) => `<label class="field"><span>${label}</span><input class="input num" data-act="wi-in" data-k="${k}" data-pct="${isPct ? 1 : 0}" inputmode="decimal" value="${isPct ? pct(W[k]) : W[k]}"></label>`;
  return `${planTop("What if?", true)}
    <p class="muted" style="margin:0 0 12px">Change the split and see how your last ${n} paychecks would have gone with the same spending. Nothing changes until you tap Use these.</p>
    <div class="panel"><div class="grid2">${inp("personalPct", "Personal %", true)}${inp("savingsPct", "Savings %", true)}${inp("debtPct", "Debt %", true)}${inp("gasBudget", "Gas per paycheck ($)", false)}${inp("leftoverSavePct", "Leftover to savings %", true)}
      <label class="field"><span>Paychecks</span><select class="input" data-act="wi-in" data-k="n">${[["3", "Last 3"], ["6", "Last 6"], ["12", "Last 12"], ["all", "All"]].map(([v, t]) => `<option value="${v}" ${W.n === v ? "selected" : ""}>${t}</option>`).join("")}</select></label></div>
      ${tot > 1.0001 ? `<div class="notice" style="color:var(--neg)">Personal + Savings + Debt is ${pct(tot)}%, more than 100%.</div>` : `<p class="small muted" style="margin:0">Personal + Savings + Debt = ${pct(tot)}%. The rest (${pct(1 - tot)}%) isn’t split anywhere.</p>`}
      <div class="row" style="margin-top:12px"><button class="btn" data-act="wi-apply" ${tot > 1.0001 ? "disabled" : ""}>Use these in Settings</button><button class="btn ghost" data-act="wi-reset">Back to my numbers</button></div></div>
    <div class="stats"><div class="stat"><div class="v num" style="color:${savB >= savA ? "var(--pos)" : "var(--neg)"}">${savB - savA >= 0 ? "+" : "−"}${money0(Math.abs(savB - savA))}</div><div class="k">Savings change</div></div>
      <div class="stat"><div class="v num">${overB} <span class="small muted">vs ${overA}</span></div><div class="k">Paychecks over budget</div></div>
      <div class="stat"><div class="v num ${last.b.personalLeft < 0 ? "" : ""}">${money0(last.b.personalLeft)}</div><div class="k">Left now (actual ${money0(last.a.personalLeft)})</div></div></div>
    <div class="panel" style="padding:0;overflow:hidden"><div class="tablewrap"><table style="width:100%;border-collapse:collapse;font-size:14px"><tr style="text-align:right" class="muted"><td style="text-align:left;padding:8px 12px">Paycheck</td><td style="padding:8px">Personal</td><td style="padding:8px">Left: actual</td><td style="padding:8px 12px">What-if</td></tr>
      ${R.slice().reverse().map(r => `<tr style="border-top:1px solid var(--line);text-align:right" class="num"><td style="text-align:left;padding:8px 12px">${esc(short(r.p))}</td><td style="padding:8px">${money0(r.b.personalBudget)}</td><td style="padding:8px;${r.a.personalLeft < 0 ? "color:var(--neg)" : ""}">${money0(r.a.personalLeft)}</td><td style="padding:8px 12px;font-weight:700;${r.b.personalLeft < 0 ? "color:var(--neg)" : ""}">${money0(r.b.personalLeft)}</td></tr>`).join("")}</table></div></div>`;
}

/* ---------- privacy mode and PIN lock (this device only) ---------- */
function privacyOn(){ return lsGet("payday-privacy") === "1"; }
function applyPrivacy(){ PRIVATE = privacyOn(); document.body.classList.toggle("privacy", PRIVATE); }
function pinCfg(){ try{ return JSON.parse(lsGet("payday-pin") || "null"); }catch(_){ return null; } }
async function pinHash(pin, salt){
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 150000, hash: "SHA-256"}, key, 256);
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, "0")).join("");
}
let locked = false;
function lockNow(){
  if (!pinCfg() || locked) return;
  locked = true; closeSheet();
  let root = $("#lockRoot"); if (!root){ root = document.createElement("div"); root.id = "lockRoot"; document.body.appendChild(root); }
  root.innerHTML = `<div class="lock" role="dialog" aria-modal="true" aria-label="Payday is locked"><div class="lock-box">
    <div style="font-size:40px">🔒</div><h2 style="margin:6px 0 4px">Payday is locked</h2><p class="muted" style="margin:0 0 16px">Enter your PIN</p>
    <input class="input bigamt" id="pinIn" type="password" inputmode="numeric" autocomplete="off" maxlength="12" aria-label="PIN" style="letter-spacing:.3em">
    <div class="small" id="pinMsg" style="min-height:20px;margin:8px 0;color:var(--neg)"></div>
    <button class="btn yellow" data-act="pin-unlock" style="width:100%">Unlock</button>
    ${pinCfg() && pinCfg().bio ? `<button class="btn ghost" data-act="bio-unlock" style="width:100%;margin-top:10px">Use fingerprint or face</button>` : ""}
    <button class="linkish small muted" data-act="pin-forgot" style="margin-top:14px;font-weight:400;text-decoration:underline">Forgot PIN?</button></div></div>`;
  document.documentElement.style.overflow = "hidden";
  setTimeout(() => { const i = $("#pinIn"); if (i) i.focus(); }, 60);
}
function unlockUI(){ locked = false; const r = $("#lockRoot"); if (r) r.innerHTML = ""; document.documentElement.style.overflow = ""; lsSet("payday-hidden-at", null); }
async function tryUnlock(){
  const c = pinCfg(), i = $("#pinIn"); if (!c || !i) return unlockUI();
  const h = await pinHash(i.value, c.salt);
  if (h === c.hash){ unlockUI(); return; }
  i.value = ""; $("#pinMsg").textContent = "That’s not it. Try again."; if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
}
function pinSheet(){
  const c = pinCfg();
  openSheet(`<h2>${c ? "Change your PIN" : "Set a PIN"}</h2><p class="muted" style="margin:-6px 0 12px">Asks for a PIN when you open Payday on this device. It keeps out someone who picks up your phone. It doesn’t encrypt your data.</p>
    <label class="field"><span>New PIN (4 to 12 digits)</span><input class="input num" id="pin1" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
    <label class="field"><span>Type it again</span><input class="input num" id="pin2" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="pin-save">Save PIN</button></div>`);
}
function privacyPanel(){
  const c = pinCfg(), after = c ? String(c.after ?? 1) : "1";
  return `<div class="panel"><h2 style="margin-bottom:6px">Privacy and lock</h2>
    <label class="row" style="gap:10px;flex-wrap:nowrap;cursor:pointer;margin-bottom:12px"><input type="checkbox" data-act="privacy-check" style="width:22px;height:22px" ${privacyOn() ? "checked" : ""}><span><b>Hide amounts</b><span class="small muted" style="display:block">Shows $••• instead of dollar amounts until you turn it off. Also on the 👁 button on the Paycheck screen. This device only.</span></span></label>
    <div class="small muted" style="margin:0 0 6px">PIN lock (this device)</div>
    ${c ? `<div class="row" style="margin-bottom:10px"><button class="btn ghost sm" data-act="pin-set">Change PIN</button><button class="btn danger sm" data-act="pin-remove">Turn off PIN</button><button class="btn ghost sm" data-act="pin-lock-now">Lock now</button>${c.bio ? `<button class="btn ghost sm" data-act="bio-off">Turn off fingerprint</button>` : window.PublicKeyCredential ? `<button class="btn ghost sm" data-act="bio-setup">Also use fingerprint or face</button>` : ""}</div>
      <label class="field"><span>Lock again after leaving for</span><select class="input" data-act="pin-after" style="max-width:220px">${[["0", "Right away"], ["1", "1 minute"], ["5", "5 minutes"], ["15", "15 minutes"], ["60", "1 hour"]].map(([v, l]) => `<option value="${v}" ${after === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>`
      : `<button class="btn sm" data-act="pin-set">Set a PIN</button>`}
    <p class="small muted" style="margin:8px 0 0">Forgot it? If you’re signed in with Google, you can unlock by signing in again.</p></div>`;
}
document.addEventListener("visibilitychange", () => {
  const c = pinCfg(); if (!c) return;
  if (document.visibilityState === "hidden"){ if (!locked) lsSet("payday-hidden-at", String(Date.now())); }
  else { const h = +lsGet("payday-hidden-at") || 0; if (h && Date.now() - h >= (+c.after || 0) * 60000) lockNow(); }
});

/* ---------- events for everything above ---------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, id = el.dataset.id, P = plan();
  if (locked && !["pin-unlock", "pin-forgot"].includes(a)) return;
  if (a === "pl-add") plEditSheet(el.dataset.kind, null);
  else if (a === "pl-edit") plEditSheet(el.dataset.kind, id);
  else if (a === "pl-save"){ if (plSave(el.dataset.kind, id)){ closeSheet(); render(); toast("Saved."); } }
  else if (a === "pl-del"){ const k = el.dataset.kind; P[k] = P[k].filter(x => x.id !== id); savePlan(); closeSheet(); render(); toast("Deleted."); }
  else if (a === "pl-bill-paid"){ const b = P.bills.find(x => x.id === id); if (!b) return; b.paid = [...(b.paid || []), el.dataset.d].slice(-36); savePlan(); render(); toast(`${b.name} marked paid for ${short(el.dataset.d)}.`); }
  else if (a === "pl-sink-set"){ const s = P.sinks.find(x => x.id === id), l = periodList(); if (!s || !l.length) return; const p = l[l.length - 1], sh = Math.ceil(sinkShare(s, p)); s.saved = r2((+s.saved || 0) + sh); s.setFor = p; savePlan(); render(); toast(`${money0(sh)} set aside for ${s.name}. Move it to savings when you move the rest.`); }
  else if (a === "pl-sink-paid"){ const s = P.sinks.find(x => x.id === id); if (!s) return; if (!s.freq || s.freq === "once"){ P.sinks = P.sinks.filter(x => x !== s); toast(`${s.name} done.`); } else { s.saved = Math.max(0, r2((+s.saved || 0) - (+s.amount || 0))); s.due = nthDate({due: s.due, freq: s.freq}, 1); delete s.setFor; toast(`${s.name} paid. Next one is ${short(s.due)}.`); } savePlan(); render(); }
  else if (a === "pl-watch-done"){ const w = P.watch.find(x => x.id === id); if (!w) return; w.done = todayIso(); savePlan(); render(); toast("Done."); }
  else if (a === "pl-iou-settle"){ const x = P.ious.find(y => y.id === id); if (!x) return; x.settled = todayIso(); savePlan(); render(); toast("Settled."); }
  else if (a === "pl-clear-done"){ const k = el.dataset.kind; P[k] = P[k].filter(x => !(x.done || x.settled)); savePlan(); render(); }
  else if (a === "pl-lim-edit") limitsSheet();
  else if (a === "pl-lim-save"){ const L = {}; document.querySelectorAll("[data-lim]").forEach(i => { const v = r2(parseAmt(i.value)); if (i.value.trim() && v > 0) L[i.dataset.lim] = v; }); P.limits = L; savePlan(); closeSheet(); render(); toast("Limits saved."); }
  else if (a === "pl-ics"){ saveFile("payday-calendar.ics", icsText(), "text/calendar"); toast("Open the file to add paydays, bills and reminders to your calendar."); }
  else if (a === "pl-gas-budget"){ S.settings.gasBudget = +el.dataset.v; store.save("settings", S.settings); render(); toast(`Gas budget is now ${money0(S.settings.gasBudget)} a paycheck.`); }
  else if (a === "wi-reset"){ S.wi = null; render(); }
  else if (a === "wi-apply"){ const W = S.wi; if (!W) return; Object.assign(S.settings, {personalPct: W.personalPct, savingsPct: W.savingsPct, debtPct: W.debtPct, gasBudget: W.gasBudget, leftoverSavePct: W.leftoverSavePct}); store.save("settings", S.settings); S.wi = null; render(); toast("New split saved. It applies to every paycheck, past ones too, like Settings does."); }
  else if (a === "privacy-toggle"){ lsSet("payday-privacy", privacyOn() ? null : "1"); applyPrivacy(); render(); }
  else if (a === "pin-set") pinSheet();
  else if (a === "pin-save"){ const p1 = $("#pin1").value.trim(), p2 = $("#pin2").value.trim(); if (!/^\d{4,12}$/.test(p1)){ toast("Use 4 to 12 digits."); return; } if (p1 !== p2){ toast("The two PINs don’t match."); return; } const salt = uid() + uid(); const old = pinCfg(); lsSet("payday-pin", JSON.stringify({salt, hash: await pinHash(p1, salt), after: old ? old.after : 1})); closeSheet(); render(); toast("PIN set. Payday asks for it when you come back."); }
  else if (a === "pin-remove"){ lsSet("payday-pin", null); render(); toast("PIN turned off."); }
  else if (a === "pin-lock-now") lockNow();
  else if (a === "pin-unlock") tryUnlock();
  else if (a === "pin-forgot"){
    if (FB.user && FB.auth){ try{ await FB.user.reauthenticateWithPopup(new firebase.auth.GoogleAuthProvider()); lsSet("payday-pin", null); unlockUI(); render(); toast("Unlocked. Your PIN is off. Set a new one in Settings."); }catch(_){ $("#pinMsg").textContent = "Google sign-in didn’t finish."; } }
    else $("#pinMsg").textContent = "Without Google sign-in, the only way back in is clearing this site’s data in your browser settings. That also erases Payday data saved only on this device, so restore a backup after.";
  }
});
document.addEventListener("change", e => {
  const d = e.target.dataset || {};
  if (d.act === "pl-opt"){
    const P = plan(), k = d.k;
    if (e.target.type === "checkbox") P.opts[k] = e.target.checked;
    else if (k === "debtStrat") P.opts[k] = e.target.value;
    else { const s = e.target.value.trim(); P.opts[k] = s === "" ? "" : r2(parseAmt(s)); }
    savePlan(); render(); return;
  }
  if (d.act === "wi-in"){
    const W = S.wi; if (!W) return;
    if (d.k === "n") W.n = e.target.value;
    else { const v = parseFloat(e.target.value); if (isNaN(v) || v < 0){ toast("Use a number."); return; } W[d.k] = d.pct === "1" ? v / 100 : v; }
    render(); return;
  }
  if (d.act === "privacy-check"){ lsSet("payday-privacy", e.target.checked ? "1" : null); applyPrivacy(); render(); return; }
  if (d.act === "pin-after"){ const c = pinCfg(); if (c){ c.after = +e.target.value; lsSet("payday-pin", JSON.stringify(c)); toast("Saved."); } return; }
});
document.addEventListener("keydown", e => {
  if (locked && e.key === "Enter" && document.activeElement && document.activeElement.id === "pinIn"){ e.preventDefault(); tryUnlock(); }
  if (locked && e.key === "Escape") e.stopImmediatePropagation();
}, true);
document.addEventListener("keydown", e => { if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("section.safe")){ e.preventDefault(); go("plan"); } });

JUMPS.push(
  ["Plan", "bills safe to spend budget", () => go("plan")], ["Bills", "bill due rent phone autopay", () => go("plan")],
  ["Yearly costs", "sinking fund registration christmas", () => go("plan")], ["Spending limits", "cap category budget", () => limitsSheet()],
  ["Debt payoff", "debt loan card interest avalanche snowball", () => go("debt")], ["Net worth", "assets balances worth", () => go("networth")],
  ["Gas log", "mpg fill up gallons", () => go("gas")], ["What if", "simulate split percent", () => go("whatif")],
  ["IOUs", "owe split venmo zelle", () => go("plan")], ["Refunds, trials and returns", "refund trial return reminder", () => go("plan")],
  ["Add to my calendar", "ics calendar paydays bills", () => { saveFile("payday-calendar.ics", icsText(), "text/calendar"); }],
  ["Privacy and lock", "pin lock hide blur", () => { S.setOpen = S.setOpen || new Set(); S.setOpen.add("Privacy and lock"); go("settings"); }]
);
HELP.splice(1, 0,
  ["Safe to spend", "The card under Personal money. It takes what’s left, subtracts bills due before payday and this paycheck’s share of yearly costs, and divides by the days left. The bar shows how much you’ve spent; the black mark is where you’d be if you spent evenly. Tap it to open Plan."],
  ["Plan", "Bills, yearly costs, spending limits, refunds and trials, IOUs, savings growth, debt payoff, net worth, gas log and What if. Open it from the Safe to spend card, Jump anywhere, or put Plan in the bottom bar (Settings → Appearance)."],
  ["Bills", "Add each bill with its due date and how often it repeats. Payday marks it paid when a charge with its words shows up near the due date, or tap Paid. Unpaid bills from Personal come out of Safe to spend. With bank balances, it warns you if checking could drop too low before payday."],
  ["Smart search", "Type things like “doordash over $20 since august”, “dining last month”, “gas in september”, “#trip”, “amount:<10” or “cat:dining”. The line under the box shows how Payday read it."],
  ["Privacy and lock", "👁 on the Paycheck screen hides every dollar amount (handy in public). Settings → Privacy and lock sets a PIN for this device."]
);

/* ======================================================================
   v43: automatic pulls + alerts, pay stubs, card statements, tax helper,
   year recap, duplicate + unusual charge alerts, rule reach, category icons,
   demo mode, Google Sheets export, fingerprint unlock, automatic round-ups,
   split a charge with someone.
   ====================================================================== */

/* ---------- automatic pulls: your server drops new charges in "autopull", they go to Review ---------- */
let autoBusy = false;
async function processAutopull(){
  const items = (S.autopull && Array.isArray(S.autopull.items)) ? S.autopull.items : [];
  if (!items.length || autoBusy || DEMO || !store.cloud) return;
  autoBusy = true;
  try{
    const groups = {};
    for (const it of items){
      const src = plaidSrc(it.inst || "", {id: it.accountId, type: it.type, subtype: it.subtype});
      if (src === "off") continue;
      (groups[src] = groups[src] || []).push({date: it.date, desc: (it.desc || "Charge").trim(), flow: +it.flow});
    }
    let sent = 0;
    for (const [src, list] of Object.entries(groups)){
      const r = {id: uid(), name: SOURCES[src] + " (automatic)", state: "parsing", flip: false, items: list, src};
      S.imports.unshift(r); addImport(r); sent += (r.log || []).filter(x => x.outcome === "review").length;
    }
    await store.cloud.ref.doc("autopull").update({items: firebase.firestore.FieldValue.arrayRemove(...items)}).catch(() => store.cloud.ref.doc("autopull").set({items: []}));
    S.autopull = {items: []};
    if (sent){ renderTabs(); toast(`${sent} new charge${sent === 1 ? "" : "s"} from your bank ${sent === 1 ? "is" : "are"} in Review.`); if (S.view === "home" || S.view === "review") render(); }
  } finally { autoBusy = false; }
}
const pushOk = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function b64ToBytes(s){ s = s.replace(/-/g, "+").replace(/_/g, "/"); s += "=".repeat((4 - s.length % 4) % 4); return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }
async function pushOn(){
  if (!pushOk()) return toast("This browser can’t show alerts. On iPhone, add Payday to your home screen first.");
  const perm = await Notification.requestPermission(); if (perm !== "granted") return toast("Alerts are blocked. Allow notifications for this site in your browser settings.");
  try{
    plaidSet("Turning on alerts…");
    const {key} = await plaidCall("vapid");
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: b64ToBytes(key)});
    await plaidCall("subscribe", {sub: sub.toJSON(), device: /android/i.test(navigator.userAgent) ? "Android phone" : /iphone|ipad/i.test(navigator.userAgent) ? "iPhone" : "Computer"});
    lsSet("payday-push", "on"); plaidSet(""); toast("Alerts are on for this device.");
  }catch(e){ plaidSet("", e.message.includes("Unknown request") ? "Your server needs the v43 update for alerts (see SETUP-PLAID.txt)." : e.message); }
}
async function pushOff(){
  try{ const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription(); if (sub){ await plaidCall("unsubscribe", {endpoint: sub.endpoint}).catch(() => {}); await sub.unsubscribe(); } }catch(_){}
  lsSet("payday-push", null); render(); toast("Alerts are off for this device.");
}
function autoPanel(){
  if (!plaidUrl()) return "";
  const on = lsGet("payday-push") === "on";
  return `<div class="panel"><h2 style="margin-bottom:6px">Automatic pulls and alerts</h2>
    <p class="muted" style="margin:0 0 10px">Once your server is set up for it (SETUP-PLAID.txt, part D), it checks your banks every few hours. New charges land in Review on their own, and this device gets an alert like “3 new charges, $58.20”. Tap it to go straight to Review.</p>
    <div class="row">${on ? `<span class="status"><i></i>Alerts on for this device</span><button class="btn ghost sm" data-act="push-off">Turn off</button><button class="btn ghost sm" data-act="push-test">Send a test</button>` : `<button class="btn sm" data-act="push-on" ${pushOk() ? "" : "disabled"}>Turn on alerts on this device</button>`}</div>
    ${pushOk() ? "" : `<p class="small muted" style="margin:8px 0 0">This browser can’t show alerts. On iPhone, add Payday to your home screen and open it from there.</p>`}</div>`;
}

/* ---------- pay stubs ---------- */
const STUB_FIELDS = [["gross", /gross\s*(?:pay|earnings|wages)?/], ["net", /net\s*(?:pay|amount|check)/], ["fed", /(?:federal\s*(?:income\s*)?(?:tax|withholding|w\/h)|fed(?:eral)?\s*(?:income\s*)?tax|\bfit\b|\bfitw\b)/], ["state", /(?:state\s*(?:income\s*)?tax|\bsit\b|\bsitw\b|[a-z]{2}\s*state\s*tax)/], ["ss", /(?:social\s*security|oasdi|fica[\s-]*(?:ss|oasdi))/], ["med", /(?:medicare|fica[\s-]*med|\bmed\s*tax)/], ["ret", /(?:401\s*\(?k\)?|403\s*\(?b\)?|retirement)/], ["ot", /(?:overtime|\bot\s*(?:pay|hours|earn))/]];
// Takes the first dollar amount on the line after each label. Stubs vary, so you check the result before it's saved.
function parseStub(text){
  const out = {}, lines = String(text).toLowerCase().split(/\n/);
  for (const [k, re] of STUB_FIELDS){
    for (const l of lines){ const m = l.match(re); if (!m) continue; const rest = l.slice(m.index + m[0].length); const a = rest.match(/-?\$?\s*([\d,]+\.\d{2})/); if (a){ out[k] = r2(parseFloat(a[1].replace(/,/g, ""))); break; } }
  }
  const d = String(text).match(/(?:pay|check|advice)\s*date[^\d]{0,12}(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})/i);
  if (d){ const y = d[3].length === 2 ? "20" + d[3] : d[3]; out.date = `${y}-${pad(+d[1])}-${pad(+d[2])}`; }
  return out;
}
async function importStub(file){
  try{
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") return toast("Pick the PDF of your pay stub.");
    const lines = await pdfLines(file);
    if (!lines.join("").trim()) return toast("That PDF has no readable text (it may be a scan). Add the numbers by hand.");
    const s = parseStub(lines.join("\n")), n = ["gross", "net", "fed", "state", "ss", "med"].filter(k => s[k] !== undefined).length;
    const st = {id: uid(), made: todayIso(), date: s.date || todayIso(), ...s, file: file.name};
    plan().stubs.push(st); savePlan(); render();
    plEditSheet("stubs", st.id);
    toast(n ? `Read ${n} amount${n === 1 ? "" : "s"} from the stub. Check them and fix anything that’s off.` : "Couldn’t read amounts from that stub. Type them in.");
  }catch(e){ toast("Couldn’t read that PDF (" + e.message + ")."); }
}
function stubFlags(st, prev){
  const f = [];
  if (prev && st.gross && prev.gross){ const ch = (st.gross - prev.gross) / prev.gross; if (Math.abs(ch) >= 0.02) f.push(`Gross ${ch > 0 ? "up" : "down"} ${money(Math.abs(st.gross - prev.gross))} from last stub${ch > 0.02 && !st.ot ? " (raise?)" : ""}`); }
  if (st.ot) f.push(`Overtime ${money(st.ot)}`);
  if (st.net){ const p = periodList().find(q => Math.abs(daysBetween(q, st.date)) <= 3); if (p && Math.abs((+S.periods[p].amount || 0) - st.net) > 0.5) f.push(`Net ${money(st.net)} but the ${short(p)} paycheck says ${money(S.periods[p].amount)}`); }
  if (prev && st.net && prev.net && st.net < prev.net - 20 && !(st.gross < prev.gross)) f.push("Net is lower but gross isn’t. Check the deductions.");
  return f;
}

/* ---------- card statements: what you owe and which paycheck pays it ---------- */
function dayOf(y, m, day){ return iso(new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()))); }
function lastClose(date, day){ const d = toD(date); let c = dayOf(d.getFullYear(), d.getMonth(), day); if (c > date){ c = dayOf(d.getFullYear(), d.getMonth() - 1, day); } return c; }
function nextMonthDay(after, day){ const d = toD(after); let c = dayOf(d.getFullYear(), d.getMonth(), day); if (c <= after) c = dayOf(d.getFullYear(), d.getMonth() + 1, day); return c; }
function cardCharges(src, from, to){
  let t = 0;
  for (const p of periodList()) for (const x of (S.periods[p].txns || [])) if (x.src === src && x.date >= from && x.date <= to && x.fund !== "income" && x.fund !== "savings") t += +x.amount || 0;
  for (const i of S.inbox.items) if (i.status === "pending" && i.src === src && i.date >= from && i.date <= to && i.flow < 0) t += -i.flow;
  return r2(t);
}
function payingPaycheck(due){ const l = periodList(); let p = null; for (const q of l) if (q <= due) p = q; let next = nextPayday(); while (next && next <= due){ p = next; next = addDays(next, 14); } return p; }
function cardCycle(c, today){
  today = today || todayIso();
  const close = +c.closeDay || 1, dueD = +c.dueDay || 25;
  const lc = lastClose(today, close), pc = lastClose(addDays(lc, -1), close), nc = nextMonthDay(lc, close);
  const stDue = nextMonthDay(lc, dueD), nextDue = nextMonthDay(nc, dueD);
  return {stmt: {from: addDays(pc, 1), to: lc, due: stDue, amt: cardCharges(c.src, addDays(pc, 1), lc), pay: payingPaycheck(addDays(stDue, -1))},
          cur: {from: addDays(lc, 1), to: nc, due: nextDue, amt: cardCharges(c.src, addDays(lc, 1), today), pay: payingPaycheck(addDays(nextDue, -1))}};
}

/* ---------- alerts: same charge twice, and charges that look unusual ---------- */
function currentItems(){
  const l = periodList(); if (!l.length) return [];
  const p = l[l.length - 1], out = (S.periods[p].txns || []).filter(t => +t.amount > 0 && ["personal", "gas", "debt"].includes(t.fund)).map(t => ({id: t.id, date: t.date, desc: t.desc, orig: t.orig, amt: +t.amount, kind: "tx"}));
  for (const i of S.inbox.items) if (i.status === "pending" && i.flow < 0 && i.date >= p) out.push({id: i.id, date: i.date, desc: i.desc, orig: i.orig, amt: -i.flow, kind: "rv"});
  return out;
}
function dupGroups(){
  const ok = plan().opts.dupOk || {}, g = {};
  for (const x of currentItems()){ const k = `${x.date}|${norm(x.orig || x.desc)}|${x.amt.toFixed(2)}`; (g[k] = g[k] || []).push(x); }
  return Object.entries(g).filter(([k, v]) => v.length > 1 && !ok[k]).map(([k, v]) => ({k, items: v}));
}
function unusualCharges(){
  const l = periodList(); if (l.length < 2) return [];
  const p = l[l.length - 1], hist = {}, ok = plan().opts.flagOk || {}, newBig = +plan().opts.newBig || 75;
  for (const q of l) if (q < p) for (const t of (S.periods[q].txns || [])) if (+t.amount > 0){ const k = norm(t.orig || t.desc); (hist[k] = hist[k] || []).push(+t.amount); }
  const out = [];
  for (const x of currentItems()){
    if (ok[x.id]) continue;
    const h = hist[norm(x.orig || x.desc)] || [];
    if (!h.length && x.amt >= newBig) out.push({...x, why: "First time at this place"});
    else if (h.length >= 3){ const s = h.slice().sort((a, b) => a - b), med = s[Math.floor(s.length / 2)]; if (x.amt >= med * 3 && x.amt - med >= 20) out.push({...x, why: `About ${Math.round(x.amt / med)}× your usual ${money(med)}`}); }
  }
  return out;
}
function alertBanners(){
  const out = [];
  for (const g of dupGroups().slice(0, 2)) out.push(`<div class="banner" style="flex-wrap:wrap;border-color:var(--gas)"><span class="dot" style="background:var(--gas)"></span><span style="flex:1;min-width:200px"><b>Charged twice? ${esc(g.items[0].desc)} ${money(g.items[0].amt)}</b><span class="small muted">${g.items.length} identical charges on ${esc(short(g.items[0].date))}${g.items.some(x => x.kind === "rv") ? ", some in Review" : ""}. If you didn’t buy it twice, contact the store or bank.</span></span><span class="row" style="gap:6px"><button class="btn ghost sm" data-act="al-dup-ok" data-k="${esc(g.k)}">It’s fine</button></span></div>`);
  const U = unusualCharges();
  if (U.length) out.push(`<div class="banner" style="flex-wrap:wrap"><span class="dot" style="background:var(--income)"></span><span style="flex:1;min-width:200px"><b>${U.length === 1 ? "A charge looks unusual" : `${U.length} charges look unusual`}</b><span class="small muted">${U.slice(0, 3).map(x => `${esc(x.desc)} ${money(x.amt)}: ${esc(x.why)}`).join("<br>")}</span></span><button class="btn ghost sm" data-act="al-flag-ok" data-ids="${esc(U.map(x => x.id).join(","))}">${U.length === 1 ? "It’s fine" : "They’re fine"}</button></div>`);
  return out;
}

/* ---------- rules: how many charges each one touches ---------- */
function ruleReach(k){
  let n = 0;
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])) if (norm(t.orig || t.desc) === k) n++;
  for (const i of S.inbox.items) if (i.status === "pending" && norm(i.orig || i.desc) === k) n++;
  return n;
}

/* ---------- category icons ---------- */
const CAT_EMOJI = {Gas: "⛽", Groceries: "🛒", Dining: "🍔", Health: "💊", Car: "🚗", Overdraft: "⚠️", Bills: "🧾", Subscriptions: "🔁", Fun: "🎟️", People: "🎁", Shopping: "🛍️", "Vapes & smoke": "💨", Other: "", "Extra income": "💵", "Moved to savings": "🏦", Debt: "💳"};
function catEmoji(t){ if (S.settings.icons === false) return ""; const k = rawCategory(t), m = S.settings.catEmoji || {}; return k in m ? m[k] : (CAT_EMOJI[k] || ""); }
function iconsPanel(){
  const m = S.settings.catEmoji || {};
  return `<h3 style="margin:22px 0 4px">Icons</h3><p class="small muted" style="margin:0 0 8px">Shown on each charge instead of the first letter. Type or paste any emoji, or clear it for the letter.</p>
    <label class="row" style="gap:10px;flex-wrap:nowrap;cursor:pointer;margin-bottom:8px"><input type="checkbox" data-act="icons-on" style="width:20px;height:20px" ${S.settings.icons === false ? "" : "checked"}><span>Show category icons</span></label>
    <div class="list" style="padding:0">${[...allCategories(), "Gas", "Extra income", "Moved to savings", "Debt"].filter((v, i, a) => a.indexOf(v) === i).map(c => `<label class="row" style="justify-content:space-between;flex-wrap:nowrap;padding:6px 14px;border-top:1px solid var(--line)"><span>${esc(catName(c))}</span><input class="input" data-cemoji="${esc(c)}" value="${esc(c in m ? m[c] : (CAT_EMOJI[c] || ""))}" style="width:70px;min-height:38px;text-align:center;font-size:20px" aria-label="Icon for ${esc(catName(c))}"></label>`).join("")}</div>`;
}

/* ---------- year recap ---------- */
function recapData(y){
  const txs = [], out = {y};
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])) if (t.date.startsWith(y)) txs.push(t);
  const spend = txs.filter(t => ["personal", "gas", "debt"].includes(t.fund) && +t.amount > 0);
  out.spent = r2(txs.filter(t => ["personal", "gas", "debt"].includes(t.fund)).reduce((a, t) => a + (+t.amount || 0), 0)); out.n = spend.length; // refunds count against spending
  const by = (f) => { const m = {}; spend.forEach(t => { const k = f(t); m[k] = (m[k] || 0) + +t.amount; }); return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  const visits = {}; spend.forEach(t => { const k = merchantOf(t); visits[k] = (visits[k] || 0) + 1; });
  out.topPlace = by(t => merchantOf(t))[0] || null; out.topCat = by(t => category(t))[0] || null; out.topMonth = by(t => t.date.slice(0, 7))[0] || null;
  out.visits = Object.entries(visits).sort((a, b) => b[1] - a[1])[0] || null;
  out.biggest = spend.slice().sort((a, b) => b.amount - a.amount)[0] || null;
  out.saved = r2(txs.filter(t => t.fund === "savings").reduce((a, t) => a + +t.amount, 0));
  out.extra = r2(txs.filter(t => t.fund === "income").reduce((a, t) => a + +t.amount, 0));
  out.paychecks = periodList().filter(p => p.startsWith(y)).length;
  const days = new Set(spend.filter(t => t.fund === "personal").map(t => t.date)); let best = 0, run = 0;
  const end = y === todayIso().slice(0, 4) ? todayIso() : y + "-12-31", start = periodList().find(p => p.startsWith(y)) || y + "-01-01";
  for (let d = start; d <= end; d = addDays(d, 1)){ if (days.has(d)) run = 0; else { run++; best = Math.max(best, run); } }
  out.streak = best; out.places = Object.keys(visits).length;
  return out;
}
function viewRecap(){
  const years = [...new Set(periodList().map(p => p.slice(0, 4)))].reverse(), y = S.recapY && years.includes(S.recapY) ? S.recapY : years[0];
  if (!y) return `${planTop("Your year", true)}<div class="list"><div class="empty">Nothing to look back on yet.</div></div>`;
  const R = recapData(y);
  const card = (big, line, sub, bg) => `<section class="rc" style="background:${bg}"><div class="rc-line">${line}</div><div class="rc-big num">${big}</div><div class="rc-sub">${sub}</div></section>`;
  const cards = [
    card(y, "Your year in Payday", `${R.paychecks} paychecks • ${R.n} charges • ${R.places} places`, "var(--personal)"),
    card(money0(R.spent), "You spent", "across Personal, Gas and Debt", "var(--surface)"),
    R.topPlace ? card(esc(R.topPlace[0]), "Your top place", `${money0(R.topPlace[1])} all year`, "var(--surface)") : "",
    R.visits ? card(`${R.visits[1]} visits`, "You kept going back to", esc(R.visits[0]), "var(--surface)") : "",
    R.topCat ? card(esc(R.topCat[0]), "Biggest category", money0(R.topCat[1]), "var(--surface)") : "",
    R.topMonth ? card(esc(monthName(R.topMonth[0]).split(" ")[0]), "Biggest month", money0(R.topMonth[1]), "var(--surface)") : "",
    R.biggest ? card(money0(R.biggest.amount), "Biggest single charge", `${esc(R.biggest.desc)}, ${esc(short(R.biggest.date))}`, "var(--surface)") : "",
    card(`${R.streak} days`, "Longest no-spend streak", "from Personal money", "var(--surface)"),
    card(money0(R.saved), "Moved to savings", R.extra ? `plus ${money0(R.extra)} in extra income` : "Every bit counts", "var(--savings)"),
  ].filter(Boolean);
  return `${planTop("Your year", true)}
    ${years.length > 1 ? `<div class="seg" style="margin-bottom:10px">${years.map(v => `<button data-act="recap-y" data-y="${v}" aria-pressed="${v === y}">${v}</button>`).join("")}</div>` : ""}
    <p class="small muted" style="margin:0 0 10px">Swipe through. ${cards.length} cards.</p>
    <div class="rc-row">${cards.join("")}</div>`;
}

/* ---------- tax helper ---------- */
function taxData(y){
  const inc = {}, ded = [];
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])){
    if (!t.date.startsWith(y)) continue;
    if (t.fund === "income"){ const k = merchantOf(t); inc[k] = r2((inc[k] || 0) + +t.amount); }
    if ((t.tags || []).some(g => /^(deductible|tax|taxes|business)$/i.test(g))) ded.push(t);
  }
  const stubs = plan().stubs.filter(s => (s.date || "").startsWith(y));
  const sum = k => r2(stubs.reduce((a, s) => a + (+s[k] || 0), 0));
  const extra = r2(Object.values(inc).reduce((a, v) => a + v, 0)), pct = plan().opts.taxPct === undefined || plan().opts.taxPct === "" ? 25 : +plan().opts.taxPct;
  return {inc: Object.entries(inc).sort((a, b) => b[1] - a[1]), extra, ded, dedTotal: r2(ded.reduce((a, t) => a + +t.amount, 0)), pct, setAside: r2(extra * pct / 100), saved: +((plan().opts.taxSaved || {})[y] || 0), stubs, wh: {gross: sum("gross"), fed: sum("fed"), state: sum("state"), ss: sum("ss"), med: sum("med"), ret: sum("ret")}};
}
function viewTax(){
  const years = [...new Set([todayIso().slice(0, 4), ...periodList().map(p => p.slice(0, 4))])].sort().reverse(), y = S.taxY && years.includes(S.taxY) ? S.taxY : years[0], T = taxData(y);
  return `${planTop("Tax helper", true)}
    <div class="seg" style="margin-bottom:10px">${years.map(v => `<button data-act="tax-y" data-y="${v}" aria-pressed="${v === y}">${v}</button>`).join("")}</div>
    <p class="muted" style="margin:0 0 12px">Not tax advice. It gathers what you’ll want at tax time: extra income (side jobs usually need a 1099 or self-employment tax), what your pay stubs withheld, and charges you tagged #deductible.</p>
    <div class="stats"><div class="stat"><div class="v num">${money0(T.extra)}</div><div class="k">Extra income</div></div><div class="stat"><div class="v num">${money0(T.setAside)}</div><div class="k">To set aside (${T.pct}%)</div></div><div class="stat"><div class="v num">${money0(T.dedTotal)}</div><div class="k">Tagged #deductible</div></div></div>
    <div class="panel"><h3>Set aside for taxes</h3><div class="grid2" style="margin-top:8px"><label class="field"><span>% of extra income</span><input class="input num" data-act="pl-opt" data-k="taxPct" inputmode="decimal" value="${T.pct}"></label><label class="field"><span>Set aside so far in ${y}</span><input class="input num" data-act="tax-saved" data-y="${y}" inputmode="decimal" value="${T.saved || ""}" placeholder="$0"></label></div>
      <p class="small ${T.saved >= T.setAside ? "" : "muted"}" style="margin:0">${T.saved >= T.setAside ? "✓ You’re covered for what’s come in so far." : `${money(T.setAside - T.saved)} more to put aside.`} 25% is a common rough number for side income. A tax pro can give you the right one.</p></div>
    <div class="panel"><h3 style="margin-bottom:6px">Extra income by source</h3>${T.inc.length ? T.inc.map(([k, v]) => `<div class="cat" style="grid-template-columns:1fr auto"><span>${esc(k)}</span><span class="num">${money(v)}</span></div>`).join("") : '<p class="small muted">None this year.</p>'}</div>
    <div class="panel"><h3 style="margin-bottom:6px">From your pay stubs</h3>${T.stubs.length ? `<p class="small muted" style="margin:0 0 6px">${T.stubs.length} stub${T.stubs.length === 1 ? "" : "s"} added for ${y}. Your W-2 is the final word.</p>${[["Gross pay", "gross"], ["Federal tax withheld", "fed"], ["State tax withheld", "state"], ["Social Security", "ss"], ["Medicare", "med"], ["Retirement (401k)", "ret"]].map(([l, k]) => `<div class="cat" style="grid-template-columns:1fr auto"><span>${l}</span><span class="num">${money(T.wh[k])}</span></div>`).join("")}` : `<p class="small muted" style="margin:0">Add pay stubs on the Plan page to total what was withheld.</p>`}</div>
    <div class="panel"><h3 style="margin-bottom:6px">Tagged #deductible (${T.ded.length})</h3>${T.ded.length ? `<div class="list">${T.ded.map(txRow).join("")}</div>` : `<p class="small muted" style="margin:0">Add the tag <b>deductible</b> to any charge (edit it, then Tags) and it shows here.</p>`}</div>
    <button class="btn ghost" data-act="tax-csv" data-y="${y}">Download for my tax person (CSV)</button>`;
}
function taxCsv(y){
  const T = taxData(y), rows = [["Section", "Date", "Description", "Amount", "Category", "Details"]];
  T.inc.forEach(([k, v]) => rows.push(["Extra income", y, k, v, "", ""]));
  for (const p of periodList()) for (const t of (S.periods[p].txns || [])) if (t.date.startsWith(y) && t.fund === "income") rows.push(["Extra income (each)", t.date, t.desc, t.amount, "", t.details || ""]);
  T.ded.forEach(t => rows.push(["Tagged deductible", t.date, t.desc, t.amount, category(t), t.details || ""]));
  Object.entries(T.wh).forEach(([k, v]) => rows.push(["Pay stub totals", y, k, v, "", ""]));
  saveFile(`payday-taxes-${y}.csv`, rows.map(r => r.map(c => { c = String(c ?? ""); return /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c; }).join(",")).join("\n"), "text/csv");
}

/* ---------- Google Sheets export ---------- */
async function sheetsExport(){
  if (!FB.user) return toast("Sign in with Google in Settings → Sync first.");
  try{
    toast("Making your Google Sheet…");
    await getDriveToken();
    const form = new FormData();
    form.append("metadata", new Blob([JSON.stringify({name: `Payday export ${todayIso()}`, mimeType: "application/vnd.google-apps.spreadsheet"})], {type: "application/json"}));
    form.append("file", new Blob([csvText()], {type: "text/csv"}));
    const r = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink", {method: "POST", body: form});
    toast("Google Sheet made. It’s in your Drive.");
    if (r && r.webViewLink) window.open(r.webViewLink, "_blank", "noopener");
  }catch(e){ toast(e && e.status === 403 ? "Turn on the Google Drive API for your Firebase project (guide step 6)." : "Couldn’t make the sheet (" + ((e && (e.code || e.message)) || "error") + ")."); }
}

/* ---------- demo mode: fake data, nothing saved ---------- */
let DEMO = false;
function demoDocs(){
  const t = todayIso(), l = []; let p = addDays(t, -((daysBetween("2026-01-02", t)) % 14)); for (let i = 0; i < 8; i++){ l.unshift(p); p = addDays(p, -14); }
  const places = [["Wawa", 9, "personal"], ["DoorDash", 28, "personal"], ["Wegmans", 64, "personal"], ["Netflix", 15.49, "personal"], ["Amazon", 35, "personal"], ["Sunoco", 42, "gas"], ["Chipotle", 14, "personal"], ["Target", 48, "personal"], ["Spotify", 11.99, "personal"]];
  let seed = 7; const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  const docs = {settings: {...DEFAULTS, selfName: "Sam Demo"}, inbox: {items: [], seen: []}, rules: {map: {}}};
  l.forEach((q, i) => { const tx = []; const end = minIso(addDays(q, 13), t); for (let d = q; d <= end; d = addDays(d, 1)) if (rnd() < 0.55){ const [n, a, f] = places[Math.floor(rnd() * places.length)]; tx.push({id: uid(), date: d, desc: n, amount: r2(a * (0.6 + rnd() * 0.9)), fund: f, src: "chase_bank"}); }
    if (i % 3 === 1) tx.push({id: uid(), date: addDays(q, 5), desc: "Facebook Marketplace sale", amount: 60, fund: "income"});
    tx.push({id: uid(), date: addDays(q, 2), desc: "To PayPal Savings", amount: 400, fund: "savings"});
    docs["p-" + q] = {kind: "period", date: q, amount: 1150, txns: tx}; });
  docs.plan = {...clone(PLAN_DEF), bills: [{id: "d1", name: "Phone", amount: 45, freq: "monthly", due: addDays(t, 3), fund: "personal"}, {id: "d2", name: "Car insurance", amount: 138, freq: "monthly", due: addDays(t, 9), fund: "other"}],
    sinks: [{id: "d3", name: "Car registration", amount: 120, due: addMonthsIso(t, 4), freq: "yearly", saved: 30}], debts: [{id: "d4", name: "Credit card", balance: 1450, apr: 24.99, min: 40, inNW: true}],
    assets: [{id: "d5", name: "Car", value: 7000, kind: "asset"}, {id: "d6", name: "Savings", value: 1800, kind: "asset"}], limits: {Dining: 100}, watch: [{id: "d7", kind: "trial", name: "Hulu", amount: 9.99, date: addDays(t, 2)}],
    gas: [{id: "g1", date: addDays(t, -20), gallons: 11, total: 39, odo: 52000}, {id: "g2", date: addDays(t, -9), gallons: 12, total: 43, odo: 52330}], opts: {apy: 4}};
  return docs;
}
function demoStart(){ DEMO = true; applyDocs(demoDocs()); S.pIdx = null; S.imports = []; closeSheet(); go("home"); toast("Demo mode: made-up data. Nothing you do is saved."); }
function demoEnd(){ DEMO = false; applyDocs(readLocal()); S.pIdx = null; go("home"); toast("Back to your real data."); }

/* ---------- fingerprint / face unlock (on top of the PIN) ---------- */
const bioOk = async () => { try{ return !!(window.PublicKeyCredential && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }catch(_){ return false; } };
const rand = n => crypto.getRandomValues(new Uint8Array(n));
const toB64 = u8 => btoa(String.fromCharCode(...new Uint8Array(u8)));
async function bioSetup(){
  const c = pinCfg(); if (!c) return toast("Set a PIN first. It’s the backup if fingerprint doesn’t work.");
  try{
    const cred = await navigator.credentials.create({publicKey: {challenge: rand(32), rp: {name: "Payday"}, user: {id: rand(16), name: "payday", displayName: "Payday"}, pubKeyCredParams: [{type: "public-key", alg: -7}, {type: "public-key", alg: -257}], authenticatorSelection: {authenticatorAttachment: "platform", userVerification: "required", residentKey: "discouraged"}, timeout: 60000}});
    c.bio = toB64(cred.rawId); lsSet("payday-pin", JSON.stringify(c)); render(); toast("Fingerprint or face unlock is on.");
  }catch(e){ toast("Didn’t finish setting up fingerprint (" + (e.name || "error") + ")."); }
}
async function bioUnlock(){
  const c = pinCfg(); if (!c || !c.bio) return;
  try{ await navigator.credentials.get({publicKey: {challenge: rand(32), allowCredentials: [{type: "public-key", id: b64ToBytes(c.bio.replace(/\+/g, "-").replace(/\//g, "_"))}], userVerification: "required", timeout: 60000}}); unlockUI(); }
  catch(_){ const m = $("#pinMsg"); if (m) m.textContent = "Fingerprint didn’t work. Use your PIN."; }
}

/* ---------- round-ups added to savings automatically ---------- */
function roundupFor(p){ const o = S.plan && S.plan.opts; return o && o.roundups && o.roundupsFrom && p >= o.roundupsFrom && S.periods[p] ? roundUps(p) : 0; }

/* ---------- split a charge with someone ---------- */
function splitSheet(id){
  const f = findTx(id); if (!f) return; const t = f.t;
  openSheet(`<h2>Split ${esc(t.desc)}</h2><p class="muted" style="margin:-6px 0 12px">Only your share stays on this charge. The rest becomes an IOU on the Plan page, so you remember to get paid back.</p>
    <div class="field"><span>Your share</span><div class="seg" id="sp-share">${[["0.5", "Half"], ["0.3333", "A third"], ["0.25", "A quarter"]].map(([v, l], i) => `<button type="button" data-pickd aria-pressed="${i === 0}" data-v="${v}">${l}</button>`).join("")}</div></div>
    <label class="field"><span>Or my share is exactly ($)</span><input class="input num" id="sp-amt" inputmode="decimal" placeholder="${money(t.amount / 2)}"></label>
    <label class="field"><span>Who owes you the rest?</span><input class="input" id="sp-who" placeholder="e.g. Mike" autocomplete="off"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="tx-split-save" data-id="${esc(id)}">Split ${money(t.amount)}</button></div>`);
}
function splitSave(id){
  const f = findTx(id); if (!f) return; const t = f.t, total = +t.amount;
  const who = $("#sp-who").value.trim(); if (!who) return toast("Who owes you the rest?");
  const exact = $("#sp-amt").value.trim(), sh = exact ? r2(parseAmt(exact)) : r2(total * +(($("#sp-share [aria-pressed=true]") || {dataset: {v: "0.5"}}).dataset.v));
  if (!(sh >= 0 && sh < total)) return toast("Your share has to be less than the whole charge.");
  t.amount = sh; t.details = (t.details ? t.details + " • " : "") + `Your share of ${money(total)}, split with ${who}`;
  plan().ious.push({id: uid(), made: todayIso(), who, dir: "me", amount: r2(total - sh), note: t.desc, date: t.date});
  savePeriod(f.p); savePlan(); closeSheet(); render(); toast(`${who} owes you ${money(total - sh)}. It’s on the Plan page.`);
}

/* ---------- events ---------- */
document.addEventListener("click", async e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const a = el.dataset.act, P = plan();
  if (locked && a !== "bio-unlock") return;
  if (a === "push-on") pushOn();
  else if (a === "push-off") pushOff();
  else if (a === "push-test"){ try{ await plaidCall("push_test"); toast("Sent. It should pop up in a few seconds."); }catch(err){ toast(err.message); } }
  else if (a === "stub-flag-net"){ const p = el.dataset.p; S.periods[p].amount = +el.dataset.v; savePeriod(p); render(); toast(`${short(p)} paycheck set to ${money(el.dataset.v)}.`); }
  else if (a === "al-dup-ok"){ P.opts.dupOk = {...(P.opts.dupOk || {}), [el.dataset.k]: todayIso()}; savePlan(); render(); }
  else if (a === "al-flag-ok"){ const ok = {...(P.opts.flagOk || {})}; el.dataset.ids.split(",").forEach(i => ok[i] = 1); P.opts.flagOk = ok; savePlan(); render(); }
  else if (a === "recap-y"){ S.recapY = el.dataset.y; render(); }
  else if (a === "tax-y"){ S.taxY = el.dataset.y; render(); }
  else if (a === "tax-csv") taxCsv(el.dataset.y);
  else if (a === "sheets-export") sheetsExport();
  else if (a === "demo-start") demoStart();
  else if (a === "demo-end") demoEnd();
  else if (a === "bio-setup") bioSetup();
  else if (a === "bio-off"){ const c = pinCfg(); if (c){ delete c.bio; lsSet("payday-pin", JSON.stringify(c)); render(); toast("Fingerprint unlock off."); } }
  else if (a === "bio-unlock") bioUnlock();
  else if (a === "tx-split"){ closeSheet(); splitSheet(el.dataset.id); }
  else if (a === "tx-split-save") splitSave(el.dataset.id);
});
document.addEventListener("change", e => {
  const d = e.target.dataset || {};
  if (e.target.id === "stubIn" && e.target.files.length){ importStub(e.target.files[0]); e.target.value = ""; return; }
  if (d.cemoji !== undefined){ S.settings.catEmoji = {...(S.settings.catEmoji || {}), [d.cemoji]: e.target.value.trim()}; store.save("settings", S.settings); toast("Icon saved."); return; }
  if (d.act === "icons-on"){ S.settings.icons = e.target.checked; store.save("settings", S.settings); toast("Saved."); return; }
  if (d.act === "tax-saved"){ const P = plan(); P.opts.taxSaved = {...(P.opts.taxSaved || {}), [d.y]: r2(parseAmt(e.target.value || "0")) || 0}; savePlan(); render(); return; }
  if (d.act === "roundups-on"){ const P = plan(), l = periodList(); P.opts.roundups = e.target.checked; if (e.target.checked) P.opts.roundupsFrom = l[l.length - 1]; savePlan(); render(); toast(e.target.checked ? "Round-ups now go to savings, starting with this paycheck." : "Round-ups off."); return; }
});

JUMPS.push(["Pay stubs", "stub paystub gross net withholding", () => go("plan")], ["Card statements", "statement closing due date credit card", () => go("plan")], ["Tax helper", "tax 1099 deductible withholding", () => go("tax")], ["Your year (recap)", "wrapped recap year", () => go("recap")], ["Export to Google Sheets", "google sheets drive export", () => sheetsExport()], ["Demo mode", "demo sample fake show", () => demoStart()], ["Automatic pulls and alerts", "push notifications alerts automatic", () => go("accounts")]);
HELP.splice(6, 0,
  ["Automatic pulls and alerts", "After the one-time server step (SETUP-PLAID.txt, part D), your server checks your banks every few hours and new charges land in Review on their own. Turn on alerts on the Accounts tab to get a notification on that device."],
  ["Pay stubs", "Plan → Pay stubs: give it the PDF and Payday reads gross, net and taxes. Check the numbers. It flags raises, overtime, a net that doesn’t match your paycheck, and deductions that jumped."],
  ["Card statements", "Plan → Card statements: enter each card’s closing day and due day. Payday shows what the last statement owes, when it’s due, which paycheck pays it, and what’s building up for the next one."],
  ["Charged twice and unusual charges", "The Paycheck screen warns you when the same charge appears twice on one day, and when a charge is your first at a place over $75 or about 3× what you usually spend there."],
  ["Split a charge", "Edit a charge and tap Split with someone. Only your share stays on the charge, and the rest becomes an IOU."],
  ["Demo mode", "Settings → Your data → Try demo mode shows Payday with made-up data. Nothing is saved. Tap Exit demo to go back."]
);

PLAN_DEF.stubs = []; PLAN_DEF.cards = [];
PSCHEMA.stubs = {one: "pay stub", fields: [["date", "Pay date", "date"], ["gross", "Gross pay", "money"], ["net", "Net pay (take-home)", "money"], ["fed", "Federal tax", "money"], ["state", "State tax", "money"], ["ss", "Social Security", "money"], ["med", "Medicare", "money"], ["ret", "401(k) / retirement", "money"], ["ot", "Overtime pay", "money", "Leave blank if none."]]};
PSCHEMA.cards = {one: "card", fields: [["name", "Card", "text", "", "e.g. Chase Amazon Visa"], ["src", "Charges come from", "select", {chase_amazon: "Chase Amazon card", paypal_mc: "PayPal Mastercard", other: "Other"}], ["closeDay", "Statement closes on day", "number", "The day of the month on your statement, like 3."], ["dueDay", "Payment due on day", "number", "Like 28."]]};
PREQ.stubs = ["date"]; PREQ.cards = ["name", "closeDay", "dueDay"];

try{ const t = localStorage.getItem("payday-theme"); if (t && t !== "auto") document.documentElement.dataset.theme = t; }catch(_){}
function applyZoom(){ const z = parseFloat(lsGet("payday-zoom") || "1") || 1; document.body.style.zoom = z === 1 ? "" : String(z); }
applyZoom(); applyPrivacy(); if (pinCfg()) lockNow();
takeLinkFromUrl(); localBoot(); setupPWA(); initFirebase(); takeSharedFile(); takeShortcut();
// "What changed while you were away" counts from the last time this device was used.
if (!lsGet("payday-lastseen")) lsSet("payday-lastseen", String(Date.now()));
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && !awaySummary()) lsSet("payday-lastseen", String(Date.now())); });
