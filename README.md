# COCONOW — full store (real orders)

Standalone COCONOW store: the same storefront as the live COCONOW site —
Palmo-style design, palm-tree loader, single-scroll coconut break, products
appearing one after another in the scroll, shop with Pick-a-pack, and a
Cash on Delivery checkout — plus a real orders backend (Express + Postgres).

This is the **full store, not the static review copy**: orders placed at
checkout are stored in Postgres and can be reviewed in the admin page.
The static review copy (demo checkout, nothing saved) is a different build.

## What is inside

- `public/index.html` — the storefront. Same design and scroll as the live
  store (15:02 version: single-scroll coconut break after "Fresh from the
  Palm", no badge parade, Daab → Narikel → Coconut Water in sequence with
  hard cuts, counter and full turns, scalloped wave, showcase, shop with
  Pick-a-pack, MENU overlay, footer). The checkout posts real orders to
  `/api/orders`. On load it fetches `/api/products` so prices and delivery
  charges set in the admin show up on the storefront; if the API is
  unreachable it falls back to the prices built into the page.
- `public/admin.html` — owner page: enter the admin token, see orders
  (newest first), edit product prices / availability, edit delivery
  charges and Cash on Delivery.
- `server.js` — Express server. Serves `public/` and the API:
  - `GET /api/health`
  - `GET /api/products` — catalog + settings (delivery charges, COD on/off)
  - `POST /api/orders` — places an order. Items are validated against the
    catalog and the subtotal, delivery charge and total are computed
    server-side (client prices are never trusted). Returns an order number
    like `GN-20261124-0001`.
  - `GET /api/admin/orders` — orders, newest first, with line items
  - `PUT /api/admin/products/:id` — edit name, tagline, description, unit,
    price, availability
  - `PUT /api/admin/settings` — edit delivery charges and COD on/off
  - All `/api/admin/*` routes need `Authorization: Bearer <ADMIN_TOKEN>`.
- `render.yaml` — Render Blueprint: one Node web service + one free
  Postgres database, with `DATABASE_URL` wired in.

## Deploy on Render (Blueprint, one click)

1. Push this folder to a GitHub repository (e.g. `coconow-site`).
2. In Render: **New → Blueprint**, pick the repository. Render reads
   `render.yaml` and creates the web service (`coconow-store`) and the
   Postgres database (`coconow-db`).
3. Render generates a random `ADMIN_TOKEN` for the service. Find it in the
   Render dashboard: service → **Environment** → `ADMIN_TOKEN`. Copy it —
   it is the password for `/admin.html`. (You can also set your own value
   there instead of the generated one; redeploy after changing it.)
4. Open the service URL. Place a test order if you like, then open
   `/admin.html`, enter the token, and check the order is listed.

Orders are stored in Postgres, not in the browser. The database is free
tier; keep an eye on its limits in the Render dashboard.

## Admin page

Open `<your-site>/admin.html`, enter the admin token, and you can:

- see every order (newest first) with customer name, phone, address,
  district, delivery area, items and totals;
- change a product's price or mark it unavailable (the storefront picks
  the change up on its next load);
- change the Inside Dhaka / nationwide delivery charges and switch Cash
  on Delivery on or off.

## Run locally

```sh
npm install
npm start
```

With no `DATABASE_URL` set, the server uses an in-memory Postgres
emulator (pg-mem, dev dependency) with the same tables, so you can try
the whole flow without a database server. To use a real Postgres
locally, set `DATABASE_URL` (e.g.
`postgres://user:pass@localhost:5432/coconow`) and set `ADMIN_TOKEN`
to any secret for testing:

```sh
ADMIN_TOKEN=test-admin-token npm start
```

Then open http://localhost:3000, add to cart, check out, and open
http://localhost:3000/admin.html with the same token to see the order.

## Notes

- Products: Daab ৳120/pc, Narikel ৳120/pc, Coconut Water ৳150/serving,
  More Goodness ৳350/item. Delivery: ৳60 inside Dhaka, ৳120 nationwide.
  Cash on Delivery only — no card or mobile-money processing.
- Orders are confirmed by phone: the checkout tells the customer COCONOW
  will call to confirm before dispatch.
- The storefront file is large (~5.6 MB) because the product photos are
  embedded in the page; that is how the review export was built, and it
  keeps the site to a single file with no extra asset hosting.
