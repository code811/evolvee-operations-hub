import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getEffectivePermissions } from '../api.js';
import { useTableView, SortHeader, SearchBox, ExportButton, CopyText } from '../ui.jsx';
import { applyOrder, dropBefore, reorder } from '../dashboardOrder.js';
import {
    ResponsiveContainer,
    LineChart,
    Line,
    BarChart,
    Bar,
    XAxis,
    YAxis,
    Tooltip,
    CartesianGrid,
} from 'recharts';

function formatGBP(amount) {
    return '$' + Number(amount).toLocaleString('en-GB', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    });
}

function sumBy(list, key) {
    return (list || []).reduce((acc, item) => acc + Number(item[key] || 0), 0);
}

function formatCount(value) {
    return Number(value || 0).toLocaleString('en-GB');
}

// Builds the top KPI strip from whichever modules the user has access to.
function ExecKpiCards({ inventory, sales, revenue, shipping, alerts, expenseSummary }) {
    const cards = [];

    if (revenue.data) {
        cards.push({
            key: 'revenue',
            label: 'Revenue — last 30 days',
            value: formatGBP(sumBy(revenue.data.daily, 'revenue')),
        });
    }

    if (sales.data) {
        cards.push({
            key: 'sales-today',
            label: "Today's sales",
            value: formatGBP(sales.data.sales_today || 0),
        });
        cards.push({
            key: 'orders-today',
            label: 'Orders today',
            value: formatCount(sales.data.orders_today),
        });
        cards.push({
            key: 'sales-revenue',
            label: 'Sales — last 30 days',
            value: formatGBP(sumBy(sales.data.products, 'revenue_30d')),
        });
        cards.push({
            key: 'units',
            label: 'Units sold — 30 days',
            value: formatCount(sumBy(sales.data.products, 'units_sold_30d')),
        });
    }

    if (inventory.data) {
        const inventoryValue = (inventory.data.items || []).reduce(
            (acc, item) => acc + Number(item.price || 0) * Number(item.stock_on_hand || 0),
            0,
        );
        cards.push({
            key: 'inventory-value',
            label: 'Inventory value',
            value: formatGBP(inventoryValue),
        });
        cards.push({
            key: 'stock',
            label: 'Units in stock',
            value: formatCount(sumBy(inventory.data.items, 'stock_on_hand')),
        });
        cards.push({
            key: 'low-stock',
            label: 'Low stock SKUs',
            value: formatCount(inventory.data.low_count),
            bad: inventory.data.low_count > 0,
        });
    }

    if (shipping.data) {
        const pending = (shipping.data.trackings || []).filter((t) => t.status !== 'Delivered').length;
        cards.push({
            key: 'pending',
            label: 'Pending shipments',
            value: formatCount(pending),
            bad: (shipping.data.exceptions || []).length > 0,
        });
    }

    if (alerts.data) {
        cards.push({
            key: 'alerts',
            label: 'Open reorder alerts',
            value: formatCount(alerts.data.open_count),
            bad: alerts.data.open_count > 0,
        });
    }

    const summary = expenseSummary?.data?.summary ?? expenseSummary?.data ?? {};
    if (summary) {
        cards.push({
            key: 'company-profit',
            label: 'Company profit - last 30 days',
            value: summary.netProfit != null ? formatGBP(summary.netProfit): 'N/A',
        });
        cards.push({
            key: 'company-profit-margin',
            label: 'Profit margin - last 30 days',
            value: summary.profitMargin != null ? `${Number(summary.profitMargin).toFixed(2)}%` : 'N/A',
        });
    }

    if (cards.length === 0) return null;

    return (
        <div className="kpi-strip">
            {cards.map((c) => (
                <div className="kpi kpi-card" key={c.key}>
                    <div className="v" style={c.bad ? { color: 'var(--bad)' } : undefined}>{c.value}</div>
                    <div className="l">{c.label}</div>
                </div>
            ))}
        </div>
    );
}

function Tile({ id, title, source, wide, drag, children }) {
    // `drag` is null when the layout is locked; the tile renders inert.

    const active = Boolean(drag);
    const cls =
        `tile${wide ? ' wide' : ''}` +
        (drag?.dragging ? ' dragging' : '') +
        (drag?.over === 'before' ? ' drop-before' : '') +
        (drag?.over === 'after' ? ' drop-after' : '');

    return (
        <section className={cls} data-tile-id={id}>
            <h2>
                {active && (
                    <button
                        type="button"
                        className="tile-grip"
                        title="Drag to reorder"
                        aria-label={`Drag to reorder ${title}`}
                        onPointerDown={(e) => drag.onPointerDown(id, e)}
                        onPointerMove={drag.onPointerMove}
                        onPointerUp={drag.onPointerUp}
                        onPointerCancel={drag.onPointerUp}
                    >
                        ⠿
                    </button>
                )}
                {title} {source && <span className="src">{source}</span>}
            </h2>
            {children}
        </section>
    );
}

// Layout persistence + lock, in localStorage. Falls back to defaults if
// storage is unavailable (private mode, quota).
const ORDER_KEY = 'dashboard-tile-order';
const LOCK_KEY = 'dashboard-locked';

function load(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function save(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore */ }
}

function useDashboardLayout() {
    const [order, setOrderState] = useState(() => load(ORDER_KEY, []));
    const [locked, setLockedState] = useState(() => load(LOCK_KEY, true));

    const setOrder = (next) => {
        setOrderState(next);
        save(ORDER_KEY, next);
    };
    const setLocked = (next) => {
        setLockedState(next);
        save(LOCK_KEY, next);
    };
    const reset = () => {
        setOrderState([]);
        try {
            localStorage.removeItem(ORDER_KEY);
        } catch { /* ignore */ }
    };

    return { order, setOrder, locked, setLocked, reset };
}

// Loads one dashboard module's data when enabled. Pass refreshMs to re-poll
// in the background; a failed refresh keeps the last good data.
function useModule(path, enabled, refreshMs) {
    const [state, setState] = useState({ loading: enabled, data: null, error: null });

    useEffect(() => {
        if (!enabled) return;

        // Skip state updates if the effect was cleaned up before the fetch resolved.
        let active = true;

        const load = () => {
            api(path)
                .then((data) => {
                    if (active) setState({ loading: false, data, error: null });
                })
                .catch((err) => {
                    if (active) setState((s) => ({ loading: false, data: s.data, error: s.data ? null : err.message }));
                });
        };

        load();
        const timer = refreshMs ? setInterval(load, refreshMs) : null;

        return () => {
            active = false;
            if (timer) clearInterval(timer);
        };
    }, [path, enabled, refreshMs]);

    return state;
}

// Renders loading and error states; otherwise passes data to children.
function Body({ state, children, errorMessage }) {
    if (state.loading) return <p className="empty">Loading…</p>;

    if (state.error) {
        return (
            <div className="banner error">
                {errorMessage || `Couldn\'t load this module: ${state.error}` }
            </div>
        );
    }
    return children(state.data);
}

const ALERTS_SEEN_KEY = 'alerts-seen-count';

function NewAlertsBadge({ count }) {
    const [seen] = useState(() => load(ALERTS_SEEN_KEY, null));
    useEffect(() => { save(ALERTS_SEEN_KEY, count); }, [count]);

    const delta = seen == null ? 0 : count - seen;
    if (delta <= 0) return null;

    return <span className="pill low" style={{ marginLeft: 8 }}>▲ {delta} new</span>;
}

function stockPill(isLowStock) {
    if (isLowStock) return <span className="pill low">Low</span>;

    return <span className="pill ok">OK</span>;
}

function shippingStatusClass(status) {
    if (status === 'Delivered') return 'ok';
    if (status === 'Exception') return 'low';

    return 'info';
}

function DataTable({ columns, rows, filename, limit, copyKey, keyField = 'id', search }) {
    const searchFields = search || columns.map((c) => c.key);
    const { query, setQuery, view, sort, toggleSort } = useTableView(rows, searchFields);
    const shown = limit && !query ? view.slice(0, limit) : view;
    const csvColumns = columns.map((c) => ({ label: c.label, get: (row) => row[c.key] }));
    const showSearch = (rows?.length || 0) > (limit || 8);

    return (
        <>
            <div
                className="toolbar"
                style={{ justifyContent: showSearch ? 'space-between' : 'flex-end', marginBottom: 8 }}
            >
                {showSearch && <SearchBox query={query} setQuery={setQuery} />}
                <ExportButton filename={filename} columns={csvColumns} rows={view} />
            </div>
            <div className="table-scroll">
                <table>
                    <thead>
                        <tr>
                            {columns.map((c) => (
                                <SortHeader
                                    key={c.key}
                                    label={c.label}
                                    sortKey={c.key}
                                    sort={sort}
                                    toggleSort={toggleSort}
                                    className={c.num ? 'num' : undefined}
                                />
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {shown.map((row, i) => (
                            <tr key={row[keyField] ?? row[copyKey] ?? i}>
                                {columns.map((c) => (
                                    <td key={c.key} className={c.num ? 'num' : undefined}>
                                        {c.key === copyKey
                                            ? <CopyText value={row[c.key]} />
                                            : c.render
                                                ? c.render(row)
                                                : row[c.key]}
                                    </td>
                                ))}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </>
    );
}

export default function Dashboard() {
    const permissions = getEffectivePermissions();

    function canAccess(permission) {
        return permissions.includes(permission);
    }

    const inventory = useModule('/dashboard/inventory', canAccess('inventory'));
    const sales = useModule('/dashboard/sales', canAccess('sales'));
    const productPerf = useModule('/dashboard/product-performance', canAccess('revenue'));
    const customers = useModule('/dashboard/customers', canAccess('customers'));
    const revenue = useModule('/dashboard/revenue', canAccess('revenue'));
    const shipping = useModule('/dashboard/shipping', canAccess('shipping'), 30000);
    const alerts = useModule('/dashboard/alerts-summary', canAccess('alerts'));
    const partners = useModule('/dashboard/partners', canAccess('partners'));
    const sync = useModule('/sync/status', canAccess('sync'));
    const expenseSummary = useModule('/expense-Summary/summary', canAccess('revenue'), 30000);

    // Sources that failed their most recent sync
    const failedSources = (sync.data?.sources || []).filter((source) => source.ok === false);

    // Tile order + lock state, persisted to localStorage
    const layout = useDashboardLayout();
    const { order, setOrder, locked, setLocked, reset } = layout;

    // Transient drag state (not persisted). `over` = { id, before }
    const [dragId, setDragId] = useState(null);
    const [over, setOver] = useState(null);
    const clearDrag = () => {
        setDragId(null);
        setOver(null);
    };

    // Build the visible tiles as { id, el }, then apply the saved order
    const defs = [];
    if (canAccess('alerts')) {
        defs.push({ id: 'alerts', el: (
                    <Tile title="Reorder alerts" source="Manufacturer tool">
                        <Body state={alerts}>
                            {(data) => {
                                if (data.open_count === 0) {
                                    return (
                                        <p className="empty">
                                            No open alerts — all stock is above its reorder threshold.
                                        </p>
                                    );
                                }
                                return (
                                    <>
                                        <div className="kpis">
                                            <div className="kpi">
                                                <div className="v" style={{ color: 'var(--bad)' }}>
                                                    {data.open_count}
                                                </div>
                                                <div className="l">
                                                    SKUs / item IDs need reordering
                                                    <NewAlertsBadge count={data.open_count} />
                                                </div>
                                            </div>
                                        </div>
                                        <DataTable
                                            rows={data.open_alerts}
                                            filename="reorder-alerts.csv"
                                            limit={5}
                                            copyKey="sku"
                                            columns={[
                                                { label: 'SKU / Item ID', key: 'sku' },
                                                { label: 'Product', key: 'name' },
                                                { label: 'Stock', key: 'stock_level', num: true },
                                                { label: 'Threshold', key: 'threshold', num: true },
                                                { label: 'Manufacturer', key: 'manufacturer', render: (a) => a.manufacturer || '—' },
                                            ]}
                                        />
                                        <p style={{ marginBottom: 0 }}>
                                            <Link to="/alerts">Manage alerts →</Link>
                                        </p>
                                    </>
                                );
                            }}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('inventory')) {
        defs.push({ id: 'inventory', el: (
                    <Tile title="Stock levels" source="Shopify">
                        <Body
                            state={inventory}
                            errorMessage="Stock levels could not be loaded. Please try again."
                        >
                            {(data) => (
                                <DataTable
                                    rows={data.items}
                                    filename="stock-levels.csv"
                                    copyKey="sku"
                                    keyField="sku"
                                    columns={[
                                        { label: 'SKU / Item ID', key: 'sku' },
                                        { label: 'Product', key: 'name' },
                                        { label: 'On hand', key: 'stock_on_hand', num: true },
                                        { label: 'Status', key: 'low_stock', render: (item) => stockPill(item.low_stock) },
                                    ]}
                                />
                            )}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('sales')) {
        defs.push({ id: 'product-sales', el: (
                    <Tile title="Product sales — last 30 days" source="Shopify">
                        <Body state={sales}>
                            {(data) => (
                                <>
                                    <div className="toolbar" style={{ justifyContent: 'flex-end', marginBottom: 8 }}>
                                        <ExportButton
                                            filename="product-sales.csv"
                                            rows={data.products}
                                            columns={[
                                                { label: 'SKU', get: (p) => p.sku },
                                                { label: 'Units sold (30d)', get: (p) => p.units_sold_30d },
                                            ]}
                                        />
                                    </div>
                                    <ResponsiveContainer width="100%" height={180}>
                                        <BarChart
                                            data={data.products}
                                            margin={{ top: 4, right: 8, left: -18, bottom: 0 }}
                                        >
                                            <CartesianGrid stroke="#f0ebe2" vertical={false} />
                                            <XAxis
                                                dataKey="sku"
                                                tick={{ fontSize: 10 }}
                                                interval={0}
                                                angle={-30}
                                                textAnchor="end"
                                                height={50}
                                            />
                                            <YAxis tick={{ fontSize: 11 }} />
                                            <Tooltip formatter={(value) => [value, 'Units sold']} />
                                            <Bar
                                                dataKey="units_sold_30d"
                                                fill="#b08d4f"
                                                radius={[3, 3, 0, 0]}
                                            />
                                        </BarChart>
                                    </ResponsiveContainer>
                                    <p style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 0 }}>
                                        Best seller:{' '}
                                        <strong style={{ color: 'var(--ink)' }}>
                                            {data.best_sellers[0]?.title}
                                        </strong>
                                        {' · '}
                                        Slowest:{' '}
                                        <strong style={{ color: 'var(--ink)' }}>
                                            {data.slow_movers[0]?.title}
                                        </strong>
                                    </p>
                                </>
                            )}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('revenue')) {
        defs.push({ id: 'product-performance', el: (
                    <Tile title="Product performance — last 30 days" source="Shopify" wide>
                        <Body state={productPerf}>
                            {(data) => (
                                <>
                                    {data.inventory_status === 'unavailable' && (
                                        <div className="banner notice">
                                            Inventory is unavailable. Inventory-dependent metrics cannot be calculated;
                                            any available sales data is shown below.
                                        </div>
                                    )}
                                    <DataTable
                                        rows={data.products}
                                        filename="product-performance.csv"
                                        keyField="sku"
                                        copyKey="sku"
                                        columns={[
                                            { label: 'SKU', key: 'sku' },
                                            { label: 'Product', key: 'title' },
                                            { label: 'Units (30d)', key: 'units_sold_30d', num: true },
                                            { label: 'Revenue (30d)', key: 'revenue_30d', num: true, render: (p) => formatGBP(p.revenue_30d) },
                                            { label: 'Potential Margin %', key: 'profit_margin', num: true, render: (p) => (p.profit_margin != null ? `${Number(p.profit_margin).toFixed(2)}%` : '—') },
                                            { label: 'Turnover', key: 'turnover', num: true, render: (p) => (p.turnover != null ? p.turnover : '—') },
                                            { label: 'Sell-through %', key: 'sell_through', num: true, render: (p) => (p.sell_through != null ? `${p.sell_through}%` : '—') },
                                        ]}
                                    />
                                </>
                            )}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('customers')) {
        defs.push({ id: 'customers', el: (
                    <Tile title="Top customers" source="Shopify + Zoho CRM">
                        <Body state={customers}>
                            {(data) => (
                                <DataTable
                                    rows={data.customers}
                                    filename="top-customers.csv"
                                    limit={6}
                                    columns={[
                                        { label: 'Customer', key: 'name' },
                                        { label: 'Segment', key: 'segment', render: (c) => <span className="pill info">{c.segment}</span> },
                                        { label: 'Orders', key: 'orders_count', num: true },
                                        { label: 'Total spent (LTV)', key: 'total_spent', num: true, render: (c) => formatGBP(c.total_spent) },
                                        { label: 'Avg order', key: 'avg_order', num: true, render: (c) => formatGBP(c.orders_count > 0 ? c.total_spent / c.orders_count : 0) },
                                        { label: 'Returning', key: 'returning', render: (c) => <span className={`pill ${c.orders_count > 1 ? 'ok' : 'info'}`}>{c.orders_count > 1 ? 'Returning' : 'New'}</span> },
                                        { label: 'Favorite', key: 'favorite_title', render: (c) => c.favorite_title ? `${c.favorite_title} (${c.favorite_units})` : '—' },
                                        { label: 'History', key: 'history', render: (c) => (c.history && c.history.length) ? (
                                            <details>
                                                <summary>{c.history.length} order{c.history.length === 1 ? '' : 's'}</summary>
                                                <ul style={{ margin: '6px 0 0', paddingLeft: 16 }}>
                                                    {c.history.map((h, i) => (
                                                        <li key={i} style={{ fontSize: 12 }}>
                                                            {h.date} · {h.order} · {formatGBP(h.total)}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </details>
                                        ) : '—' },
                                    ]}
                                />
                            )}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('shipping')) {
        defs.push({ id: 'shipping', el: (
                    <Tile title="Orders in transit" source="Shopify">
                        <Body state={shipping}>
                            {(data) => (
                                <>
                                    {data.exceptions.length > 0 && (
                                        <div className="banner error" style={{ marginBottom: 12 }}>
                                            {data.exceptions.length} delivery{' '}
                                            {data.exceptions.length === 1 ? 'problem' : 'problems'} — check{' '}
                                            {data.exceptions.map((exception) => exception.order_id).join(', ')}
                                        </div>
                                    )}
                                    <DataTable
                                        rows={data.trackings}
                                        filename="orders-in-transit.csv"
                                        keyField="tracking_number"
                                        columns={[
                                            { label: 'Order', key: 'order_id' },
                                            { label: 'Customer', key: 'customer' },
                                            { label: 'Courier', key: 'courier' },
                                            { label: 'Status', key: 'status', render: (t) => <span className={`pill ${shippingStatusClass(t.status)}`}>{t.status}</span> },
                                        ]}
                                    />
                                </>
                            )}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('partners')) {
        defs.push({ id: 'partners', el: (
                    <Tile title="Partners & commissions" source="QR partner dashboard" wide>
                        <Body state={partners}>
                            {(data) => {
                                const kpis = data.kpis || {};
                                const leaderboard = data.leaderboard || [];

                                const hasActivity =
                                    leaderboard.length > 0 ||
                                    kpis.approved_partners ||
                                    kpis.pending_partners ||
                                    kpis.total_clicks;

                                if (!hasActivity) {
                                    return <p className="empty">No partner activity yet.</p>;
                                }

                                return (
                                    <>
                                        <div className="kpis">
                                            <div className="kpi">
                                                <div className="v">{formatCount(kpis.approved_partners)}</div>
                                                <div className="l">Approved partners</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{formatCount(kpis.pending_partners)}</div>
                                                <div className="l">Awaiting approval</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{formatCount(kpis.total_clicks)}</div>
                                                <div className="l">QR scans / link clicks</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{Number(kpis.conversion_rate || 0)}%</div>
                                                <div className="l">Conversion rate</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{formatGBP(kpis.total_revenue)}</div>
                                                <div className="l">Partner-driven revenue</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{formatGBP(kpis.total_commission)}</div>
                                                <div className="l">Commission earned</div>
                                            </div>
                                            <div className="kpi">
                                                <div className="v">{formatGBP(kpis.pending_commission)}</div>
                                                <div className="l">Commission pending payout</div>
                                            </div>
                                        </div>
                                        {leaderboard.length === 0 ? (
                                            <p className="empty">No approved partners yet.</p>
                                        ) : (
                                        <DataTable
                                            rows={leaderboard}
                                            filename="partner-leaderboard.csv"
                                            keyField="partner_code"
                                            copyKey="partner_code"
                                            limit={5}
                                            columns={[
                                                { label: 'Partner', key: 'partner_name' },
                                                { label: 'Code', key: 'partner_code' },
                                                { label: 'Location', key: 'location' },
                                                { label: 'Scans', key: 'clicks', num: true },
                                                { label: 'Conversions', key: 'conversions', num: true },
                                                { label: 'Revenue', key: 'revenue', num: true, render: (p) => formatGBP(p.revenue) },
                                                { label: 'Commission', key: 'commission', num: true, render: (p) => formatGBP(p.commission) },
                                            ]}
                                        />
                                        )}
                                    </>
                                );
                            }}
                        </Body>
                    </Tile>
        ) });
    }
    if (canAccess('revenue')) {
        defs.push({ id: 'revenue', el: (
                    <Tile title="Revenue" source="Shopify" wide>
                        <Body state={revenue}>
                            {(data) => (
                                <div className="row">
                                    <div style={{ minWidth: 280 }}>
                                        <h3 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
                                            Daily — this month
                                        </h3>
                                        <ResponsiveContainer width="100%" height={190}>
                                            <LineChart
                                                data={data.daily}
                                                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                                            >
                                                <CartesianGrid stroke="#f0ebe2" vertical={false} />
                                                <XAxis
                                                    dataKey="date"
                                                    tick={{ fontSize: 10 }}
                                                    tickFormatter={(value) => value.slice(8)}
                                                />
                                                <YAxis tick={{ fontSize: 11 }} />
                                                <Tooltip formatter={(value) => [formatGBP(value), 'Revenue']} />
                                                <Line
                                                    type="monotone"
                                                    dataKey="revenue"
                                                    stroke="#8a6a33"
                                                    strokeWidth={2}
                                                    dot={false}
                                                />
                                            </LineChart>
                                        </ResponsiveContainer>
                                    </div>
                                    <div style={{ minWidth: 280 }}>
                                        <h3 style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 500 }}>
                                            Monthly
                                        </h3>
                                        <ResponsiveContainer width="100%" height={190}>
                                            <BarChart
                                                data={data.monthly}
                                                margin={{ top: 4, right: 8, left: -10, bottom: 0 }}
                                            >
                                                <CartesianGrid stroke="#f0ebe2" vertical={false} />
                                                <XAxis dataKey="month" tick={{ fontSize: 10 }} />
                                                <YAxis tick={{ fontSize: 11 }} />
                                                <Tooltip formatter={(value) => [formatGBP(value), 'Revenue']} />
                                                <Bar
                                                    dataKey="revenue"
                                                    fill="#b08d4f"
                                                    radius={[3, 3, 0, 0]}
                                                />
                                            </BarChart>
                                        </ResponsiveContainer>
                                    </div>
                                </div>
                            )}
                        </Body>
                    </Tile>
        ) });
    }

    const ordered = applyOrder(defs, order);
    const orderedIds = ordered.map((d) => d.id);

    // Drag-to-reorder handlers for the tile grid (only active when layout is unlocked)
    const onPointerDown = (id, e) => {
        e.currentTarget.setPointerCapture(e.pointerId); // route move/up here even off-tile
        setDragId(id);
    };
    const onPointerMove = (e) => {
        if (dragId == null) return;

        const tile = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-tile-id]');

        if (!tile) return;

        const id = tile.dataset.tileId;
        const before = dropBefore(tile.getBoundingClientRect(), e.clientX, e.clientY);

        if (!over || over.id !== id || over.before !== before) setOver({ id, before });
    };
    const onPointerUp = () => {
        if (dragId != null && over && over.id !== dragId) {
            setOrder(reorder(orderedIds, dragId, over.id, over.before));
        }

        clearDrag();
    };
    const makeDrag = (id) =>
        locked
            ? null
            : {
                  dragging: dragId === id,
                  over:
                      over && over.id === id && dragId !== id
                          ? over.before ? 'before' : 'after'
                          : null,
                  onPointerDown,
                  onPointerMove,
                  onPointerUp,
              };

    return (
        <>
            <h1>Operations dashboard</h1>
            <p className="sub">
                A single view of stock, sales, customers, revenue, and deliveries.
            </p>

            {failedSources.length > 0 && (
                <div className="banner error">
                    Data sync issue — the following sources failed their last update and may
                    be showing older data: {failedSources.map((source) => source.source).join(', ')}.
                </div>
            )}

            <ExecKpiCards
                inventory={inventory}
                sales={sales}
                revenue={revenue}
                shipping={shipping}
                alerts={alerts}
                expenseSummary={expenseSummary}
            />

            <div className="toolbar dash-tools">
                <button type="button" onClick={() => setLocked(!locked)}>
                    {locked ? 'Rearrange tiles' : 'Lock layout'}
                </button>
                {!locked && (
                    <span className="dash-hint">Drag the ⠿ handle to reorder tiles.</span>
                )}
                {order.length > 0 && (
                    <button type="button" className="link" onClick={reset}>
                        Reset order
                    </button>
                )}
            </div>

            <div className="grid">
                {ordered.map((d) =>
                    React.cloneElement(d.el, { key: d.id, id: d.id, drag: makeDrag(d.id) }),
                )}
            </div>
        </>
    );
}