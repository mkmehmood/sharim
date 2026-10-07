import { findCalcLinkForReturn } from './link-guards.js';
import { findReturnLogFor, getReturnStockDrop, newGroupId, stampGroup, DELETE_ORIGIN_FIELD, findPayableInTxs, planPayableAdjustment } from './link-graph.js';
import { actionRowHtml, beginEditMode, endEditMode, getEditCtx, registerEditHandler, stampEdit } from './edit-mode.js';
import { _creatorBadgeHtml, _mergedBadgeHtml, _safeErr, appMode, currentUser, database, ensureArray, ensureRecordIntegrity, esc, fmtAmt, fmtNum, generateUUID, getTimestamp, localDateStr, lockedSaleValue, round2, safeNumber, safeToFixed, sqliteStore, validateUUID } from './business.js';
import { emitSyncUpdate, pushDataToCloud, sanitizeForFirestore, unifiedDelete, unifiedSave } from './sync.js';
import { OfflineQueue, _refreshSupplierLinkViews, _recomputeSupplierPayables, notifyDataChange, triggerAutoSync, updatePaymentStatusVisibility } from './utilities-core.js';
import { _set_currentFactoryEntryStore, calculateCashTracker, calculateNetCash, currentFactoryEntryStore, deleteStockTransfer, getAppStores, getStoreFormulaType, getStoreLabel, refreshFactoryTab, refreshUI, updateAllTabsWithFactoryCosts, updateFactorySummaryCard, updateFactoryUnitsAvailableStats } from './utilities-sales.js';
import { _filterFactoryHistoryByMode, formatCurrency, refreshPaymentTab, renderUnifiedTable, safeValue } from './utilities-payments.js';
import { showGlassConfirm, showToast } from './customers.js';
import { getFormulaSlotLabels, getSelectedFormula } from './formula-store.js';

export let editingFactoryInventoryId;
window.editingFactoryInventoryId = editingFactoryInventoryId;
export function _set_editingFactoryInventoryId(v) { editingFactoryInventoryId = v; window.editingFactoryInventoryId = v; }
export let currentFactorySummaryMode = 'daily';
window.currentFactorySummaryMode = currentFactorySummaryMode;
export function _set_currentFactorySummaryMode(v) { currentFactorySummaryMode = v; window.currentFactorySummaryMode = v; }
export let currentStore = 'STORE_A';
window.currentStore = currentStore;
export function _set_currentStore(v) { currentStore = v; window.currentStore = v; }

(window.__uiSyncers = window.__uiSyncers || []).push(() => {
  try { const v = window.currentStore; if (v !== undefined) currentStore = v; } catch (_) {}
  try { const v = window.currentFactorySummaryMode; if (v !== undefined) currentFactorySummaryMode = v; } catch (_) {}
});

export function resolveLiveCost(item, inventory) {
const list = Array.isArray(inventory) ? inventory : [];
let live = list.find(i => String(i.id) === String(item.id));
if (!live && item.name) live = list.find(i => i.name && i.name.trim().toLowerCase() === item.name.trim().toLowerCase());
const c = live ? Number(live.cost) : NaN;
return Number.isFinite(c) && c > 0 ? c : (Number(item.cost) || 0);
}

export async function getCostPerUnit(storeType) {
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const factoryUnitTracking = (await sqliteStore.get('factory_unit_tracking')) || {};
const formula = factoryDefaultFormulas[storeType];
const additionalCost = factoryAdditionalCosts[storeType] || 0;
if (formula && formula.length > 0) {
let totalMaterialCost = 0;
formula.forEach(item => {
const liveItem = Array.isArray(factoryInventoryData) ? factoryInventoryData.find(i => String(i.id) === String(item.id)) : null;
const unitCost = liveItem ? (liveItem.cost || item.cost || 0) : (item.cost || 0);
totalMaterialCost += unitCost * (item.quantity || 0);
});
return totalMaterialCost + additionalCost;
}
const tracking = factoryUnitTracking?.[storeType];
if (tracking && Array.isArray(tracking.unitCostHistory) && tracking.unitCostHistory.length > 0) {
let totalWeightedCost = 0, totalUnits = 0;
tracking.unitCostHistory.forEach(entry => {
totalWeightedCost += (entry.costPerUnit || 0) * (entry.units || 0);
totalUnits += (entry.units || 0);
});
return totalUnits > 0 ? totalWeightedCost / totalUnits : 0;
}
return 0;
}

export async function calculateFactoryInventoryValue() {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const factoryUnitTracking = (await sqliteStore.get('factory_unit_tracking')) || {};
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
let totalValue = 0;
if (factoryInventoryData && factoryInventoryData.length > 0) {
factoryInventoryData.forEach(item => { totalValue += (item.quantity * item.cost) || 0; });
}
const stdTracking = factoryUnitTracking?.standard || { available: 0 };
const asaanTracking = factoryUnitTracking?.asaan || { available: 0 };
const stdCostPerUnit = await getCostPerUnit('standard');
const asaanCostPerUnit = await getCostPerUnit('asaan');
totalValue += (stdTracking.available * stdCostPerUnit);
totalValue += (asaanTracking.available * asaanCostPerUnit);
return totalValue;
}

export async function updateFactoryInventoryDisplay() {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const factoryUnitTracking = (await sqliteStore.get('factory_unit_tracking')) || {};
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
let rawMaterialsValue = 0;
if (factoryInventoryData && factoryInventoryData.length > 0) {
factoryInventoryData.forEach(item => { rawMaterialsValue += (item.quantity * item.cost) || 0; });
}
const stdTracking = factoryUnitTracking?.standard || { available: 0 };
const asaanTracking = factoryUnitTracking?.asaan || { available: 0 };
const stdCostPerUnit = await getCostPerUnit('standard');
const asaanCostPerUnit = await getCostPerUnit('asaan');
const formulaUnitsValue = (stdTracking.available * stdCostPerUnit) + (asaanTracking.available * asaanCostPerUnit);
const rawMaterialsEl = document.getElementById('formulaRawMaterials');
const unitsValueEl = document.getElementById('formulaUnitsValue');
if (rawMaterialsEl) rawMaterialsEl.textContent = `${fmtAmt(safeValue(rawMaterialsValue))}`;
if (unitsValueEl) unitsValueEl.textContent = `${fmtAmt(safeValue(formulaUnitsValue))}`;
}

export async function calculatePaymentSummaries() {
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
const today = localDateStr();
const todayObj = new Date();
const year = todayObj.getFullYear();
const month = todayObj.getMonth();
const day = todayObj.getDate();
const weekStart = new Date(todayObj);
weekStart.setDate(day - 6);
const summaries = {
day: { in: 0, out: 0, count: 0 },
week: { in: 0, out: 0, count: 0 },
month: { in: 0, out: 0, count: 0 },
year: { in: 0, out: 0, count: 0 }
};
paymentTransactions.forEach(transaction => {
const transDate = new Date(transaction.date);
const transYear = transDate.getFullYear();
const transMonth = transDate.getMonth();
if (transaction.date === today) {
if (transaction.type === 'IN') summaries.day.in += transaction.amount;
else summaries.day.out += transaction.amount;
summaries.day.count++;
}
if (transDate >= weekStart && transDate <= todayObj) {
if (transaction.type === 'IN') summaries.week.in += transaction.amount;
else summaries.week.out += transaction.amount;
summaries.week.count++;
}
if (transYear === year && transMonth === month) {
if (transaction.type === 'IN') summaries.month.in += transaction.amount;
else summaries.month.out += transaction.amount;
summaries.month.count++;
}
if (transYear === year) {
if (transaction.type === 'IN') summaries.year.in += transaction.amount;
else summaries.year.out += transaction.amount;
summaries.year.count++;
}
});
const updateSummary = (prefix, data) => {
const inEl = document.getElementById(`${prefix}-in`);
const outEl = document.getElementById(`${prefix}-out`);
const netEl = document.getElementById(`${prefix}-net`);
const countEl = document.getElementById(`${prefix}-count`);
if (inEl) inEl.textContent = `${fmtAmt(safeValue(data.in))}`;
if (outEl) outEl.textContent = `${fmtAmt(safeValue(data.out))}`;
if (netEl) netEl.textContent = `${fmtAmt(safeValue(data.in - data.out))}`;
if (countEl) countEl.textContent = data.count;
};
updateSummary('payments-day', summaries.day);
updateSummary('payments-week', summaries.week);
updateSummary('payments-month', summaries.month);
updateSummary('payments-year', summaries.year);
}

export function openFactoryInventoryModal() {
const _facInvT1 = document.getElementById('factoryInventoryModalTitle');
if (_facInvT1) _facInvT1.innerText = 'Add Raw Material';
const _delBtnHide = document.getElementById('deleteFactoryInventoryBtn');
if (_delBtnHide) _delBtnHide.style.display = 'none';
clearFactoryInventoryForm();
editingFactoryInventoryId = null; window.editingFactoryInventoryId = editingFactoryInventoryId;
const qtyInput = document.getElementById('factoryMaterialQuantity');
const conversionInput = document.getElementById('factoryMaterialConversionFactor');
const costInput = document.getElementById('factoryMaterialCost');
if (qtyInput && conversionInput && costInput) {
qtyInput.removeEventListener('input', updateFactoryKgCalculation);
conversionInput.removeEventListener('input', updateFactoryKgCalculation);
costInput.removeEventListener('input', updateFactoryKgCalculation);
qtyInput.addEventListener('input', updateFactoryKgCalculation);
conversionInput.addEventListener('input', updateFactoryKgCalculation);
costInput.addEventListener('input', updateFactoryKgCalculation);
}
if (typeof openStandaloneScreen === 'function') openStandaloneScreen('raw-material-screen');
}

export function closeFactoryInventoryModal() {
if (typeof closeStandaloneScreen === 'function') closeStandaloneScreen('raw-material-screen');
}

export function clearFactoryInventoryForm() {
document.getElementById('factoryMaterialName').value = '';
document.getElementById('factoryMaterialQuantity').value = '';
document.getElementById('factoryMaterialConversionFactor').value = '1';
document.getElementById('factoryMaterialUnitName').value = '';
document.getElementById('factoryMaterialCost').value = '';
updateFactoryKgCalculation();
}

export async function editFactoryInventoryItem(id) {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const item = factoryInventoryData.find(i => i.id === id);
if (!item) return;
openFactoryInventoryModal();
const _facInvT2 = document.getElementById('factoryInventoryModalTitle');
if (_facInvT2) _facInvT2.innerText = 'Edit Material';
const _delBtn = document.getElementById('deleteFactoryInventoryBtn');
if (_delBtn) _delBtn.style.display = '';
document.getElementById('factoryMaterialName').value = item.name;
if (item.purchaseQuantity && item.conversionFactor) {
document.getElementById('factoryMaterialQuantity').value = item.purchaseQuantity;
document.getElementById('factoryMaterialCost').value = item.purchaseCost;
document.getElementById('factoryMaterialConversionFactor').value = item.conversionFactor;
document.getElementById('factoryMaterialUnitName').value = item.purchaseUnitName || '';
} else {
document.getElementById('factoryMaterialQuantity').value = item.quantity;
document.getElementById('factoryMaterialCost').value = item.cost;
document.getElementById('factoryMaterialConversionFactor').value = 1;
document.getElementById('factoryMaterialUnitName').value = '';
}
updateFactoryKgCalculation();
const supplierTypeSelect = document.getElementById('factoryMaterialSupplierType');
const existingSupplierSection = document.getElementById('existingSupplierSection');
const newSupplierSection = document.getElementById('newSupplierSection');
if (item.supplierId) {
supplierTypeSelect.value = 'existing';
existingSupplierSection.classList.remove('hidden');
newSupplierSection.classList.add('hidden');
const supplierInput = document.getElementById('factoryExistingSupplier');
const supplier = paymentEntities.find(e => String(e.id) === String(item.supplierId));
if (supplier && supplierInput) {
supplierInput.value = supplier.name;
supplierInput.setAttribute('data-supplier-id', item.supplierId);
}
showSupplierUnlinkOption(item);
} else {
supplierTypeSelect.value = 'none';
existingSupplierSection.classList.add('hidden');
newSupplierSection.classList.add('hidden');
}
editingFactoryInventoryId = id; window.editingFactoryInventoryId = editingFactoryInventoryId;
}

export function updateFactoryKgCalculation() {
const qty = parseFloat(document.getElementById('factoryMaterialQuantity').value) || 0;
const conversionFactor = parseFloat(document.getElementById('factoryMaterialConversionFactor').value) || 1;
const cost = parseFloat(document.getElementById('factoryMaterialCost').value) || 0;
const totalKg = qty * conversionFactor;
const totalAmount = qty * cost;
const kgDisplayElement = document.getElementById('factoryCalculatedKg');
const amountDisplayElement = document.getElementById('factoryCalculatedAmount');
if (kgDisplayElement) kgDisplayElement.textContent = fmtNum(safeNumber(totalKg, 0)) + ' kg';
if (amountDisplayElement) amountDisplayElement.textContent = fmtAmt(totalAmount);
}

export function showSupplierUnlinkOption(material) {
const existingSupplierSection = document.getElementById('existingSupplierSection');
let unlinkButton = existingSupplierSection.querySelector('.unlink-supplier-btn');
if (!unlinkButton) {
unlinkButton = document.createElement('button');
unlinkButton.className = 'btn btn-danger unlink-supplier-btn';
unlinkButton.style.cssText = 'width:100%;margin-top:10px;font-size:0.8rem;';
unlinkButton.innerHTML = ' Unlink Supplier & Reverse Transactions';
unlinkButton.onclick = function(e) { e.preventDefault(); unlinkSupplierConfirmation(material); };
existingSupplierSection.appendChild(unlinkButton);
}
}

export async function unlinkSupplierConfirmation(material) {
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const linkedTransactions = paymentTransactions.filter(t => t.materialId === material.id && t.entityId === material.supplierId && t.isPayable === true);
let confirmMsg = ` Unlink ${material.supplierName} from ${material.name}?\n\n`;
confirmMsg += `This will:\n Remove supplier association\n Reset payment status to 'pending'\n`;
if (linkedTransactions.length > 0) {
const totalReversed = linkedTransactions.reduce((sum, t) => sum + t.amount, 0);
confirmMsg += ` Reverse ${linkedTransactions.length} payment transaction(s) totaling ${fmtAmt(safeNumber(totalReversed, 0))}\n`;
}
confirmMsg += `\nThe material will be ready to link with a different supplier.\n\nThis cannot be undone.`;
if (await showGlassConfirm(confirmMsg, { title: `Unlink ${esc(material.supplierName)}`, confirmText: 'Unlink', danger: true })) {
await unlinkSupplierFromMaterial(material, true);
closeFactoryInventoryModal();
setTimeout(() => editFactoryInventoryItem(material.id), 100);
refreshPaymentTab();
calculateNetCash();
renderFactoryInventory();
}
}

export async function saveFactoryInventoryItem() {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
const salesCustomers = ensureArray(await sqliteStore.get('sales_customers'));
const name = document.getElementById('factoryMaterialName').value;
const qty = parseFloat(document.getElementById('factoryMaterialQuantity').value) || 0;
const cost = parseFloat(document.getElementById('factoryMaterialCost').value) || 0;
const conversionFactor = parseFloat(document.getElementById('factoryMaterialConversionFactor').value) || 1;
const unitName = document.getElementById('factoryMaterialUnitName').value.trim() || '';
const supplierType = document.getElementById('factoryMaterialSupplierType').value;
if (!name) return showToast('Name required', 'warning');
if (qty < 0) return showToast('Quantity cannot be negative', 'warning');
if (cost <= 0) return showToast('Please enter a valid cost greater than 0', 'warning');
if (conversionFactor <= 0) return showToast('Conversion factor must be greater than 0', 'warning');
try {
const quantityInKg = qty * conversionFactor;
const costPerKg = conversionFactor > 0 ? cost / conversionFactor : cost;
const totalValue = qty * cost;
let materialId;
let _supplierUnchanged = false;
let _oldStockValue = 0;
if (editingFactoryInventoryId) {
materialId = editingFactoryInventoryId;
const idx = factoryInventoryData.findIndex(i => i.id === editingFactoryInventoryId);
if (idx !== -1) {
const existingMaterial = factoryInventoryData[idx];
_oldStockValue = Number(existingMaterial.totalValue) || 0;
const oldSupplierId = existingMaterial.supplierId;
const supplierInput = document.getElementById('factoryExistingSupplier');
const newSupplierId = (supplierInput && supplierInput.getAttribute('data-supplier-id')) || '';
const isSupplierSame = supplierType === 'existing' && oldSupplierId && newSupplierId && String(oldSupplierId) === String(newSupplierId);
const isSupplierChanging = !isSupplierSame && (
(supplierType === 'none' && oldSupplierId) ||
(supplierType === 'existing' && oldSupplierId && newSupplierId && String(oldSupplierId) !== String(newSupplierId))
);
if (isSupplierChanging) await unlinkSupplierFromMaterial(existingMaterial, false, true);
_supplierUnchanged = isSupplierSame;
factoryInventoryData[idx] = ensureRecordIntegrity({ ...factoryInventoryData[idx], name, quantity: quantityInKg, cost: costPerKg, unit: 'kg', totalValue, purchaseQuantity: qty, purchaseCost: cost, conversionFactor, purchaseUnitName: unitName, updatedAt: getTimestamp() }, true);
}
} else {
materialId = generateUUID('mat');
if (!validateUUID(materialId)) materialId = generateUUID('mat');
const _matNow = getTimestamp();
let _newMaterial = { id: materialId, name, quantity: quantityInKg, cost: costPerKg, unit: 'kg', totalValue, paymentStatus: 'pending', syncedAt: new Date().toISOString(), purchaseQuantity: qty, purchaseCost: cost, conversionFactor, purchaseUnitName: unitName, createdAt: _matNow, updatedAt: _matNow, timestamp: _matNow };
_newMaterial = ensureRecordIntegrity(_newMaterial, false);
factoryInventoryData.push(_newMaterial);
}
if (supplierType === 'none') {
const material = factoryInventoryData.find(m => m.id === materialId);
if (material) {
delete material.supplierId;
delete material.supplierName;
delete material.supplierContact;
delete material.supplierType;
material.paymentStatus = 'pending';
material.totalPayable = totalValue;
}
} else if (supplierType === 'existing') {
if (!_supplierUnchanged) {
const supplierInput = document.getElementById('factoryExistingSupplier');
const existingSupplierId = supplierInput.getAttribute('data-supplier-id') || supplierInput.value;
if (existingSupplierId) await linkMaterialToSupplier(materialId, existingSupplierId, totalValue, true, factoryInventoryData);
}
} else if (supplierType === 'new') {
const supplierName = document.getElementById('factorySupplierName').value.trim();
const supplierPhone = document.getElementById('factorySupplierPhone').value.trim();
if (supplierName) {
const newSupplier = await createSupplierFromMaterial({ name: supplierName, phone: supplierPhone, materialId, materialName: name, materialTotal: totalValue });
if (newSupplier && newSupplier.id) await linkMaterialToSupplier(materialId, newSupplier.id, totalValue, true, factoryInventoryData);
}
}
const savedMaterial = factoryInventoryData.find(m => m.id === materialId);
await unifiedSave('factory_inventory_data', factoryInventoryData, savedMaterial);
if (editingFactoryInventoryId && _supplierUnchanged && savedMaterial && savedMaterial.supplierId) {
const _delta = (Number(savedMaterial.totalValue) || 0) - _oldStockValue;
if (Math.abs(_delta) > 0.01) {
const _allTx = ensureArray(await sqliteStore.get('payment_transactions'));
const _inv = findPayableInTxs(_allTx, savedMaterial.id, savedMaterial.supplierId).filter(t => t.materialId === savedMaterial.id && !(t.materialIds && t.materialIds.length > 1));
if (_inv.length > 0) {
const _tx = _inv[_inv.length - 1];
const _plan = planPayableAdjustment(_tx.amount, _delta);
if (_plan.change !== 0) {
const _go = await showGlassConfirm(`You changed the stock value of ${savedMaterial.name} by ${fmtAmt(_delta)}.\n\nWhat you owe ${savedMaterial.supplierName || 'the supplier'} for it is ${fmtAmt(_tx.amount)}. Update it to ${fmtAmt(_plan.next)}?`, { title: 'Update supplier payable?', confirmText: 'Update payable', cancelText: 'Keep as is' });
if (_go) {
_tx.amount = _plan.next; _tx.updatedAt = getTimestamp();
ensureRecordIntegrity(_tx, true);
await unifiedSave('payment_transactions', _allTx, _tx);
await _recomputeSupplierPayables([String(savedMaterial.supplierId)], ensureArray(await sqliteStore.get('factory_inventory_data')), _allTx, new Set(), new Set([String(savedMaterial.id)]));
await _refreshSupplierLinkViews();
}
}
}
}
}
notifyDataChange('inventory');
emitSyncUpdate({ factory_inventory_data: null});
if (typeof renderFactoryInventory === 'function') renderFactoryInventory();
if (typeof renderUnifiedTable === 'function') renderUnifiedTable(1);
closeFactoryInventoryModal();
if (typeof calculateNetCash === 'function') calculateNetCash();
showToast('Material saved successfully!', 'success');
} catch (error) {
showToast('Failed to save material. Please try again.', 'error');
}
}

export async function unlinkSupplierFromMaterial(material, showToastOnNoSupplier = false, skipSideEffects = false, groupId = null) {
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
if (!material) { showToast('Invalid material data', 'error'); return; }
if (!material.supplierId) {
if (showToastOnNoSupplier) showToast('No supplier to unlink', 'info');
return;
}
const materialId = material.id;
const linkedTransactions = paymentTransactions.filter(t => t.materialId === materialId && t.entityId === material.supplierId && t.isPayable === true);
if (linkedTransactions.length > 0) {
const removedTransactions = linkedTransactions.slice();
let filteredTx = paymentTransactions.slice();
for (const tx of removedTransactions) {
filteredTx = filteredTx.filter(t => t.id !== tx.id);
await unifiedDelete('payment_transactions', filteredTx, tx.id, { strict: true }, groupId ? stampGroup(tx, groupId) : tx);
}
}
delete material.supplierId;
delete material.supplierName;
delete material.supplierContact;
delete material.supplierType;
material.paymentStatus = 'pending';
delete material.totalPayable;
delete material.paidDate;
material.updatedAt = getTimestamp();
ensureRecordIntegrity(material, true);
if (!skipSideEffects) {
await unifiedSave('factory_inventory_data', factoryInventoryData, material);
triggerAutoSync();
await _refreshSupplierLinkViews();
showToast(`Unlinked from ${esc(material.name)}`, 'success');
}
}

export async function createSupplierFromMaterial(supplierData) {
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const existingSupplier = paymentEntities.find(e => e && e.name && supplierData && supplierData.name && e.name.toLowerCase() === supplierData.name.toLowerCase() && e.type === 'payee');
if (existingSupplier) return existingSupplier;
let suppId = generateUUID('supp');
if (!validateUUID(suppId)) suppId = generateUUID('supp');
const suppCreatedAt = getTimestamp();
let supplierEntity = ensureRecordIntegrity({ id: suppId, name: supplierData.name, type: 'payee', phone: supplierData.phone || '', wallet: '', createdAt: suppCreatedAt, updatedAt: suppCreatedAt, timestamp: suppCreatedAt, isSupplier: true, supplierCategory: 'raw_materials' }, false);
paymentEntities.push(supplierEntity);
await unifiedSave('payment_entities', paymentEntities, supplierEntity);
notifyDataChange('entities');
triggerAutoSync();
return supplierEntity;
}

export async function renderFactoryInventory() {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const tbody = document.getElementById('factoryInventoryTableBody');
let totalVal = 0;
if (factoryInventoryData.length === 0) {
tbody.innerHTML = '<tr><td class="u-empty-state-md" colspan="5">No items in inventory</td></tr>';
const _invEl = document.getElementById('factoryTotalInventoryValue');
if (_invEl) _invEl.innerText = await formatCurrency(0);
return;
}
const prebuiltRows = [];
for (const item of factoryInventoryData) {
const itemTotalValue = (item.quantity * item.cost) || 0;
totalVal += itemTotalValue;
let supplierHtml = '';
if (item.supplierName) {
const remainingPayable = item.totalPayable || 0;
const isFullyPaid = item.paymentStatus === 'paid' || remainingPayable <= 0;
const payableDisplay = isFullyPaid ? `<span class="u-text-emerald">0</span>` : `<span style="font-weight:600;color:var(--accent);">${fmtNum(safeNumber(remainingPayable, 0))}</span>`;
supplierHtml = `<div style="font-size:0.65rem;color:var(--text-muted);margin-top:4px;"><div class="supplier-name-badge">${String(item.supplierName).replace(/'/g, "&#39;").replace(/"/g, "&quot;")}</div><div style="margin-top:3px;font-size:0.7rem;">${payableDisplay}</div></div>`;
} else {
supplierHtml = `<div style="font-size:0.65rem;color:var(--text-muted);margin-top:4px;font-style:italic;opacity:0.6;">No supplier linked</div>`;
}
let quantityHtml = '';
if (item.purchaseQuantity && item.purchaseUnitName && item.conversionFactor && item.conversionFactor !== 1) {
quantityHtml = `<div class="u-text-center"><div class="u-fs-sm3 u-text-main u-fw-600">${fmtNum(item.purchaseQuantity || 0)}</div><div class="u-fs-sm u-text-muted">${esc(item.purchaseUnitName)}</div><div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">(${fmtNum(item.quantity || 0)})</div></div>`;
} else if (item.purchaseQuantity && item.conversionFactor && item.conversionFactor !== 1) {
quantityHtml = `<div class="u-text-center"><div class="u-fs-sm3 u-text-main u-fw-600">${fmtNum(item.purchaseQuantity || 0)}</div><div class="u-fs-sm u-text-muted">units</div><div style="font-size:0.65rem;color:var(--text-muted);margin-top:2px;">(${fmtNum(item.quantity || 0)})</div></div>`;
} else {
quantityHtml = `<div class="u-text-center"><div class="u-fs-sm3 u-text-main u-fw-600">${fmtNum(item.quantity || 0)}</div><div class="u-fs-sm u-text-muted">kg</div></div>`;
}
if (!(Number(item.quantity) > 0)) quantityHtml += `<div class="u-text-center" style="font-size:0.6rem;font-weight:700;color:var(--danger,#ef4444);margin-top:2px;">OUT OF STOCK</div>`;
let costHtml = '';
if (item.purchaseCost && item.purchaseUnitName && item.conversionFactor && item.conversionFactor !== 1) {
costHtml = `<div class="u-text-center"><div class="u-fs-sm2 u-text-main">${await formatCurrency(item.purchaseCost)}</div><div class="u-fs-sm u-text-muted">${esc(item.purchaseUnitName)}</div></div>`;
} else if (item.purchaseCost && item.conversionFactor && item.conversionFactor !== 1) {
costHtml = `<div class="u-text-center"><div class="u-fs-sm2 u-text-main">${await formatCurrency(item.purchaseCost)}</div><div class="u-fs-sm u-text-muted">unit</div></div>`;
} else {
costHtml = `<div class="u-text-center"><div class="u-fs-sm2 u-text-main">${await formatCurrency(item.cost)}</div><div class="u-fs-sm u-text-muted">kg</div></div>`;
}
const totalValueStr = await formatCurrency(itemTotalValue);
const itemId = esc(item.id);
const itemName = esc(item.name);
const tr = document.createElement('tr');
tr.style.borderBottom = '1px solid var(--glass-border)';
tr.style.cursor = 'pointer';
tr.innerHTML = `<td style="padding:8px 2px; cursor:pointer;" onclick="editFactoryInventoryItem('${itemId}')"><div style="font-weight:600;font-size:0.8rem;color:var(--accent);">${itemName}</div>${supplierHtml}</td><td style="text-align:center;padding:8px 2px;">${quantityHtml}</td><td style="text-align:right;padding:8px 2px;font-size:0.75rem;color:var(--text-muted);">${costHtml}</td><td style="text-align:right;padding:8px 2px;font-size:0.8rem;font-weight:700;color:var(--accent);">${totalValueStr}</td>`;
prebuiltRows.push(tr);
}
tbody.innerHTML = '';
const _fragF = document.createDocumentFragment();
prebuiltRows.forEach(el => { if (el) _fragF.appendChild(el); });
tbody.appendChild(_fragF);

const _invEl = document.getElementById('factoryTotalInventoryValue');
if (_invEl) _invEl.innerText = await formatCurrency(totalVal);
}

export async function unlinkSupplierFromMaterialById(materialId) {
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
let material = factoryInventoryData.find(m => m.id === materialId);
if (!material) {
const reloadedData = await sqliteStore.get('factory_inventory_data');
if (Array.isArray(reloadedData)) {
material = factoryInventoryData.find(m => m.id === materialId);
}
}
if (!material) { showToast('Material not found', 'error'); return; }
if (!material.supplierId) { showToast('No supplier linked', 'warning'); return; }
const linkedTransactions = paymentTransactions.filter(t => t.materialId === materialId && t.entityId === material.supplierId && t.isPayable === true);
const _us2Total = linkedTransactions.reduce((sum, t) => sum + (parseFloat(t.amount) || 0), 0);
let confirmMsg = `Unlink ${material.supplierName} from "${material.name}"?`;
confirmMsg += `\nCurrent Stock: ${fmtNum(material.quantity || 0)} kg`;
if (material.totalPayable) confirmMsg += `\nOutstanding Payable: ${fmtAmt(material.totalPayable || 0)}`;
if (linkedTransactions.length > 0) confirmMsg += `\n\n↩ ${linkedTransactions.length} payment transaction${linkedTransactions.length !== 1 ? 's' : ''} totaling ${fmtAmt(_us2Total)} will be reversed and the material reverted to "Pending Payable" status.`;
confirmMsg += `\n\nThe material will be available to link with a different supplier.\n\nThis cannot be undone.`;
if (await showGlassConfirm(confirmMsg, { title: `Unlink ${esc(material.supplierName)}`, confirmText: 'Unlink', danger: true })) {
await unlinkSupplierFromMaterial(material, true);
}
}

export function toggleSupplierFields() {
const supplierType = document.getElementById('factoryMaterialSupplierType').value;
const existingSection = document.getElementById('existingSupplierSection');
const newSection = document.getElementById('newSupplierSection');
if (existingSection) existingSection.classList.add('hidden');
if (newSection) newSection.classList.add('hidden');
if (supplierType === 'existing') { if (existingSection) existingSection.classList.remove('hidden'); }
else if (supplierType === 'new') { if (newSection) newSection.classList.remove('hidden'); }
}

export async function loadExistingSuppliers() {
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const selectElement = document.getElementById('factoryExistingSupplier');
if (!selectElement) return;
selectElement.innerHTML = '<option value="">Choose Supplier</option>';
const suppliers = paymentEntities.filter(entity => entity.type === 'payee');
suppliers.forEach(supplier => {
const option = document.createElement('option');
option.value = supplier.id;
option.textContent = `${supplier.name || 'Unknown'} ${supplier.phone ? `(${supplier.phone})` : ''}`;
selectElement.appendChild(option);
});
if (suppliers.length === 0) {
const option = document.createElement('option');
option.value = '';
option.textContent = 'No suppliers found. Create a new one.';
option.disabled = true;
selectElement.appendChild(option);
}
}

export async function linkMaterialToSupplier(materialId, supplierId, totalCost, skipSideEffects = false, sharedInventory = null) {
const factoryInventoryData = sharedInventory || ensureArray(await sqliteStore.get('factory_inventory_data'));
const paymentEntities = ensureArray(await sqliteStore.get('payment_entities'));
const paymentTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
let material = factoryInventoryData.find(m => m.id === materialId);
if (!material) {
const reloadedData = await sqliteStore.get('factory_inventory_data');
if (Array.isArray(reloadedData)) {
material = reloadedData.find(m => m.id === materialId);
}
}
if (!material) { showToast('Material not found. Try refreshing.', 'error'); return; }
let supplier = paymentEntities.find(e => e.id === supplierId || String(e.id) === String(supplierId));
if (!supplier) {
const supplierTransaction = paymentTransactions.find(t => t.entityId === supplierId || String(t.entityId) === String(supplierId));
if (supplierTransaction) {
supplier = { id: supplierId, name: supplierTransaction.entityName || 'Supplier', type: 'payee', phone: '' };
} else {
showToast('Supplier not found. Please refresh and try again.', 'error');
return;
}
}
if (material.supplierId && String(material.supplierId) !== String(supplierId)) {
await unlinkSupplierFromMaterial(material, false, true);
}
// Already invoiced by this supplier: a second payable would count the same debt twice.
if (findPayableInTxs(paymentTransactions, material.id, supplier.id).length > 0) {
if (!skipSideEffects) showToast(`${esc(material.name)} is already linked to ${esc(supplier.name)}.`, 'info');
return;
}
material.supplierId = supplier.id;
material.supplierName = supplier.name;
material.supplierContact = supplier.phone || '';
material.supplierType = 'payee';
material.paymentStatus = 'pending';
material.totalPayable = totalCost;
material.updatedAt = getTimestamp();
ensureRecordIntegrity(material, true);
const payableTransactions = ensureArray(await sqliteStore.get('payment_transactions'));
const now = new Date();
const dateStr = localDateStr(now);
const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });
let payableTxId = generateUUID('pay');
if (!validateUUID(payableTxId)) payableTxId = generateUUID('pay');
const payableTxCreatedAt = getTimestamp();
let payableTx = {
id: payableTxId,
entityId: supplier.id,
entityName: supplier.name,
entityType: 'payee',
date: dateStr,
time: timeStr,
amount: totalCost,
description: `Material purchase: ${material.name}`,
type: 'IN',
isPayable: true,
materialId: material.id,
createdAt: payableTxCreatedAt,
updatedAt: payableTxCreatedAt,
timestamp: payableTxCreatedAt,
syncedAt: now.toISOString()
};
payableTx = ensureRecordIntegrity(payableTx, false);
payableTransactions.push(payableTx);
if (!skipSideEffects) {
await unifiedSave('factory_inventory_data', factoryInventoryData, material);
await unifiedSave('payment_transactions', payableTransactions, payableTx);
notifyDataChange('all');
triggerAutoSync();
await renderFactoryInventory();
await refreshPaymentTab();
calculateNetCash();
showToast(`Linked to ${esc(supplier.name)}`, 'success');
} else {
await sqliteStore.set('payment_transactions', payableTransactions);
}
}

export async function selectFactoryFormula(formulaType) {
const _sffStores = typeof getAppStores === 'function' ? await getAppStores() : [];
const _sffRep = _sffStores.find(s => (s.formulaType || 'standard') === formulaType);
if (!_sffRep) {
showToast('No store is using this formula.', 'warning', 3000);
return;
}
_set_currentFactoryEntryStore(_sffRep.key);
if (typeof window.syncFactoryFormulaPicker === 'function') window.syncFactoryFormulaPicker(formulaType);
calculateFactoryProduction();
}

export async function getSalePriceForStore(store) {
if (!store) return 0;
const stores = typeof getAppStores === 'function' ? await getAppStores() : [];
const storeEntry = stores.find(s => s.key === store);
return (storeEntry && storeEntry.salePrice > 0) ? storeEntry.salePrice : 0;
}

export async function getEffectiveSalePriceForCustomer(customerName, store) {
const salesCustomers = ensureArray(await sqliteStore.get('sales_customers'));
if (customerName) {
const _reg = Array.isArray(salesCustomers) ? salesCustomers.find(c => c && c.name && c.name.toLowerCase() === String(customerName).toLowerCase()) : null;
if (_reg && _reg.customSalePrice > 0) return _reg.customSalePrice;
}
return await getSalePriceForStore(store);
}

export async function getSaleTransactionValue(t) {
const salesCustomers = ensureArray(await sqliteStore.get('sales_customers'));
if (!t) return 0;
if (t.isMerged) return parseFloat(t.totalValue) || 0;
const pt = t.paymentType || 'CASH';
if (pt === 'COLLECTION' || pt === 'PARTIAL_PAYMENT') return parseFloat(t.totalValue) || 0;
if (t.transactionType === 'OLD_DEBT') return parseFloat(t.totalValue) || 0;
const qty = parseFloat(t.quantity) || 0;
const locked = lockedSaleValue(t);
if (locked !== null) return locked;
return round2(qty * (await getEffectiveSalePriceForCustomer(t.customerName, t.supplyStore || 'STORE_A')));
}

export async function getCostPriceForStore(store) {
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
const factoryCostAdjustmentFactor = (await sqliteStore.get('factory_cost_adjustment_factor')) || {};
if (!store) return 0;
const formulaType = typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(store) : (store === 'STORE_C' ? 'asaan' : 'standard');
return await calculateSalesCostPerKg(formulaType);
}

export async function getStorePricing(store) {
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
const factoryCostAdjustmentFactor = (await sqliteStore.get('factory_cost_adjustment_factor')) || {};
return { salePrice: await getSalePriceForStore(store), costPrice: await getCostPriceForStore(store) };
}

let _cfpToken = 0;
export async function calculateFactoryProduction() {
// Newest call wins: a slower, older render must never overwrite a newer one.
const token = ++_cfpToken;
const units = parseInt(document.getElementById('factoryProductionUnits').value) || 1;
const sel = await getSelectedFormula(currentFactoryEntryStore);
const lines = [];
let baseCost = 0;
for (const i of sel.ingredients) {
const qty = i.quantity * units;
const lineTotal = i.cost * qty;
baseCost += lineTotal;
let note = '';
if (i.missing) note = ' <span style="color:var(--danger);">(not in inventory)</span>';
else if (i.stock + 1e-6 < qty) note = ` <span style="color:var(--danger);">(short ${fmtNum(qty - i.stock)} kg)</span>`;
lines.push(`<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:2px;"><span>${esc(i.name)} (${fmtNum(qty)} kg)${note}</span><span>${await formatCurrency(lineTotal)}</span></div>`);
}
let html = `<h4 style="margin:0 0 5px 0;font-size:0.9rem;">${esc(sel.name)} Formula (${units} Units)</h4>`;
if (lines.length > 0) {
html += lines.join('');
const totalAdditionalCost = sel.additionalCost * units;
if (totalAdditionalCost > 0) {
html += `<div style="display:flex;justify-content:space-between;font-size:0.8rem;margin-bottom:2px;color:var(--danger);"><span>Additional Cost (${sel.additionalCost} per unit)</span><span>${await formatCurrency(totalAdditionalCost)}</span></div>`;
baseCost += totalAdditionalCost;
}
} else {
html += `<div class="u-text-muted">No formula set.</div>`;
}
const totalText = await formatCurrency(baseCost);
if (token !== _cfpToken) return;
const _fd = document.getElementById('factoryFormulaDisplay');
if (_fd) _fd.innerHTML = html;
const _prodCostEl = document.getElementById('factoryTotalProductionCostDisplay');
if (_prodCostEl) _prodCostEl.innerText = totalText;
}

function _resetFactoryForm() {
const u = document.getElementById('factoryProductionUnits'); if (u) u.value = '1';
if (typeof calculateFactoryProduction === 'function') calculateFactoryProduction();
}

export async function startEditFactoryEntry(id) {
const hist = ensureArray(await sqliteStore.get('factory_production_history'));
const rec = hist.find(h => h && String(h.id) === String(id));
if (!rec || rec.isMerged) { showToast('This batch cannot be edited.', 'warning'); return; }
if (typeof showTab === 'function') showTab('factory');
const _ft = rec.formulaType || (typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(rec.store) : 'standard');
_set_currentFactoryEntryStore(rec.store);
if (typeof window.syncFactoryFormulaPicker === 'function') window.syncFactoryFormulaPicker(_ft);
const u = document.getElementById('factoryProductionUnits'); if (u) u.value = rec.units;
if (typeof calculateFactoryProduction === 'function') await calculateFactoryProduction();
beginEditMode('factory', rec, { buttonId: 'btn-save-factory-production', watchIds: ['factoryProductionUnits'], label: 'Update Batch', anchorId: 'factoryProductionUnits', cancelFn: _resetFactoryForm });
}
registerEditHandler('factory', startEditFactoryEntry);

export async function saveFactoryProductionEntry() {
const _ed = getEditCtx('factory');

if (!currentFactoryEntryStore) {
showToast('Please select a formula before saving.', 'warning', 3000);
return;
}
const _sfpeBatch = await sqliteStore.getBatch([
'factory_default_formulas','factory_additional_costs',
'factory_inventory_data','factory_production_history',
]);
const factoryDefaultFormulas = _sfpeBatch.get('factory_default_formulas') || {};
const factoryAdditionalCosts = _sfpeBatch.get('factory_additional_costs') || {};
const factoryInventoryData = ensureArray(_sfpeBatch.get('factory_inventory_data'));
const factoryProductionHistory = ensureArray(_sfpeBatch.get('factory_production_history'));
if (appMode === 'userrole' && !(window._userRoleAllowedTabs || []).includes('factory')) {
showToast('Access Denied — Factory not in your assigned tabs', 'warning', 3000);
return;
}
const units = parseInt(document.getElementById('factoryProductionUnits').value) || 0;
if (units <= 0) return showToast('Invalid units', 'warning', 3000);
const inventorySnapshot = JSON.parse(JSON.stringify(factoryInventoryData));
const historySnapshot = [...factoryProductionHistory];
try {
const _sfpeType = typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(currentFactoryEntryStore) : (currentFactoryEntryStore === 'STORE_C' ? 'asaan' : 'standard');
const _freshFormula = await getSelectedFormula(currentFactoryEntryStore);
const settings = _freshFormula.ingredients.filter(i => i.quantity > 0);
if (!settings || settings.length === 0) {
showToast('No formula configured for this store. Assign a formula to it in Store Manager first.', 'warning', 5000);
return;
}
let _edHistIdx = -1;
if (_ed) {
const o = _ed.original;
const oType = o.formulaType || (typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(o.store) : 'standard');
const tr = await updateFormulaInventory();
const avail = tr?.[oType]?.available || 0;
const delta = (oType === _sfpeType) ? (units - (o.units || 0)) : -(o.units || 0);
if (avail + delta < -1e-9) {
throw new Error(`Cannot change this batch: its units are already used in manufacturing entries. Delete or reduce those first.`);
}
const restore = (Array.isArray(o.materialsUsed) && o.materialsUsed.length > 0)
? o.materialsUsed
: (factoryDefaultFormulas[oType] || []).map(m => ({ id: m.id, name: m.name, quantity: m.quantity * (o.units || 0) }));
for (const m of restore) {
let inv = factoryInventoryData.find(i => String(i.id) === String(m.id));
if (!inv && m.name) inv = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === m.name.trim().toLowerCase());
if (inv) {
inv.quantity = parseFloat(((inv.quantity || 0) + m.quantity).toFixed(6));
inv.totalValue = inv.quantity * inv.cost;
if (inv.conversionFactor && inv.conversionFactor !== 1) inv.purchaseQuantity = inv.quantity / inv.conversionFactor;
inv.updatedAt = getTimestamp();
}
}
_edHistIdx = factoryProductionHistory.findIndex(h => h && h.id === o.id);
if (_edHistIdx >= 0) factoryProductionHistory.splice(_edHistIdx, 1);
}
const additionalCost = _freshFormula.additionalCost;
let baseCost = 0;
let rawMat = 0;
if (settings) {
baseCost = settings.reduce((acc, cur) => {
let liveItem = factoryInventoryData.find(i => String(i.id) === String(cur.id));
if (!liveItem && cur.name) liveItem = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === cur.name.trim().toLowerCase());
const liveCost = liveItem ? liveItem.cost : cur.cost;
return acc + (liveCost * cur.quantity);
}, 0) * units;
rawMat = settings.reduce((acc, cur) => acc + cur.quantity, 0) * units;
}
const totalCost = baseCost + (additionalCost * units);
let inventoryUpdated = false;
const materialsUsed = [];
if (settings && settings.length > 0) {
const _notInInventory = settings.filter(it => !factoryInventoryData.find(i => String(i.id) === String(it.id)) && !(it.name && factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === it.name.trim().toLowerCase())));
if (_notInInventory.length) {
throw new Error(`Cannot produce: ${_notInInventory.map(m => '"' + m.name + '"').join(', ')} ${_notInInventory.length === 1 ? 'is' : 'are'} not in Raw Material Inventory. Add ${_notInInventory.length === 1 ? 'it' : 'them'} with the Add Raw Material button first.`);
}
for (const item of settings) {
const materialUsed = item.quantity * units;
let inventoryItem = factoryInventoryData.find(i => String(i.id) === String(item.id));
if (!inventoryItem && item.name) {
inventoryItem = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === item.name.trim().toLowerCase());
}
if (!inventoryItem) {
throw new Error(`Material "${item.name}" not found in inventory. Please re-save the formula in the Formula Store to relink all materials.`);
}
if (inventoryItem.quantity + 1e-6 >= materialUsed) {
inventoryItem.quantity -= materialUsed;
inventoryItem.quantity = Math.max(0, parseFloat(inventoryItem.quantity.toFixed(6)));
inventoryItem.totalValue = inventoryItem.quantity * inventoryItem.cost;
if (inventoryItem.conversionFactor && inventoryItem.conversionFactor !== 1) {
inventoryItem.purchaseQuantity = inventoryItem.quantity / inventoryItem.conversionFactor;
}
inventoryItem.updatedAt = getTimestamp();
inventoryUpdated = true;
materialsUsed.push({ id: inventoryItem.id, name: inventoryItem.name, quantity: materialUsed, cost: inventoryItem.cost });
} else {
throw new Error(`Insufficient "${inventoryItem.name}" in inventory! Available: ${fmtNum(inventoryItem.quantity)} kg, Required: ${fmtNum(materialUsed)} kg`);
}
}
}
let factProdId = _ed ? _ed.id : generateUUID('fprod');
if (!validateUUID(factProdId)) factProdId = generateUUID('fprod');
const factProdCreatedAt = getTimestamp();
const _savedFormulaType = typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(currentFactoryEntryStore) : (currentFactoryEntryStore === 'STORE_C' ? 'asaan' : 'standard');
const productionRecord = {
id: factProdId,
date: localDateStr(),
time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
store: currentFactoryEntryStore,
formulaType: _savedFormulaType,
formulaName: (await getFormulaSlotLabels())[_savedFormulaType] || 'Formula',
units,
totalCost,
materialsCost: baseCost,
additionalCost: additionalCost * units,
rawMaterialsUsed: rawMat,
materialsUsed,
createdAt: factProdCreatedAt,
updatedAt: factProdCreatedAt,
timestamp: factProdCreatedAt,
syncedAt: new Date().toISOString(),
managedBy: (appMode === 'factory' && window._assignedManagerName) ? window._assignedManagerName : null,
createdBy: (appMode === 'userrole' && window._assignedManagerName) ? window._assignedManagerName : null
};
if (_ed) {
const o = _ed.original;
stampEdit(productionRecord, o);
productionRecord.date = o.date;
productionRecord.time = o.time;
if (o.managedBy) productionRecord.managedBy = o.managedBy;
}
const validatedRecord = ensureRecordIntegrity(productionRecord, !!_ed);
if (_ed && _edHistIdx >= 0) factoryProductionHistory.splice(_edHistIdx, 0, validatedRecord); else factoryProductionHistory.unshift(validatedRecord);
await unifiedSave('factory_production_history', factoryProductionHistory, validatedRecord);
if (inventoryUpdated) {
const inventoryIds = factoryInventoryData.filter(i => i && i.id).map(i => i.id);
await unifiedSave('factory_inventory_data', factoryInventoryData, null, inventoryIds);
} else {
await unifiedSave('factory_inventory_data', factoryInventoryData);
}
notifyDataChange('factory');
emitSyncUpdate({ factory_inventory_data: null, factory_production_history: null});
await syncFactoryProductionStats();
await refreshFactoryTab();
calculateNetCash();
calculateCashTracker();
if (_ed) endEditMode();
document.getElementById('factoryProductionUnits').value = '1';

showToast(_ed ? 'Production batch updated!' : 'Production saved successfully!', 'success');
} catch (error) {
factoryInventoryData.length = 0;
factoryInventoryData.push(...inventorySnapshot);
factoryProductionHistory.length = 0;
factoryProductionHistory.push(...historySnapshot);
try {
await sqliteStore.setBatch([
['factory_inventory_data', factoryInventoryData],
['factory_production_history', factoryProductionHistory]
]);
} catch (rollbackError) {
console.error('Failed to save data locally.', _safeErr(rollbackError));
showToast('Production rollback failed: ' + (_safeErr(rollbackError).message || 'data may be inconsistent, please reload'), 'error');
}
showToast(error.message || 'Failed to save production data. Please try again.', 'error', 4000);
}
}

export function setFactorySummaryMode(mode, el) {
currentFactorySummaryMode = mode; window.currentFactorySummaryMode = currentFactorySummaryMode;
document.querySelectorAll('#tab-factory .toggle-group .toggle-opt').forEach(opt => opt.classList.remove('active'));
if (el) el.classList.add('active');
updateFactorySummaryCard();
_filterFactoryHistoryByMode(mode);
}

export async function setFactoryAvailableStore(formulaType) {
const _ftype = (formulaType === 'asaan') ? 'asaan' : 'standard';
['S1', 'S2'].forEach(k => {
const panel = document.getElementById('factoryAvailStats' + k);
if (!panel) return;
panel.classList.add('hidden');
panel.style.display = 'none';
});
const statsElement = document.getElementById('factoryAvailStats' + (_ftype === 'asaan' ? 'S2' : 'S1'));
if (statsElement) {
statsElement.classList.remove('hidden');
statsElement.style.display = 'grid';
}
if (typeof window.syncFactoryAvailPicker === 'function') window.syncFactoryAvailPicker(_ftype);
await updateFactoryUnitsAvailableStats();
}

export async function renderFactoryHistory() {
const _fhBatch = await sqliteStore.getBatch(['factory_production_history','factory_additional_costs','factory_default_formulas','factory_inventory_data']);
const factoryProductionHistory = ensureArray(_fhBatch.get('factory_production_history'));
const factoryAdditionalCosts = (_fhBatch.get('factory_additional_costs')) || {};
const factoryDefaultFormulas = (_fhBatch.get('factory_default_formulas')) || {};
const factoryInventoryData = ensureArray(_fhBatch.get('factory_inventory_data'));
const _fhLabels = await getFormulaSlotLabels();
const list = document.getElementById('factoryHistoryList');
if (!list) return;
if (factoryProductionHistory.length === 0) {
list.replaceChildren(Object.assign(document.createElement('div'), { className: 'u-empty-state-sm', textContent: 'No recent activity' }));
return;
}
const _fhFrag = document.createDocumentFragment();
const recent = [...factoryProductionHistory].sort((a, b) => {
const timeA = a.timestamp || new Date(a.date + ' ' + a.time).getTime();
const timeB = b.timestamp || new Date(b.date + ' ' + b.time).getTime();
return timeB - timeA;
});
for (const entry of recent) {
const dateObj = new Date(entry.date);
const month = dateObj.toLocaleDateString('en-US', { month: 'short' });
const day = String(dateObj.getDate()).padStart(2, '0');
const year = String(dateObj.getFullYear()).slice(-2);
const dateStr = `${month} ${day} ${year} ${esc(entry.time || '')}`;
const _histFtype = entry.formulaType || (entry.store === 'asaan' || entry.store === 'STORE_C' ? 'asaan' : 'standard');
const badgeClass = _histFtype === 'asaan' ? 'factory-badge-asn' : 'factory-badge-std';
const formulaLabel = esc(entry.formulaName || _fhLabels[_histFtype] || 'Formula');
const perUnitCost = entry.units > 0 ? entry.totalCost / entry.units : 0;
const additionalCostPerUnit = factoryAdditionalCosts[_histFtype] || factoryAdditionalCosts[entry.store] || 0;
const totalAdditionalCost = entry.additionalCost != null ? (parseFloat(entry.additionalCost) || 0) : additionalCostPerUnit * entry.units;

const _hasUsed = Array.isArray(entry.materialsUsed) && entry.materialsUsed.length > 0;
const formula = _hasUsed ? entry.materialsUsed : (factoryDefaultFormulas[_histFtype] || factoryDefaultFormulas[entry.store] || []);
let matsBreakdownHtml = '';
if (formula.length > 0) {
const rowsHtml = formula.map(f => {
let inv = factoryInventoryData.find(i => String(i.id) === String(f.id));
if (!inv && f.name) inv = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === f.name.trim().toLowerCase());
const matName = esc(f.name || inv?.name || 'Material');
const qtyUsed = fmtNum(_hasUsed ? f.quantity : f.quantity * entry.units);
const unitCost = _hasUsed ? (f.cost != null ? f.cost : (inv ? inv.cost : 0)) : (inv ? inv.cost : (f.cost || 0));
const matCost = _hasUsed ? (unitCost * f.quantity) : (unitCost * f.quantity * entry.units);
return `<div style="display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:1px solid var(--glass-border);">
<span style="font-size:0.72rem;color:var(--text-main);font-weight:500;">${matName}</span>
<span style="display:flex;gap:10px;align-items:center;">
<span style="font-size:0.7rem;color:var(--text-muted);">${qtyUsed} kg</span>
<span class="cost-val" style="font-size:0.72rem;min-width:60px;text-align:right;">${fmtAmt(matCost)}</span>
</span>
</div>`;
}).join('');
const breakdownId = `fh-breakdown-${entry.id}`;
matsBreakdownHtml = `
<div style="margin-top:8px;">
<button onclick="(function(el){var p=document.getElementById('${breakdownId}');var open=p.style.display!=='none';p.style.display=open?'none':'block';el.querySelector('span').textContent=open?'':'';})(this)"
style="display:flex;align-items:center;gap:5px;background:none;border:none;cursor:pointer;padding:4px 0;width:100%;">
<span style="font-size:0.68rem;color:var(--accent);"></span>
<span style="font-size:0.68rem;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:0.05em;">Materials Breakdown</span>
</button>
<div id="${breakdownId}" style="display:none;background:var(--glass-raised);border-radius:10px;padding:8px 10px;margin-top:4px;border:1px solid var(--glass-border);">
<div style="display:flex;justify-content:space-between;padding-bottom:5px;margin-bottom:2px;">
<span style="font-size:0.62rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Material</span>
<span style="display:flex;gap:10px;">
<span style="font-size:0.62rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">Qty Used</span>
<span style="font-size:0.62rem;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;min-width:60px;text-align:right;">Cost</span>
</span>
</div>
${rowsHtml}
</div>
</div>`;
}
const div = document.createElement('div');
div.className = 'factory-history-item';
if (entry.date) div.setAttribute('data-date', entry.date);
div.innerHTML = `
<div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:5px;margin-bottom:8px;border-bottom:1px solid var(--glass-border);padding-bottom:5px;">
<div style="display:flex;align-items:center;flex-wrap:wrap;gap:5px;">
<span class="u-fs-sm2 u-text-muted">${dateStr}</span>
${entry.managedBy ? `<span class="managed-by-badge">${esc(entry.managedBy)}</span>` : ''}
${entry.createdBy && typeof _creatorBadgeHtml === 'function' ? _creatorBadgeHtml(entry) : ''}
</div>
<div style="display:flex;gap:6px;align-items:center;">
${_mergedBadgeHtml(entry)}
<span class="factory-badge ${badgeClass}">${formulaLabel}</span>
</div>
</div>
<div class="factory-summary-row"><span class="factory-summary-label">Units Produced</span><span class="qty-val">${entry.units}</span></div>
<div class="factory-summary-row"><span class="factory-summary-label">Material Cost</span><span class="cost-val">${await formatCurrency(entry.materialsCost || 0)}</span></div>
${totalAdditionalCost > 0 ? `<div class="factory-summary-row"><span class="factory-summary-label">Additional Cost</span><span class="cost-val">${await formatCurrency(totalAdditionalCost)}</span></div>` : ''}
<div class="factory-summary-row"><span class="factory-summary-label">Per Unit Cost</span><span class="cost-val">${await formatCurrency(perUnitCost)}</span></div>
<div class="factory-summary-row"><span class="factory-summary-label">Total Cost</span><span class="rev-val">${await formatCurrency(entry.totalCost)}</span></div>
<div class="factory-summary-row"><span class="factory-summary-label">Raw Materials Used</span><span class="qty-val">${fmtNum(safeNumber(entry.rawMaterialsUsed, 0))} kg</span></div>
${matsBreakdownHtml}
${entry.isMerged ? '' : actionRowHtml('factory', entry.id, `<button class="tbl-action-btn danger u-w-full u-mt-8" onclick="deleteFactoryEntry('${entry.id}')">Delete & Restore</button>`)}`;
_fhFrag.appendChild(div);
}
list.replaceChildren(_fhFrag);
_filterFactoryHistoryByMode(currentFactorySummaryMode || 'all');
}

export async function deleteFactoryEntry(id) {
const factoryProductionHistory = ensureArray(await sqliteStore.get('factory_production_history'));
const factoryInventoryData = ensureArray(await sqliteStore.get('factory_inventory_data'));
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
if (!id || !validateUUID(id)) { showToast('Invalid factory entry ID', 'error'); return; }
const entryIndex = factoryProductionHistory.findIndex(e => e.id === id);
if (entryIndex === -1) { await refreshFactoryTab(); return; }
const entry = factoryProductionHistory[entryIndex];
if (entry.isMerged) { showToast('Merged opening balance records cannot be deleted', 'warning'); return; }
const _feStoreLabel = getStoreLabel(entry.store) || entry.store;
const _feFormulaKey = entry.formulaType || (typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(entry.store) : entry.store);
const _feRestore = (Array.isArray(entry.materialsUsed) && entry.materialsUsed.length > 0)
? entry.materialsUsed.map(m => ({ id: m.id, name: m.name, quantity: m.quantity }))
: (factoryDefaultFormulas[_feFormulaKey] || factoryDefaultFormulas[entry.store] || []).map(f => ({ id: f.id, name: f.name, quantity: f.quantity * entry.units }));
const _feMatsDetail = _feRestore.length > 0
? _feRestore.map(f => {
let inv = factoryInventoryData.find(i => String(i.id) === String(f.id));
if (!inv && f.name) inv = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === f.name.trim().toLowerCase());
return ` • ${inv?.name || f.name || 'Material'}: ${fmtNum(f.quantity)} kg restored`;
}).join('\n')
: '';
{
const _feTracking = await updateFormulaInventory();
const _feAvail = _feTracking?.[_feFormulaKey]?.available || 0;
if (_feAvail + 1e-9 < (entry.units || 0)) {
showToast(`Cannot delete: ${fmtNum((entry.units || 0) - _feAvail)} unit${((entry.units || 0) - _feAvail) === 1 ? '' : 's'} of this batch already used in manufacturing entries. Delete those first.`, 'warning', 5000);
return;
}
}
let _feMsg = `Delete this factory production batch permanently?`;
_feMsg += `\nStore: ${_feStoreLabel}\nDate: ${entry.date}\nUnits Produced: ${entry.units}`;
if (entry.totalCost) _feMsg += `\nTotal Cost: ${fmtAmt(entry.totalCost || 0)}`;
_feMsg += _feMatsDetail ? `\n\n↩ Raw materials restored to inventory:\n${_feMatsDetail}` : `\n\n↩ Raw materials used in this batch will be restored to inventory.`;
_feMsg += `\n\n Sales already made from this batch will NOT be reversed — but available stock will change.\n\nThis cannot be undone.`;
if (await showGlassConfirm(_feMsg, { title: 'Delete Factory Production', confirmText: 'Delete', danger: true })) {
try {
entry.deletedAt = getTimestamp();
entry.updatedAt = getTimestamp();
ensureRecordIntegrity(entry, true);
let restoredMaterials = [];
for (const formulaItem of _feRestore) {
const materialToRestore = formulaItem.quantity;
let inventoryItem = factoryInventoryData.find(i => String(i.id) === String(formulaItem.id));
if (!inventoryItem && formulaItem.name) {
inventoryItem = factoryInventoryData.find(i => i.name && i.name.trim().toLowerCase() === formulaItem.name.trim().toLowerCase());
}
if (inventoryItem) {
inventoryItem.quantity = parseFloat(((inventoryItem.quantity || 0) + materialToRestore).toFixed(6));
inventoryItem.totalValue = inventoryItem.quantity * inventoryItem.cost;
if (inventoryItem.conversionFactor && inventoryItem.conversionFactor !== 1) {
inventoryItem.purchaseQuantity = inventoryItem.quantity / inventoryItem.conversionFactor;
}
inventoryItem.updatedAt = getTimestamp();
ensureRecordIntegrity(inventoryItem, true);
restoredMaterials.push({ name: inventoryItem.name || 'Unknown', quantity: materialToRestore });
}
}
factoryProductionHistory.splice(entryIndex, 1);
const inventoryIds = factoryInventoryData.filter(i => i && i.id).map(i => i.id);
await Promise.all([
unifiedDelete('factory_production_history', factoryProductionHistory, id, { strict: true }, entry),
unifiedSave('factory_inventory_data', factoryInventoryData, null, inventoryIds)
]);
await refreshFactoryTab();
calculateNetCash();
calculateCashTracker();
notifyDataChange('factory');
if (restoredMaterials.length > 0) {
showToast(` Entry deleted! Raw materials restored: ${restoredMaterials.map(m => `${m.name}: +${fmtNum(m.quantity)} kg`).join(', ')}`, 'success');
} else {
showToast(' Entry deleted and inventory restored.', 'success');
}
} catch (error) {
showToast(' Failed to delete entry. Please try again.', 'error');
}
}
}

export async function calculateDynamicCost(storeType, formulaUnits, netWeight) {
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
const _dcInv = ensureArray(await sqliteStore.get('factory_inventory_data'));
let formulaStore = 'standard';
if (storeType === 'standard' || storeType === 'asaan') {
  formulaStore = storeType;
} else if (typeof getStoreFormulaType === 'function') {
  formulaStore = await getStoreFormulaType(storeType);
} else {
  formulaStore = storeType === 'STORE_C' ? 'asaan' : 'standard';
}
const formula = factoryDefaultFormulas[formulaStore];
if (!formula || formula.length === 0 || netWeight <= 0) {
return { costPerUnit: 0, totalFormulaCost: 0, dynamicCostPerKg: 0, formulaStore, formulaName: '', formulaMaterials: [], rawMaterialCost: 0 };
}
let totalMaterialCost = 0;
let totalWeight = 0;
formula.forEach(item => { totalMaterialCost += (resolveLiveCost(item, _dcInv) * item.quantity); totalWeight += item.quantity; });
const additionalCost = factoryAdditionalCosts[formulaStore] || 0;
const costPerUnit = totalMaterialCost + additionalCost;
return {
costPerUnit,
totalMaterialCost,
additionalCost,
totalFormulaCost: costPerUnit * formulaUnits,
dynamicCostPerKg: formulaUnits > 0 ? (costPerUnit * formulaUnits) / netWeight : 0,
formulaStore,
formulaName: (await getFormulaSlotLabels())[formulaStore] || 'Formula',
formulaMaterials: formula.map(item => ({ id: item.id, name: item.name, quantity: item.quantity, cost: resolveLiveCost(item, _dcInv) })),
rawMaterialCost: totalMaterialCost,
unitWeight: totalWeight
};
}

export async function calculateSalesCostPerKg(formulaStore) {
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
const factoryAdditionalCosts = (await sqliteStore.get('factory_additional_costs')) || {};
const factoryCostAdjustmentFactor = (await sqliteStore.get('factory_cost_adjustment_factor')) || {};
const _scInv = ensureArray(await sqliteStore.get('factory_inventory_data'));
const formula = factoryDefaultFormulas[formulaStore];
if (!formula || formula.length === 0) return 0;
let rawMaterialCost = 0;
formula.forEach(item => { rawMaterialCost += (resolveLiveCost(item, _scInv) * item.quantity); });
const additionalCost = factoryAdditionalCosts[formulaStore] || 0;
const adjustmentFactor = factoryCostAdjustmentFactor[formulaStore] || 1;
return adjustmentFactor > 0 ? (rawMaterialCost + additionalCost) / adjustmentFactor : rawMaterialCost + additionalCost;
}

export async function updateFormulaInventory() {
const factoryProductionHistory = ensureArray(await sqliteStore.get('factory_production_history'));
const factoryUnitTracking = (await sqliteStore.get('factory_unit_tracking')) || {};
const db = ensureArray(await sqliteStore.get('mfg_pro_pkr'));
const tracking = {
standard: { produced: 0, consumed: 0, available: 0, unitCostHistory: [] },
asaan: { produced: 0, consumed: 0, available: 0, unitCostHistory: [] }
};

const _appStores = (typeof getAppStores === 'function') ? await getAppStores() : [];
const _storeTypeMap = {};
_appStores.forEach(s => { _storeTypeMap[s.key] = s.formulaType || 'standard'; });
function _resolveFormulaType(storeVal) {
  if (storeVal === 'standard' || storeVal === 'asaan') return storeVal;
  return _storeTypeMap[storeVal] || (storeVal === 'STORE_C' ? 'asaan' : 'standard');
}
factoryProductionHistory.forEach(entry => {
if (entry.store && entry.units > 0) {
const ft = entry.formulaType || _resolveFormulaType(entry.store);
if (!tracking[ft]) tracking[ft] = { produced: 0, consumed: 0, available: 0, unitCostHistory: [] };
tracking[ft].produced += entry.units;
if (entry.totalCost && entry.units > 0) {
tracking[ft].unitCostHistory.push({ date: entry.date, costPerUnit: entry.totalCost / entry.units, units: entry.units });
}
}
});
db.forEach(entry => {
if (entry.isReturn) return;
const formulaStore = entry.formulaStore || _resolveFormulaType(entry.store);
if (!tracking[formulaStore]) tracking[formulaStore] = { produced: 0, consumed: 0, available: 0, unitCostHistory: [] };
if (entry.formulaUnits) tracking[formulaStore].consumed += entry.formulaUnits;
});
tracking.standard.available = Math.max(0, tracking.standard.produced - tracking.standard.consumed);
tracking.asaan.available = Math.max(0, tracking.asaan.produced - tracking.asaan.consumed);
const timestamp = Date.now();

await sqliteStore.set('factory_unit_tracking', tracking);
await sqliteStore.set('factory_unit_tracking_timestamp', timestamp);
return tracking;
}

export async function syncFactoryProductionStats() {
const tracking = await updateFormulaInventory();
await updateUnitsAvailableIndicator(tracking);
updateFactoryUnitsAvailableStats();
updateFactorySummaryCard();
return tracking;
}

export async function validateFormulaAvailability(storeType, requestedUnits) {
const factoryUnitTracking = (await sqliteStore.get('factory_unit_tracking')) || {};
let formulaStore = 'standard';
if (storeType === 'standard' || storeType === 'asaan') {
  formulaStore = storeType;
} else if (typeof getStoreFormulaType === 'function') {
  formulaStore = await getStoreFormulaType(storeType);
} else {
  formulaStore = storeType === 'STORE_C' ? 'asaan' : 'standard';
}
const available = factoryUnitTracking[formulaStore]?.available || 0;
return { available, sufficient: available >= requestedUnits, deficit: Math.max(0, requestedUnits - available) };
}

export async function updateUnitsAvailableIndicator(preloadedTracking) {
const factoryUnitTracking = preloadedTracking || (await sqliteStore.get('factory_unit_tracking')) || {};
const store = document.getElementById('storeSelector').value;
if (!store) return;
const formulaStore = typeof getStoreFormulaType === 'function' ? await getStoreFormulaType(store) : (store === 'STORE_C' ? 'asaan' : 'standard');
const available = factoryUnitTracking[formulaStore]?.available || 0;
const indicator = document.getElementById('currentUnitsAvailable');
const warning = document.getElementById('insufficientUnitsWarning');
let indicatorClass = 'units-available-good';
if (available < 10) indicatorClass = 'units-available-warning';
if (available <= 0) indicatorClass = 'units-available-danger';
const _uaiLabel = (await getFormulaSlotLabels())[formulaStore] || '';
if (indicator) { indicator.className = `units-available-indicator ${indicatorClass}`; indicator.textContent = `${fmtNum(available || 0)} units available${_uaiLabel ? ' · ' + _uaiLabel : ''}`; }
const requestedUnits = parseFloat(document.getElementById('formula-units')?.value) || 0;
if (warning) {
if (requestedUnits > available) warning.classList.remove('hidden');
else warning.classList.add('hidden');
}
}

export async function calculateDynamicProductionCost() {
const net = parseFloat(document.getElementById('net-wt').value) || 0;
const store = document.getElementById('storeSelector').value;
if (!store) return;
const formulaUnits = parseFloat(document.getElementById('formula-units').value) || 0;
const costData = await calculateDynamicCost(store, formulaUnits, net);
const salePrice = await getSalePriceForStore(store);
const _setProd = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
_setProd('formula-unit-cost-display', `${fmtAmt(safeValue(costData.costPerUnit))}/unit`);
_setProd('total-formula-cost-display', `${fmtAmt(safeValue(costData.totalFormulaCost))}`);
_setProd('dynamic-cost-per-kg', `${fmtNum(safeValue(costData.dynamicCostPerKg))}/kg`);
_setProd('factory-cost-price', `${fmtNum(safeValue(costData.dynamicCostPerKg))}/kg`);
_setProd('production-sale-price-display', `${fmtNum(safeValue(salePrice))}/kg`);
_setProd('profit-sale-price', `${fmtNum(safeValue(salePrice))}/kg`);
_setProd('display-cost-value', `${fmtAmt(safeValue(net * costData.dynamicCostPerKg))}`);
_setProd('profit-per-kg', `${fmtAmt(safeValue(salePrice - costData.dynamicCostPerKg))}`);
updateUnitsAvailableIndicator();
}

export async function updateProductionCostOnStoreChange() {
const store = document.getElementById('storeSelector').value;
if (!store) return;
currentStore = store; window.currentStore = currentStore;
const salePrice = await getSalePriceForStore(store);
const _setStore = (id, val) => { const el = document.getElementById(id); if (el) el.innerText = val; };
_setStore('production-sale-price-display', `${fmtNum(safeValue(salePrice))}/kg`);
_setStore('profit-sale-price', `${fmtNum(safeValue(salePrice))}/kg`);
calculateDynamicProductionCost();
updatePaymentStatusVisibility();
if (typeof refreshUI === 'function') refreshUI();
}

export function calcNet() {
const g = parseFloat(document.getElementById('gross-wt').value) || 0;
const c = parseFloat(document.getElementById('cont-wt').value) || 0;
document.getElementById('net-wt').value = safeNumber(Math.max(0, g - c), 0).toFixed(2);
calculateDynamicProductionCost();
}

export async function deleteProdEntry(id) {
const customerSales = ensureArray(await sqliteStore.get('customer_sales'));
const db = ensureArray(await sqliteStore.get('mfg_pro_pkr'));
const factoryDefaultFormulas = (await sqliteStore.get('factory_default_formulas')) || {};
if (!id || !validateUUID(id)) { showToast('Invalid production record ID', 'error'); return; }
const entryToDelete = db.find(item => item.id === id);
if (!entryToDelete) return;
if (entryToDelete.isMerged) { showToast('Merged opening balance records cannot be deleted', 'warning'); return; }
if (entryToDelete.isTransfer === true) {
if (typeof deleteStockTransfer === 'function') await deleteStockTransfer(entryToDelete.transferPairId);
return;
}
const isReturn = entryToDelete.isReturn === true;
if (isReturn) {
const _lk = await findCalcLinkForReturn(entryToDelete);
if (_lk) { showToast(`This return belongs to ${_lk.entry.seller}'s calculator record of ${_lk.entry.date}. Delete that calculator record to remove it.`, 'warning', 6000); return; }
}
const _dpStoreLabel = getStoreLabel(entryToDelete.store) || entryToDelete.store;
// A return is two records. Only its stock_returns LOG counts toward stock, so find it: both go together.
const _retLog = isReturn ? findReturnLogFor(entryToDelete, ensureArray(await sqliteStore.get('stock_returns'))) : null;
const _stockDrop = isReturn ? getReturnStockDrop(entryToDelete, _retLog) : (entryToDelete.net || 0);
if (_stockDrop > 0 && typeof window.computeStoreStockSnapshot === 'function') {
const _snap = await window.computeStoreStockSnapshot(entryToDelete.store, entryToDelete.date);
if (_snap.available - _stockDrop < -0.0001) {
showToast(`Cannot delete: ${fmtNum(_stockDrop)} kg of ${_dpStoreLabel} stock on ${entryToDelete.date} was already sold. Delete those sales first.`, 'warning', 6000);
return;
}
}
const _dpSalesOnDate = (typeof customerSales !== 'undefined' ? customerSales : []).filter(s => s.date === entryToDelete.date && s.store === entryToDelete.store).length;
let confirmMsg;
if (isReturn) {
confirmMsg = `Remove this stock return record?`;
confirmMsg += `\nStore: ${_dpStoreLabel}\nDate: ${entryToDelete.date}\nQty Returned: ${entryToDelete.net} kg`;
confirmMsg += _retLog
? `\n\n↩ This will DECREASE available stock by ${_stockDrop} kg on ${entryToDelete.date} (its return log is removed with it).`
: `\n\nNo return log is attached to this record, so available stock will not change.`;
if (_dpSalesOnDate > 0) confirmMsg += ` ${_dpSalesOnDate} sale${_dpSalesOnDate !== 1 ? 's' : ''} exist on this date — those records may be affected.`;
} else {
confirmMsg = `Permanently delete this production record?`;
confirmMsg += `\nStore: ${_dpStoreLabel}\nDate: ${entryToDelete.date}\nNet Qty: ${entryToDelete.net} kg`;
if (entryToDelete.gross) confirmMsg += `\nGross / Tare: ${entryToDelete.gross} / ${fmtNum((entryToDelete.gross || 0) - (entryToDelete.net || 0))} kg`;
confirmMsg += `\n\n↩ ${entryToDelete.net} kg will be removed from ${entryToDelete.date} inventory.`;
if (_dpSalesOnDate > 0) confirmMsg += `\n\n ${_dpSalesOnDate} sale${_dpSalesOnDate !== 1 ? 's' : ''} on this date for ${_dpStoreLabel} will remain on record, but available stock will drop.`;
}
confirmMsg += `\n\nThis cannot be undone.`;
if (await showGlassConfirm(confirmMsg, { title: isReturn ? 'Remove Return' : 'Delete Production', confirmText: isReturn ? 'Remove' : 'Delete', danger: true })) {
try {
const record = db.find(item => item.id === id);
if (record) { record.deletedAt = getTimestamp(); record.updatedAt = getTimestamp(); ensureRecordIntegrity(record, true); }
const dbWithoutDeleted = db.filter(item => item.id !== id);
let _snapRec = record || null;
if (isReturn && record) {
// Deleted from the Production tab (not by reversing a calculator record): it may be recovered as a pair.
const _grp = newGroupId('ret');
_snapRec = stampGroup({ ...record, [DELETE_ORIGIN_FIELD]: 'prod-tab' }, _grp);
if (_retLog) {
const _logs = ensureArray(await sqliteStore.get('stock_returns'));
await unifiedDelete('stock_returns', _logs.filter(l => l.id !== _retLog.id), _retLog.id, { strict: true }, stampGroup({ ..._retLog, [DELETE_ORIGIN_FIELD]: 'prod-tab' }, _grp));
}
}
await unifiedDelete('mfg_pro_pkr', dbWithoutDeleted, id, { strict: true }, _snapRec);
notifyDataChange('production');
void syncFactoryProductionStats().catch(() => {});
await refreshUI();
calculateNetCash();
calculateCashTracker();
const deletedQuantity = entryToDelete.net || 0;
if (isReturn) {
showToast(` Return record removed. ${deletedQuantity} kg removed from ${entryToDelete.date} stock.`, 'success');
} else {
showToast(` Production deleted. ${deletedQuantity} kg removed from ${entryToDelete.date} inventory. Sales on this date may be affected.`, 'success');
}
} catch (error) {
showToast(' Failed to delete entry. Please try again.', 'error');
}
}
}

window.getCostPerUnit = getCostPerUnit;
window.calculateFactoryInventoryValue = calculateFactoryInventoryValue;
window.updateFactoryInventoryDisplay = updateFactoryInventoryDisplay;
window.calculatePaymentSummaries = calculatePaymentSummaries;
window.openFactoryInventoryModal = openFactoryInventoryModal;
window.closeFactoryInventoryModal = closeFactoryInventoryModal;
window.clearFactoryInventoryForm = clearFactoryInventoryForm;
window.editFactoryInventoryItem = editFactoryInventoryItem;
window.updateFactoryKgCalculation = updateFactoryKgCalculation;
window.showSupplierUnlinkOption = showSupplierUnlinkOption;
window.unlinkSupplierConfirmation = unlinkSupplierConfirmation;
window.saveFactoryInventoryItem = saveFactoryInventoryItem;
window.unlinkSupplierFromMaterial = unlinkSupplierFromMaterial;
window.createSupplierFromMaterial = createSupplierFromMaterial;
window.renderFactoryInventory = renderFactoryInventory;
window.unlinkSupplierFromMaterialById = unlinkSupplierFromMaterialById;
window.toggleSupplierFields = toggleSupplierFields;
window.loadExistingSuppliers = loadExistingSuppliers;
window.linkMaterialToSupplier = linkMaterialToSupplier;
window.selectFactoryFormula = selectFactoryFormula;
window.getSalePriceForStore = getSalePriceForStore;
window.getEffectiveSalePriceForCustomer = getEffectiveSalePriceForCustomer;
window.getSaleTransactionValue = getSaleTransactionValue;
window.getCostPriceForStore = getCostPriceForStore;
window.getStorePricing = getStorePricing;
window.calculateFactoryProduction = calculateFactoryProduction;
window.saveFactoryProductionEntry = saveFactoryProductionEntry;
window.setFactorySummaryMode = setFactorySummaryMode;
window.setFactoryAvailableStore = setFactoryAvailableStore;
window.renderFactoryHistory = renderFactoryHistory;
window.deleteFactoryEntry = deleteFactoryEntry;
window.calculateDynamicCost = calculateDynamicCost;
window.calculateSalesCostPerKg = calculateSalesCostPerKg;
window.updateFormulaInventory = updateFormulaInventory;
window.syncFactoryProductionStats = syncFactoryProductionStats;
window.validateFormulaAvailability = validateFormulaAvailability;
window.updateUnitsAvailableIndicator = updateUnitsAvailableIndicator;
window.calculateDynamicProductionCost = calculateDynamicProductionCost;
window.updateProductionCostOnStoreChange = updateProductionCostOnStoreChange;
window.calcNet = calcNet;
window.deleteProdEntry = deleteProdEntry;
