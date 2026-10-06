// End-to-end check against a deployed stack: API_URL=https://xxx.execute-api.region.amazonaws.com node scripts/e2e.mjs
import assert from 'node:assert/strict';

const base = process.env.API_URL;
if (!base) throw new Error('set API_URL');
const id = `e2e-${Date.now()}`;
const notice = {
  id,
  venue: 'XAMS',
  title: 'FIX gateway migration and fee update',
  body: 'The FIX session gateway moves to a new IP range on 1 December. Clearing fees will increase from the same date.',
  effectiveDate: '2026-12-01',
};
const call = async (method, path, body) => {
  const t = Date.now();
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  const json = await res.json();
  console.log(method, path, res.status, `${Date.now() - t} ms`);
  return { status: res.status, json };
};

const first = await call('POST', '/notices', notice);
assert.equal(first.status, 201);
assert.equal(first.json.impact, 'high');
assert.deepEqual(first.json.categories, ['fee_change', 'connectivity']);

const dup = await call('POST', '/notices', notice);
assert.equal(dup.status, 200);
assert.equal(dup.json.duplicate, true);

const read = await call('GET', `/notices/${id}`);
assert.equal(read.status, 200);
assert.equal(read.json.venue, 'XAMS');

assert.equal((await call('POST', '/notices', { id: 'x' })).status, 400);
assert.equal((await call('GET', '/notices/does-not-exist')).status, 404);
console.log('e2e ok');
