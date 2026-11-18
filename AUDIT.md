# Aura & Oak — Audit & Changes (v2 → v3)

Everything below was verified by running the site against a real MariaDB
database and a headless Chrome browser (all pages, desktop + mobile, a full
add-to-cart → promo → checkout → confirmation flow, and the admin dashboard).

## 🔴 Critical security fixes

| # | Problem in v2 | Impact | Fix |
|---|---|---|---|
| 1 | `express.static(__dirname)` served the whole project folder | Anyone could download **`/.env`** (database password, JWT secret, Stripe secret key), `server.js`, `db.sql` | Only `public/` is served now. Verified `/.env` → 404 |
| 2 | With Stripe enabled, `/api/checkout/complete` treated any `payment_intent_id` starting with `sim_` (or none at all) as "simulated" | **Free orders**: anyone could get a paid order without paying | Stripe mode requires a real, succeeded PaymentIntent whose amount + currency match the cart; one payment = one order; auto-refund if stock runs out |
| 3 | Product reviews, names, addresses and order data were inserted into pages with `innerHTML` unescaped | **Stored XSS**: a review like `<script>…</script>` ran for every visitor; a checkout name with a script ran inside the **admin dashboard** and could steal the admin session | Every page escapes database/user data (`esc()` helper). Verified the payload renders as text |
| 4 | `PUT/DELETE /api/cart/:id` had no ownership check | Anyone could change or empty other shoppers' carts by guessing ids | Cart lines are only editable by their owner (account or browser session) |
| 5 | `GET /api/orders/:orderNumber` returned the order if no email was given | Leaked customers' names and home addresses to anyone with an order number | Requires the matching email or the signed-in owner; internal fields stripped |
| 6 | Default admin `admin / ChangeMe123!` printed on the public login page; insecure fallback JWT secret | Takeover of a freshly deployed store | First admin password comes from `.env` or is random and printed once to the server log; random per-boot secrets in dev, refuses to start in production without real ones |
| 7 | No rate limiting | Password guessing, review/contact spam | Limits on logins, signup, reviews, contact, newsletter, promo checks, checkout |
| 8 | `?next=` redirect after login accepted any URL | Phishing via open redirect | Only same-site paths allowed |

Also: Helmet security headers, request size limits, generic error messages in
production (no SQL errors shown to visitors), honeypot on the contact form,
image uploads validated by file signature, CSV exports safe against formula
injection, bcrypt cost raised to 12.

## 🟠 Bugs fixed

- **Re-running `db.sql` duplicated every product** (products had no unique key) — proven: 8 → 16. Slugs are unique now; seeds are separate and idempotent.
- `FREESHIP` was a $12 discount off the subtotal, not free shipping (README said otherwise) — new `free_shipping` promo type.
- Shipping/discount math was copy-pasted in 3 places (cart, checkout, server) and could disagree — now computed only on the server (`/api/cart/totals`).
- Cancelling an order never returned stock; revenue counted cancelled orders.
- "All" filter on the shop page did nothing after picking a category.
- `shipping.html` promised "a shipping notification once it's on its way" — never sent. Now sent with carrier + tracking.
- Merging a guest cart on login could exceed available stock.
- Product page quantity could go above stock; `btn-primary` on the review form had no styles.
- Promo codes had no usage limits; order numbers were guessable (`Date.now()` + 4 chars).
- Mobile: hamburger overlapped the logo on the homepage.
- Footer links "Makers", "Sustainability", "FAQ" went nowhere; copyright year hard-coded to 2024.
- `css/common.css` and `js/common.js` weren't part of the upload, so they were rewritten from scratch against every function the pages call. If you'd customised the old ones, compare before replacing.

## 🟢 New for a local business

- **Contact & Visit page** — address, hours, click-to-call, WhatsApp, Google Map, directions button, contact form → admin inbox + email alert.
- **"Visit the Store" section** on the homepage and store details in every footer.
- **WhatsApp chat button** (set `STORE_WHATSAPP`).
- **Google-ready SEO, rendered on the server**: LocalBusiness (HomeGoodsStore) data with address/hours/geo, Product data with price/stock/ratings (eligible for rich results), breadcrumbs, canonical URLs, Open Graph/Twitter cards, clean product URLs (`/product/<slug>`, old `?id=` links 301-redirect), auto `sitemap.xml` + `robots.txt`, proper 404s.
- **Any currency + tax** from `.env` (e.g. INR + 18% GST) — every page, email and Stripe follow it.

## 🟢 New for customers

Forgot/reset password, change password, default address, wishlist → add to cart,
order tracking page with status steps (also works without an account via
order # + email), "verified buyer" badges on reviews, shareable shop filters
(`/shop.html?category=2&q=lamp&sort=price_asc`), autocomplete on checkout forms,
keyboard/screen-reader improvements.

## 🟢 New for the owner (admin)

Orders search/filter, tracking + carrier, internal notes, refunds (Stripe or
test), CSV export (orders, customers, newsletter); product photo upload and
gallery, hide/show products, SEO fields per product; categories; promo-code
manager; contact inbox; review moderation; customer list; setup checklist on
the overview.

## Still worth doing (not code)

Google Business Profile, Search Console + sitemap, real product photography,
and Stripe live keys — see README → "Getting found locally" and "Going live".
