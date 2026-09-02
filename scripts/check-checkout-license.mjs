// WHICH LICENSE KEY DOES THE THANK-YOU PAGE SHOW?
//
//   node scripts/check-checkout-license.mjs
//
// A customer who buys a second subscription -- a second machine, which is a
// real thing we sell -- already holds a granted key. The first version of this
// endpoint took `.find()`'s first match, which is very likely the key already
// activated on machine one: the page handed them a key they could not use and
// said nothing about it.
//
// Drives the real handler against a stubbed Polar. What is under test is which
// key comes back, and that is decided entirely by the checkout's timestamp
// versus each key's own.

import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// pathToFileURL: a Windows absolute path is not a valid ESM specifier.
const mod = await import(pathToFileURL(path.join(HERE, '..', 'src', 'index.js')).href);

let fails = 0;
const ok = (what, cond, got) => {
  if (cond) { console.log('  PASS ' + what); return; }
  fails += 1;
  console.log('  FAIL ' + what + '  ' + JSON.stringify(got));
};

const CO = '11111111-2222-4333-8444-555555555555';
const CUST = 'cus_1';
const iso = (ms) => new Date(ms).toISOString();
const T0 = Date.parse('2026-09-02T12:00:00.000Z');

// Polar, as far as this handler is concerned.
function polar({ checkout, keys }) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/v1/checkouts/')) {
      return { ok: true, json: async () => checkout };
    }
    if (u.includes('/v1/license-keys/')) {
      return { ok: true, json: async () => ({ items: keys, pagination: { max_page: 1 } }) };
    }
    throw new Error('unexpected fetch ' + u);
  };
}

async function ask({ checkout, keys }) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = polar({ checkout, keys });
  try {
    const res = await mod.default.fetch(
      new Request(`https://ryli.app/api/checkout-license?checkout_id=${CO}`),
      { POLAR_OAT: 'test-token' }
    );
    return await res.json();
  } finally {
    globalThis.fetch = realFetch;
  }
}

const checkout = (at) => ({ id: CO, status: 'succeeded', customer_id: CUST, created_at: iso(at) });
const key = (id, at, customer = CUST) => ({
  id, key: 'RYLI-' + id, customer_id: customer, status: 'granted', created_at: iso(at),
});

console.log('');
console.log('  ---- a first purchase');
{
  const r = await ask({ checkout: checkout(T0), keys: [key('A', T0 + 4000)] });
  ok('shows the key that was just granted', r.ok && r.key === 'RYLI-A', r);
}
{
  // The webhook has not landed yet. This is the ordinary few-second race the
  // client already retries through.
  const r = await ask({ checkout: checkout(T0), keys: [] });
  ok('says processing while the key is still being granted',
    !r.ok && r.reason === 'processing', r);
}

console.log('');
console.log('  ---- a second machine: the reported bug');
{
  const older = key('OLD', T0 - 86400000);      // bought yesterday, in use
  const fresh = key('NEW', T0 + 3000);          // this purchase
  const r = await ask({ checkout: checkout(T0), keys: [older, fresh] });
  ok('shows the NEW key, not the one already on machine one',
    r.ok && r.key === 'RYLI-NEW', r);
  // Order must not decide it.
  const r2 = await ask({ checkout: checkout(T0), keys: [fresh, older] });
  ok('...whichever order Polar happens to list them in',
    r2.ok && r2.key === 'RYLI-NEW', r2);
}
{
  // Five machines: four already held, the fifth just bought.
  const held = [1, 2, 3, 4].map((n) => key('H' + n, T0 - n * 3600000));
  const fresh = key('FIFTH', T0 + 5000);
  const r = await ask({ checkout: checkout(T0), keys: [...held, fresh] });
  ok('the fifth purchase shows the fifth key', r.ok && r.key === 'RYLI-FIFTH', r);
}
{
  // The same second-purchase page, polled BEFORE the new key exists. It must
  // not fall back to an older key just because one is there.
  const older = key('OLD', T0 - 86400000);
  const r = await ask({ checkout: checkout(T0), keys: [older] });
  ok('never shows an older key while the new one is still coming',
    !r.ok && r.reason === 'processing', r);
}

console.log('');
console.log('  ---- other people');
{
  const mine = key('MINE', T0 + 2000);
  const theirs = key('THEIRS', T0 + 2500, 'cus_2');
  const r = await ask({ checkout: checkout(T0), keys: [theirs, mine] });
  ok('another customer\'s newer key is never shown', r.ok && r.key === 'RYLI-MINE', r);
}

console.log('');
console.log('  ---- when the checkout has no usable timestamp');
{
  const noAt = { id: CO, status: 'succeeded', customer_id: CUST };
  const r = await ask({ checkout: noAt, keys: [key('ONLY', T0)] });
  ok('one key is still unambiguous', r.ok && r.key === 'RYLI-ONLY', r);
  const r2 = await ask({ checkout: noAt, keys: [key('A', T0), key('B', T0 + 10)] });
  ok('...but several are not, so it falls back rather than guessing',
    !r2.ok && r2.reason === 'multiple', r2);
}

console.log('');
console.log('  ---- when the KEYS have no usable timestamp');
{
  // Failing closed here would break the common case to protect the rare one:
  // a first-time buyer would poll and never be shown their key.
  const undated = { id: 'U', key: 'RYLI-U', customer_id: CUST, status: 'granted' };
  const r = await ask({ checkout: checkout(T0), keys: [undated] });
  ok('a lone undated key is still shown', r.ok && r.key === 'RYLI-U', r);
  const r2 = await ask({
    checkout: checkout(T0),
    keys: [undated, { id: 'V', key: 'RYLI-V', customer_id: CUST, status: 'granted' }],
  });
  ok('...and several undated ones fall back rather than guessing',
    !r2.ok && r2.reason === 'multiple', r2);
}

console.log('');
console.log('  ---- a checkout that has not completed');
{
  const r = await ask({
    checkout: { id: CO, status: 'open', customer_id: null, created_at: iso(T0) }, keys: [],
  });
  ok('is processing, not an error', !r.ok && r.reason === 'processing', r);
}

console.log('');
console.log(fails ? '  FAILURES: ' + fails : '  ALL PASS');
process.exitCode = fails ? 1 : 0;
