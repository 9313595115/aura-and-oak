# Eagle CNC Art & Craft — Online Store (v3)

A complete website for a CNC art & craft workshop: storefront, product pages
that rank in Google, customer accounts, cart, checkout (Stripe or test mode),
order emails, a Contact & Visit page with map and hours, and an admin dashboard
to run orders, products, promo codes, messages and reviews.

Node.js + Express backend, MySQL/MariaDB database, plain HTML/CSS/JS front end
(no build step).

---

## Folder layout

```
server.js              API + page server (the only file Node runs)
database/schema.sql    Tables
database/seed.sql      Sample products, categories, promo codes
scripts/migrate.js     `npm run db:setup` — creates/upgrades the database
scripts/hash-password.js
.env.example           All settings — copy to .env
public/                EVERYTHING the browser can see (and nothing else)
  index, shop, product, cart, checkout, order-confirmation, account,
  contact, shipping, returns, reset-password, 404, admin  (.html)
  css/common.css  js/common.js  images/  uploads/
```

> Only `public/` is served. Your `.env`, `server.js` and database files can no
> longer be downloaded by visitors (in v2 they could — see AUDIT.md).

---

## Setup (about 10 minutes)

1. **Install Node.js 18+** and **MySQL 8 or MariaDB 10.6+**.
2. **Photos** live in `public/images/` (sample product photos are included).
   Replace them with your own work any time, or upload new ones from the admin
   panel. Each bundled photo has `name.webp` + `name-sm.webp` copies for speed.
3. Install and configure:
   ```bash
   npm install
   cp .env.example .env
   ```
   Open `.env` and fill in at least: `MYSQL_*`, `JWT_SECRET`, `ADMIN_JWT_SECRET`
   (generate each with
   `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`),
   and the **STORE_*** business details.
4. Create the database (safe to re-run any time, including after updates):
   ```bash
   npm run db:setup              # add  -- --no-seed  to skip sample products
   ```
5. Start it:
   ```bash
   npm start                     # or: npm run dev  (auto-restarts on changes)
   ```
   Open http://localhost:3000. The first start prints the **admin password**
   in the terminal (or uses `ADMIN_INITIAL_PASSWORD`). Sign in at `/admin.html`
   and change it under Settings.

### Upgrading from v2

Point `.env` at your existing database and run `npm run db:setup`. It adds the
new columns/tables without touching existing orders, customers or products.
If the old `db.sql` was ever run twice you'll have duplicate products — they
are kept (with unique URLs); delete the extras from Admin → Products.
Then replace your old files with this folder (keep your `images/`).

---

## Your business details

Everything about the business lives in `.env` and appears automatically on the
site (footer, Contact page, homepage "Visit the Store"), in order emails, and
in the structured data Google reads:

| Setting | Example |
|---|---|
| `STORE_NAME`, `STORE_TAGLINE` | Eagle CNC Art & Craft |
| `STORE_PHONE`, `STORE_EMAIL`, `STORE_WHATSAPP` | WhatsApp (defaults to the store phone; `off` hides it): chat button on every page, “Ask about this design” on products, “Order on WhatsApp” in the cart, “Message us” after ordering, and “WhatsApp customer” in the admin order view |
| `STORE_STREET`, `STORE_CITY`, `STORE_REGION`, `STORE_POSTAL_CODE`, `STORE_COUNTRY` | Drives the map and directions |
| `STORE_HOURS` (for Google) / `STORE_HOURS_DISPLAY` (for people) | `Mo-Sa 10:00-20:00` / `Mon–Sat 10am–8pm` |
| `STORE_MAPS_URL` | Your Google Business Profile link |
| `STORE_CURRENCY`, `STORE_LOCALE` | `INR` + `en-IN` for India, `USD` + `en-US`, `CAD` + `en-CA` … |
| `SHIPPING_FLAT_RATE`, `FREE_SHIPPING_THRESHOLD` | One place for shipping rules; every page follows it |
| `TAX_RATE_PERCENT`, `TAX_LABEL` | e.g. `18` and `GST` |

Restart the server after editing `.env`.

---

## Payments

Checkout picks the payment methods automatically from `.env`:

- **Razorpay** (UPI, cards, netbanking, wallets): set `RAZORPAY_KEY_ID` and
  `RAZORPAY_KEY_SECRET`. The server creates the Razorpay order for the exact cart
  total, verifies the payment signature and amount before creating the order, and
  refunds automatically if anything doesn't match. Optional webhook: point
  Razorpay at `BASE_URL/api/razorpay/webhook` (event `payment.captured`) with
  `RAZORPAY_WEBHOOK_SECRET` — you're emailed if a payment ever has no order.
- **Cash on delivery**: `COD_ENABLED=true`, optional `COD_FEE` and `COD_MAX_ORDER`.
  COD orders arrive as *processing / unpaid*; use **Mark as paid** in the admin
  order view once the courier has collected the cash.
- **Stripe** (cards) still works with `STRIPE_*` keys if you prefer it.
- With none of these set, checkout runs in **preview mode** (no money taken).

## Before you launch

- **Payments:** with no Razorpay, Stripe or COD switched on, the live checkout shows
  *“Online ordering opens soon”* with a WhatsApp button, and the server refuses unpaid
  orders. (`ALLOW_PREVIEW_CHECKOUT=true` allows unpaid test orders for demos only.)
- **Privacy & Terms:** `/privacy` and `/terms` fill themselves from `LEGAL_NAME`,
  `LEGAL_ADDRESS`, `GSTIN`, `LEGAL_JURISDICTION` and `GRIEVANCE_OFFICER_*`. The server
  log lists anything missing. Have a lawyer or CA review the wording.
- **Photos:** images uploaded in the admin are stored in the database, so they survive
  restarts and redeploys on hosts with temporary disks (like Render).
- **Test data:** Admin → Settings → *Remove test data before launch* clears preview orders,
  test customers, messages, reviews and subscribers, and puts the stock back. Once a real
  order exists it only removes preview orders.

## Customisation options

Each product can have options, written as simple lines in **Admin → Products**:

```
text* Family name | 30 | The Sharma Family      (* = required · max letters · example)
choice Size: 45 × 15 cm, 60 × 20 cm (+700)       (first = default · (+700) adds ₹700)
preview nameplate                                 (live preview: nameplate or round)
days 5                                            (made to order: extra working days)
```

The price is always worked out on the server from the product's own options, and
the customer's choices appear in the cart, checkout, emails and admin order view.

## Email

Without an email service, emails are printed in the server log. To send real
emails, either set `BREVO_API_KEY` + `MAIL_FROM` (Brevo's free HTTPS API, 300
emails/day — **required on Render's free plan, which blocks SMTP ports**), or
set `SMTP_*` for any SMTP server. Verify the `MAIL_FROM` address in Brevo →
Senders before sending. Emails sent: order confirmation, "your order shipped"
(with tracking), cancellation, password reset, and new-order / new-message
alerts to `STORE_NOTIFY_EMAIL`.

---

## Running the business (admin)

`/admin.html` — separate login, 12-hour sessions.

- **Overview:** revenue, orders to ship, low stock, unread messages, best sellers, setup checklist
- **Orders:** search/filter, mark processing → shipped (with carrier + tracking, emails the customer), cancel (restocks), refund, private notes, CSV export
- **Products:** add/edit with photo upload and gallery, hide without deleting, featured flag, stock, SEO title/description/URL
- **Categories**, **Promo codes** (% off, fixed off, free shipping, minimum order, usage limit, expiry)
- **Messages** from the Contact form, **Reviews** (hide spam), **Customers** + newsletter export

Forgot the admin password? `node scripts/hash-password.js "NewPassword123"` then
`UPDATE admin_users SET password_hash='<output>' WHERE username='admin';`

---

## Going live

1. A small VPS (DigitalOcean, Lightsail, Hostinger VPS) or Render/Railway with a
   managed MySQL. Shared PHP hosting won't run Node.
2. Set `NODE_ENV=production` and `BASE_URL=https://yourdomain.com` (the server
   refuses to start in production without JWT secrets).
3. Run behind HTTPS (Caddy is easiest — it gets certificates automatically:
   `yourdomain.com { reverse_proxy localhost:3000 }`), and keep it running with
   `pm2 start server.js --name store` or a systemd service.
4. Back up the database daily (`mysqldump`) and the `public/uploads/` folder.

---

## Getting found locally (do these after launch)

The site already does the technical part: each page has its own title and
description, product pages live at clean URLs (`/product/carved-mandala-wall-art`)
with price/stock/rating data for Google, the homepage and Contact page tell
Google your business type, address, phone, hours and map location, and
`/sitemap.xml` + `/robots.txt` are generated automatically.

The rest is outside the code, and it matters more:

1. **Google Business Profile** — create/claim it at business.google.com, use the
   exact same name, address and phone as in `.env`, add photos, hours, and the
   website link. Put the profile link in `STORE_MAPS_URL`.
2. **Google Search Console** — verify the domain and submit
   `https://yourdomain.com/sitemap.xml`.
3. **Bing Places** and **Apple Business Connect** — same details, 10 minutes each.
4. **Reviews** — ask happy customers to review you on Google; reply to every one.
5. **Consistent NAP** — the same Name/Address/Phone everywhere: Instagram,
   Facebook, Justdial/IndiaMART (India) or Yelp (US), local directories.
6. **Real product photos and descriptions** — unique text per product beats
   anything else for product searches.
7. Optional: add Google Analytics or Plausible to see where visitors come from.
