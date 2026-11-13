const express = require('express');
const { query } = require('../config/db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const shopify = require('../services/integrations/shopify');
const zohoCrm = require('../services/integrations/zohoCrm');
const partnerDashboard = require('../services/integrations/partnerDashboard');
const { computeProductMetrics } = require('../services/productMetrics');

const router = express.Router();

router.use(authenticate);

router.get('/inventory', requirePermission('inventory'), asyncRoute(async (req, res) => {
    const { items: stock, retrieved_at } = await shopify.getStockLevels();

    if (retrieved_at == null) {
        return res.status(503).json({ error: 'Current inventory is unavailable.' });
    }

    const thresholdResult = await query(
        'SELECT p.sku, p.shopify_inventory_item_id, rt.threshold ' +
        'FROM reorder_thresholds rt ' +
        'JOIN products p ON p.id = rt.product_id'
    );

    // Index thresholds by both inventory item id and SKU for flexible lookup below.
    const thresholds = {};
    for (const row of thresholdResult.rows) {
        if (row.shopify_inventory_item_id) {
            thresholds[row.shopify_inventory_item_id] = row.threshold;
        }
        if (row.sku) {
            thresholds[row.sku] = row.threshold;
        }
    }

    const items = [];
    for (const i of stock) {
        // Threshold by item id, then SKU, then the feed's own level, else 0.
        const threshold =
            (i.inventory_item_id != null ? thresholds[i.inventory_item_id] : undefined) ??
            thresholds[i.sku] ??
            i.reorder_level ??
            0;

        const item = Object.assign({}, i);
        item.threshold = threshold;
        item.low_stock = i.stock_on_hand <= threshold;
        items.push(item);
    }

    const lowCount = items.filter((item) => item.low_stock).length;

    res.json({ items: items, low_count: lowCount });
}));

router.get('/sales', requirePermission('sales'), asyncRoute(async (req, res) => {
    const [products, today] = await Promise.all([
        shopify.getSalesOverview(),
        shopify.getTodayOrders()
    ]);

    const sorted = products.slice();
    sorted.sort(function (a, b) {
        return b.units_sold_30d - a.units_sold_30d;
    });

    const bestSellers = sorted.slice(0, 3);

    const slowMovers = sorted.slice(Math.max(bestSellers.length, sorted.length - 3));
    slowMovers.reverse();

    res.json({
        products: sorted,
        best_sellers: bestSellers,
        slow_movers: slowMovers,
        orders_today: today.orders_count,
        sales_today: today.sales_total
    });
}));

router.get('/product-performance', requirePermission('revenue'), asyncRoute(async (req, res) => {
    const [sales, inventory, costResult] = await Promise.all([
        shopify.getSalesOverview(),
        shopify.getStockLevels()
            .catch(err => {
                console.error('Product-performance inventory unavailable:', err.message);
                return { items: [], retrieved_at: null};
            }),
        query('SELECT sku, unit_cost FROM products WHERE unit_cost IS NOT NULL')
    ]);

    const stock = inventory.items;
    const inventoryStatus = inventory.retrieved_at == null ? 'unavailable' : 'available';

    // Build lookup maps so we can merge cost and stock data with sales per SKU.
    const costBySku = {};
    for (const row of costResult.rows) {
        costBySku[row.sku] = Number(row.unit_cost);
    }

    const stockBySku = {};
    const stockByVariantId = {};
    for (const s of stock) {
        stockBySku[s.sku] = s;

         if (s.variant_id) {
            stockByVariantId[String(s.variant_id)] = s;
        }
    }
// Fetch data from shopify. Obtain the unit cost of each variant and use that to calculate the potential profit margin of each product. If any variant is missing cost or price, we cannot calculate the margin for that product.
    const rows = [];
    for (const p of sales) {
        const row = computeProductMetrics(p, stockBySku[p.sku], costBySku[p.sku]);
        let totalPotentialRevenue = 0;
        let totalPotentialCost = 0;
        let canCalculateMargin =
            Array.isArray(p.variants) &&
            p.variants.length > 0;

        for (const variant of (p.variants || [])) {
            const stockVariant =
                stockByVariantId[String(variant.variant_id)];

            if (
                !stockVariant ||
                stockVariant.unit_cost === null ||
                stockVariant.unit_cost === undefined ||
                !stockVariant.price
            ) {
                canCalculateMargin = false;
                continue;
            }

            const quantity = Number(variant.quantity || 0);
            const price = Number(stockVariant.price);
            const cost = Number(stockVariant.unit_cost);

            totalPotentialRevenue += price * quantity;
            totalPotentialCost += cost * quantity;
        }

        if (canCalculateMargin && totalPotentialRevenue > 0) {
            const potentialProfit =
                totalPotentialRevenue - totalPotentialCost;

            row.profit_margin =
                (potentialProfit / totalPotentialRevenue) * 100;
        } else {
            row.profit_margin = null;
        }

        rows.push(row);
    }

    rows.sort(function (a, b) {
        return b.revenue_30d - a.revenue_30d;
    });

    res.json({ products: rows, inventory_status: inventoryStatus });
}));

router.get('/customers', requirePermission('customers'), asyncRoute(async (req, res) => {
    const [shop, crm, purchases] = await Promise.all([
        shopify.getTopCustomers(),
        zohoCrm.getCrmCustomers(),
        shopify.getCustomerPurchases()
    ]);

    // Index CRM records by lowercased email to match Shopify customers case-insensitively.
    const crmByEmail = {};
    for (const c of crm) {
        crmByEmail[(c.email || '').toLowerCase()] = c;
    }

    shop.sort(function (a, b) {
        return b.total_spent - a.total_spent;
    });

    const topTen = shop.slice(0, 10);

    const customers = [];
    for (const c of topTen) {
        const crmEntry = crmByEmail[(c.email || '').toLowerCase()];

        let segment = '—';
        let crmNotes = '';

        if (crmEntry) {
            if (crmEntry.segment) {
                segment = crmEntry.segment;
            }
            if (crmEntry.lifetime_notes) {
                crmNotes = crmEntry.lifetime_notes;
            }
        }

        const purchase = purchases[c.email];

        const customer = Object.assign({}, c);
        customer.segment = segment;
        customer.crm_notes = crmNotes;
        customer.favorite_title = purchase ? purchase.favorite_title : null;
        customer.favorite_units = purchase ? purchase.favorite_units : 0;
        customer.history = purchase ? purchase.history : [];
        customers.push(customer);
    }

    res.json({ customers: customers });
}));

router.get('/revenue', requirePermission('revenue'), asyncRoute(async (req, res) => {
    const [daily, monthly] = await Promise.all([
        shopify.getDailyRevenue(),
        shopify.getMonthlyRevenue()
    ]);

    // Bucket daily revenue into Monday-start weeks.
    const weekly = {};
    for (const d of daily) {
        const dt = new Date(d.date + 'T00:00:00Z');
        const monday = new Date(dt);
        // Days since Monday; getUTCDay has Sunday = 0.
        const offsetToMonday = (dt.getUTCDay() + 6) % 7;
        monday.setUTCDate(dt.getUTCDate() - offsetToMonday);

        const key = monday.toISOString().slice(0, 10);
        weekly[key] = (weekly[key] || 0) + d.revenue;
    }

    const weekKeys = Object.keys(weekly);
    weekKeys.sort();

    const weeklyList = [];
    for (const key of weekKeys) {
        weeklyList.push({
            week_starting: key,
            revenue: Number(weekly[key].toFixed(2))
        });
    }

    res.json({
        daily: daily,
        weekly: weeklyList,
        monthly: monthly
    });
}));

router.get('/shipping', requirePermission('shipping'), asyncRoute(async (req, res) => {
    const trackings = await shopify.getTrackings();

    const byStatus = {};
    for (const t of trackings) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
    }

    const exceptions = trackings.filter((t) => t.status === 'Exception');

    res.json({
        trackings: trackings,
        by_status: byStatus,
        exceptions: exceptions
    });
}));

router.get('/alerts-summary', requirePermission('alerts'), asyncRoute(async (req, res) => {
    const sql =
        'SELECT ra.id, p.sku, p.name, ra.stock_level, ra.threshold, ra.status, ra.triggered_at, ' +
        '       m.name AS manufacturer, COUNT(*) OVER()::int AS total_open ' +
        'FROM reorder_alerts ra ' +
        'JOIN products p ON p.id = ra.product_id ' +
        'LEFT JOIN manufacturers m ON m.id = p.manufacturer_id ' +
        "WHERE ra.status = 'open' " +
        'ORDER BY ra.triggered_at DESC ' +
        'LIMIT 20';

    const result = await query(sql);

    res.json({
        open_alerts: result.rows,
        open_count: result.rows.length > 0 ? result.rows[0].total_open : 0
    });
}));

router.get('/partners', requirePermission('partners'), asyncRoute(async (req, res) => {
    res.json(await partnerDashboard.getPartnerProgram());
}));

module.exports = router;