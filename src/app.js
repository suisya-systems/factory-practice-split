'use strict';

const { randomUUID } = require('node:crypto');
const { splitAmount, settle } = require('./settle');

const MAX_NAME = 100;
const MAX_DESCRIPTION = 500;
const MAX_AMOUNT = 1_000_000_000_000; // 1 trillion yen
const MAX_BODY = 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = (message) => new HttpError(400, 'validation_error', message);
const notFound = (what) => new HttpError(404, 'not_found', `${what} not found`);

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.trim() === '') return reject(badRequest('request body must be a JSON object'));
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return reject(new HttpError(400, 'invalid_json', 'request body is not valid JSON'));
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return reject(badRequest('request body must be a JSON object'));
      }
      resolve(body);
    });
    req.on('error', reject);
  });
}

function requireName(body) {
  const { name } = body;
  if (name === undefined || name === null) throw badRequest('name is required');
  if (typeof name !== 'string') throw badRequest('name must be a string');
  const trimmed = name.trim();
  if (trimmed === '') throw badRequest('name must not be empty');
  if (trimmed.length > MAX_NAME) throw badRequest(`name must be at most ${MAX_NAME} characters`);
  return trimmed;
}

const publicMember = (m) => ({ id: m.id, name: m.name });
const publicGroup = (g) => ({ id: g.id, name: g.name, members: g.members.map(publicMember), createdAt: g.createdAt });
const publicExpense = (e) => ({
  id: e.id,
  payerId: e.payerId,
  beneficiaryIds: [...e.beneficiaryIds],
  amount: e.amount,
  description: e.description,
  shares: { ...e.shares },
  createdAt: e.createdAt,
});

function getGroup(store, id) {
  const g = store.get(id);
  if (!g) throw notFound('group');
  return g;
}

function validateExpense(group, body) {
  const { payerId, beneficiaryIds, amount, description } = body;
  const memberIds = new Set(group.members.map((m) => m.id));

  if (payerId === undefined || payerId === null) throw badRequest('payerId is required');
  if (typeof payerId !== 'string') throw badRequest('payerId must be a string');
  if (!memberIds.has(payerId)) throw badRequest('payerId is not a member of this group');

  if (beneficiaryIds === undefined || beneficiaryIds === null) throw badRequest('beneficiaryIds is required');
  if (!Array.isArray(beneficiaryIds)) throw badRequest('beneficiaryIds must be an array');
  if (beneficiaryIds.length === 0) throw badRequest('beneficiaryIds must not be empty');
  const seen = new Set();
  for (const id of beneficiaryIds) {
    if (typeof id !== 'string') throw badRequest('beneficiaryIds must contain only strings');
    if (!memberIds.has(id)) throw badRequest(`beneficiary ${id} is not a member of this group`);
    if (seen.has(id)) throw badRequest(`beneficiaryIds contains duplicate id ${id}`);
    seen.add(id);
  }

  if (amount === undefined || amount === null) throw badRequest('amount is required');
  if (typeof amount !== 'number' || !Number.isFinite(amount)) throw badRequest('amount must be a number');
  if (!Number.isInteger(amount)) throw badRequest('amount must be an integer number of yen');
  if (amount <= 0) throw badRequest('amount must be greater than 0');
  if (amount > MAX_AMOUNT) throw badRequest(`amount must be at most ${MAX_AMOUNT}`);

  let desc = '';
  if (description !== undefined && description !== null) {
    if (typeof description !== 'string') throw badRequest('description must be a string');
    if (description.length > MAX_DESCRIPTION) {
      throw badRequest(`description must be at most ${MAX_DESCRIPTION} characters`);
    }
    desc = description;
  }

  return { payerId, beneficiaryIds: [...beneficiaryIds], amount, description: desc };
}

function route(method, parts) {
  // parts: path segments after splitting on '/'
  if (parts[0] !== 'groups') return null;
  const n = parts.length;
  if (n === 1) return method === 'POST' ? { name: 'createGroup' } : { allow: ['POST'] };
  const groupId = parts[1];
  if (n === 2) return method === 'GET' ? { name: 'getGroup', groupId } : { allow: ['GET'] };
  if (n === 3 && parts[2] === 'members') {
    const name = { GET: 'listMembers', POST: 'addMember' }[method];
    return name ? { name, groupId } : { allow: ['GET', 'POST'] };
  }
  if (n === 3 && parts[2] === 'expenses') {
    const name = { GET: 'listExpenses', POST: 'addExpense' }[method];
    return name ? { name, groupId } : { allow: ['GET', 'POST'] };
  }
  if (n === 4 && parts[2] === 'expenses') {
    return method === 'GET' ? { name: 'getExpense', groupId, expenseId: parts[3] } : { allow: ['GET'] };
  }
  if (n === 3 && parts[2] === 'settlement') {
    return method === 'GET' ? { name: 'settlement', groupId } : { allow: ['GET'] };
  }
  return null;
}

function createApp(store) {
  const handlers = {
    async createGroup(req) {
      const body = await readJson(req);
      const group = {
        id: randomUUID(),
        name: requireName(body),
        members: [],
        expenses: [],
        extraCounts: {},
        createdAt: new Date().toISOString(),
      };
      store.put(group);
      store.save();
      return [201, publicGroup(group)];
    },
    async getGroup(req, r) {
      return [200, publicGroup(getGroup(store, r.groupId))];
    },
    async addMember(req, r) {
      const group = getGroup(store, r.groupId);
      const body = await readJson(req);
      const member = { id: randomUUID(), name: requireName(body), createdAt: new Date().toISOString() };
      group.members.push(member);
      store.save();
      return [201, publicMember(member)];
    },
    async listMembers(req, r) {
      return [200, getGroup(store, r.groupId).members.map(publicMember)];
    },
    async addExpense(req, r) {
      const group = getGroup(store, r.groupId);
      const body = await readJson(req);
      const input = validateExpense(group, body);
      const order = {};
      group.members.forEach((m, i) => (order[m.id] = i));
      const counts = { ...group.extraCounts };
      const shares = splitAmount(input.amount, input.beneficiaryIds, counts, order);
      const expense = { id: randomUUID(), ...input, shares, createdAt: new Date().toISOString() };
      group.extraCounts = counts;
      group.expenses.push(expense);
      store.save();
      return [201, publicExpense(expense)];
    },
    async listExpenses(req, r) {
      return [200, getGroup(store, r.groupId).expenses.map(publicExpense)];
    },
    async getExpense(req, r) {
      const group = getGroup(store, r.groupId);
      const e = group.expenses.find((x) => x.id === r.expenseId);
      if (!e) throw notFound('expense');
      return [200, publicExpense(e)];
    },
    async settlement(req, r) {
      return [200, settle(getGroup(store, r.groupId))];
    },
  };

  return async function app(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      let parts;
      try {
        parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      } catch {
        throw notFound('resource');
      }
      const r = route(req.method, parts);
      if (!r) throw notFound('resource');
      if (r.allow) {
        res.setHeader('Allow', r.allow.join(', '));
        throw new HttpError(405, 'method_not_allowed', `method ${req.method} not allowed`);
      }
      const [status, body] = await handlers[r.name](req, r);
      send(res, status, body);
    } catch (err) {
      if (err instanceof HttpError) {
        send(res, err.status, { error: { code: err.code, message: err.message } });
      } else {
        console.error(err);
        send(res, 500, { error: { code: 'internal_error', message: 'internal server error' } });
      }
    }
  };
}

module.exports = { createApp };
