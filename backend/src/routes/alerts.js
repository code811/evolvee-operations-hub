const express = require('express');
const { query, pool } = require('../config/db');
const { authenticate, requirePermission, requireWrite, requireRole, ALERT_DELETE_ROLES } = require('../middleware/auth');
const { asyncRoute } = require('../middleware/errorHandler');
const { validateId } = require('../middleware/validateId');
const { runStockCheck } = require('../jobs/stockCheck');
const { rateLimit } = require('../middleware/rateLimit');
const { recordAudit } = require('../services/audit');
const { reorder, ReorderValidationError} = require("../services/reorder");
const shopify = require('../services/integrations/shopify');

const router = express.Router();

router.use(authenticate, requirePermission('alerts'), requireWrite('alerts'));
router.param('id', validateId);

class AlertNotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AlertNotFoundError';
    }
}

// Each run calls Shopify. Unthrottled, this is a free way to exhaust the store's
// API quota from any logged-in account.
const checkRateLimit = rateLimit(
    [
        { name: 'check-user', key: (req) => req.user.id, windowMs: 60 * 1000, max: 5 },
        { name: 'check-all', key: () => 'global', windowMs: 60 * 1000, max: 20 },
    ],
    'Stock check was run too recently. Please wait a minute and try again.'
);

async function getInventory() {
    const latestStock = await shopify.getStockLevels();
    if (latestStock.retrieved_at == null) throw new Error('Shopify inventory unavailable');
    if (!Array.isArray(latestStock.items)) throw new Error('Unexpected inventory response');
    return latestStock;
}

router.get('/', asyncRoute(async (req, res) => {
    const status = req.query.status;

    let whereClause = '';
    let params = [];

    if (status) {
        whereClause = 'WHERE ra.status = $1';
        params = [status];
    }

    const result = await query(
        'SELECT ra.*, ' +
        '   p.sku, p.name AS product_name, p.shopify_inventory_item_id, p.manufacturer_id, ' +
        '   m.name AS manufacturer, ' +
        '   rt.threshold AS latest_threshold ' +
        'FROM reorder_alerts ra ' +
        'JOIN products p ON p.id = ra.product_id ' +
        'LEFT JOIN manufacturers m ON m.id = p.manufacturer_id ' +
        'LEFT JOIN reorder_thresholds AS rt ON rt.product_id = p.id ' +
        whereClause + ' ' +
        'ORDER BY ra.triggered_at DESC LIMIT 200',
        params);

    let latestStock;

    try {
        latestStock = await getInventory();
    } catch(err) {
        console.error(`Unable to get inventory: ${err.message}.`)
        const alerts = result.rows.map((row) => ({ ...row, latest_stock: null }));
        return res.status(200).json({
            alerts: alerts,
            inventory_status: 'unavailable',
            retrieved_at: null
        });
    }

    const alerts = result.rows.map((row) => {
        const stockRow = latestStock.items.find((product) =>
                // Follows existing convention in `routes/product.js:85`; does not guarantee ID-first selection.
                (row.shopify_inventory_item_id && product.inventory_item_id === row.shopify_inventory_item_id) ||
                product.sku === row.sku) ||
            { stock_on_hand: null };

        return { ...row, latest_stock: stockRow.stock_on_hand ?? null };
    });

    return res.status(200).json({
        alerts: alerts,
        inventory_status: 'available',
        retrieved_at: latestStock.retrieved_at
    });
}));

router.get('/:id/reorder-suggestion', asyncRoute(async (req, res) => {
    const alert_id = req.params.id;

    const requestedAlert = await query(
        'SELECT ra.stock_level, ra.product_id, ' +
            'p.sku, p.shopify_inventory_item_id, ' +
            'm.min_order_quantity, ' +
            'rt.threshold ' +
        'FROM reorder_alerts as ra ' +
        'LEFT JOIN products AS p ON p.id = ra.product_id ' +
        'LEFT JOIN manufacturers AS m ON m.id = p.manufacturer_id ' +
        'LEFT JOIN reorder_thresholds AS rt ON rt.product_id = p.id ' +
        'WHERE ra.id = $1',
        [alert_id]);
    const alert = requestedAlert.rows[0];

    if (!alert) {
        return res.status(404).json({ error: 'Alert not found.' });
    }

    let latestStock
    try {
        latestStock = await getInventory();
    } catch (err) {
        console.error(`Unable to suggest reorder quantity: ${err.message}.`)
        return res.status(503).json({
            error: 'Unable to suggest a reorder quantity because current inventory is unavailable.'
        });
    }

    const stock = latestStock.items.find((product) =>
        // Does not guarantee ID-first selection.
        (alert.shopify_inventory_item_id &&
            product.inventory_item_id === alert.shopify_inventory_item_id) ||
        product.sku === alert.sku)?.stock_on_hand ?? null;
    const threshold = alert.threshold;

    if (stock == null || threshold == null) {
        return res.status(503).json({ error: 'A reorder suggestion is unavailable because current stock or ' +
                                             'the configured threshold is missing.' });
    }

    // Suggests by previous reorder alerts
    const reorder_history = await query(
        'SELECT rh.quantity_ordered ' +
        'FROM reorder_history AS rh ' +
        'WHERE rh.product_id = $1 ' +
        'ORDER BY rh.created_at DESC, rh.id DESC',
        [alert.product_id]);

    for (const reorder of reorder_history.rows) {
        const pastQuantity = reorder.quantity_ordered;

        if (Number.isInteger(pastQuantity) &&
            pastQuantity > 0 &&
            pastQuantity + stock > threshold) {
            return res.json({ suggestion : pastQuantity });
        }
    }

    // Suggests by set manufacturer minimum quantity order
    const manufacturer_min = alert.min_order_quantity;

    if (Number.isInteger(manufacturer_min) &&
            (manufacturer_min > 0) &&
            (manufacturer_min + stock > threshold)) {
        return res.json({ suggestion : manufacturer_min });
    }

    // Suggests by past sales
    try {
        const sales = await shopify.getSalesOverview();
        const sale = sales.find((sale) => sale.sku === alert.sku);
        const units_sold_30d = sale?.units_sold_30d;
        const roundedQuantity = Math.ceil(units_sold_30d / 10) * 10;

        if (Number.isInteger(roundedQuantity) &&
            (roundedQuantity > 0) &&
            (roundedQuantity + stock > threshold)) {
            return res.json({ suggestion: roundedQuantity });
        }
    } catch (err) {
        await recordAudit(req, {
            action: 'shopify_lookup_failed',
            entity: 'shopify',
            entityId: null,
            details: { notes: 'Attempted to fetch Shopify data for alerts.js to suggest quantity for reorder.' },
        });
    }

    return res.json({ suggestion : Math.max(1, threshold + 1 - stock) });
}));

class StatusConflictError extends Error {
    constructor(message) {
        super(message);
        this.name = 'StatusConflictError';
    }
}

router.post('/:id/reorders', asyncRoute(async (req, res) => {
    // Atomic process for logging reorder and changing alert status
    const client = await pool.connect();
    let alert;
    let createdReorder;

    try {
        await client.query('BEGIN');

        // Map alert to product to manufacturer
        const alert_id = req.params.id;
        const queryResult = await client.query(
            'SELECT r.id, r.status, r.product_id, p.manufacturer_id ' +
            'FROM reorder_alerts AS r ' +
            'JOIN products AS p ON p.id = r.product_id ' +
            'WHERE r.id = $1 ' +
            'FOR UPDATE OF r',
            [alert_id]);
        const alertProduct = queryResult.rows[0];

        if (!alertProduct) {
            throw new AlertNotFoundError("Alert not found.");
        } else if (alertProduct.status !== "open") {
            throw new StatusConflictError("Status must be open!");
        }

        const body = req.body || {};
        body.product_id = alertProduct.product_id;
        const manufacturerId = alertProduct.manufacturer_id;
        const userId = req.user.id;

        // Logs reorder in table used by Manufacturer/Product page
        const reorderResult = await reorder(body, manufacturerId, userId, client);
        createdReorder = reorderResult.reorder;

        // Updates alert status
        const statusAwaiting = await client.query(
            'UPDATE reorder_alerts ' +
            "SET status = 'awaiting', " +
            "   resolved_at = NULL " +
            'WHERE id = $1 ' +
            'RETURNING *',
            [alert_id]);

        alert = statusAwaiting.rows[0];

        if (!alert) {
            throw new AlertNotFoundError("Alert not found.");
        }

        await client.query('COMMIT');
    } catch (err) {
        try {
            await client.query('ROLLBACK');
        } catch (rollbackError) {
            console.error('X: Rollback failed:', rollbackError.message);
        }

        if (err instanceof ReorderValidationError) {
            return res.status(400).json({ error: err.message });
        } else if (err instanceof AlertNotFoundError) {
            return res.status(404).json({ error: err.message });
        } else if (err instanceof  StatusConflictError) {
            return res.status(409).json({ error: err.message });
        }

        throw err;
    } finally {
        client.release();
    }

    await recordAudit(req, {
        action: 'create',
        entity: 'reorder',
        entityId: createdReorder.id,
        details: {
            productId : createdReorder.product_id,
            manufacturerId : createdReorder.manufacturer_id,
            quantity : createdReorder.quantity_ordered,
            alertId : alert.id,
        },
    });

    return res.status(201).json(alert);
}));

router.patch('/:id', asyncRoute(async (req, res) => {
    const body = req.body || {};
    const status = body.status;

    const allowed = ['resolved'];
    if (!allowed.includes(status)) {
        return res.status(400).json({ error: "status must be 'resolved'." });
    }

    const id = Number(req.params.id);

    const updateResult = await query(
        'UPDATE reorder_alerts ' +
        "SET status = 'resolved', " +
        "    resolved_at = NOW() " +
        "WHERE id = $1 AND status = 'awaiting' " +
        'RETURNING *',
        [id]);
    const alert = updateResult.rows[0];

    if (!alert) {
        const existingResult = await query(
            'SELECT id, status ' +
            'FROM reorder_alerts ' +
            'WHERE id = $1',
            [id]);

        const existingAlert = existingResult.rows[0];

        if (!existingAlert) {
            return res.status(404).json({ error: 'Alert not found.' });
        }

        return res.status(409).json({
            error: 'Alert could not be resolved from its current state. Refresh and try again.'
        });
    }

    await recordAudit(req, {
        action: 'update',
        entity: 'alert',
        entityId: alert.id,
        details: {
            status : alert.status,
        },
    });

    res.json({ alert: alert });
}));

router.delete('/:id', requireRole(...ALERT_DELETE_ROLES), asyncRoute(async (req, res) => {
    const id = Number(req.params.id);
    const result = await query(
        'DELETE FROM reorder_alerts WHERE id = $1 RETURNING id, product_id, stock_level, threshold, status',
        [id]
    );
    const deleted = result.rows[0];

    if (!deleted) {
        return res.status(404).json({ error: 'Alert not found.' });
    }

    // The row is gone, so the audit entry is the only remaining record that it existed.
    await recordAudit(req, {
        action: 'delete', entity: 'reorder_alert', entityId: id,
        details: {
            product_id: deleted.product_id,
            stock_level: deleted.stock_level,
            threshold: deleted.threshold,
            status: deleted.status,
        },
    });

    res.json({ deleted: id });
}));

router.post('/check-now', checkRateLimit, asyncRoute(async (req, res) => {
    try {
        const result = await runStockCheck();
        res.json(result);
    } catch (err) {
        res.status(503).json({ error: 'Stock check could not be completed. Please try again.' });
    }
}));

module.exports = router;