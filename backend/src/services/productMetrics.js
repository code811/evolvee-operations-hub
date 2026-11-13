function computeProductMetrics(sale, stock, cost) {
    const units = sale.units_sold_30d || 0;
    const revenue = sale.revenue_30d || 0;
    const onHand = stock?.stock_on_hand ?? null;
    // Fall back to average sale price when we don't have a listed stock price.
    const price = Number(stock && stock.price) || (units > 0 ? revenue / units : 0);

    const hasCost = cost != null && price > 0;
    const marginPct = hasCost ? Number((((price - cost) / price) * 100).toFixed(1)) : null;
    const margin30d = cost != null ? Number(((price - cost) * units).toFixed(2)) : null;
    const turnover = ((onHand != null) && (onHand > 0)) ? Number((units / onHand).toFixed(2)) : null;
    const sellThrough = ((onHand != null) && (units + onHand > 0)) ? Number(((units / (units + onHand)) * 100).toFixed(1)) : null;

    return {
        sku: sale.sku,
        title: sale.title || (stock && stock.name) || sale.sku,
        units_sold_30d: units,
        revenue_30d: Number(revenue.toFixed(2)),
        stock_on_hand: onHand,
        margin_pct: marginPct,
        margin_30d: margin30d,
        turnover: turnover,
        sell_through: sellThrough
    };
}

module.exports = { computeProductMetrics };
