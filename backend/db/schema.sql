-- Evolvee Radiance Operations Hub. PostgreSQL schema
-- Applied idempotently by db/applySchema.js (safe to run more than once).

CREATE TABLE IF NOT EXISTS users (
    id            SERIAL PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name     TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin','developer','ops_manager','marketing','partner')),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    -- Bumped on password change / reset to invalidate previously issued JWTs.
    token_version INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- For databases created before token_version existed:
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS manufacturers (
    id                 SERIAL PRIMARY KEY,
    name               TEXT NOT NULL,
    country            TEXT,
    notes              TEXT,
    lead_time_days     INTEGER CHECK (lead_time_days >= 0),
    min_order_quantity INTEGER CHECK (min_order_quantity >= 0),
    payment_terms      TEXT,
    quality_rating     INTEGER CHECK (quality_rating BETWEEN 1 AND 5),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS lead_time_days     INTEGER;
ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS min_order_quantity INTEGER;
ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS payment_terms      TEXT;
ALTER TABLE manufacturers ADD COLUMN IF NOT EXISTS quality_rating     INTEGER;

CREATE TABLE IF NOT EXISTS manufacturer_contacts (
    id              SERIAL PRIMARY KEY,
    manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    role            TEXT,
    email           TEXT,
    phone           TEXT,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
    id              SERIAL PRIMARY KEY,
    sku             TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    -- Shopify inventory_item_id. The live store has no SKUs, so stock levels are
    -- matched on this; SKU is still used for the bundled sample data.
    shopify_inventory_item_id TEXT,
    manufacturer_id INTEGER REFERENCES manufacturers(id) ON DELETE SET NULL,
    unit_cost       NUMERIC(10,2),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_synced_at  TIMESTAMPTZ
);

-- For databases created before the column existed:
ALTER TABLE products ADD COLUMN IF NOT EXISTS shopify_inventory_item_id TEXT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(10,2);
ALTER TABLE products ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS reorder_thresholds (
    id         SERIAL PRIMARY KEY,
    product_id INTEGER UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    threshold  INTEGER NOT NULL CHECK (threshold >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS reorder_alerts (
    id           SERIAL PRIMARY KEY,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    stock_level  INTEGER NOT NULL,
    threshold    INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','awaiting','resolved')),
    triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    resolved_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS reorder_history (
    id               SERIAL PRIMARY KEY,
    product_id       INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    manufacturer_id  INTEGER REFERENCES manufacturers(id) ON DELETE SET NULL,
    quantity_ordered INTEGER NOT NULL CHECK (quantity_ordered > 0),
    ordered_at       DATE NOT NULL DEFAULT CURRENT_DATE,
    notes            TEXT,
    created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS communications (
    id              SERIAL PRIMARY KEY,
    manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    contact_id      INTEGER REFERENCES manufacturer_contacts(id) ON DELETE SET NULL,
    channel         TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email','phone','meeting','other')),
    summary         TEXT NOT NULL,
    logged_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
    logged_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS production_runs (
    id              SERIAL PRIMARY KEY,
    manufacturer_id INTEGER NOT NULL REFERENCES manufacturers(id) ON DELETE CASCADE,
    product_id      INTEGER REFERENCES products(id) ON DELETE SET NULL,
    quantity        INTEGER,
    status          TEXT NOT NULL DEFAULT 'ordered'
                    CHECK (status IN ('ordered','in_production','shipped','received','cancelled')),
    expected_date   DATE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Reject non-positive quantities at the DB
DO $$ BEGIN
    ALTER TABLE production_runs
        ADD CONSTRAINT production_runs_quantity_positive CHECK (quantity IS NULL OR quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS sync_status (
    source       TEXT PRIMARY KEY,
    mode         TEXT NOT NULL,
    last_run_at  TIMESTAMPTZ,
    last_success TIMESTAMPTZ,
    ok           BOOLEAN,
    message      TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id         SERIAL PRIMARY KEY,
    user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    user_name  TEXT,
    action     TEXT NOT NULL,
    entity     TEXT NOT NULL,
    entity_id  INTEGER,
    details    JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- NULL values don't violate uniqueness, so products without a Shopify id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_products_shopify_iid ON products(shopify_inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_alerts_status   ON reorder_alerts(status);
-- At most one open/awaiting alert per product, makes the stock-check insert race-safe.
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_one_active
    ON reorder_alerts(product_id) WHERE status IN ('open', 'awaiting');
CREATE INDEX IF NOT EXISTS idx_comms_mfr       ON communications(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_runs_mfr        ON production_runs(manufacturer_id);
CREATE INDEX IF NOT EXISTS idx_history_product ON reorder_history(product_id);
CREATE INDEX IF NOT EXISTS idx_audit_created   ON audit_log(created_at DESC);