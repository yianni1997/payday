// Builds the LifeBud summary on the server by running Payday's OWN page code (app.js, plan.js, lblink.js)
// in a sandbox, so the numbers always match what Payday shows, with no second copy of the math to drift.
// Used by index.js on the Cloud Scheduler run, and by tests/run-tests.js.
'use strict';
const vm = require('vm');

// A do-nothing stand-in for the browser: every property and call returns another stand-in.
const dummy = () => new Proxy(function(){}, {
  get: (t, k) => k === Symbol.toPrimitive ? (() => '') : k === 'then' ? undefined : k === 'length' ? 0 : k === Symbol.iterator ? function*(){} : dummy(),
  set: () => true, apply: () => dummy(), construct: () => dummy(), has: () => true,
});

// code: app.js + plan.js + lblink.js joined. docs: {docId: data} from users/<uid>/docs.
// opts.url: the Payday page address (goes in the summary). opts.items: fresh Plaid items for balances.
// opts.now: a fixed time (tests only).
function buildSummary(code, docs, opts = {}){
  const store = {}, url = new URL(opts.url || 'https://payday.invalid/');
  const RealDate = Date, fixed = opts.now ? new RealDate(opts.now).getTime() : null;
  const D = fixed === null ? RealDate : class extends RealDate { constructor(...a){ super(...(a.length ? a : [fixed])); } static now(){ return fixed; } };
  const ctx = {
    console: { log(){}, warn(){}, error(){}, info(){} }, Math, Date: D, JSON, Intl, Promise,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
    sessionStorage: { getItem: () => null, setItem(){}, removeItem(){} },
    document: dummy(), navigator: dummy(), history: dummy(), caches: dummy(),
    location: { search: '', hash: '', href: url.href, pathname: url.pathname, origin: url.origin },
    matchMedia: () => ({ matches: false, addEventListener(){} }), addEventListener(){}, removeEventListener(){},
    fetch: () => Promise.reject(new Error('offline')), crypto: require('crypto').webcrypto,
    TextEncoder, TextDecoder, URL, URLSearchParams, Blob: function(){}, FormData: function(){},
    firebase: undefined, pdfjsLib: undefined, JSZip: undefined, Event: function(){}, CustomEvent: function(){}, requestAnimationFrame: () => 0,
    atob: s => Buffer.from(s, 'base64').toString('binary'), btoa: s => Buffer.from(s, 'binary').toString('base64'),
  };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code + `
;globalThis.__build = function(docs, items){
  applyDocs(docs); S.ready = true;
  // New bank charges the server pulled but the page hasn't taken in yet: run them through the
  // page's own import rules, so duplicates and already-seen charges aren't counted in Review.
  const ap = (S.autopull && S.autopull.items) || [], groups = {};
  for (const it of ap){ const src = plaidSrc(it.inst || "", {id: it.accountId, type: it.type, subtype: it.subtype}); if (src === "off") continue; (groups[src] = groups[src] || []).push({date: it.date, desc: (it.desc || "Charge").trim(), flow: +it.flow}); }
  for (const [src, list] of Object.entries(groups)) addImport({id: uid(), name: "server", state: "parsing", flip: false, items: list, src});
  if (Array.isArray(items)){ PL.items = items; cacheBalances(); }
  return lbSummary();
};`, ctx, { filename: 'payday-page-code.js', timeout: 10000 });
  return ctx.__build(JSON.parse(JSON.stringify(docs)), opts.items || null);
}
module.exports = { buildSummary };
