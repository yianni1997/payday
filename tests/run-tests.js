// Payday tests. Run from a computer with Node 18+:   node tests/run-tests.js
// Loads the app's own code from index.html (no browser needed) and checks the money math.
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm");

const code = ["app.js", "plan.js"].map(f => fs.readFileSync(path.join(__dirname, "..", f), "utf8")).join("\n;\n");

// A do-nothing stand-in for the browser: every property and call just returns another stand-in.
const dummy = () => new Proxy(function(){}, {
  get: (t, k) => k === Symbol.toPrimitive ? (() => "") : k === "then" ? undefined : k === "length" ? 0 : k === Symbol.iterator ? function*(){} : dummy(),
  set: () => true, apply: () => dummy(), construct: () => dummy(), has: () => true,
});
const store = {};
const ctx = {
  console, Math, Date, JSON, Intl, Promise, setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
  localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  document: dummy(), navigator: dummy(), location: { search: "", href: "http://x/", pathname: "/", origin: "http://x", hash: "" },
  history: dummy(), matchMedia: () => ({ matches: false, addEventListener(){} }), addEventListener(){}, removeEventListener(){},
  fetch: () => Promise.reject(new Error("offline")), crypto: require("crypto").webcrypto, TextEncoder, TextDecoder, URL, URLSearchParams, Blob: function(){}, FormData: function(){},
  caches: dummy(), firebase: undefined, pdfjsLib: undefined, JSZip: undefined, Event: function(){}, CustomEvent: function(){}, requestAnimationFrame: () => 0,
};
ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(code + `
;globalThis.__api = {S, calc, periodList, todayIso, addDays, r2, parseQuery, billDates, billPaid, safeInfo, debtSim, sinkShare, whatIf, noSpendInfo, biggestChange, netWorth, gasStats, icsText, plan, addMonthsIso, paychecksUntil, watchArrived, parseStub, cardCycle, dupGroups, unusualCharges, ruleReach, moneyInMatches, recapData, taxData, roundUps, norm, sureFund, checkinData, checkinDue, forecastInfo, upcomingPaychecks, parseBankText, debtBal, challengeInfo, suggestedLimits, tagSpent, weekSpent, monthlyNeed};`, ctx, { filename: "app.js+plan.js" });
const A = ctx.__api;

let pass = 0, fail = 0;
function eq(name, got, want){
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++; else { fail++; console.log("✗ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want)); }
}
function near(name, got, want, tol = 0.011){ if (Math.abs(got - want) <= tol) pass++; else { fail++; console.log(`✗ ${name}: got ${got}, want ${want}`); } }

// ---------- sample data ----------
function reset(today){
  const S = A.S;
  S.settings = { personalPct: 0.44, savingsPct: 0.46, debtPct: 0.05, gasBudget: 60, extraSavingsPct: 0.5, extraGasPct: 0, leftoverFrom: "2026-10-16", leftoverSavePct: 0.5, selfName: "Me" };
  S.periods = {}; S.inbox = { items: [], seen: [] }; S.rules = { map: {} }; S.plan = undefined;
  ctx.Date = class extends Date { constructor(...a){ super(...(a.length ? a : [today + "T12:00:00"])); } static now(){ return new Date(today + "T12:00:00").getTime(); } };
}
const tx = (date, amount, fund = "personal", desc = "Store") => ({ id: Math.random().toString(36).slice(2), date, amount, fund, desc });

// ---------- calc: the split, carryover and leftover ----------
reset("2026-11-08");
A.S.periods["2026-10-02"] = { date: "2026-10-02", amount: 1000, txns: [tx("2026-10-05", 500)] };            // 440 budget, overspent by 60
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [tx("2026-10-20", 280)] };            // 440 - 60 carried - 280 = 100 left
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 50), tx("2026-11-02", 20, "gas")] };
let c = A.calc("2026-10-02");
eq("personal budget is 44% of pay", c.personalBudget, 440);
eq("overspent first paycheck", c.personalLeft, -60);
c = A.calc("2026-10-16");
eq("overspending carries in", c.carry, 60);
eq("left after carry", c.personalLeft, 100);
c = A.calc("2026-10-30");
eq("half of leftover rolls in (as negative carry)", c.carry, -50);
eq("other half goes to savings", c.leftoverSave, 50);
eq("savings = 46% + leftover half", c.savings, 510);
eq("personal left with rollover", c.personalLeft, 440 + 50 - 50);
eq("gas left", c.gasLeft, 40);

// ---------- dates ----------
eq("month add clamps to month end", A.addMonthsIso("2026-01-31", 1), "2026-02-28");
eq("monthly bill keeps its day after a short month", A.billDates({ due: "2026-01-31", freq: "monthly" }, "2026-03-01", "2026-03-31"), ["2026-03-31"]);
eq("every-2-weeks bill dates", A.billDates({ due: "2026-11-01", freq: "biweekly" }, "2026-11-01", "2026-11-30"), ["2026-11-01", "2026-11-15", "2026-11-29"]);
eq("one-time bill only once", A.billDates({ due: "2026-11-10", freq: "once" }, "2026-11-01", "2027-11-30"), ["2026-11-10"]);

// ---------- safe to spend ----------
reset("2026-11-08");
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 100), tx("2026-11-07", 39.5, "personal", "VERIZON WIRELESS")] };
A.plan().bills = [
  { id: "b1", name: "Phone", amount: 40, freq: "monthly", due: "2026-11-07", fund: "personal", match: "verizon" }, // already paid (charge on Nov 7)
  { id: "b2", name: "Spotify", amount: 12, freq: "monthly", due: "2026-11-10", fund: "personal" },                   // due, not paid
  { id: "b3", name: "Car loan", amount: 200, freq: "monthly", due: "2026-11-11", fund: "other" },                     // not from Personal
];
eq("bill matched to its charge counts as paid", A.billPaid(A.plan().bills[0], "2026-11-07"), true);
eq("bill without a charge is unpaid", A.billPaid(A.plan().bills[1], "2026-11-10"), false);
let si = A.safeInfo();
eq("only unpaid Personal bills before payday count", si.billsDue, 12);
eq("safe = left - bills", si.safe, A.r2(440 - 139.5 - 12));
eq("days left counts today", si.daysLeft, 5);           // Nov 8..12
near("per day", si.perDay, A.r2((440 - 139.5 - 12) / 5));
// pace: day 10 of 14, should have spent 440*10/14 = 314.29 by now; spent 139.5 → under pace
near("pace: under by", si.diff, 440 * 10 / 14 - 139.5);

// yearly costs count against Personal until set aside
A.plan().sinks = [{ id: "s1", name: "Registration", amount: 120, due: "2026-12-20", freq: "yearly", saved: 0 }];
eq("paychecks until Dec 20 from Nov 8 (this one + Nov 13 + Nov 27 + Dec 11)", A.paychecksUntil("2026-12-20"), 4);
eq("share per paycheck", A.sinkShare(A.plan().sinks[0], "2026-10-30"), 30);
eq("safe includes yearly share", A.safeInfo().sinksDue, 30);
A.plan().sinks[0].setFor = "2026-10-30";
eq("set aside this paycheck = no longer counted", A.safeInfo().sinksDue, 0);

// ---------- debt payoff ----------
const D = [{ name: "Card", balance: 1000, apr: 24, min: 30 }, { name: "Loan", balance: 500, apr: 6, min: 25 }];
const av = A.debtSim(D, 150, "avalanche"), sb = A.debtSim(D, 150, "snowball");
eq("avalanche pays the card first", av.done.Card < av.done.Loan, true);
eq("snowball pays the small loan first", sb.done.Loan < sb.done.Card, true);
eq("avalanche costs less interest", av.interest <= sb.interest, true);
eq("payments below interest never finish", A.debtSim([{ name: "X", balance: 10000, apr: 30, min: 10 }], 10, "avalanche").stuck, true);
// 0% loan: 1000 at 100/month = 10 months, no interest
const z = A.debtSim([{ name: "Z", balance: 1000, apr: 0, min: 100 }], 100, "avalanche");
eq("zero interest months", z.months, 10); eq("zero interest cost", z.interest, 0);

// ---------- what-if replays your paychecks ----------
reset("2026-11-08");
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [tx("2026-10-20", 400)] };
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 400)] };
const wi = A.whatIf({ personalPct: 0.40, savingsPct: 0.50 }, 2);
eq("what-if leaves real settings alone", A.S.settings.personalPct, 0.44);
eq("what-if personal left on first", wi[0].b.personalLeft, 0);
eq("actual personal left on first", wi[0].a.personalLeft, 40);

// ---------- smart search ----------
let q = A.parseQuery("doordash over $25 since august");
eq("words", q.words, ["doordash"]);
eq("min", q.F.min, 25);
eq("since a month means the 1st of the latest August", q.F.from, "2026-08-01");
q = A.parseQuery("cat:dining <10 last month");
eq("category", q.F.cat, "dining"); eq("max", q.F.max, 10);
eq("last month range", [q.F.from, q.F.to], ["2026-10-01", "2026-10-31"]);
q = A.parseQuery("gas in september #trip amount:>=100");
eq("in a month", [q.F.from, q.F.to], ["2026-09-01", "2026-09-30"]);
eq("tag", q.F.tag, "trip"); eq("amount op", q.F.min, 100); eq("gas stays a word", q.words, ["gas"]);
q = A.parseQuery("since december");
eq("since a future month means last year", q.F.from, "2025-12-01");

// ---------- streaks and changes ----------
reset("2026-11-08");
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [tx("2026-10-17", 30, "personal", "Pizza Hut")] };
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-10-31", 80, "personal", "Pizza Hut"), tx("2026-11-05", 5)] };
eq("no-spend streak (Nov 6, 7, 8)", A.noSpendInfo().streak, 3);
const bc = A.biggestChange();
eq("biggest change vs same point last paycheck", [bc.k, bc.d], ["Dining", 50]);

// ---------- net worth ----------
reset("2026-11-08");
A.plan().assets = [{ id: "a", name: "Car", value: 8000, kind: "asset" }, { id: "b", name: "Mom loan", value: 500, kind: "owe" }];
A.plan().debts = [{ id: "d", name: "Card", balance: 1200, apr: 20, min: 40, inNW: true }, { id: "e", name: "Old", balance: 300, apr: 0, min: 0, inNW: false }];
A.plan().balances = { x: { name: "Checking", type: "depository", cur: 900 }, y: { name: "Amazon card", type: "credit", cur: 250 } };
eq("net worth", A.netWorth().total, 900 - 250 + 8000 - 500 - 1200);

// ---------- gas log ----------
reset("2026-11-08");
A.plan().gas = [{ id: "1", date: "2026-10-01", gallons: 10, total: 30, odo: 1000 }, { id: "2", date: "2026-10-10", gallons: 10, total: 32, odo: 1300 }, { id: "3", date: "2026-10-20", gallons: 8, total: 28, odo: 1540 }];
const gs = A.gasStats();
eq("miles per gallon", gs.mpg, 30);
near("price per gallon", gs.ppg, 90 / 28);
near("cost per mile", gs.cpm, 60 / 540, 0.0005);

// ---------- refunds and calendar file ----------
reset("2026-11-08");
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-04", -24.99, "personal", "AMAZON REFUND")] };
eq("refund shows up", !!A.watchArrived({ kind: "refund", amount: 24.99, made: "2026-11-01" }), true);
eq("refund before you added it doesn't count", !!A.watchArrived({ kind: "refund", amount: 24.99, made: "2026-11-06" }), false);
A.plan().bills = [{ id: "b", name: "Rent", amount: 900, freq: "monthly", due: "2026-12-01" }];
const ics = A.icsText();
eq("calendar has the bill", /SUMMARY:Rent \$900\.00/.test(ics) && /RRULE:FREQ=MONTHLY/.test(ics), true);
eq("calendar has paydays", /RRULE:FREQ=WEEKLY;INTERVAL=2/.test(ics), true);

// ---------- v43 ----------
reset("2026-11-08");
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 10.25), tx("2026-11-02", 4.5)] };
eq("round-ups add up", A.roundUps("2026-10-30"), 1.25);
A.plan().opts = { roundups: true, roundupsFrom: "2026-10-30" };
c = A.calc("2026-10-30");
eq("round-ups leave Personal", c.personalLeft, A.r2(440 - 14.75 - 1.25));
eq("round-ups join savings", c.savings, A.r2(460 + 1.25));
A.plan().opts = {};
eq("round-ups off = no change", A.calc("2026-10-30").personalLeft, A.r2(440 - 14.75));

const st = A.parseStub("ACME Corp\nPay Date: 11/06/2026\nGross Pay 1,642.31 18,220.00\nFederal Income Tax 142.10\nSocial Security 101.82\nMedicare 23.81\nNY State Tax 61.20\n401(k) 82.12\nNet Pay 1,231.26");
eq("stub parse", [st.date, st.gross, st.net, st.fed, st.state, st.ss, st.med, st.ret], ["2026-11-06", 1642.31, 1231.26, 142.1, 61.2, 101.82, 23.81, 82.12]);

reset("2026-11-08");
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [Object.assign(tx("2026-10-20", 100), { src: "chase_amazon" }), Object.assign(tx("2026-11-02", 40), { src: "chase_amazon" })] };
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [Object.assign(tx("2026-11-05", 25), { src: "chase_amazon" }), Object.assign(tx("2026-11-05", 99), { src: "paypal" })] };
const cy = A.cardCycle({ src: "chase_amazon", closeDay: 3, dueDay: 28 });
eq("statement period", [cy.stmt.from, cy.stmt.to, cy.stmt.due], ["2026-10-04", "2026-11-03", "2026-11-28"]);
eq("statement amount (only that card, only that period)", cy.stmt.amt, 140);
eq("paid from the paycheck before the due date", cy.stmt.pay, "2026-11-27");
eq("current cycle so far", [cy.cur.amt, cy.cur.to, cy.cur.due], [25, "2026-12-03", "2026-12-28"]);
eq("month-end close day clamps", A.cardCycle({ src: "x", closeDay: 31, dueDay: 25 }, "2026-11-08").stmt.to, "2026-10-31");

reset("2026-11-08");
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [tx("2026-10-17", 6, "personal", "WAWA 123"), tx("2026-10-19", 7, "personal", "WAWA 77"), tx("2026-10-22", 5, "personal", "WAWA 9")] };
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 12.99, "personal", "NETFLIX"), tx("2026-11-01", 12.99, "personal", "NETFLIX"), tx("2026-11-02", 30, "personal", "WAWA 5"), tx("2026-11-03", 180, "personal", "BEST BUY")] };
eq("charged twice found", A.dupGroups().length, 1);
A.plan().opts.dupOk = { [A.dupGroups()[0].k]: "2026-11-08" };
eq("dismissed duplicate stays quiet", A.dupGroups().length, 0);
eq("unusual: 5x usual + new big place", A.unusualCharges().map(x => x.desc).sort(), ["BEST BUY", "WAWA 5"]);
eq("rule reach counts matching charges", A.ruleReach(A.norm("WAWA 1")), 4);

reset("2026-11-08");
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-04", -30, "personal", "AMAZON REFUND"), tx("2026-11-05", 30, "income", "VENMO FROM MIKE")] };
eq("IOU ignores store refunds, takes Venmo", A.moneyInMatches(30, "2026-11-01", "Mike").map(x => x.desc), ["VENMO FROM MIKE"]);
eq("refund reminders take any money back", A.moneyInMatches(30, "2026-11-01").length, 2);
const tx2 = Object.assign(tx("2026-03-03", 50, "personal", "Pizza"), {}); A.S.periods["2026-03-01"] = { date: "2026-03-01", amount: 900, txns: [tx2, tx("2026-03-09", 20, "income", "Etsy"), Object.assign(tx("2026-03-10", 15, "personal", "Staples"), { tags: ["deductible"] })] };
const T = A.taxData("2026");
eq("tax: extra income + deductible", [T.extra, T.dedTotal, T.setAside], [50, 15, 12.5]);
eq("recap totals", A.recapData("2026").spent, 50 + 15 - 30);

// ---------- v44 ----------
reset("2026-11-03");
A.S.periods["2026-10-02"] = { date: "2026-10-02", amount: 1000, txns: [1, 2, 3, 4, 5].map(i => tx("2026-10-0" + (i + 2), 6 + i, "personal", "WAWA " + i)).concat([tx("2026-10-04", 80, "personal", "Pizza Hut"), tx("2026-10-05", 30, "personal", "Pizza Hut")]) };
A.S.periods["2026-10-16"] = { date: "2026-10-16", amount: 1000, txns: [tx("2026-10-20", 40, "gas", "SUNOCO"), tx("2026-10-21", 40, "personal", "SUNOCO"), ...[1, 2, 3].map(i => tx("2026-10-2" + i, 40, "gas", "SUNOCO"))] };
eq("sure: 5 Wawas, normal amount", A.sureFund({ flow: -9, desc: "WAWA 88" }), "personal");
eq("not sure: way bigger than usual", A.sureFund({ flow: -40, desc: "WAWA 88" }), null);
eq("not sure: mixed funds", A.sureFund({ flow: -40, desc: "SUNOCO" }), null);
eq("not sure: too few visits", A.sureFund({ flow: -20, desc: "Pizza Hut" }), null);
eq("not sure: money coming in", A.sureFund({ flow: 9, desc: "WAWA 88" }), null);
A.S.periods["2026-09-04"] = { date: "2026-09-04", amount: 1000, txns: [tx("2026-09-10", 50, "personal", "Pizza Hut")] };
const ci = A.checkinData("2026-10");
eq("check-in month total", ci.cur.total, A.r2(7+8+9+10+11+80+30+40));
eq("check-in vs usual", ci.avg, 50);
eq("check-in due early in the month", A.checkinDue(), true);
A.plan().opts.checkinSeen = "2026-10";
eq("check-in not due once seen", A.checkinDue(), false);

// ---------- v45 ----------
reset("2026-11-08");
A.S.periods["2026-10-30"] = { date: "2026-10-30", amount: 1000, txns: [tx("2026-11-01", 100), tx("2026-11-06", 100, "debt", "CHASE CARD PAYMENT")] };
let I5 = A.safeInfo(), F5 = A.forecastInfo(I5);
eq("forecast: 10/day so far, 4 more days", F5.end, A.r2(340 - 10 * 4));
eq("forecast: half of leftover to savings", F5.toSave, 150);
eq("week so far (Mon Nov 2 – Sun Nov 8)", A.weekSpent(), 0);
A.plan().bills = [{ id: "b", name: "Rent", amount: 300, freq: "monthly", due: "2026-11-20", fund: "personal" }];
const U5 = A.upcomingPaychecks(3);
eq("rent lands on the Nov 13 paycheck", [U5[1].start, U5[1].fromPersonal, U5[1].free], ["2026-11-13", 300, 140]);
eq("bank text", A.parseBankText("Chase: You made a $12.50 transaction with WAWA 8123 on Nov 7, 2026 at 3:02 PM"), { amount: 12.5, desc: "WAWA 8123", date: "2026-11-07" });
eq("bank text with slash date", A.parseBankText("PayPal: You sent $40.00 USD to John Smith. 11/05").desc, "John Smith");
eq("debt balance drops with payments after you set it", A.debtBal({ name: "Chase", balance: 1000, match: "chase card", asOf: "2026-11-01" }), 900);
eq("payments before then don't count", A.debtBal({ name: "Chase", balance: 1000, match: "chase card", asOf: "2026-11-07" }), 1000);
A.plan().challenge = { start: "2026-11-02", days: 7, cats: [] };
const CH = A.challengeInfo();
eq("challenge clean days", [CH.elapsed, CH.clean], [7, 7]);
A.S.periods["2026-10-30"].txns.push(tx("2026-11-04", 9));
eq("a slip breaks a day", A.challengeInfo().clean, 6);
A.S.periods["2026-10-30"].txns.push(Object.assign(tx("2026-11-04", 55), { tags: ["vacation"] }), Object.assign(tx("2026-11-04", -5), { tags: ["vacation"] }));
eq("tag spent (refunds count back)", A.tagSpent("vacation"), 50);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
