const express = require('express');
const { query, pool } = require('../config/db');
const { authenticate, requirePermission, requireWrite } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { validateId } = require('../middleware/validateId');
const shopify = require('../services/integrations/shopify');
const shopifyReviews = require('../services/integrations/shopifyReviews');
const { computeProductMetrics } = require('../services/productMetrics');
const { recordAudit } = require('../services/audit');
const { rateLimit } = require('../middleware/rateLimit');

const router = express.Router();

router.use(authenticate, requirePermission('manufacturers'), requireWrite('manufacturers'));
router.param('id', validateId);

// This endpoint calls Shopify on every request, so an unthrottled loop burns the
// store's API quota and takes the dashboard down for everyone.
const syncRateLimit = rateLimit(
    [
        { name: 'sync-user', key: (req) => req.user.id, windowMs: 60 * 1000, max: 5 },
        { name: 'sync-all', key: () => 'global', windowMs: 60 * 1000, max: 20 },
    ],
    'Sync was run too recently. Please wait a minute and try again.'
);

function matchProducts(hubProducts, shopifyProducts) {
    const results = hubProducts.map((hubProduct) => {
        const shopifyProduct = shopifyProducts.find((shopifyProduct) =>
            (hubProduct.shopify_inventory_item_id &&
                shopifyProduct.inventory_item_id === hubProduct.shopify_inventory_item_id) ||
            (hubProduct.sku &&
                shopifyProduct.sku === hubProduct.sku)
        );

        return [hubProduct.id,
        shopifyProduct ? 'matched' : 'unmatched']
    });

    return Object.fromEntries(results);
}

router.get('/', asyncRoute(async (req, res) => {
    const sql =
        'SELECT p.*, m.name AS manufacturer_name, rt.threshold ' +
        'FROM products p ' +
        'LEFT JOIN manufacturers m ON m.id = p.manufacturer_id ' +
        'LEFT JOIN reorder_thresholds rt ON rt.product_id = p.id ' +
        'ORDER BY p.sku ' +
        'LIMIT 1000';

    const result = await query(sql);
    const hubProducts = result.rows;
    let shopifyProducts;
    try {
        const inventory = await shopify.getStockLevels();

        if (inventory.retrieved_at == null) {
            throw new Error('Current inventory is unavailable.');
        }

        shopifyProducts = inventory.items;
    } catch (err) {
        console.error('Unable to retrieve Shopify products: ' + err.message);
        const products = hubProducts.map((product) => ({
            ...product,
            shopify_match: null
        }));
        return res.json({ products: products });
    }

    const matches = matchProducts(hubProducts, shopifyProducts);

    const products = hubProducts.map((product) => ({
        ...product,
        shopify_match: matches[product.id]
    }));

    res.json({ products: products });
}));

router.get('/:id', asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    const productResult = await query(
        'SELECT p.*, m.name AS manufacturer_name, rt.threshold ' +
        'FROM products p ' +
        'LEFT JOIN manufacturers m ON m.id = p.manufacturer_id ' +
        'LEFT JOIN reorder_thresholds rt ON rt.product_id = p.id ' +
        'WHERE p.id = $1',
        [id]
    );

    const product = productResult.rows[0];

    if (!product) {
        return res.status(404).json({ error: 'Product not found.' });
    }
    const safe = (p, fallback, label) => p.catch((err) => {
        console.error(`[products] ${label} unavailable —`, err.message);
        return fallback;
    });

    // Fetch everything needed for the detail view in parallel.
    const [stock, sales, trend, reviews, reorderHistory, productionRuns] = await Promise.all([
        safe(shopify.getStockLevels().then(result => result.items), [], 'stock'),
        safe(shopify.getSalesOverview(), [], 'sales'),
        safe(shopify.getSalesTrend(), {}, 'trend'),
        safe(shopifyReviews.getReviews(), [], 'reviews'),
        query(
            'SELECT rh.*, m.name AS manufacturer_name FROM reorder_history rh ' +
            'LEFT JOIN manufacturers m ON m.id = rh.manufacturer_id ' +
            'WHERE rh.product_id = $1 ORDER BY rh.ordered_at DESC',
            [id]
        ),
        query(
            'SELECT pr.*, m.name AS manufacturer_name FROM production_runs pr ' +
            'LEFT JOIN manufacturers m ON m.id = pr.manufacturer_id ' +
            'WHERE pr.product_id = $1 ORDER BY pr.created_at DESC',
            [id]
        )
    ]);

    // Match Shopify stock by inventory item id first, falling back to SKU.
    const stockRow = stock.find((s) =>
        (product.shopify_inventory_item_id && s.inventory_item_id === product.shopify_inventory_item_id) ||
        s.sku === product.sku
    ) || null;

    const saleRow = sales.find((s) => s.sku === product.sku) ||
        { sku: product.sku, title: product.name, units_sold_30d: 0, revenue_30d: 0 };

    const cost = product.unit_cost != null ? Number(product.unit_cost) : null;
    const metrics = computeProductMetrics(saleRow, stockRow, cost);

    res.json({
        product: product,
        photo: stockRow ? (stockRow.image || null) : null,
        retail_price: stockRow ? stockRow.price : null,
        current_inventory: stockRow ? stockRow.stock_on_hand : null,
        metrics: metrics,
        trend: trend[product.sku] || [],
        reviews: reviews.filter((r) => r.sku === product.sku),
        reorder_history: reorderHistory.rows,
        production_runs: productionRuns.rows
    });
}));

router.post('/sync-shopify', syncRateLimit, asyncRoute(async (req, res) => {
    let inventory;
    try {
        inventory = await shopify.getStockLevels();
        if (inventory.retrieved_at == null) throw new Error('Shopify inventory unavailable');
        if (!Array.isArray(inventory.items)) throw new Error('Unexpected inventory response');
    } catch (err) {
        return res.status(503).json({ error: `Unable to sync products because Shopify inventory is unavailable.` });
    }

    const stock = inventory.items;

    let synced = 0;
    let skipped = 0;

    for (const item of stock) {
        if (!item.sku) { skipped += 1; continue; }

        try {
            await query(
                'INSERT INTO products (sku, name, shopify_inventory_item_id, last_synced_at) ' +
                'VALUES ($1, $2, $3, NOW()) ' +
                'ON CONFLICT (sku) DO UPDATE SET ' +
                '    name = EXCLUDED.name, ' +
                '    shopify_inventory_item_id = COALESCE(products.shopify_inventory_item_id, EXCLUDED.shopify_inventory_item_id), ' +
                '    last_synced_at = EXCLUDED.last_synced_at',
                [item.sku, item.name, item.inventory_item_id || null]
            );
            synced += 1;
        } catch (err) {
            console.error('[sync-shopify] skipped', item.sku, '—', err.message);
            skipped += 1;
        }
    }

    res.json({ synced: synced, skipped: skipped, total: stock.length });
}));

router.post('/', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const sku = body.sku;
    const name = body.name;
    const manufacturerId = body.manufacturer_id;
    const threshold = body.threshold;
    const unitCost = body.unit_cost;

    if (!sku || !name) {
        return res.status(400).json({ error: 'sku and name are required.' });
    }

    let thresholdValue = null;

    if (threshold !== undefined && threshold !== null && threshold !== '') {
        const n = Number(threshold);
        if (!Number.isFinite(n) || n < 0) {
            return res.status(400).json({ error: 'threshold must be a number of 0 or more.' });
        }
        thresholdValue = n;
    }

    let unitCostValue = null;
    if (unitCost !== undefined && unitCost !== null && unitCost !== '') {
        const c = Number(unitCost);
        if (!Number.isFinite(c) || c < 0) {
            return res.status(400).json({ error: 'unit_cost must be a number of 0 or more.' });
        }
        unitCostValue = c;
    }

    const manufacturerIdValue = manufacturerId || null;

    // Product and threshold rows must be created together, so wrap in a transaction.
    const client = await pool.connect();
    let product;

    try {
        await client.query('BEGIN');

        const productResult = await client.query(
            'INSERT INTO products (sku, name, manufacturer_id, unit_cost) ' +
            'VALUES ($1, $2, $3, $4) RETURNING *',
            [sku.trim(), name, manufacturerIdValue, unitCostValue]
        );
        product = productResult.rows[0];

        if (thresholdValue !== null) {
            await client.query(
                'INSERT INTO reorder_thresholds (product_id, threshold) ' +
                'VALUES ($1, $2) ' +
                'ON CONFLICT (product_id) DO UPDATE ' +
                '    SET threshold = $2, updated_at = NOW()',
                [product.id, thresholdValue]
            );
        }

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    await recordAudit(req, {
        action: 'create', entity: 'product', entityId: product.id,
        details: { sku: product.sku, manufacturer_id: manufacturerIdValue, threshold: thresholdValue },
    });

    res.status(201).json({ product: product });
}));

router.patch('/:id', asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const body = req.body || {};

    const set = [];
    const values = [];
    let i = 1;

    // Only touch fields that were actually sent in the request body.
    if (body.sku !== undefined) {
        const sku = String(body.sku).trim();
        if (!sku) return res.status(400).json({ error: 'sku cannot be empty.' });
        set.push(`sku = $${i++}`); values.push(sku);
    }
    if (body.name !== undefined) {
        const name = String(body.name).trim();
        if (!name) return res.status(400).json({ error: 'name cannot be empty.' });
        set.push(`name = $${i++}`); values.push(name);
    }
    if (body.shopify_inventory_item_id !== undefined) {
        const raw = body.shopify_inventory_item_id;
        const iid = (raw === null || raw === '') ? null : String(raw).trim();
        set.push(`shopify_inventory_item_id = $${i++}`); values.push(iid);
    }

    if (set.length === 0) {
        return res.status(400).json({ error: 'Nothing to update. Send sku, name, and/or shopify_inventory_item_id.' });
    }

    values.push(id);
    const result = await query(
        `UPDATE products SET ${set.join(', ')} WHERE id = $${i} RETURNING *`,
        values
    );

    if (!result.rows[0]) {
        return res.status(404).json({ error: 'Product not found.' });
    }

    await recordAudit(req, {
        action: 'update', entity: 'product', entityId: id,
        details: { fields: set.map((clause) => clause.split(' = ')[0]) },
    });

    res.json({ product: result.rows[0] });
}));

router.patch('/:id/manufacturer', asyncRoute(async (req, res) => {
    const body = req.body || {};

    const manufacturerIdValue = body.manufacturer_id || null;

    const id = Number(req.params.id);
    const sql = 'UPDATE products SET manufacturer_id = $1 WHERE id = $2 RETURNING *';

    const result = await query(sql, [manufacturerIdValue, id]);

    if (!result.rows[0]) {
        return res.status(404).json({ error: 'Product not found.' });
    }

    await recordAudit(req, {
        action: 'manufacturer.assign', entity: 'product', entityId: id,
        details: { manufacturer_id: manufacturerIdValue },
    });

    res.json({ product: result.rows[0] });
}));

router.put('/:id/threshold', asyncRoute(async (req, res) => {
    const body = req.body || {};

    const threshold = Number(body.threshold);
    if (!Number.isFinite(threshold) || threshold < 0) {
        return res.status(400).json({ error: 'threshold must be a number of 0 or more.' });
    }

    const productId = Number(req.params.id);
    // Upsert: one threshold row per product.
    const sql =
        'INSERT INTO reorder_thresholds (product_id, threshold) ' +
        'VALUES ($1, $2) ' +
        'ON CONFLICT (product_id) DO UPDATE ' +
        '    SET threshold = $2, updated_at = NOW() ' +
        'RETURNING *';

    const result = await query(sql, [productId, threshold]);

    await recordAudit(req, {
        action: 'threshold.set', entity: 'product', entityId: productId,
        details: { threshold },
    });

    res.json({ threshold: result.rows[0] });
}));

router.put('/:id/cost', asyncRoute(async (req, res) => {
    const body = req.body || {};

    const unitCost = Number(body.unit_cost);
    if (!Number.isFinite(unitCost) || unitCost < 0) {
        return res.status(400).json({ error: 'unit_cost must be a number of 0 or more.' });
    }

    const id = Number(req.params.id);
    const result = await query(
        'UPDATE products SET unit_cost = $1 WHERE id = $2 RETURNING *',
        [unitCost, id]
    );

    if (!result.rows[0]) {
        return res.status(404).json({ error: 'Product not found.' });
    }

    await recordAudit(req, {
        action: 'cost.set', entity: 'product', entityId: id,
        details: { unit_cost: unitCost },
    });

    res.json({ product: result.rows[0] });
}));

module.exports = router;