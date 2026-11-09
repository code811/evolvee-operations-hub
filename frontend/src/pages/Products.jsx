import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, canWrite } from '../api.js';
import { useTableView, SortHeader, SearchBox, onEnter } from '../ui.jsx';

const EMPTY_FORM = { sku: '', name: '', manufacturer_id: '', threshold: '', unit_cost: '' };

const MATCH_STATES = [
    { value: 'matched', label: 'Matched', className: 'ok' },
    { value: 'unmatched', label: 'Unmatched', className: 'warn' },
];

const UNKNOWN_MATCH = { label: 'Unable to Verify', className: 'low' }

export default function Products() {
    const [products, setProducts] = useState(null);
    const [manufacturers, setManufacturers] = useState([]);
    const [error, setError] = useState('');
    // In-progress threshold edits, keyed by product id.
    const [edits, setEdits] = useState({});
    const [costEdits, setCostEdits] = useState({});
    const [form, setForm] = useState(EMPTY_FORM);
    const [syncMsg, setSyncMsg] = useState('');
    const [busy, setBusy] = useState(false);
    const [selected, setSelected] = useState(() => new Set());
    const [bulkMfr, setBulkMfr] = useState('');
    const [bulkThreshold, setBulkThreshold] = useState('');
    const { query, setQuery, view, sort, toggleSort } = useTableView(products, ['sku', 'name', 'manufacturer_name']);
    const writable = canWrite('manufacturers');

    function load() {
        return Promise.all([api('/products'), api('/manufacturers')])
            .then(([p, m]) => {
                setProducts(p.products);
                setManufacturers(m.manufacturers);
            })
            .catch((e) => setError(e.message));
    }

    useEffect(() => { load(); }, []);

    function updateForm(field, value) {
        setForm((prev) => ({ ...prev, [field]: value }));
    }

    function updateEdit(productId, value) {
        setEdits((prev) => ({ ...prev, [productId]: value }));
    }

    function clearEdit(productId) {
        setEdits((prev) => ({ ...prev, [productId]: undefined }));
    }

    function updateCostEdit(productId, value) {
        setCostEdits((prev) => ({ ...prev, [productId]: value }));
    }

    function clearCostEdit(productId) {
        setCostEdits((prev) => ({ ...prev, [productId]: undefined }));
    }

    async function saveRow(product) {
        if (busy) return;
        const threshold = edits[product.id];
        const cost = costEdits[product.id];
        setBusy(true);
        try {
            if (threshold !== undefined && threshold !== '') {
                await api(`/products/${product.id}/threshold`, {
                    method: 'PUT',
                    body: JSON.stringify({ threshold: Number(threshold) }),
                });
                clearEdit(product.id);
            }
            if (cost !== undefined && cost !== '') {
                await api(`/products/${product.id}/cost`, {
                    method: 'PUT',
                    body: JSON.stringify({ unit_cost: Number(cost) }),
                });
                clearCostEdit(product.id);
            }
            load();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    function toggleRow(id) {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    }

    // "All selected" only counts rows currently visible under the active search/filter.
    const allVisibleSelected = view.length > 0 && view.every((p) => selected.has(p.id));

    function toggleAllVisible() {
        setSelected((prev) => {
            const next = new Set(prev);
            if (allVisibleSelected) view.forEach((p) => next.delete(p.id));
            else view.forEach((p) => next.add(p.id));
            return next;
        });
    }

    // Shared runner for bulk actions: applies `apply` to every selected id, then reloads either way.
    async function runBulk(apply) {
        setError('');
        try {
            await Promise.all([...selected].map(apply));
            setSelected(new Set());
            load();
        } catch (e) {
            setError(e.message);
            load();
        }
    }

    function bulkAssign() {
        const body = JSON.stringify({ manufacturer_id: bulkMfr ? Number(bulkMfr) : null });
        runBulk((id) => api(`/products/${id}/manufacturer`, { method: 'PATCH', body }))
            .then(() => setBulkMfr(''));
    }

    function bulkSetThreshold() {
        const n = Number(bulkThreshold);
        if (bulkThreshold === '' || !Number.isFinite(n) || n < 0) {
            return setError('Threshold must be a number of 0 or more.');
        }
        const body = JSON.stringify({ threshold: n });
        runBulk((id) => api(`/products/${id}/threshold`, { method: 'PUT', body }))
            .then(() => setBulkThreshold(''));
    }

    async function assignManufacturer(product, manufacturerId) {
        try {
            await api(`/products/${product.id}/manufacturer`, {
                method: 'PATCH',
                body: JSON.stringify({ manufacturer_id: manufacturerId ? Number(manufacturerId) : null }),
            });
            load();
        } catch (e) {
            setError(e.message);
        }
    }

    async function syncShopify() {
        if (busy) return;
        setError('');
        setSyncMsg('Syncing…');
        setBusy(true);
        try {
            const r = await api('/products/sync-shopify', { method: 'POST' });
            const skippedNote = r.skipped ? `, ${r.skipped} skipped` : '';
            setSyncMsg(`Synced ${r.synced} of ${r.total} Shopify items${skippedNote}.`);
            await load();
        } catch (e) {
            setSyncMsg('');
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    async function createProduct() {
        if (busy) return;
        if (!form.sku.trim() || !form.name.trim()) {
            return setError('SKU / item ID and product name are required.');
        }
        setError('');
        setBusy(true);
        try {
            await api('/products', {
                method: 'POST',
                body: JSON.stringify({
                    ...form,
                    manufacturer_id: form.manufacturer_id ? Number(form.manufacturer_id) : null,
                    threshold: form.threshold === '' ? null : Number(form.threshold),
                    unit_cost: form.unit_cost === '' ? null : Number(form.unit_cost),
                }),
            });
            setForm(EMPTY_FORM);
            load();
        } catch (e) {
            setError(e.message);
        } finally {
            setBusy(false);
        }
    }

    function renderManufacturerOptions() {
        return manufacturers.map((m) => (
            <option key={m.id} value={m.id}>{m.name}</option>
        ));
    }

    function formatDate(value) {
        return new Date(value).toLocaleString('en-GB');
    }

    function renderRow(product) {
        const matchState =
            MATCH_STATES.find(state => state.value === product.shopify_match)
            ?? UNKNOWN_MATCH;

        return (
            <tr key={product.id}>
                {writable && (
                <td>
                    <input
                        type="checkbox"
                        checked={selected.has(product.id)}
                        onChange={() => toggleRow(product.id)}
                        aria-label={`Select ${product.sku}`}
                    />
                </td>
                )}
                <td>{product.sku}</td>
                <td><Link to={`/products/${product.id}`}>{product.name}</Link></td>
                <td>
                    <span className={`pill ${matchState.className}`}>
                        {matchState.label}
                    </span>
                </td>
                <td>{product.last_synced_at ? formatDate(product.last_synced_at) : 'Never Recorded'}</td>
                <td>
                    <select
                        value={product.manufacturer_id || ''}
                        onChange={(e) => assignManufacturer(product, e.target.value)}
                        disabled={!writable}
                        style={{ maxWidth: 220 }}
                    >
                        <option value="">— unassigned —</option>
                        {renderManufacturerOptions()}
                    </select>
                </td>
                <td className="num">
                    <input
                        type="number"
                        min="0"
                        style={{ maxWidth: 90, textAlign: 'right' }}
                        // Show the pending edit if there is one, else the saved value.
                        value={edits[product.id] ?? product.threshold ?? ''}
                        onChange={(e) => updateEdit(product.id, e.target.value)}
                        disabled={!writable}
                    />
                </td>
                <td className="num">
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        style={{ maxWidth: 90, textAlign: 'right' }}
                        value={costEdits[product.id] ?? product.unit_cost ?? ''}
                        onChange={(e) => updateCostEdit(product.id, e.target.value)}
                        disabled={!writable}
                    />
                </td>
                {writable && (
                <td>
                    <button className="link" onClick={() => saveRow(product)} disabled={busy}>Save</button>
                </td>
                )}
            </tr>
        );
    }

    return (
        <>
            <h1>Products &amp; reorder thresholds</h1>
            <p className="sub">
                Link each SKU (or Shopify inventory item ID) to its manufacturer and set the stock level that should trigger a reorder alert.
            </p>

            {error && <div className="banner error">{error}</div>}

            {writable && (
            <div className="tile" style={{ marginBottom: 18 }}>
                <h2>Add product</h2>
                <div className="row">
                    <input
                        placeholder="SKU or item ID (e.g. ER-SER-009)"
                        value={form.sku}
                        onChange={(e) => updateForm('sku', e.target.value)}
                        onKeyDown={onEnter(createProduct)}
                    />
                    <input
                        placeholder="Product name"
                        value={form.name}
                        onChange={(e) => updateForm('name', e.target.value)}
                        onKeyDown={onEnter(createProduct)}
                    />
                    <select
                        value={form.manufacturer_id}
                        onChange={(e) => updateForm('manufacturer_id', e.target.value)}
                    >
                        <option value="">Manufacturer (optional)</option>
                        {renderManufacturerOptions()}
                    </select>
                    <input
                        type="number"
                        min="0"
                        placeholder="Threshold"
                        value={form.threshold}
                        onChange={(e) => updateForm('threshold', e.target.value)}
                        onKeyDown={onEnter(createProduct)}
                        style={{ maxWidth: 120 }}
                    />
                    <input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="Unit cost $"
                        value={form.unit_cost}
                        onChange={(e) => updateForm('unit_cost', e.target.value)}
                        onKeyDown={onEnter(createProduct)}
                        style={{ maxWidth: 120 }}
                    />
                    <button className="primary" onClick={createProduct} disabled={busy} style={{ flex: '0 0 auto' }}>
                        {busy ? 'Adding…' : 'Add'}
                    </button>
                </div>
            </div>
            )}

            {!products ? (
                <p className="empty">Loading…</p>
            ) : (
                <div className="tile">
                    <div className="toolbar">
                        <SearchBox
                            query={query}
                            setQuery={setQuery}
                            placeholder="Search SKU, product, manufacturer…"
                        />
                        {writable && (
                            <button className="link" onClick={syncShopify} disabled={busy}>Sync from Shopify</button>
                        )}
                        {syncMsg && <span style={{ color: 'var(--muted)', fontSize: 13 }}>{syncMsg}</span>}
                    </div>

                    {writable && selected.size > 0 && (
                        <div className="toolbar bulk-bar">
                            <strong>{selected.size} selected</strong>
                            <select value={bulkMfr} onChange={(e) => setBulkMfr(e.target.value)} style={{ maxWidth: 200 }}>
                                <option value="">— unassigned —</option>
                                {renderManufacturerOptions()}
                            </select>
                            <button className="link" onClick={bulkAssign}>Assign manufacturer</button>
                            <span className="bulk-sep" aria-hidden="true">·</span>
                            <input
                                type="number"
                                min="0"
                                placeholder="Threshold"
                                value={bulkThreshold}
                                onChange={(e) => setBulkThreshold(e.target.value)}
                                onKeyDown={onEnter(bulkSetThreshold)}
                                style={{ maxWidth: 110 }}
                            />
                            <button className="link" onClick={bulkSetThreshold}>Set threshold</button>
                            <span className="bulk-sep" aria-hidden="true">·</span>
                            <button className="link" onClick={() => setSelected(new Set())}>Clear</button>
                        </div>
                    )}

                    <table>
                        <thead>
                            <tr>
                                {writable && (
                                <th style={{ width: 28 }}>
                                    <input
                                        type="checkbox"
                                        checked={allVisibleSelected}
                                        onChange={toggleAllVisible}
                                        aria-label="Select all visible"
                                    />
                                </th>
                                )}
                                <SortHeader label="SKU / Item ID" sortKey="sku" sort={sort} toggleSort={toggleSort} />
                                <SortHeader label="Product" sortKey="name" sort={sort} toggleSort={toggleSort} />
                                <SortHeader label="Shopify Match" sortKey="shopify_match" sort={sort} toggleSort={toggleSort} />
                                <SortHeader
                                    label={
                                        <span
                                            style={{ whiteSpace: 'nowrap' }}
                                            title="Last synced records the latest successful product sync to the Hub and may use cached Shopify data."
                                        >
                                            Last Synced to Hub ⓘ
                                        </span>
                                    }
                                    sortKey="last_synced_at"
                                    sort={sort}
                                    toggleSort={toggleSort}
                                />
                                <SortHeader label="Manufacturer" sortKey="manufacturer_name" sort={sort} toggleSort={toggleSort} />
                                <SortHeader label="Reorder threshold" sortKey="threshold" sort={sort} toggleSort={toggleSort} className="num" />
                                <SortHeader label="Unit cost ($)" sortKey="unit_cost" sort={sort} toggleSort={toggleSort} className="num" />
                                {writable && <th />}
                            </tr>
                        </thead>
                        <tbody>
                            {view.length === 0 ? (
                                <tr><td colSpan={writable ? 9 : 7} className="empty">No products match “{query}”.</td></tr>
                            ) : view.map(renderRow)}
                        </tbody>
                    </table>
                </div>
            )}
        </>
    );
}