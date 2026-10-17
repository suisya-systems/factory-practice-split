'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/app');
const { Store } = require('../src/store');

async function withServer(fn, dataDir) {
  const server = http.createServer(createApp(new Store(dataDir)));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : {},
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  try {
    await fn(call);
  } finally {
    server.close();
  }
}

async function setup(call, names) {
  const g = (await call('POST', '/groups', { name: 'trip' })).body;
  const ms = [];
  for (const name of names) ms.push((await call('POST', `/groups/${g.id}/members`, { name })).body);
  return { g, ms };
}

test('basic flow and settlement', () =>
  withServer(async (call) => {
    const { g, ms } = await setup(call, ['A', 'B', 'C']);
    const [a, b, c] = ms;
    let r = await call('POST', `/groups/${g.id}/expenses`, {
      payerId: a.id, beneficiaryIds: [a.id, b.id, c.id], amount: 3000, description: 'dinner',
    });
    assert.strictEqual(r.status, 201);
    assert.strictEqual(r.body.amount, 3000);
    const eid = r.body.id;
    r = await call('GET', `/groups/${g.id}/expenses/${eid}`);
    assert.strictEqual(r.body.description, 'dinner');
    r = await call('GET', `/groups/${g.id}`);
    assert.strictEqual(r.body.members.length, 3);
    r = await call('GET', `/groups/${g.id}/settlement`);
    assert.deepStrictEqual(
      r.body.transfers.map((t) => [t.from, t.to, t.amount]),
      [[b.id, a.id, 1000], [c.id, a.id, 1000]],
    );
  }));

test('remainders rotate across beneficiaries', () =>
  withServer(async (call) => {
    const { g, ms } = await setup(call, ['A', 'B', 'C']);
    const ids = ms.map((m) => m.id);
    const extras = { [ids[0]]: 0, [ids[1]]: 0, [ids[2]]: 0 };
    for (let i = 0; i < 3; i++) {
      const r = await call('POST', `/groups/${g.id}/expenses`, { payerId: ids[0], beneficiaryIds: ids, amount: 100 });
      for (const id of ids) extras[id] += r.body.shares[id] - 33;
    }
    assert.deepStrictEqual(Object.values(extras), [1, 1, 1]);
    const r = await call('GET', `/groups/${g.id}/settlement`);
    assert.deepStrictEqual(r.body.transfers.map((t) => t.amount).sort(), [100, 100]);
  }));

test('settlement sums to zero for each member', () =>
  withServer(async (call) => {
    const { g, ms } = await setup(call, ['A', 'B', 'C', 'D']);
    const ids = ms.map((m) => m.id);
    const exps = [[0, [0, 1, 2, 3], 1001], [1, [2, 3], 777], [2, [0, 1], 5], [3, [0], 400]];
    const net = {};
    for (const [p, bs, amount] of exps) {
      const r = await call('POST', `/groups/${g.id}/expenses`, { payerId: ids[p], beneficiaryIds: bs.map((i) => ids[i]), amount });
      net[ids[p]] = (net[ids[p]] || 0) + amount;
      for (const [id, s] of Object.entries(r.body.shares)) net[id] = (net[id] || 0) - s;
    }
    const r = await call('GET', `/groups/${g.id}/settlement`);
    for (const t of r.body.transfers) {
      assert.ok(t.amount > 0 && Number.isInteger(t.amount));
      net[t.from] += t.amount;
      net[t.to] -= t.amount;
    }
    for (const v of Object.values(net)) assert.strictEqual(v, 0);
  }));

test('validation and errors', () =>
  withServer(async (call) => {
    const { g, ms } = await setup(call, ['A', 'B']);
    const [a, b] = ms;
    const post = (body) => call('POST', `/groups/${g.id}/expenses`, body);
    assert.strictEqual((await call('POST', '/groups', {})).status, 400);
    assert.strictEqual((await call('POST', '/groups', '{bad')).status, 400);
    assert.strictEqual((await call('GET', '/groups/nope')).status, 404);
    assert.strictEqual((await call('GET', '/groups/nope/settlement')).status, 404);
    assert.strictEqual((await call('GET', `/groups/${g.id}/expenses/nope`)).status, 404);
    assert.strictEqual((await post({ payerId: 'x', beneficiaryIds: [a.id], amount: 1 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: [], amount: 1 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: [b.id, b.id], amount: 1 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: ['zz'], amount: 1 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: [b.id], amount: 1.5 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: [b.id], amount: 0 })).status, 400);
    assert.strictEqual((await post({ payerId: a.id, beneficiaryIds: [b.id], amount: '100' })).status, 400);
    const r = await post({ payerId: a.id, beneficiaryIds: [b.id], amount: -5 });
    assert.strictEqual(r.body.error.code, 'validation_error');
    assert.deepStrictEqual((await call('GET', `/groups/${g.id}/settlement`)).body.transfers, []);
    assert.deepStrictEqual((await call('GET', `/groups/${g.id}/expenses`)).body, []);
  }));

test('persists to DATA_DIR', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'settle-'));
  let gid;
  await withServer(async (call) => {
    gid = (await setup(call, ['A'])).g.id;
  }, dir);
  await withServer(async (call) => {
    const r = await call('GET', `/groups/${gid}`);
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.members[0].name, 'A');
  }, dir);
  fs.rmSync(dir, { recursive: true });
});
