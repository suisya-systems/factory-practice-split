'use strict';

// Split `amount` yen equally among `beneficiaryIds`. Remainder yen (amount % n)
// go one each to the beneficiaries who have received the fewest remainder yen
// so far in this group (`extraCounts`, mutated); ties are broken by member
// join order (`memberOrder`). This is deterministic and keeps the remainder
// spread evenly across people over time instead of always hitting the same one.
function splitAmount(amount, beneficiaryIds, extraCounts, memberOrder) {
  const n = beneficiaryIds.length;
  const base = Math.floor(amount / n);
  let remainder = amount - base * n;
  const shares = {};
  for (const id of beneficiaryIds) shares[id] = base;
  if (remainder > 0) {
    const ranked = [...beneficiaryIds].sort(
      (a, b) => (extraCounts[a] || 0) - (extraCounts[b] || 0) || memberOrder[a] - memberOrder[b],
    );
    for (const id of ranked) {
      if (remainder === 0) break;
      shares[id] += 1;
      extraCounts[id] = (extraCounts[id] || 0) + 1;
      remainder -= 1;
    }
  }
  return shares;
}

// Net balance per member: positive = is owed money, negative = owes money.
function balances(group) {
  const bal = {};
  for (const m of group.members) bal[m.id] = 0;
  for (const e of group.expenses) {
    bal[e.payerId] += e.amount;
    for (const [id, share] of Object.entries(e.shares)) bal[id] -= share;
  }
  return bal;
}

// Greedy matching of largest debtor with largest creditor. Produces at most
// (members - 1) transfers, all positive integers, ordered deterministically.
function settle(group) {
  const order = {};
  group.members.forEach((m, i) => (order[m.id] = i));
  const bal = balances(group);
  const byAmount = (a, b) => b.amt - a.amt || order[a.id] - order[b.id];
  const creditors = [];
  const debtors = [];
  for (const m of group.members) {
    if (bal[m.id] > 0) creditors.push({ id: m.id, amt: bal[m.id] });
    else if (bal[m.id] < 0) debtors.push({ id: m.id, amt: -bal[m.id] });
  }
  const transfers = [];
  while (creditors.length && debtors.length) {
    creditors.sort(byAmount);
    debtors.sort(byAmount);
    const c = creditors[0];
    const d = debtors[0];
    const amt = Math.min(c.amt, d.amt);
    transfers.push({ from: d.id, to: c.id, amount: amt });
    c.amt -= amt;
    d.amt -= amt;
    if (c.amt === 0) creditors.shift();
    if (d.amt === 0) debtors.shift();
  }
  return { transfers, balances: group.members.map((m) => ({ memberId: m.id, balance: bal[m.id] })) };
}

module.exports = { splitAmount, balances, settle };
