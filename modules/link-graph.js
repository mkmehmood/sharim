// Pure link-graph helpers. NO imports on purpose: everything here works on plain arrays/objects so it
// can be unit-tested in node and reused by the store-aware wrappers in link-guards.js.
//
// Record links in this app:
//   customer_sales / rep_sales : relatedSaleId  (partial payment -> parent credit sale)
//   rep_sales                  : usedInCalcId   (rep sale consumed by a calculator record)
//   noman_history              : linkedSalesIds[], linkedRepSalesIds[], transferSaleId, returnEntryId, returnLogId
//   payment_transactions       : expenseId      (payment -> expense record), entityId (payment -> entity)
// Recovering a record from the recycle bin gives it a NEW id (so cloud tombstones on other devices
// cannot re-delete it). Every field above therefore has to be re-pointed at the new id.

export const GROUP_FIELD = '_deletionGroup';

export const REF_FIELDS = {
  customer_sales:       { scalar: ['relatedSaleId'], array: [] },
  rep_sales:            { scalar: ['relatedSaleId', 'usedInCalcId'], array: [] },
  noman_history:        { scalar: ['transferSaleId', 'returnEntryId', 'returnLogId'], array: ['linkedSalesIds', 'linkedRepSalesIds'] },
  payment_transactions: { scalar: ['expenseId', 'entityId', 'materialId'], array: ['materialIds'] },
  factory_inventory_data: { scalar: ['supplierId'], array: [] },
};

// Tombstone collection name -> storage key
export const COLLECTION_TO_KEY = {
  sales: 'customer_sales',
  rep_sales: 'rep_sales',
  calculator_history: 'noman_history',
  transactions: 'payment_transactions',
  payment_transactions: 'payment_transactions',
  expenses: 'expenses',
  production: 'mfg_pro_pkr',
  returns: 'stock_returns',
  sales_customers: 'sales_customers',
  rep_customers: 'rep_customers',
  entities: 'payment_entities',
  inventory: 'factory_inventory_data',
  factory_history: 'factory_production_history',
};

const _n = (v) => Number(v) || 0;
const _r2 = (v) => Math.round((_n(v) + Number.EPSILON) * 100) / 100;

// Follow oldId -> newId chains (a record can be deleted and recovered more than once).
export function resolveId(id, idMap) {
  if (!id || !idMap) return id;
  let cur = String(id);
  const seen = new Set();
  while (Object.prototype.hasOwnProperty.call(idMap, cur) && !seen.has(cur)) {
    seen.add(cur);
    cur = String(idMap[cur]);
  }
  return cur;
}

// Re-point every reference to oldId at newId. `stores` is { storeKey: record[] }.
// Mutates records in place and returns { storeKey: [changedRecord, ...] } so callers save only what changed.
export function remapReferences(stores, oldId, newId) {
  const changed = {};
  const o = String(oldId);
  const nw = String(newId);
  for (const key of Object.keys(REF_FIELDS)) {
    const arr = stores[key];
    if (!Array.isArray(arr)) continue;
    const { scalar, array } = REF_FIELDS[key];
    for (const rec of arr) {
      if (!rec || typeof rec !== 'object') continue;
      let hit = false;
      for (const f of scalar) if (rec[f] != null && String(rec[f]) === o) { rec[f] = nw; hit = true; }
      for (const f of array) {
        if (!Array.isArray(rec[f])) continue;
        const idx = rec[f].findIndex(x => String(x) === o);
        if (idx !== -1) { rec[f] = rec[f].map(x => String(x) === o ? nw : x); hit = true; }
      }
      if (hit) (changed[key] = changed[key] || []).push(rec);
    }
  }
  return changed;
}

// Re-point a snapshot's OWN outgoing links using the recovered-id map (parent was recovered earlier).
export function resolveOwnLinks(collectionName, snapshot, idMap) {
  const key = COLLECTION_TO_KEY[collectionName];
  const spec = REF_FIELDS[key];
  if (!spec || !snapshot) return snapshot;
  for (const f of spec.scalar) if (snapshot[f]) snapshot[f] = resolveId(snapshot[f], idMap);
  for (const f of spec.array) if (Array.isArray(snapshot[f])) snapshot[f] = snapshot[f].map(x => resolveId(x, idMap));
  return snapshot;
}

// ---- partial payment <-> parent credit sale -------------------------------------------------------

// Delete side: take a child payment's amount back off its parent. Returns the NEW parent state
// (a patch) or null when nothing needs to change. Pure: does not mutate.
export function planChildDetach(parent, child) {
  if (!parent || !child) return null;
  const paid = Math.max(0, _r2(_n(parent.partialPaymentReceived) - _n(child.totalValue)));
  const patch = { partialPaymentReceived: paid };
  if (paid === 0) { patch.creditReceived = false; patch.clearCreditReceivedDate = true; }
  return patch;
}

// Restore side: put the child's amount back on the parent. Returns { patch } or { block }.
export function planChildReattach(parent, child) {
  if (!child || child.paymentType !== 'PARTIAL_PAYMENT' || !child.relatedSaleId) return { patch: null };
  if (!parent) return { block: 'The credit sale this payment belongs to is not in your records. Recover that sale first, then recover the payment.' };
  if (parent.paymentType !== 'CREDIT') return { block: 'The sale this payment belongs to is no longer a credit sale.' };
  const amount = _n(child.totalValue);
  const next = _r2(_n(parent.partialPaymentReceived) + amount);
  const cap = _n(parent.totalValue);
  if (cap > 0 && next > cap + 0.01) {
    return { block: `Recovering this payment would put ${next} against a sale worth ${cap}. The sale was changed after the payment was deleted.` };
  }
  return { patch: { partialPaymentReceived: next } };
}

export function applyPatch(rec, patch) {
  if (!rec || !patch) return rec;
  const { clearCreditReceivedDate, ...rest } = patch;
  Object.assign(rec, rest);
  if (clearCreditReceivedDate) { delete rec.creditReceivedDate; delete rec.creditReceivedTime; delete rec.creditReceivedManually; }
  return rec;
}

// Save side: an edit must not leave children inconsistent with their parent.
// children = records whose relatedSaleId === original.id
export function getEditLinkIssue(original, next, children) {
  if (!original || !next) return null;
  const kids = Array.isArray(children) ? children : [];
  const paid = _n(original.partialPaymentReceived);
  if (kids.length === 0 && paid === 0) return null;
  if (original.customerName && next.customerName && original.customerName !== next.customerName) {
    return `This sale has ${kids.length || 'linked'} payment record${kids.length === 1 ? '' : 's'} under "${original.customerName}". Renaming it would separate them. Delete the payment record${kids.length === 1 ? '' : 's'} first.`;
  }
  if (paid > 0 && _n(next.totalValue) + 0.01 < paid) {
    return `${paid} has already been collected against this sale, so its value cannot be reduced below that.`;
  }
  return null;
}

// ---- payment transaction <-> expense record --------------------------------------------------------

// Delete side: deleting a payment must also remove the expense record that was created with it, but only
// when no OTHER payment still points at that expense. Pure: returns the expense to remove, or null.
// excludeIds = ids of payments that are being deleted in the same operation.
export function planExpenseCascade(tx, allTxs, expenses, excludeIds) {
  if (!tx || !tx.expenseId) return null;
  const skip = new Set([String(tx.id), ...(excludeIds ? [...excludeIds].map(String) : [])]);
  const stillUsed = (Array.isArray(allTxs) ? allTxs : []).some(t => t && !skip.has(String(t.id)) && String(t.expenseId) === String(tx.expenseId));
  if (stillUsed) return null;
  return (Array.isArray(expenses) ? expenses : []).find(e => e && String(e.id) === String(tx.expenseId)) || null;
}

// ---- deletion groups ---------------------------------------------------------------------------

// Stamp a snapshot so the recycle bin knows which tombstones were deleted together.
export function stampGroup(rec, groupId) {
  return rec && groupId ? { ...rec, [GROUP_FIELD]: groupId } : rec;
}

export function newGroupId(prefix = 'grp') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// Order tombstones for restore: parents before children, expenses/customers before the rows that point at them.
const _COLLECTION_RANK = { sales_customers: 0, rep_customers: 0, expenses: 0, entities: 0, inventory: 0 };
export function orderForRestore(tombstones) {
  const list = tombstones.slice();
  const ids = new Set(list.map(t => String(t.recordId || t.id)));
  const depth = (t, seen = new Set()) => {
    const s = t.snapshot || {};
    const p = s.relatedSaleId && String(s.relatedSaleId);
    if (p && ids.has(p) && !seen.has(p)) {
      seen.add(p);
      const parent = list.find(x => String(x.recordId || x.id) === p);
      return 1 + (parent ? depth(parent, seen) : 0);
    }
    return 0;
  };
  return list
    .map(t => ({ t, rank: (_COLLECTION_RANK[t.collection || t.recordType] ?? 1) * 100 + depth(t) }))
    .sort((a, b) => a.rank - b.rank)
    .map(x => x.t);
}

// All tombstones that belong to the same deletion as `tomb` (including itself).
export function findGroupMembers(tomb, allTombstones) {
  const snap = (tomb && tomb.snapshot) || {};
  const gid = snap[GROUP_FIELD];
  const pairId = snap.transferPairId;
  if (!gid && !pairId) return [tomb];
  const members = (allTombstones || []).filter(t => {
    const s = t && t.snapshot;
    if (!s) return false;
    return (gid && s[GROUP_FIELD] === gid) || (pairId && s.transferPairId === pairId);
  });
  if (!members.some(t => t === tomb)) members.push(tomb);
  return members;
}

// Every tombstone that must be erased / recovered with the given ones: each record plus the other members of
// its deletion group or transfer pair, de-duplicated by record id. `all` is every tombstone known to the bin.
export function expandGroups(recs, all) {
  const out = new Map();
  for (const r of recs || []) {
    if (!r) continue;
    for (const m of findGroupMembers(r, all)) {
      const k = String(m.recordId || m.id);
      if (!out.has(k)) out.set(k, m);
    }
  }
  return Array.from(out.values());
}

// ---- nested material references (factory batches + formulas point at inventory item ids) -------------

// history: factory_production_history[], formulas: { formulaKey: [{id,...}] }
export function remapMaterialRefs(history, formulas, oldId, newId) {
  const o = String(oldId), nw = String(newId);
  const historyChanged = [];
  for (const h of Array.isArray(history) ? history : []) {
    let hit = false;
    for (const m of Array.isArray(h && h.materialsUsed) ? h.materialsUsed : []) {
      if (m && m.id != null && String(m.id) === o) { m.id = nw; hit = true; }
    }
    if (hit) historyChanged.push(h);
  }
  let formulasChanged = false;
  if (formulas && typeof formulas === 'object') {
    for (const k of Object.keys(formulas)) {
      for (const f of Array.isArray(formulas[k]) ? formulas[k] : []) {
        if (f && f.id != null && String(f.id) === o) { f.id = nw; formulasChanged = true; }
      }
    }
  }
  return { historyChanged, formulasChanged };
}

// ---- restoring a factory batch must take its raw materials out of inventory again --------------------
// Deleting a batch ADDED the materials back; restoring it must remove them, or they are counted twice.
export function planMaterialDeduction(entry, inventory, formulas, formulaKey) {
  if (!entry) return { updates: [] };
  const used = (Array.isArray(entry.materialsUsed) && entry.materialsUsed.length > 0)
    ? entry.materialsUsed.map(m => ({ id: m.id, name: m.name, quantity: _n(m.quantity) }))
    : ((formulas && (formulas[formulaKey] || formulas[entry.store])) || []).map(f => ({ id: f.id, name: f.name, quantity: _n(f.quantity) * _n(entry.units) }));
  const updates = [];
  for (const u of used) {
    if (!(u.quantity > 0)) continue;
    let item = (inventory || []).find(i => i && u.id != null && String(i.id) === String(u.id));
    if (!item && u.name) item = (inventory || []).find(i => i && i.name && i.name.trim().toLowerCase() === String(u.name).trim().toLowerCase());
    if (!item) return { block: `"${u.name || 'A raw material'}" used in this batch is no longer in your inventory. Recover that material first, then recover the batch.` };
    const have = _n(item.quantity);
    if (have + 1e-9 < u.quantity) {
      return { block: `Not enough ${item.name || u.name} in inventory to recover this batch: it used ${u.quantity} kg and only ${have} kg is in stock.` };
    }
    updates.push({ id: item.id, quantity: parseFloat((have - u.quantity).toFixed(6)) });
  }
  return { updates };
}

// ---- restoring something that CONSUMES store stock must not overdraw that store/day -------------------
export function getStockOverdrawIssue(label, qty, availableNow) {
  const q = _n(qty);
  if (q <= 0) return null;
  if (_n(availableNow) - q < -0.0001) {
    return `Recovering this would use ${q} kg of ${label} stock but only ${Math.max(0, _n(availableNow))} kg is available on that date. Recover or add the stock first.`;
  }
  return null;
}

// ---- customer renames: records deleted before a rename must come back under the new name -------------
export function recordRename(map, kind, from, to) {
  const m = map && typeof map === 'object' ? map : {};
  const f = String(from || '').trim().toLowerCase();
  const t = String(to || '').trim();
  if (!f || !t || f === t.toLowerCase()) return m;
  m[`${kind}:${f}`] = t;
  return m;
}
export function resolveRename(map, kind, name) {
  if (!map || !name) return name;
  let cur = String(name);
  const seen = new Set();
  while (Object.prototype.hasOwnProperty.call(map, `${kind}:${cur.trim().toLowerCase()}`) && !seen.has(cur.trim().toLowerCase())) {
    seen.add(cur.trim().toLowerCase());
    cur = map[`${kind}:${cur.trim().toLowerCase()}`];
  }
  return cur;
}

// ---- old-debt edits: changing the amount must not erase payments that were already collected ---------
export function getOldDebtEditIssue(newAmount, children) {
  const paid = (Array.isArray(children) ? children : []).reduce((s, c) => s + _n(c && c.totalValue), 0);
  if (paid > 0 && _n(newAmount) + 0.01 < paid) {
    return `${_r2(paid)} has already been collected against this old balance, so it cannot be set below that. Delete those payment records first.`;
  }
  return null;
}
export function sumChildPayments(children) {
  return _r2((Array.isArray(children) ? children : []).reduce((s, c) => s + _n(c && c.totalValue), 0));
}

// ---- production returns --------------------------------------------------------------------------------
// A return is TWO records: the production-tab entry (mfg_pro_pkr, isReturn) and the stock_returns log.
// Only the log counts toward store stock, so the pair must always be deleted / restored together.
export const DELETE_ORIGIN_FIELD = '_deleteOrigin';

export function findReturnLogFor(entry, logs) {
  if (!entry) return null;
  const cands = (Array.isArray(logs) ? logs : []).filter(l => l && !l.deletedAt &&
    l.store === entry.store && l.date === entry.date && _n(l.quantity) === _n(entry.net));
  if (!cands.length) return null;
  return cands.find(l => entry.createdAt != null && l.createdAt === entry.createdAt)
    || cands.find(l => entry.returnedBy && l.seller === entry.returnedBy)
    || cands[0];
}

// How many kg of store stock disappear when this return is deleted (0 when no log counts it).
export function getReturnStockDrop(entry, log) {
  return entry && log ? _n(log.quantity) : 0;
}

// ---- factory formula units consumed by a production entry -------------------------------------------
export function getUnitsShortIssue(label, requested, available) {
  const r = _n(requested);
  if (r <= 0) return null;
  if (_n(available) + 1e-9 < r) {
    return `Recovering this would use ${r} formula unit${r === 1 ? '' : 's'} of ${label}, but only ${Math.max(0, _n(available))} ${_n(available) === 1 ? 'is' : 'are'} available in the factory. Add or recover factory batches first.`;
  }
  return null;
}

// ---- supplier payables (Factory raw materials <-> Payment tab) ---------------------------------------------
// A linked material owes its supplier the amount that was INVOICED (the IN payable transaction), not its
// current stock value: batches use stock up, which lowers totalValue, but the debt does not shrink.
const _txMatIds = (t) => {
  const ids = new Set();
  if (t && t.materialId) ids.add(String(t.materialId));
  if (t && Array.isArray(t.materialIds)) t.materialIds.forEach(i => { if (i) ids.add(String(i)); });
  return ids;
};
const _stockValueFallback = (m) => _r2(m.totalValue || (m.purchaseCost && m.purchaseQuantity ? m.purchaseCost * m.purchaseQuantity : _n(m.quantity) * _n(m.cost)) || 0);

export function findPayableInTxs(txs, materialId, supplierId) {
  return (Array.isArray(txs) ? txs : []).filter(t => t && !t.deletedAt && t.isPayable === true && t.type === 'IN' &&
    (supplierId == null || String(t.entityId) === String(supplierId)) && _txMatIds(t).has(String(materialId)));
}

// inTxs: payable IN transactions of the material's supplier (already excluding any being deleted).
export function materialOriginalPayable(material, inTxs) {
  const direct = findPayableInTxs(inTxs, material && material.id).filter(t => _txMatIds(t).size === 1);
  if (direct.length) return _r2(direct.reduce((s, t) => s + _n(t.amount), 0));
  return _stockValueFallback(material || {});
}

// Pay oldest materials first. Mutates the materials; originalOf(m) gives each one's invoiced amount.
export function allocatePayments(mats, payments, originalOf) {
  mats.forEach(m => { m.totalPayable = originalOf(m); m.paymentStatus = 'pending'; delete m.paidDate; });
  payments.forEach(pay => {
    let remaining = parseFloat(pay.amount) || 0;
    for (const m of mats) {
      if (remaining <= 0) break;
      if (m.totalPayable <= 0) continue;
      if (remaining >= m.totalPayable) {
        remaining -= m.totalPayable;
        m.totalPayable = 0;
        m.paymentStatus = 'paid';
        m.paidDate = pay.date;
      } else {
        m.totalPayable = parseFloat((m.totalPayable - remaining).toFixed(2));
        remaining = 0;
      }
    }
  });
  return mats;
}

// Editing a linked material's stock value by `delta` moves the invoiced amount by the same delta.
export function planPayableAdjustment(currentInvoiced, delta) {
  const next = Math.max(0, _r2(_n(currentInvoiced) + _n(delta)));
  return { next, change: _r2(next - _n(currentInvoiced)) };
}

// ---- which formula will a store actually use? (pure; callers pass freshly-read data) -------------------------
const _SLOTS = ['standard', 'asaan'];
const _SLOT_LABEL = { standard: 'Standard', asaan: 'Asaan' };
export function resolveSelectedFormula(data, storeKey) {
  const list = (Array.isArray(data.list) ? data.list : []).filter(f => f && f.id);
  const slots = data.slots || {};
  const st = (Array.isArray(data.stores) ? data.stores : []).find(s => s && s.key === storeKey);
  const type = _SLOTS.includes(storeKey) ? storeKey : ((st && st.formulaType) || (storeKey === 'STORE_C' ? 'asaan' : 'standard'));
  const formulaId = (st && st.formulaId) || slots[type] || null;
  const f = formulaId ? list.find(x => String(x.id) === String(formulaId)) : null;
  const inv = (Array.isArray(data.inventory) ? data.inventory : []).filter(i => i && !i.deletedAt);
  const resolve = (i) => {
    let live = inv.find(x => String(x.id) === String(i.id));
    if (!live && i.name) live = inv.find(x => x.name && x.name.trim().toLowerCase() === String(i.name).trim().toLowerCase());
    const liveCost = live ? Number(live.cost) : NaN;
    return {
      id: i.id,
      name: (live && live.name) || i.name || 'Material',
      quantity: _n(i.quantity),
      cost: Number.isFinite(liveCost) && liveCost > 0 ? liveCost : _n(i.cost),
      missing: !live,
      stock: live ? _n(live.quantity) : 0,
    };
  };
  if (f) {
    return { source: 'store', type, formulaId: f.id, name: f.name || _SLOT_LABEL[type], additionalCost: _n(f.additionalCost), ingredients: (Array.isArray(f.ingredients) ? f.ingredients : []).map(resolve) };
  }
  const feed = data.feed || {};
  const costs = data.costs || {};
  return { source: 'feed', type, formulaId: null, name: _SLOT_LABEL[type] || 'Formula', additionalCost: _n(costs[type] != null ? costs[type] : costs[storeKey]), ingredients: (Array.isArray(feed[type] || feed[storeKey]) ? (feed[type] || feed[storeKey]) : []).map(resolve) };
}
