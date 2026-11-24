// COCONOW store — Express server + Postgres orders backend.
//
// Serves the static storefront (public/) and a real orders API.
//  - Production (Render): Postgres via DATABASE_URL.
//  - No DATABASE_URL set: in-memory Postgres emulator (pg-mem) for local
//    dev / verification only. Same SQL, same behaviour; not a second
//    production database engine.
"use strict";

const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 3000;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// Catalog — matches the live COCONOW store (confirmed via getstorefront).
const CATALOG = [
  { id: 1, slug: "daab", name: "Daab", tagline: "Fresh green tender coconut", description: "Young green coconut, chilled by nature — crack it open for sweet, clear coconut water and soft, tender flesh.", unit: "per piece", priceBdt: 120, imageKey: "daab", sortOrder: 1 },
  { id: 2, slug: "narikel", name: "Narikel", tagline: "Mature coconut", description: "The classic mature coconut — firm white flesh and rich flavour for cooking, grating and everything in between.", unit: "per piece", priceBdt: 120, imageKey: "narikel", sortOrder: 2 },
  { id: 3, slug: "coconut-water", name: "Coconut Water", tagline: "Fresh from the daab", description: "Coconut water poured fresh — light, clear and naturally refreshing, exactly as it comes from the coconut.", unit: "per serving", priceBdt: 150, imageKey: "water", sortOrder: 3 },
  { id: 4, slug: "more-goodness", name: "More Goodness", tagline: "Coconut oil & more", description: "More of the coconut to love — coconut oil and further coconut favorites, added to the collection as they become available.", unit: "per item", priceBdt: 350, imageKey: "more", sortOrder: 4 },
];
const DEFAULT_SETTINGS = { deliveryDhaka: 60, deliveryNationwide: 120, codEnabled: true };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  tagline TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'per piece',
  price INTEGER NOT NULL,
  image_key TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  available BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  order_number TEXT UNIQUE NOT NULL,
  customer_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT NOT NULL,
  district TEXT NOT NULL,
  delivery_area TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  payment_method TEXT NOT NULL DEFAULT 'Cash on Delivery',
  status TEXT NOT NULL DEFAULT 'pending',
  subtotal INTEGER NOT NULL,
  delivery_fee INTEGER NOT NULL,
  total INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL,
  product_name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL
);
`;

let pool;
let dbMode = "memory";

async function initDb() {
  if (process.env.DATABASE_URL) {
    const url = process.env.DATABASE_URL;
    const needsSsl = /sslmode=require/i.test(url) || /render\.com/i.test(url);
    pool = new Pool({
      connectionString: url,
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    dbMode = "postgres";
  } else {
    // Local dev / verification only.
    const { newDb } = require("pg-mem");
    const db = newDb();
    const { Pool: MemPool } = db.adapters.createPg();
    pool = new MemPool();
    dbMode = "memory (pg-mem)";
  }
  await pool.query(SCHEMA);
  for (const p of CATALOG) {
    await pool.query(
      `INSERT INTO products (id, slug, name, tagline, description, unit, price, image_key, sort_order, available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.slug, p.name, p.tagline, p.description, p.unit, p.priceBdt, p.imageKey, p.sortOrder]
    );
  }
  await pool.query(
    `INSERT INTO settings (key, value) VALUES
       ('delivery_dhaka', '60'),
       ('delivery_nationwide', '120'),
       ('cod_enabled', 'true')
     ON CONFLICT (key) DO NOTHING`
  );
}

function productRow(r) {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    tagline: r.tagline,
    description: r.description,
    unit: r.unit,
    priceBdt: r.price,
    imageKey: r.image_key,
    sortOrder: r.sort_order,
    available: r.available,
  };
}

async function getSettings() {
  const { rows } = await pool.query("SELECT key, value FROM settings");
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) {
    if (r.key === "delivery_dhaka") s.deliveryDhaka = parseInt(r.value, 10);
    if (r.key === "delivery_nationwide") s.deliveryNationwide = parseInt(r.value, 10);
    if (r.key === "cod_enabled") s.codEnabled = r.value === "true";
  }
  return s;
}

async function getProducts() {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY sort_order ASC, id ASC");
  return rows.map(productRow);
}

// Dhaka local date as YYYYMMDD (store timezone is Asia/Dhaka, UTC+6).
function dhakaDateStr(d) {
  const t = new Date((d || new Date()).getTime() + 6 * 60 * 60 * 1000);
  return t.toISOString().slice(0, 10).replace(/-/g, "");
}

function orderRow(r, items) {
  return {
    id: r.id,
    orderNumber: r.order_number,
    customerName: r.customer_name,
    phone: r.phone,
    address: r.address,
    district: r.district,
    deliveryArea: r.delivery_area,
    instructions: r.instructions,
    paymentMethod: r.payment_method,
    status: r.status,
    subtotal: r.subtotal,
    deliveryFee: r.delivery_fee,
    total: r.total,
    createdAt: r.created_at,
    items: (items || []).map((it) => ({
      productId: it.product_id,
      productName: it.product_name,
      unitPrice: it.unit_price,
      qty: it.qty,
    })),
  };
}

const app = express();
app.use(express.json({ limit: "100kb" }));

// Never serve a stale storefront after an update.
const pubDir = path.join(__dirname, "public");
app.use(
  express.static(pubDir, {
    setHeaders(res, p) {
      if (p.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    },
  })
);

app.get("/api/health", (req, res) => res.json({ ok: true, db: dbMode }));

app.get("/api/products", async (req, res, next) => {
  try {
    res.json({ products: await getProducts(), settings: await getSettings() });
  } catch (e) {
    next(e);
  }
});

const PHONE_RE = /^[0-9+\-\s]{6,20}$/;

app.post("/api/orders", async (req, res, next) => {
  try {
    const b = req.body || {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    const phone = typeof b.phone === "string" ? b.phone.trim() : "";
    const address = typeof b.address === "string" ? b.address.trim() : "";
    const district = typeof b.district === "string" ? b.district.trim() : "";
    const deliveryArea = b.deliveryArea;
    const instructions = typeof b.instructions === "string" ? b.instructions.trim().slice(0, 500) : "";
    const items = Array.isArray(b.items) ? b.items : [];

    if (name.length < 2) return res.status(400).json({ error: "Please enter your full name." });
    if (!PHONE_RE.test(phone)) return res.status(400).json({ error: "Please enter a valid phone number." });
    if (address.length < 8) return res.status(400).json({ error: "Please enter your full delivery address." });
    if (district.length < 2) return res.status(400).json({ error: "Please enter your district." });
    if (deliveryArea !== "dhaka" && deliveryArea !== "nationwide")
      return res.status(400).json({ error: "Please choose a delivery area." });
    if (items.length === 0 || items.length > 20)
      return res.status(400).json({ error: "Your cart is empty." });

    const settings = await getSettings();
    if (!settings.codEnabled)
      return res.status(400).json({ error: "Cash on Delivery is currently unavailable." });

    const products = await getProducts();
    const byId = new Map(products.map((p) => [p.id, p]));
    const lines = [];
    let subtotal = 0;
    for (const it of items) {
      const pid = Number(it.productId);
      const qty = Number(it.qty);
      const p = byId.get(pid);
      if (!p) return res.status(400).json({ error: "Unknown product in cart." });
      if (!p.available) return res.status(400).json({ error: p.name + " is currently unavailable." });
      if (!Number.isInteger(qty) || qty < 1 || qty > 99)
        return res.status(400).json({ error: "Invalid quantity." });
      lines.push({ productId: p.id, productName: p.name, unitPrice: p.priceBdt, qty });
      subtotal += p.priceBdt * qty;
    }
    const deliveryFee = deliveryArea === "dhaka" ? settings.deliveryDhaka : settings.deliveryNationwide;
    const total = subtotal + deliveryFee;

    // Insert with a GN-YYYYMMDD-XXXX number; retry on a same-day collision.
    let saved = null;
    for (let attempt = 0; attempt < 5 && !saved; attempt++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const dateStr = dhakaDateStr();
        const cnt = await client.query("SELECT COUNT(*) AS n FROM orders WHERE order_number LIKE $1", [
          `GN-${dateStr}-%`,
        ]);
        const seq = parseInt(cnt.rows[0].n, 10) + 1 + attempt;
        const orderNumber = `GN-${dateStr}-${String(seq).padStart(4, "0")}`;
        const ins = await client.query(
          `INSERT INTO orders (order_number, customer_name, phone, address, district, delivery_area, instructions, payment_method, status, subtotal, delivery_fee, total)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'Cash on Delivery', 'pending', $8, $9, $10)
           RETURNING *`,
          [orderNumber, name, phone, address, district, deliveryArea, instructions, subtotal, deliveryFee, total]
        );
        const order = ins.rows[0];
        for (const l of lines) {
          await client.query(
            `INSERT INTO order_items (order_id, product_id, product_name, unit_price, qty)
             VALUES ($1, $2, $3, $4, $5)`,
            [order.id, l.productId, l.productName, l.unitPrice, l.qty]
          );
        }
        await client.query("COMMIT");
        saved = orderRow(order, lines.map((l) => ({ product_id: l.productId, product_name: l.productName, unit_price: l.unitPrice, qty: l.qty })));
      } catch (e) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {
          /* ignore */
        }
        if (e && e.code === "23505" && attempt < 4) continue; // order_number collision: try next seq
        throw e;
      } finally {
        client.release();
      }
    }
    if (!saved) return res.status(500).json({ error: "Could not place your order. Please try again." });
    res.status(201).json({
      ok: true,
      orderNumber: saved.orderNumber,
      subtotal: saved.subtotal,
      deliveryFee: saved.deliveryFee,
      total: saved.total,
      status: saved.status,
    });
  } catch (e) {
    next(e);
  }
});

// ---- admin (owner) ----
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    return res.status(503).json({ error: "Admin access is not configured on this server (ADMIN_TOKEN is not set)." });
  }
  const h = req.get("authorization") || "";
  if (h !== "Bearer " + ADMIN_TOKEN) {
    return res.status(401).json({ error: "Wrong admin token." });
  }
  next();
}

app.get("/api/admin/orders", requireAdmin, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 200");
    let itemsByOrder = {};
    if (rows.length > 0) {
      const ids = rows.map((r) => r.id);
      const placeholders = ids.map((_, i) => "$" + (i + 1)).join(",");
      const ir = await pool.query(
        `SELECT * FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id ASC`,
        ids
      );
      for (const it of ir.rows) (itemsByOrder[it.order_id] = itemsByOrder[it.order_id] || []).push(it);
    }
    res.json({ orders: rows.map((r) => orderRow(r, itemsByOrder[r.id] || [])) });
  } catch (e) {
    next(e);
  }
});

app.put("/api/admin/products/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid product id." });
    const b = req.body || {};
    const sets = [];
    const vals = [];
    const strField = (col, v, max) => {
      if (typeof v === "string" && v.trim().length > 0 && v.trim().length <= max) {
        vals.push(v.trim());
        sets.push(col + " = $" + vals.length);
      }
    };
    strField("name", b.name, 120);
    strField("tagline", b.tagline, 200);
    strField("description", b.description, 1000);
    strField("unit", b.unit, 40);
    const price = b.priceBdt !== undefined ? b.priceBdt : b.price;
    if (price !== undefined) {
      const p = Number(price);
      if (!Number.isInteger(p) || p < 0) return res.status(400).json({ error: "Price must be a whole number of Taka (0 or more)." });
      vals.push(p);
      sets.push("price = $" + vals.length);
    }
    if (typeof b.available === "boolean") {
      vals.push(b.available);
      sets.push("available = $" + vals.length);
    }
    if (sets.length === 0) return res.status(400).json({ error: "Nothing to update." });
    vals.push(id);
    const { rows } = await pool.query(
      `UPDATE products SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`,
      vals
    );
    if (rows.length === 0) return res.status(404).json({ error: "Product not found." });
    res.json({ product: productRow(rows[0]) });
  } catch (e) {
    next(e);
  }
});

app.put("/api/admin/settings", requireAdmin, async (req, res, next) => {
  try {
    const b = req.body || {};
    const updates = [];
    const intField = (key, v) => {
      if (v === undefined) return;
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) throw Object.assign(new Error("Delivery charge must be a whole number of Taka (0 or more)."), { status: 400 });
      updates.push([key, String(n)]);
    };
    intField("delivery_dhaka", b.deliveryDhaka);
    intField("delivery_nationwide", b.deliveryNationwide);
    if (b.codEnabled !== undefined) {
      if (typeof b.codEnabled !== "boolean") throw Object.assign(new Error("codEnabled must be true or false."), { status: 400 });
      updates.push(["cod_enabled", b.codEnabled ? "true" : "false"]);
    }
    if (updates.length === 0) return res.status(400).json({ error: "Nothing to update." });
    for (const [k, v] of updates) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [k, v]
      );
    }
    res.json({ settings: await getSettings() });
  } catch (e) {
    next(e);
  }
});

app.use("/api", (req, res) => res.status(404).json({ error: "Unknown API route." }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error." });
});

initDb()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`COCONOW store listening on port ${PORT} (db: ${dbMode})`);
    });
  })
  .catch((e) => {
    console.error("Failed to start:", e);
    process.exit(1);
  });
