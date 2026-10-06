import test from 'node:test';
import assert from 'node:assert/strict';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { assess, validateNotice } from '../src/analyze.mjs';
import { refine } from '../src/llm.mjs';
import { makeHandler } from '../src/handler.mjs';

const NOW = new Date('2026-10-06T12:00:00Z');

test('rules find categories, systems and actions', () => {
  const r = assess({ title: 'Fee schedule update', body: 'Clearing fees will increase from 1 November. The FIX session gateway moves to a new IP range.', effectiveDate: '2026-11-01' }, { now: NOW });
  assert.equal(r.impact, 'high');
  assert.deepEqual(r.categories, ['fee_change', 'connectivity']);
  assert.ok(r.affectedSystems.includes('billing') && r.affectedSystems.includes('connectivity'));
  assert.equal(r.urgent, false);
});

test('a medium change that takes effect within 3 days becomes high and urgent', () => {
  const r = assess({ title: 'Holiday', body: 'The market will be closed on Thursday.', effectiveDate: '2026-10-08' }, { now: NOW });
  assert.deepEqual([r.impact, r.urgent, r.daysUntilEffective], ['high', true, 2]);
});

test('nothing recognised is low impact', () => {
  assert.equal(assess({ title: 'Newsletter', body: 'Our team welcomes a new member.' }, { now: NOW }).impact, 'low');
});

test('validation reports every problem', () => {
  assert.deepEqual(validateNotice({ id: 'bad id!', venue: '', title: 'x', body: '', effectiveDate: 'soon' }), [
    'id: 1-128 chars of letters, digits, . : _ -', 'venue: required', 'body: required', 'effectiveDate: must be an ISO date',
  ]);
});

test('the LLM can raise the impact but never lower it', async () => {
  const base = assess({ title: 'API change', body: 'The REST API v1 endpoint is deprecated.' }, { now: NOW });
  const lower = await refine({ title: 't', body: 'b' }, base, { complete: async () => '{"impact":"low","summary":"minor"}' });
  assert.equal(lower.impact, 'high');
  const low = assess({ title: 'Note', body: 'General update.' }, { now: NOW });
  const raised = await refine({ title: 't', body: 'b' }, low, { complete: async () => '```json\n{"impact":"medium","summary":"check it"}\n```' });
  assert.deepEqual([raised.impact, raised.source, raised.summary], ['medium', 'rules+llm', 'check it']);
});

test('a slow, failing or off-schema model falls back to the rules', async () => {
  const base = assess({ title: 'Holiday', body: 'Market closed.' }, { now: NOW });
  const events = [];
  const hang = (_p, signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  assert.equal((await refine({ title: 't', body: 'b' }, base, { complete: hang, timeoutMs: 20, log: (e) => events.push(e) })).source, 'rules');
  assert.equal((await refine({ title: 't', body: 'b' }, base, { complete: async () => { throw new Error('503'); }, log: (e) => events.push(e) })).source, 'rules');
  assert.equal((await refine({ title: 't', body: 'b' }, base, { complete: async () => '{"impact":"extreme"}', log: (e) => events.push(e) })).source, 'rules');
  assert.deepEqual(events.map((e) => e.reason), ['timeout', '503', 'off-schema reply']);
});

// In-memory fakes with the same send() contract as the AWS SDK clients.
function fakes() {
  const table = new Map();
  const objects = new Map();
  const ddb = {
    async send(cmd) {
      const name = cmd.constructor.name;
      if (name === 'PutItemCommand') {
        const id = cmd.input.Item.pk.S;
        if (table.has(id)) throw new ConditionalCheckFailedException({ message: 'exists', $metadata: {} });
        table.set(id, cmd.input.Item);
        return {};
      }
      if (name === 'GetItemCommand') return { Item: table.get(cmd.input.Key.pk.S) };
      throw new Error('unexpected ' + name);
    },
  };
  const s3 = { async send(cmd) { objects.set(cmd.input.Key, cmd.input.Body); return {}; } };
  return { ddb, s3, table, objects };
}

const post = (body) => ({ requestContext: { http: { method: 'POST' } }, rawPath: '/notices', body: JSON.stringify(body) });
const get = (id) => ({ requestContext: { http: { method: 'GET' } }, rawPath: `/notices/${id}` });

test('POST is idempotent on id; GET returns the stored assessment', async () => {
  const f = fakes();
  const h = makeHandler({ ...f, table: 't', bucket: 'b', model: null, now: () => NOW });
  const notice = { id: 'XLON-2026-114', venue: 'LSE', title: 'Tick size change', body: 'New tick size table for FTSE 100 constituents.', effectiveDate: '2026-10-20' };

  const first = await h(post(notice));
  assert.equal(first.statusCode, 201);
  assert.equal(JSON.parse(first.body).impact, 'high');

  const again = await h(post({ ...notice, body: 'Edited text sent under the same id.' }));
  assert.equal(again.statusCode, 200);
  assert.equal(JSON.parse(again.body).duplicate, true);
  assert.equal(f.table.size, 1);
  assert.equal(f.objects.size, 2, 'a different body under the same id must not overwrite the original object');

  const read = JSON.parse((await h(get('XLON-2026-114'))).body);
  assert.deepEqual([read.venue, read.impact, read.categories[0]], ['LSE', 'high', 'risk_parameters']);
});

test('bad input is a 400, unknown routes a 404, storage errors a 500', async () => {
  const f = fakes();
  const h = makeHandler({ ...f, table: 't', bucket: 'b', model: null, now: () => NOW });
  assert.equal((await h({ requestContext: { http: { method: 'POST' } }, rawPath: '/notices', body: '{' })).statusCode, 400);
  assert.equal((await h(post({ id: 'x' }))).statusCode, 400);
  assert.equal((await h(get('missing'))).statusCode, 404);
  assert.equal((await h({ requestContext: { http: { method: 'DELETE' } }, rawPath: '/notices/x' })).statusCode, 404);
  const broken = makeHandler({ ddb: { send: async () => { throw new Error('throttled'); } }, s3: f.s3, table: 't', bucket: 'b', model: null });
  assert.equal((await broken(post({ id: 'a', venue: 'v', title: 't', body: 'b' }))).statusCode, 500);
});
