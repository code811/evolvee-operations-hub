const env = require('../../config/env');
const { callExternal, withSync, cacheAll } = require('../apiClient');
const { aggregateCustomerPurchases } = require('../customerPurchases');
const sample = require('../sampleData/shopify.json');

function headers() {
    return {
        'X-Shopify-Access-Token': env.shopify.adminToken,
        'Content-Type': 'application/json'
    };
}

function base() {
    return 'https://' + env.shopify.storeDomain + '/admin/api/' + env.shopify.apiVersion;
}

// Read the rel="next" cursor URL out of Shopify's Link header.
function nextPageUrl(linkHeader) {
    if (!linkHeader) {
        return null;
    }

    for (const part of linkHeader.split(',')) {
        const match = part.match(/<([^>]+)>;\s*rel="next"/);
        if (match) {
            return match[1];
        }
    }

    return null;
}

// Follow Link-header pagination until there is no next page.
async function fetchAllPages(firstUrl, key) {
    const out = [];
    let next = firstUrl;

    while (next) {
        const result = await callExternal(next, { headers: headers() }, { includeHeaders: true });

        for (const item of (result.data[key] || [])) {
            out.push(item);
        }

        next = nextPageUrl(result.headers.get('link'));
    }

    return out;
}

// off: skip and report ok. sample: bundled JSON. else: live API.
async function getSalesOverview() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.products;
        }

        const thirtyDaysMs = 30 * 864e5;
        const since = new Date(Date.now() - thirtyDaysMs).toISOString();

        const url =
            base() +
            '/orders.json?status=any' +
            '&created_at_min='+ since + 
            '&financial_status=paid'+
            '&limit=250' +
            '&fields=line_items,total_price';

        const orders = await fetchAllPages(url, 'orders');

        const bySku = {};
        for (const order of orders) {
            const lineItems = order.line_items || [];

            for (const li of lineItems) {
                const sku = li.sku || li.title;

                if (!bySku[sku]) {
                    bySku[sku] = {
                        sku: sku,
                        title: li.title,
                        units_sold_30d: 0,
                        revenue_30d: 0,
                        variants: []
                    };
                }

                bySku[sku].units_sold_30d += li.quantity;
                bySku[sku].revenue_30d += Number(li.price) * li.quantity;
                bySku[sku].variants.push({
                variant_id: li.variant_id ? String(li.variant_id) : null,
                variant_title: li.variant_title,
                quantity: li.quantity
                });
            }
        }

        return Object.values(bySku);
    });
}

async function getCustomerPurchases() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.customer_purchases;
        }

        const thirtyDaysMs = 30 * 864e5;
        const since = new Date(Date.now() - thirtyDaysMs).toISOString();

        const url =
            base() +
            '/orders.json?status=any' +
            '&created_at_min=' + since +
            '&limit=250' +
            '&fields=name,created_at,total_price,customer,line_items';

        const orders = await fetchAllPages(url, 'orders');

        return aggregateCustomerPurchases(orders);
    }, {});
}

async function getTopCustomers() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.customers;
        }

        const url = base() + '/customers.json?limit=50&order=total_spent+desc';
        const data = await callExternal(url, { headers: headers() });

        const rawCustomers = data.customers || [];

        const customers = [];
        for (const c of rawCustomers) {
            const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();

            customers.push({
                id: String(c.id),
                name: name,
                email: c.email,
                orders_count: c.orders_count,
                total_spent: Number(c.total_spent)
            });
        }

        return customers;
    });
}

async function getDailyRevenue() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.revenue_daily;
        }

        const thirtyOneDaysMs = 31 * 864e5;
        const since = new Date(Date.now() - thirtyOneDaysMs).toISOString();

        // financial_status=paid to match getMonthlyRevenue — both revenue views on one basis.
        const url =
            base() +
            '/orders.json?status=any' +
            '&financial_status=paid' +
            '&created_at_min=' + since +
            '&limit=250' +
            '&fields=created_at,total_price';

        const orders = await fetchAllPages(url, 'orders');

        const byDay = {};
        for (const o of orders) {
            const d = o.created_at.slice(0, 10);
            byDay[d] = (byDay[d] || 0) + Number(o.total_price);
        }

        const dayKeys = Object.keys(byDay);
        dayKeys.sort();

        const daily = [];
        for (const date of dayKeys) {
            daily.push({
                date: date,
                revenue: byDay[date]
            });
        }

        return daily;
    });
}

async function getSalesTrend() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.sales_trend || {};
        }

        const since = new Date(Date.now() - 30 * 864e5).toISOString();

        const url =
            base() +
            '/orders.json?status=any' +
            '&created_at_min=' + since +
            '&limit=250' +
            '&fields=created_at,line_items';

        const orders = await fetchAllPages(url, 'orders');

        const bySku = {};
        for (const o of orders) {
            const day = o.created_at.slice(0, 10);
            for (const li of (o.line_items || [])) {
                const sku = li.sku || li.title;
                if (!bySku[sku]) {
                    bySku[sku] = {};
                }
                if (!bySku[sku][day]) {
                    bySku[sku][day] = { date: day, units: 0, revenue: 0 };
                }
                bySku[sku][day].units += li.quantity;
                bySku[sku][day].revenue += Number(li.price) * li.quantity;
            }
        }

        const out = {};
        for (const sku of Object.keys(bySku)) {
            const days = Object.values(bySku[sku]);
            days.sort((a, b) => (a.date < b.date ? -1 : 1));
            out[sku] = days;
        }
        return out;
    }, {});
}
// Fetch the cost of an inventory item from Shopify. If the cost is null, return null. If the inventory item does not exist, return null. If the inventory item exists and has a cost, return the cost as a number.
async function getInventoryItemCost(inventoryItemId) {
    const url =
        base() +
        '/inventory_items/' +
        inventoryItemId +
        '.json';

    const data = await callExternal(url, {
        headers: headers()
    });

    if (!data.inventory_item) {
        return null;
    }

    return data.inventory_item.cost !== null
        ? Number(data.inventory_item.cost)
        : null;
}

async function getStockLevels() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return {
                items: sample.inventory,
                retrieved_at: new Date().toISOString()
            };
        }

        const products = await fetchAllPages(
            base() + '/products.json?limit=250&fields=title,variants,image',
            'products'
        );

        const bySku = {};
        const itemToSku = {};

        for (const p of products) {
            const image = (p.image && p.image.src) || null;

            for (const v of (p.variants || [])) {
                const sku = v.sku || (v.inventory_item_id ? String(v.inventory_item_id) : null);
                if (!sku) {
                    continue;
                }

                const variantName = v.title && v.title !== 'Default Title'
                    ? p.title + ' - ' + v.title
                    : p.title;

                bySku[sku] = {
                    sku: sku,
                    variant_id: v.id ? String(v.id) : null,
                    inventory_item_id: v.inventory_item_id ? String(v.inventory_item_id) : null,
                    product_name: p.title,
                    variant_name: v.title,
                    name: variantName,
                    price: Number(v.price || 0),
                    image: image,
                    stock_on_hand: 0,
                    reorder_level: 0
                };

                if (v.inventory_item_id) {
                    itemToSku[v.inventory_item_id] = sku;
                }
            }
        }

        for (const item of Object.values(bySku)) {
            if (item.inventory_item_id) {
                item.unit_cost = await getInventoryItemCost(
                    item.inventory_item_id
                );       
            }
        }

        // inventory_levels caps ids per request, so query in chunks of 50.
        const itemIds = Object.keys(itemToSku);
        const chunks = [];
        for (let i = 0; i < itemIds.length; i += 50) {
            chunks.push(itemIds.slice(i, i + 50));
        }

        const fetchChunk = (chunk) => fetchAllPages(
            base() + '/inventory_levels.json?inventory_item_ids=' + chunk.join(',') + '&limit=250',
            'inventory_levels'
        );

        const CONCURRENCY = 4;
        for (let i = 0; i < chunks.length; i += CONCURRENCY) {
            const batches = await Promise.all(chunks.slice(i, i + CONCURRENCY).map(fetchChunk));
            for (const levels of batches) {
                for (const lvl of levels) {
                    const sku = itemToSku[lvl.inventory_item_id];
                    if (sku && bySku[sku]) {
                        bySku[sku].stock_on_hand += Number(lvl.available || 0);
                    }
                }
            }
        }

        return {
            items: Object.values(bySku),
            retrieved_at: new Date().toISOString()
        };
    }, {
        items: [],
        retrieved_at: null
    });
}

async function getTodayOrders() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.orders_today;
        }

        const startOfToday = new Date();
        startOfToday.setUTCHours(0, 0, 0, 0);

        const url =
            base() +
            '/orders.json?status=any' +
            '&created_at_min=' + startOfToday.toISOString() +
            '&limit=250' +
            '&fields=total_price';

        const orders = await fetchAllPages(url, 'orders');

        let salesTotal = 0;
        for (const o of orders) {
            salesTotal += Number(o.total_price);
        }

        return {
            orders_count: orders.length,
            sales_total: Number(salesTotal.toFixed(2))
        };
    }, { orders_count: 0, sales_total: 0 });
}

const SHIPMENT_STATUS = {
    confirmed: 'InfoReceived',
    label_printed: 'Pending',
    label_purchased: 'Pending',
    ready_for_pickup: 'OutForDelivery',
    in_transit: 'InTransit',
    out_for_delivery: 'OutForDelivery',
    attempted_delivery: 'Exception',
    failure: 'Exception',
    delivered: 'Delivered'
};

async function getTrackings() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.trackings;
        }

        const since = new Date(Date.now() - 30 * 864e5).toISOString();

        const url =
            base() +
            '/orders.json?status=any' +
            '&created_at_min=' + since +
            '&limit=250' +
            '&fields=name,customer,fulfillments';

        const orders = await fetchAllPages(url, 'orders');

        const trackings = [];
        for (const o of orders) {
            const customer = o.customer
                ? ((o.customer.first_name || '') + ' ' + (o.customer.last_name || '')).trim()
                : '';

            for (const f of (o.fulfillments || [])) {
                if (!f.tracking_number) {
                    continue;
                }

                trackings.push({
                    tracking_number: f.tracking_number,
                    order_id: o.name,
                    courier: f.tracking_company || '',
                    status: SHIPMENT_STATUS[f.shipment_status] || 'Pending',
                    customer: customer,
                    last_update: f.updated_at ? f.updated_at.slice(0, 10) : ''
                });
            }
        }

        return trackings;
    });
}

async function getMonthlyRevenue() {
    const mode = env.modes.shopify;

    return withSync('shopify', mode, async () => {
        if (mode === 'sample') {
            return sample.revenue_monthly;
        }

        const yearMs = 365 * 864e5;
        const since = new Date(Date.now() - yearMs).toISOString();

        const url =
            base() +
            '/orders.json?status=any' +
            '&financial_status=paid' +
            '&created_at_min=' + since +
            '&limit=250' +
            '&fields=created_at,total_price';

        const orders = await fetchAllPages(url, 'orders');

        const byMonth = {};
        for (const o of orders) {
            const m = o.created_at.slice(0, 7);
            byMonth[m] = (byMonth[m] || 0) + Number(o.total_price);
        }

        const monthKeys = Object.keys(byMonth);
        monthKeys.sort();

        const months = [];
        for (const month of monthKeys) {
            months.push({
                month: month,
                revenue: byMonth[month]
            });
        }

        return months;
    });
}

module.exports = cacheAll('shopify', {
    getSalesOverview,
    getTopCustomers,
    getCustomerPurchases,
    getDailyRevenue,
    getStockLevels,
    getMonthlyRevenue,
    getTodayOrders,
    getSalesTrend,
    getTrackings
});
