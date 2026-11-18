// ============================================================
//  Aura & Oak — server.js (v3)
//  Express + MySQL backend for the storefront, customer accounts,
//  checkout (Stripe or simulated), and the admin dashboard.
//
//  Quick start:
//    npm install
//    cp .env.example .env      (fill in DB + secrets + store info)
//    npm run db:setup          (creates/upgrades tables, sample data)
//    npm start                 → http://localhost:3000
//
//  Only the /public folder is served to browsers. Never put .env,
//  server.js or database files inside /public.
// ============================================================

require("dotenv").config();

const express     = require("express");
const mysql       = require("mysql2/promise");
const path        = require("path");
const fs          = require("fs");
const crypto      = require("crypto");
const bcrypt      = require("bcryptjs");
const jwt         = require("jsonwebtoken");
const nodemailer  = require("nodemailer");
const helmet      = require("helmet");
const compression = require("compression");
const rateLimit   = require("express-rate-limit");

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === "production";
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const BASE_URL   = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// ── Store / business settings (all from .env) ────────────────
const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const STORE = {
  name:          process.env.STORE_NAME || "Aura & Oak",
  tagline:       process.env.STORE_TAGLINE || "Curated home decor for spaces that feel intentional, warm, and wholly yours.",
  email:         process.env.STORE_EMAIL || "",
  phone:         process.env.STORE_PHONE || "",
  whatsapp:      (process.env.STORE_WHATSAPP || "").replace(/[^\d]/g, ""),
  street:        process.env.STORE_STREET || "",
  city:          process.env.STORE_CITY || "",
  region:        process.env.STORE_REGION || "",
  postal_code:   process.env.STORE_POSTAL_CODE || "",
  country:       process.env.STORE_COUNTRY || "",
  hours:         process.env.STORE_HOURS || "",           // e.g. "Mo-Sa 10:00-19:00"
  hours_display: process.env.STORE_HOURS_DISPLAY || "",   // e.g. "Mon–Sat, 10am–7pm"
  latitude:      process.env.STORE_LATITUDE || "",
  longitude:     process.env.STORE_LONGITUDE || "",
  maps_url:      process.env.STORE_MAPS_URL || "",
  instagram:     process.env.STORE_INSTAGRAM || "",
  facebook:      process.env.STORE_FACEBOOK || "",
  currency:      (process.env.STORE_CURRENCY || "USD").toUpperCase(),
  locale:        process.env.STORE_LOCALE || "en-US",
  default_country: process.env.STORE_DEFAULT_SHIP_COUNTRY || process.env.STORE_COUNTRY || "United States",
  shipping_flat: num(process.env.SHIPPING_FLAT_RATE, 12),
  free_shipping_threshold: num(process.env.FREE_SHIPPING_THRESHOLD, 150),
  tax_rate:      num(process.env.TAX_RATE_PERCENT, 0),
  tax_label:     process.env.TAX_LABEL || "Tax",
  return_days:   num(process.env.RETURN_WINDOW_DAYS, 30),
};
const NOTIFY_EMAIL = process.env.STORE_NOTIFY_EMAIL || STORE.email;

// ── Secrets ──────────────────────────────────────────────────
const JWT_SECRET       = process.env.JWT_SECRET || "";
const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || "";
if (!JWT_SECRET || !ADMIN_JWT_SECRET) {
  if (IS_PROD) {
    console.error("✗ JWT_SECRET and ADMIN_JWT_SECRET must be set in .env when NODE_ENV=production. Refusing to start.");
    process.exit(1);
  }
  console.warn("⚠️  JWT_SECRET / ADMIN_JWT_SECRET not set — using a random per-boot secret (everyone is signed out on restart).");
}
const USER_SECRET  = JWT_SECRET || crypto.randomBytes(32).toString("hex");
const ADMIN_SECRET = ADMIN_JWT_SECRET || crypto.randomBytes(32).toString("hex");

const STRIPE_SECRET_KEY      = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;
if (!stripe) console.warn("ℹ️  STRIPE_SECRET_KEY not set — checkout runs in SIMULATED payment mode (no real charges).");
if (IS_PROD && !stripe) console.warn("⚠️  Production without Stripe: orders will be marked paid without payment. Set Stripe keys before launch.");

// ── Database ─────────────────────────────────────────────────
const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "localhost",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "aura_oak",
  waitForConnections: true,
  connectionLimit: 10,
  charset: "utf8mb4",
  // Hosted MySQL (Aiven, TiDB Cloud…) needs TLS: set MYSQL_SSL=true, and
  // MYSQL_SSL_CA to the provider's CA certificate if it uses its own.
  ssl: process.env.MYSQL_SSL === "true"
    ? (process.env.MYSQL_SSL_CA ? { ca: process.env.MYSQL_SSL_CA.replace(/\\n/g, "\n") } : {})
    : undefined,
});

// ── Mail ─────────────────────────────────────────────────────
const mailTransport = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendMail(to, subject, html) {
  if (!to) return { sent: false };
  if (!mailTransport) {
    console.log(`\n✉️  [DEV EMAIL — no SMTP] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600)}\n`);
    return { sent: false, simulated: true };
  }
  try {
    await mailTransport.sendMail({ from: process.env.SMTP_FROM || `${STORE.name} <no-reply@example.com>`, to, subject, html });
    return { sent: true };
  } catch (e) {
    console.error("Email send failed:", e.message);
    return { sent: false, error: e.message };
  }
}

// ── Small helpers ────────────────────────────────────────────
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const round2 = (n) => Math.round(Number(n) * 100) / 100;
const money = (n) => new Intl.NumberFormat(STORE.locale, { style: "currency", currency: STORE.currency }).format(Number(n) || 0);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const str = (v, max = 255) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const intIn = (v, min, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= min && n <= max ? n : null; };
const slugify = (s) => String(s).toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").slice(0, 200) || "item";
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = (msg) => new HttpError(400, msg);

function orderNumber() {
  return "AO-" + new Date().toISOString().slice(2, 10).replace(/-/g, "") + "-" + crypto.randomBytes(3).toString("hex").toUpperCase();
}
function toBool(r) { return { ...r, is_featured: r.is_featured === 1, is_active: r.is_active === undefined ? true : r.is_active === 1 }; }
function productPath(p) { return p.slug ? `/product/${encodeURIComponent(p.slug)}` : `/product.html?id=${p.id}`; }
function absUrl(u) { if (!u) return ""; return /^https?:\/\//i.test(u) ? u : BASE_URL + (u.startsWith("/") ? u : "/" + u); }

// ════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.set("trust proxy", 1);
app.disable("x-powered-by");
// CSP is off because the pages use inline scripts/handlers; every other helmet header is on.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());

// Stripe webhook needs the raw body, so it is registered before express.json()
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), h(async (req, res) => {
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) return res.status(400).send("Webhook not configured");
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (e) { return res.status(400).send(`Webhook signature error: ${e.message}`); }

  if (event.type === "payment_intent.succeeded") {
    const pi = event.data.object;
    const [[order]] = await pool.query("SELECT id FROM orders WHERE payment_intent_id = ?", [pi.id]);
    if (!order) {
      // Paid but the browser never finished checkout (closed tab, lost connection).
      console.warn(`⚠️  Stripe payment ${pi.id} succeeded with no matching order — check the Stripe dashboard and contact ${pi.receipt_email || "the customer"}.`);
      sendMail(NOTIFY_EMAIL, `Action needed: payment without order (${pi.id})`,
        `<p>Stripe payment <b>${esc(pi.id)}</b> for ${esc(money(pi.amount / 100))} succeeded but no order was created. Please review it in Stripe and contact the customer or refund.</p>`);
    }
  } else if (event.type === "charge.refunded") {
    const pi = event.data.object.payment_intent;
    if (pi) await pool.query("UPDATE orders SET payment_status = 'refunded' WHERE payment_intent_id = ?", [pi]);
  }
  res.json({ received: true });
}));

app.use("/api/admin/uploads", express.json({ limit: "8mb" }));
app.use(express.json({ limit: "100kb" }));

function readToken(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : null;
}
// Attach req.user when a valid customer token is present (never blocks)
app.use((req, res, next) => {
  const token = readToken(req);
  if (token) { try { const d = jwt.verify(token, USER_SECRET); if (d && d.id && !d.role) req.user = d; } catch {} }
  next();
});
const authRequired = (req, res, next) => (req.user ? next() : res.status(401).json({ error: "Please sign in to continue." }));
function adminRequired(req, res, next) {
  const token = readToken(req);
  if (!token) return res.status(401).json({ error: "Admin login required" });
  try {
    const d = jwt.verify(token, ADMIN_SECRET);
    if (d.role !== "admin") throw new Error();
    req.admin = d; next();
  } catch { return res.status(401).json({ error: "Invalid or expired admin session" }); }
}

const limiter = (windowMin, max, msg) => rateLimit({
  windowMs: windowMin * 60 * 1000, max, standardHeaders: true, legacyHeaders: false,
  message: { error: msg || "Too many requests — please wait a few minutes and try again." },
});
const authLimiter    = limiter(15, 20, "Too many sign-in attempts. Please wait 15 minutes.");
const formLimiter    = limiter(15, 10);
const promoLimiter   = limiter(15, 40);
const checkoutLimiter = limiter(15, 30);

// Which cart a request belongs to: signed-in users by user_id (follows
// them across devices); guests by the browser's session id.
function cartIdentity(req) {
  const raw = req.get("X-Session-Id") || req.query.session_id || (req.body && req.body.session_id) || "";
  const session_id = /^[\w-]{8,64}$/.test(raw) ? raw : null;
  return { session_id, user_id: req.user ? req.user.id : null };
}
function cartWhere({ session_id, user_id }, alias = "") {
  const a = alias ? alias + "." : "";
  return user_id ? { sql: `${a}user_id = ?`, arg: user_id } : { sql: `${a}session_id = ? AND ${a}user_id IS NULL`, arg: session_id };
}

// ════════════════════════════════════════════════════════════
//  SEO: server-rendered meta, structured data, sitemap, robots
// ════════════════════════════════════════════════════════════
const htmlCache = new Map();
function readPage(file) {
  if (IS_PROD && htmlCache.has(file)) return htmlCache.get(file);
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), "utf8");
  if (IS_PROD) htmlCache.set(file, html);
  return html;
}
const jsonLd = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;

function localBusinessLd() {
  const ld = {
    "@context": "https://schema.org", "@type": "HomeGoodsStore",
    name: STORE.name, description: STORE.tagline, url: BASE_URL + "/",
    image: absUrl("/images/hero.jpg"), logo: absUrl("/images/hero.jpg"),
    priceRange: "$$", currenciesAccepted: STORE.currency,
  };
  if (STORE.phone) ld.telephone = STORE.phone;
  if (STORE.email) ld.email = STORE.email;
  if (STORE.street || STORE.city) ld.address = { "@type": "PostalAddress", streetAddress: STORE.street, addressLocality: STORE.city, addressRegion: STORE.region, postalCode: STORE.postal_code, addressCountry: STORE.country };
  if (STORE.latitude && STORE.longitude) ld.geo = { "@type": "GeoCoordinates", latitude: Number(STORE.latitude), longitude: Number(STORE.longitude) };
  if (STORE.hours) ld.openingHours = STORE.hours.split(",").map((s) => s.trim());
  if (STORE.maps_url) ld.hasMap = STORE.maps_url;
  const same = [STORE.instagram, STORE.facebook].filter(Boolean);
  if (same.length) ld.sameAs = same;
  return ld;
}

function renderPage(res, file, { title, description, canonical, image, type = "website", ld = [], status = 200, noindex = false } = {}) {
  let html = readPage(file);
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  const tags = [];
  if (description) {
    html = html.replace(/<meta name="description"[^>]*>\s*/i, "").replace(/<meta property="og:[^"]+"[^>]*>\s*/gi, "");
    tags.push(`<meta name="description" content="${esc(description)}" />`);
    tags.push(`<meta property="og:title" content="${esc(title || STORE.name)}" />`, `<meta property="og:description" content="${esc(description)}" />`);
    tags.push(`<meta property="og:type" content="${esc(type)}" />`, `<meta property="og:site_name" content="${esc(STORE.name)}" />`);
    tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
    if (image) tags.push(`<meta property="og:image" content="${esc(absUrl(image))}" />`);
  }
  if (canonical) tags.push(`<link rel="canonical" href="${esc(canonical)}" />`, `<meta property="og:url" content="${esc(canonical)}" />`);
  if (noindex) tags.push(`<meta name="robots" content="noindex" />`);
  ld.forEach((o) => tags.push(jsonLd(o)));
  html = html.includes("<!--SEO-->") ? html.replace("<!--SEO-->", tags.join("\n  ")) : html.replace("</head>", tags.join("\n") + "\n</head>");
  res.status(status).set("Cache-Control", "no-cache").type("html").send(html);
}

app.get(["/", "/index.html"], (req, res) => renderPage(res, "index.html", {
  title: `${STORE.name} — Curated Home Decor${STORE.city ? " in " + STORE.city : ""}`,
  description: `${STORE.tagline}${STORE.city ? ` Visit our store in ${STORE.city} or shop online.` : ""}`,
  canonical: BASE_URL + "/", image: "/images/hero.jpg",
  ld: [localBusinessLd(), { "@context": "https://schema.org", "@type": "WebSite", name: STORE.name, url: BASE_URL + "/",
       potentialAction: { "@type": "SearchAction", target: `${BASE_URL}/shop.html?q={search_term_string}`, "query-input": "required name=search_term_string" } }],
}));

app.get(["/contact", "/contact.html"], (req, res) => renderPage(res, "contact.html", {
  title: `Contact & Visit Us — ${STORE.name}`,
  description: `Get in touch with ${STORE.name}${STORE.city ? `, ${STORE.city}` : ""}. Store address, opening hours, phone, and directions.`,
  canonical: BASE_URL + "/contact.html", ld: [localBusinessLd()],
}));

app.get(["/shop", "/shop.html"], h(async (req, res) => {
  let title = `Shop All — ${STORE.name}`, canonical = BASE_URL + "/shop.html";
  let description = `Shop the full ${STORE.name} collection — linen textiles, artisan lighting, hand-thrown ceramics, and reclaimed wood furniture.`;
  const catId = intIn(req.query.category, 1, 1e9);
  if (catId) {
    const [[c]] = await pool.query("SELECT name FROM categories WHERE id = ?", [catId]);
    if (c) { title = `${c.name} — ${STORE.name}`; description = `Shop ${c.name.toLowerCase()} at ${STORE.name}. ${STORE.tagline}`; canonical += `?category=${catId}`; }
  }
  renderPage(res, "shop.html", { title, description, canonical, image: "/images/hero.jpg" });
}));

// Old-style product links → permanent redirect to the clean URL (keeps any SEO they earned)
app.get("/product.html", h(async (req, res, next) => {
  const id = intIn(req.query.id, 1, 1e9);
  if (!id) return next();
  const [[p]] = await pool.query("SELECT id, slug FROM products WHERE id = ?", [id]);
  if (p && p.slug) return res.redirect(301, productPath(p));
  next();
}));

app.get("/product/:slug", h(async (req, res) => {
  const [[p]] = await pool.query(`
    SELECT p.*, c.name AS category, r.avg_rating, r.review_count
    FROM products p LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN (SELECT product_id, ROUND(AVG(rating),1) avg_rating, COUNT(*) review_count FROM reviews WHERE is_hidden = 0 GROUP BY product_id) r ON r.product_id = p.id
    WHERE p.slug = ? AND p.is_active = 1`, [req.params.slug]);
  if (!p) return renderPage(res, "404.html", { title: `Page not found — ${STORE.name}`, status: 404, noindex: true });
  const url = BASE_URL + productPath(p);
  const desc = p.meta_description || (p.description || "").slice(0, 155);
  const ld = {
    "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.description || desc,
    image: [absUrl(p.image_url)], sku: String(p.id), brand: { "@type": "Brand", name: STORE.name }, category: p.category || undefined,
    offers: { "@type": "Offer", url, priceCurrency: STORE.currency, price: Number(p.price).toFixed(2),
      availability: p.stock_qty > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", itemCondition: "https://schema.org/NewCondition" },
  };
  if (p.review_count > 0) ld.aggregateRating = { "@type": "AggregateRating", ratingValue: Number(p.avg_rating), reviewCount: Number(p.review_count) };
  const crumbs = { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [
    { "@type": "ListItem", position: 1, name: "Home", item: BASE_URL + "/" },
    { "@type": "ListItem", position: 2, name: "Shop", item: BASE_URL + "/shop.html" },
    { "@type": "ListItem", position: 3, name: p.name, item: url } ] };
  renderPage(res, "product.html", { title: p.meta_title || `${p.name} — ${STORE.name}`, description: desc, canonical: url, image: p.image_url, type: "product", ld: [ld, crumbs] });
}));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Disallow: /admin.html", "Disallow: /account.html", "Disallow: /cart.html", "Disallow: /checkout.html",
    "Disallow: /order-confirmation.html", "Disallow: /reset-password.html", "Disallow: /api/",
    "", `Sitemap: ${BASE_URL}/sitemap.xml`, ""].join("\n"));
});

app.get("/sitemap.xml", h(async (req, res) => {
  const [products] = await pool.query("SELECT id, slug, updated_at FROM products WHERE is_active = 1");
  const [cats] = await pool.query("SELECT id FROM categories");
  const urls = [
    { loc: "/", pr: "1.0" }, { loc: "/shop.html", pr: "0.9" }, { loc: "/contact.html", pr: "0.8" },
    { loc: "/shipping.html", pr: "0.3" }, { loc: "/returns.html", pr: "0.3" },
    ...cats.map((c) => ({ loc: `/shop.html?category=${c.id}`, pr: "0.7" })),
    ...products.map((p) => ({ loc: productPath(p), pr: "0.8", mod: p.updated_at })),
  ];
  const body = urls.map((u) => `  <url><loc>${esc(BASE_URL + u.loc)}</loc>${u.mod ? `<lastmod>${new Date(u.mod).toISOString().slice(0, 10)}</lastmod>` : ""}<priority>${u.pr}</priority></url>`).join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`);
}));

// Static files (only /public). Clean URLs: /shop → shop.html
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res, file) {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    else if (/[\\/](images|uploads)[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=604800");
    else res.setHeader("Cache-Control", "public, max-age=3600");
  },
}));

// ════════════════════════════════════════════════════════════
//  PUBLIC CONFIG
// ════════════════════════════════════════════════════════════
app.get("/api/config", (req, res) => {
  const { tax_rate, ...publicStore } = STORE;
  res.json({
    stripePublishableKey: stripe ? STRIPE_PUBLISHABLE_KEY || null : null,
    simulated: !stripe,
    store: { ...publicStore, tax_rate },
  });
});

// ════════════════════════════════════════════════════════════
//  PRODUCTS, CATEGORIES, REVIEWS
// ════════════════════════════════════════════════════════════
const RATING_JOIN = `
  LEFT JOIN (
    SELECT product_id, ROUND(AVG(rating),1) AS avg_rating, COUNT(*) AS review_count
    FROM reviews WHERE is_hidden = 0 GROUP BY product_id
  ) r ON r.product_id = p.id`;
const PRODUCT_SELECT = `SELECT p.id, p.name, p.price, p.description, p.category_id, p.image_url, p.is_featured, p.stock_qty,
  p.slug, p.created_at, c.name AS category, r.avg_rating, r.review_count
  FROM products p LEFT JOIN categories c ON p.category_id = c.id ${RATING_JOIN}`;

app.get("/api/products/featured", h(async (req, res) => {
  const [rows] = await pool.query(`${PRODUCT_SELECT} WHERE p.is_featured = 1 AND p.is_active = 1 ORDER BY p.id`);
  res.json(rows.map(toBool));
}));

app.get("/api/products", h(async (req, res) => {
  const { category_id, search, featured, sort, min_price, max_price, in_stock } = req.query;
  let sql = `${PRODUCT_SELECT} WHERE p.is_active = 1`;
  const args = [];
  if (intIn(category_id, 1, 1e9)) { sql += " AND p.category_id = ?"; args.push(Number(category_id)); }
  if (featured === "1") sql += " AND p.is_featured = 1";
  if (search) { sql += " AND (p.name LIKE ? OR p.description LIKE ?)"; const q = `%${str(search, 100)}%`; args.push(q, q); }
  if (min_price && !isNaN(min_price)) { sql += " AND p.price >= ?"; args.push(Number(min_price)); }
  if (max_price && !isNaN(max_price)) { sql += " AND p.price <= ?"; args.push(Number(max_price)); }
  if (in_stock === "1") sql += " AND p.stock_qty > 0";
  sql += ({ price_asc: " ORDER BY p.price ASC", price_desc: " ORDER BY p.price DESC",
            newest: " ORDER BY p.created_at DESC, p.id DESC", rating: " ORDER BY r.avg_rating IS NULL, r.avg_rating DESC" })[sort] || " ORDER BY p.is_featured DESC, p.id";
  const [rows] = await pool.query(sql, args);
  res.json(rows.map(toBool));
}));

// Accepts a numeric id or a slug
app.get("/api/products/:key", h(async (req, res) => {
  const key = req.params.key;
  const byId = /^\d+$/.test(key);
  const [rows] = await pool.query(`SELECT p.*, c.name AS category, r.avg_rating, r.review_count
    FROM products p LEFT JOIN categories c ON p.category_id = c.id ${RATING_JOIN}
    WHERE ${byId ? "p.id = ?" : "p.slug = ?"} AND p.is_active = 1`, [byId ? Number(key) : key]);
  if (!rows.length) return res.status(404).json({ error: "Product not found" });
  const p = rows[0];
  const [images] = await pool.query("SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order, id", [p.id]);
  const gallery = [...new Set([p.image_url, ...images.map((i) => i.image_url)].filter(Boolean))];
  res.json({ ...toBool(p), gallery });
}));

app.get("/api/products/:id/reviews", h(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT id, name, rating, comment, verified, created_at FROM reviews WHERE product_id = ? AND is_hidden = 0 ORDER BY created_at DESC LIMIT 100",
    [Number(req.params.id) || 0]);
  res.json(rows.map((r) => ({ ...r, verified: r.verified === 1 })));
}));

app.post("/api/products/:id/reviews", formLimiter, h(async (req, res) => {
  const productId = Number(req.params.id);
  const rating = intIn(req.body.rating, 1, 5);
  if (!rating) throw bad("Please choose a rating from 1 to 5 stars.");
  let name = str(req.body.name, 80) || (req.user ? req.user.name : "");
  if (!name) throw bad("Please enter your name.");
  const comment = str(req.body.comment, 2000);
  const [[product]] = await pool.query("SELECT id FROM products WHERE id = ? AND is_active = 1", [productId]);
  if (!product) throw new HttpError(404, "Product not found");

  let verified = 0;
  if (req.user) {
    const [[bought]] = await pool.query(`SELECT 1 AS ok FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.user_id = ? AND oi.product_id = ? AND o.payment_status = 'paid' LIMIT 1`, [req.user.id, productId]);
    verified = bought ? 1 : 0;
  }
  await pool.query("INSERT INTO reviews (product_id, user_id, name, rating, comment, verified) VALUES (?, ?, ?, ?, ?, ?)",
    [productId, req.user ? req.user.id : null, name, rating, comment, verified]);
  res.json({ success: true });
}));

app.get("/api/categories", h(async (req, res) => {
  const [rows] = await pool.query(`SELECT c.*, COUNT(p.id) AS product_count FROM categories c
    LEFT JOIN products p ON p.category_id = c.id AND p.is_active = 1 GROUP BY c.id ORDER BY c.name`);
  res.json(rows);
}));

app.get("/api/products-price-range", h(async (req, res) => {
  const [[r]] = await pool.query("SELECT MIN(price) AS min_price, MAX(price) AS max_price FROM products WHERE is_active = 1");
  res.json(r);
}));

// ════════════════════════════════════════════════════════════
//  CUSTOMER AUTH
// ════════════════════════════════════════════════════════════
const signUser = (u) => jwt.sign({ id: u.id, name: u.name, email: u.email }, USER_SECRET, { expiresIn: "14d" });

app.post("/api/auth/signup", authLimiter, h(async (req, res) => {
  const name = str(req.body.name, 120), email = str(req.body.email, 255).toLowerCase(), password = req.body.password;
  if (!name) throw bad("Please enter your name.");
  if (!EMAIL_RE.test(email)) throw bad("Please enter a valid email address.");
  if (typeof password !== "string" || password.length < 8 || password.length > 200) throw bad("Password must be at least 8 characters.");
  const [existing] = await pool.query("SELECT id FROM users WHERE email = ?", [email]);
  if (existing.length) throw new HttpError(409, "An account with that email already exists. Try signing in.");
  const hash = await bcrypt.hash(password, 12);
  const [r] = await pool.query("INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)", [name, email, hash]);
  const user = { id: r.insertId, name, email };
  res.json({ token: signUser(user), user });
}));

app.post("/api/auth/login", authLimiter, h(async (req, res) => {
  const email = str(req.body.email, 255).toLowerCase(), password = req.body.password;
  if (!email || typeof password !== "string") throw bad("Email and password are required.");
  const [[u]] = await pool.query("SELECT * FROM users WHERE email = ?", [email]);
  const ok = u && (await bcrypt.compare(password, u.password_hash));
  if (!ok) throw new HttpError(401, "Incorrect email or password.");
  const user = { id: u.id, name: u.name, email: u.email };
  res.json({ token: signUser(user), user });
}));

app.get("/api/auth/me", authRequired, (req, res) => res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email } }));

app.post("/api/auth/change-password", authRequired, authLimiter, h(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (typeof new_password !== "string" || new_password.length < 8) throw bad("New password must be at least 8 characters.");
  const [[u]] = await pool.query("SELECT password_hash FROM users WHERE id = ?", [req.user.id]);
  if (!u || !(await bcrypt.compare(String(current_password || ""), u.password_hash))) throw new HttpError(401, "Current password is incorrect.");
  await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(new_password, 12), req.user.id]);
  res.json({ success: true });
}));

app.post("/api/auth/forgot-password", authLimiter, h(async (req, res) => {
  const email = str(req.body.email, 255).toLowerCase();
  const generic = { success: true, message: "If an account exists for that email, a reset link is on its way." };
  if (!EMAIL_RE.test(email)) return res.json(generic);
  const [[u]] = await pool.query("SELECT id, name FROM users WHERE email = ?", [email]);
  if (u) {
    const token = crypto.randomBytes(32).toString("hex");
    const hash = crypto.createHash("sha256").update(token).digest("hex");
    await pool.query("INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))", [u.id, hash]);
    const link = `${BASE_URL}/reset-password.html?token=${token}`;
    sendMail(email, `Reset your ${STORE.name} password`, `
      <div style="font-family:sans-serif;color:#2A2621;max-width:520px">
        <p>Hi ${esc(u.name)},</p>
        <p>Someone asked to reset the password for your ${esc(STORE.name)} account. Click below to choose a new one. The link works for 1 hour.</p>
        <p><a href="${esc(link)}" style="display:inline-block;background:#B85A44;color:#fff;padding:12px 22px;border-radius:4px;text-decoration:none">Reset password</a></p>
        <p style="color:#6B6055;font-size:13px">If you didn't ask for this, you can ignore this email.</p>
      </div>`);
  }
  res.json(generic);
}));

app.post("/api/auth/reset-password", authLimiter, h(async (req, res) => {
  const { token, password } = req.body;
  if (typeof password !== "string" || password.length < 8) throw bad("Password must be at least 8 characters.");
  const hash = crypto.createHash("sha256").update(String(token || "")).digest("hex");
  const [[row]] = await pool.query("SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()", [hash]);
  if (!row) throw bad("This reset link is invalid or has expired. Please request a new one.");
  await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(password, 12), row.user_id]);
  await pool.query("UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL", [row.user_id]);
  const [[u]] = await pool.query("SELECT id, name, email FROM users WHERE id = ?", [row.user_id]);
  res.json({ success: true, token: signUser(u), user: u });
}));

// ── Addresses ────────────────────────────────────────────────
function readAddress(b) {
  const a = {
    full_name: str(b.full_name, 255), line1: str(b.line1, 255), line2: str(b.line2, 255), city: str(b.city, 120),
    state: str(b.state, 120), postal_code: str(b.postal_code, 30), country: str(b.country, 120), phone: str(b.phone, 40),
  };
  if (!a.full_name || !a.line1 || !a.city || !a.postal_code || !a.country) return null;
  return a;
}

app.get("/api/addresses", authRequired, h(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id DESC", [req.user.id]);
  res.json(rows);
}));

app.post("/api/addresses", authRequired, h(async (req, res) => {
  const a = readAddress(req.body);
  if (!a) throw bad("Full name, address, city, postal code, and country are required.");
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM addresses WHERE user_id = ?", [req.user.id]);
  const makeDefault = req.body.is_default || c === 0;
  if (makeDefault) await pool.query("UPDATE addresses SET is_default = 0 WHERE user_id = ?", [req.user.id]);
  const [r] = await pool.query(
    `INSERT INTO addresses (user_id, full_name, line1, line2, city, state, postal_code, country, phone, is_default) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, a.full_name, a.line1, a.line2 || null, a.city, a.state || null, a.postal_code, a.country, a.phone || null, makeDefault ? 1 : 0]);
  res.json({ id: r.insertId, success: true });
}));

app.post("/api/addresses/:id/default", authRequired, h(async (req, res) => {
  const [[a]] = await pool.query("SELECT id FROM addresses WHERE id = ? AND user_id = ?", [Number(req.params.id), req.user.id]);
  if (!a) throw new HttpError(404, "Address not found");
  await pool.query("UPDATE addresses SET is_default = (id = ?) WHERE user_id = ?", [a.id, req.user.id]);
  res.json({ success: true });
}));

app.delete("/api/addresses/:id", authRequired, h(async (req, res) => {
  await pool.query("DELETE FROM addresses WHERE id = ? AND user_id = ?", [Number(req.params.id), req.user.id]);
  res.json({ success: true });
}));

// ── Wishlist ─────────────────────────────────────────────────
app.get("/api/wishlist", authRequired, h(async (req, res) => {
  const [rows] = await pool.query(`
    SELECT w.product_id, p.name, p.price, p.image_url, p.stock_qty, p.slug, c.name AS category
    FROM wishlists w JOIN products p ON p.id = w.product_id LEFT JOIN categories c ON c.id = p.category_id
    WHERE w.user_id = ? AND p.is_active = 1 ORDER BY w.created_at DESC`, [req.user.id]);
  res.json(rows);
}));
app.post("/api/wishlist", authRequired, h(async (req, res) => {
  const pid = intIn(req.body.product_id, 1, 1e9);
  if (!pid) throw bad("product_id required");
  const [[p]] = await pool.query("SELECT id FROM products WHERE id = ?", [pid]);
  if (!p) throw new HttpError(404, "Product not found");
  await pool.query("INSERT IGNORE INTO wishlists (user_id, product_id) VALUES (?, ?)", [req.user.id, pid]);
  res.json({ success: true });
}));
app.delete("/api/wishlist/:productId", authRequired, h(async (req, res) => {
  await pool.query("DELETE FROM wishlists WHERE user_id = ? AND product_id = ?", [req.user.id, Number(req.params.productId)]);
  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
//  CART
// ════════════════════════════════════════════════════════════
async function loadCart(ident, db = pool) {
  if (!ident.user_id && !ident.session_id) return [];
  const w = cartWhere(ident, "ci");
  const [rows] = await db.query(`
    SELECT ci.id, ci.product_id, ci.quantity, p.name, p.price, p.image_url, p.stock_qty, p.slug, c.name AS category
    FROM cart_items ci JOIN products p ON ci.product_id = p.id AND p.is_active = 1
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE ${w.sql} ORDER BY ci.created_at DESC, ci.id DESC`, [w.arg]);
  return rows;
}

// Loads a cart row only if it belongs to the caller (fixes: anyone could edit/delete any cart line by id)
async function ownedCartItem(req) {
  const ident = cartIdentity(req);
  const [[item]] = await pool.query(
    "SELECT ci.*, p.stock_qty FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.id = ?", [Number(req.params.id) || 0]);
  const owns = item && (ident.user_id ? item.user_id === ident.user_id : item.user_id === null && ident.session_id && item.session_id === ident.session_id);
  if (!owns) throw new HttpError(404, "Cart item not found");
  return item;
}

app.get("/api/cart", h(async (req, res) => {
  const ident = cartIdentity(req);
  if (!ident.session_id && !ident.user_id) return res.json([]);
  res.json(await loadCart(ident));
}));

app.post("/api/cart", h(async (req, res) => {
  const ident = cartIdentity(req);
  const pid = intIn(req.body.product_id, 1, 1e9), qty = intIn(req.body.quantity ?? 1, 1, 99);
  if (!ident.session_id && !ident.user_id) throw bad("Missing cart session — please refresh the page.");
  if (!pid || !qty) throw bad("Invalid product or quantity.");
  const [[product]] = await pool.query("SELECT stock_qty, name FROM products WHERE id = ? AND is_active = 1", [pid]);
  if (!product) throw new HttpError(404, "Product not found");
  const w = cartWhere(ident);
  const [[existing]] = await pool.query(`SELECT id, quantity FROM cart_items WHERE ${w.sql} AND product_id = ?`, [w.arg, pid]);
  const current = existing ? existing.quantity : 0;
  if (current + qty > product.stock_qty) {
    throw bad(product.stock_qty - current > 0 ? `Only ${product.stock_qty - current} more available.` : `${product.name} is out of stock${current ? " (you already have the last ones in your cart)" : ""}.`);
  }
  if (existing) await pool.query("UPDATE cart_items SET quantity = quantity + ? WHERE id = ?", [qty, existing.id]);
  else await pool.query("INSERT INTO cart_items (session_id, user_id, product_id, quantity) VALUES (?, ?, ?, ?)",
    [ident.session_id || `user-${ident.user_id}`, ident.user_id, pid, qty]);
  res.json({ success: true });
}));

app.put("/api/cart/:id", h(async (req, res) => {
  const qty = intIn(req.body.quantity, 1, 99);
  if (!qty) throw bad("Quantity must be between 1 and 99.");
  const item = await ownedCartItem(req);
  if (qty > item.stock_qty) throw bad(`Only ${item.stock_qty} in stock.`);
  await pool.query("UPDATE cart_items SET quantity = ? WHERE id = ?", [qty, item.id]);
  res.json({ success: true });
}));

app.delete("/api/cart/:id", h(async (req, res) => {
  const item = await ownedCartItem(req);
  await pool.query("DELETE FROM cart_items WHERE id = ?", [item.id]);
  res.json({ success: true });
}));

app.post("/api/cart/merge", authRequired, h(async (req, res) => {
  const { session_id } = cartIdentity(req);
  if (!session_id) return res.json({ success: true });
  const [guestItems] = await pool.query(
    "SELECT ci.*, p.stock_qty FROM cart_items ci JOIN products p ON p.id = ci.product_id WHERE ci.session_id = ? AND ci.user_id IS NULL", [session_id]);
  for (const item of guestItems) {
    const [[existing]] = await pool.query("SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?", [req.user.id, item.product_id]);
    if (existing) {
      await pool.query("UPDATE cart_items SET quantity = ? WHERE id = ?", [Math.min(existing.quantity + item.quantity, item.stock_qty), existing.id]);
      await pool.query("DELETE FROM cart_items WHERE id = ?", [item.id]);
    } else {
      await pool.query("UPDATE cart_items SET user_id = ? WHERE id = ?", [req.user.id, item.id]);
    }
  }
  res.json({ success: true });
}));

// ════════════════════════════════════════════════════════════
//  PROMO CODES + TOTALS (single source of truth for all money math)
// ════════════════════════════════════════════════════════════
async function evaluatePromo(code, subtotal, db = pool) {
  code = str(code, 60).toUpperCase();
  if (!code) return { valid: false, message: "" };
  const [[p]] = await db.query(
    "SELECT * FROM discount_codes WHERE code = ? AND active = 1 AND (expires_at IS NULL OR expires_at >= CURDATE())", [code]);
  if (!p) return { valid: false, message: "That code is not valid or has expired." };
  if (p.max_uses !== null && p.used_count >= p.max_uses) return { valid: false, message: "That code has reached its usage limit." };
  if (subtotal < Number(p.min_subtotal)) return { valid: false, message: `This code needs a subtotal of at least ${money(p.min_subtotal)}.` };
  const discount = p.type === "percent" ? round2(subtotal * (Number(p.value) / 100))
                 : p.type === "fixed" ? Math.min(Number(p.value), subtotal) : 0;
  return { valid: true, id: p.id, code: p.code, type: p.type, value: Number(p.value), discount_amount: discount, free_shipping: p.type === "free_shipping" };
}

function computeTotals(items, discount) {
  const subtotal = round2(items.reduce((s, i) => s + Number(i.price) * i.quantity, 0));
  const discount_amount = discount && discount.valid ? round2(Math.min(discount.discount_amount, subtotal)) : 0;
  const afterDiscount = round2(subtotal - discount_amount);
  let shipping_amount = !items.length || afterDiscount >= STORE.free_shipping_threshold ? 0 : STORE.shipping_flat;
  if (discount && discount.valid && discount.free_shipping) shipping_amount = 0;
  const tax_amount = round2(afterDiscount * (STORE.tax_rate / 100));
  return { subtotal, discount_amount, shipping_amount: round2(shipping_amount), tax_amount, total: round2(afterDiscount + shipping_amount + tax_amount),
           currency: STORE.currency, free_shipping_threshold: STORE.free_shipping_threshold };
}

// Validate a code against the caller's real cart (falls back to a supplied subtotal)
app.post("/api/promo/validate", promoLimiter, h(async (req, res) => {
  const items = await loadCart(cartIdentity(req));
  const subtotal = items.length ? items.reduce((s, i) => s + Number(i.price) * i.quantity, 0) : Number(req.body.subtotal) || 0;
  const { id, ...result } = await evaluatePromo(req.body.code, subtotal);
  res.json(result);
}));

// Cart + server-computed totals, used by the cart and checkout pages
app.post("/api/cart/totals", h(async (req, res) => {
  const items = await loadCart(cartIdentity(req));
  const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = req.body.discount_code ? await evaluatePromo(req.body.discount_code, subtotal) : { valid: false, message: "" };
  delete discount.id;
  res.json({ items, totals: computeTotals(items, discount), discount });
}));

// ════════════════════════════════════════════════════════════
//  CHECKOUT
// ════════════════════════════════════════════════════════════
const minorUnits = (amount) => Math.round(Number(amount) * 100);

// Step 1: create (or simulate) a payment for the current cart
app.post("/api/checkout/intent", checkoutLimiter, h(async (req, res) => {
  const ident = cartIdentity(req);
  const items = await loadCart(ident);
  if (!items.length) throw bad("Your cart is empty.");
  for (const i of items) if (i.quantity > i.stock_qty) throw bad(`${i.name} only has ${i.stock_qty} in stock — please update your cart.`);
  const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = req.body.discount_code ? await evaluatePromo(req.body.discount_code, subtotal) : { valid: false };
  const totals = computeTotals(items, discount);
  if (!stripe) return res.json({ simulated: true, paymentIntentId: null, totals });

  const intent = await stripe.paymentIntents.create({
    amount: minorUnits(totals.total), currency: STORE.currency.toLowerCase(), payment_method_types: ["card"],
    receipt_email: EMAIL_RE.test(str(req.body.email)) ? str(req.body.email) : undefined,
    metadata: { session_id: ident.session_id || "", user_id: ident.user_id ? String(ident.user_id) : "", total: String(totals.total) },
  });
  res.json({ simulated: false, clientSecret: intent.client_secret, paymentIntentId: intent.id, totals });
}));

// Step 2: create the order once payment has succeeded (or in simulated mode)
app.post("/api/checkout/complete", checkoutLimiter, h(async (req, res) => {
  const ident = cartIdentity(req);
  const email = str(req.body.email, 255).toLowerCase();
  const ship = readAddress(req.body.shipping || {});
  if (!EMAIL_RE.test(email)) throw bad("Please enter a valid email address.");
  if (!ship) throw bad("Please complete your shipping address.");
  const discountCode = str(req.body.discount_code, 60);

  // ── Verify payment (fixes: with Stripe on, sending "sim_…" used to create a paid order for free)
  let paymentMode = "simulated", intent = null, paymentRef = null;
  if (stripe) {
    const piId = str(req.body.payment_intent_id, 255);
    if (!piId.startsWith("pi_")) throw new HttpError(402, "Payment is required to place this order.");
    const [[already]] = await pool.query("SELECT order_number FROM orders WHERE payment_intent_id = ?", [piId]);
    if (already) return res.json({ success: true, order_number: already.order_number }); // double-click / retry
    intent = await stripe.paymentIntents.retrieve(piId);
    if (intent.status !== "succeeded") throw new HttpError(402, "Payment has not completed yet.");
    paymentMode = "stripe"; paymentRef = piId;
  } else {
    paymentRef = "sim_" + crypto.randomBytes(8).toString("hex");
  }

  const refundIfPaid = async (reason) => {
    if (intent) { try { await stripe.refunds.create({ payment_intent: intent.id }); } catch (e) { console.error("Auto-refund failed:", e.message); } }
    return new HttpError(409, reason + (intent ? " Your payment has been refunded automatically." : ""));
  };

  const conn = await pool.getConnection();
  let order_number, totals, items;
  try {
    await conn.beginTransaction();
    items = await loadCart(ident, conn);
    if (!items.length) { await conn.rollback(); throw await refundIfPaid("Your cart is empty."); }

    for (const i of items) {
      const [[fresh]] = await conn.query("SELECT stock_qty FROM products WHERE id = ? FOR UPDATE", [i.product_id]);
      if (!fresh || fresh.stock_qty < i.quantity) { await conn.rollback(); throw await refundIfPaid(`${i.name} no longer has enough stock.`); }
    }

    const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const discount = discountCode ? await evaluatePromo(discountCode, subtotal, conn) : { valid: false };
    totals = computeTotals(items, discount);

    if (intent && (intent.amount !== minorUnits(totals.total) || intent.currency !== STORE.currency.toLowerCase())) {
      await conn.rollback();
      throw await refundIfPaid("Your cart changed during checkout, so the amount paid didn't match.");
    }

    order_number = orderNumber();
    const [orderResult] = await conn.query(`
      INSERT INTO orders (order_number, user_id, session_id, email, status, subtotal, discount_code, discount_amount,
        shipping_amount, tax_amount, total, currency, shipping_full_name, shipping_line1, shipping_line2, shipping_city,
        shipping_state, shipping_postal_code, shipping_country, shipping_phone, payment_status, payment_intent_id, payment_mode)
      VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?)`,
      [order_number, ident.user_id, ident.session_id, email, totals.subtotal, discount.valid ? discount.code : null, totals.discount_amount,
       totals.shipping_amount, totals.tax_amount, totals.total, STORE.currency, ship.full_name, ship.line1, ship.line2 || null, ship.city,
       ship.state || null, ship.postal_code, ship.country, ship.phone || null, paymentRef, paymentMode]);
    const orderId = orderResult.insertId;

    for (const it of items) {
      await conn.query("INSERT INTO order_items (order_id, product_id, name, price, quantity, image_url) VALUES (?, ?, ?, ?, ?, ?)",
        [orderId, it.product_id, it.name, it.price, it.quantity, it.image_url]);
      await conn.query("UPDATE products SET stock_qty = stock_qty - ? WHERE id = ?", [it.quantity, it.product_id]);
    }
    if (discount.valid) await conn.query("UPDATE discount_codes SET used_count = used_count + 1 WHERE id = ?", [discount.id]);

    if (ident.user_id && req.body.save_address) {
      const [[dup]] = await conn.query("SELECT id FROM addresses WHERE user_id = ? AND line1 = ? AND postal_code = ?", [ident.user_id, ship.line1, ship.postal_code]);
      if (!dup) await conn.query(`INSERT INTO addresses (user_id, full_name, line1, line2, city, state, postal_code, country, phone) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ident.user_id, ship.full_name, ship.line1, ship.line2 || null, ship.city, ship.state || null, ship.postal_code, ship.country, ship.phone || null]);
    }
    const w = cartWhere(ident);
    await conn.query(`DELETE FROM cart_items WHERE ${w.sql}`, [w.arg]);
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch {}
    throw e;
  } finally { conn.release(); }

  // Emails are sent after the response so a slow SMTP server never blocks checkout
  res.json({ success: true, order_number, total: totals.total });
  const viewUrl = `${BASE_URL}/order-confirmation.html?order=${encodeURIComponent(order_number)}&email=${encodeURIComponent(email)}`;
  sendMail(email, `Order confirmed — ${order_number}`, orderEmailHtml({ order_number, items, totals, ship, viewUrl }));
  sendMail(NOTIFY_EMAIL, `🛍️ New order ${order_number} — ${money(totals.total)}`,
    `<p>New order <b>${esc(order_number)}</b> from ${esc(email)} for <b>${esc(money(totals.total))}</b>.</p>
     <p>${items.map((i) => `${esc(i.name)} × ${i.quantity}`).join("<br/>")}</p><p><a href="${BASE_URL}/admin.html">Open admin dashboard</a></p>`);
}));

function orderEmailHtml({ order_number, items, totals, ship, viewUrl }) {
  const rows = items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)} × ${i.quantity}</td><td style="padding:6px 0;text-align:right">${esc(money(i.price * i.quantity))}</td></tr>`).join("");
  const line = (label, v) => `<tr><td style="padding:3px 0;color:#6B6055">${label}</td><td style="text-align:right">${v}</td></tr>`;
  return `
  <div style="font-family:Helvetica,Arial,sans-serif;color:#2A2621;max-width:540px;margin:auto">
    <h2 style="font-family:Georgia,serif;font-weight:normal">Thank you for your order!</h2>
    <p>Your order <strong>${esc(order_number)}</strong> is confirmed. We'll email you again when it ships.</p>
    <table style="width:100%;border-collapse:collapse;margin:16px 0;border-top:1px solid #E8E2D9;border-bottom:1px solid #E8E2D9">${rows}</table>
    <table style="width:100%;border-collapse:collapse">
      ${line("Subtotal", esc(money(totals.subtotal)))}
      ${totals.discount_amount > 0 ? line("Discount", "-" + esc(money(totals.discount_amount))) : ""}
      ${line("Shipping", totals.shipping_amount ? esc(money(totals.shipping_amount)) : "Free")}
      ${totals.tax_amount > 0 ? line(esc(STORE.tax_label), esc(money(totals.tax_amount))) : ""}
      <tr><td style="padding-top:8px"><strong>Total</strong></td><td style="text-align:right;padding-top:8px"><strong>${esc(money(totals.total))}</strong></td></tr>
    </table>
    <p style="margin-top:20px"><strong>Shipping to</strong><br/>${esc(ship.full_name)}<br/>${esc(ship.line1)}${ship.line2 ? "<br/>" + esc(ship.line2) : ""}<br/>${esc(ship.city)}, ${esc(ship.state)} ${esc(ship.postal_code)}<br/>${esc(ship.country)}</p>
    <p><a href="${esc(viewUrl)}">View your order online</a></p>
    <p style="color:#6B6055;font-size:13px">Questions? Just reply to this email${STORE.phone ? ` or call us on ${esc(STORE.phone)}` : ""}.<br/>— ${esc(STORE.name)}</p>
  </div>`;
}

// ── Orders (customer) ────────────────────────────────────────
const PUBLIC_ORDER_FIELDS = (o) => {
  const { session_id, payment_intent_id, user_id, admin_note, ...rest } = o;
  return rest;
};
async function attachItems(orders) {
  if (!orders.length) return orders;
  const [items] = await pool.query("SELECT * FROM order_items WHERE order_id IN (?)", [orders.map((o) => o.id)]);
  orders.forEach((o) => (o.items = items.filter((i) => i.order_id === o.id)));
  return orders;
}

app.get("/api/orders", authRequired, h(async (req, res) => {
  const [orders] = await pool.query("SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC", [req.user.id]);
  res.json((await attachItems(orders)).map(PUBLIC_ORDER_FIELDS));
}));

// Look up one order. Allowed for the account that placed it, or with the
// matching email (fixes: previously anyone with an order number saw the
// customer's name and home address).
app.get("/api/orders/:orderNumber", formLimiter, h(async (req, res) => {
  const [[order]] = await pool.query("SELECT * FROM orders WHERE order_number = ?", [str(req.params.orderNumber, 40)]);
  const email = str(req.query.email, 255).toLowerCase();
  const allowed = order && ((req.user && req.user.id === order.user_id) || (email && order.email.toLowerCase() === email));
  if (!allowed) throw new HttpError(404, "We couldn't find an order with those details.");
  await attachItems([order]);
  res.json(PUBLIC_ORDER_FIELDS(order));
}));

// ════════════════════════════════════════════════════════════
//  NEWSLETTER + CONTACT
// ════════════════════════════════════════════════════════════
app.post("/api/newsletter", formLimiter, h(async (req, res) => {
  const email = str(req.body.email, 255).toLowerCase();
  if (!EMAIL_RE.test(email)) throw bad("Please enter a valid email address.");
  await pool.query("INSERT IGNORE INTO newsletter_subscribers (email) VALUES (?)", [email]);
  res.json({ success: true, message: "You're on the list — thank you!" });
}));

app.post("/api/contact", formLimiter, h(async (req, res) => {
  if (req.body.website) return res.json({ success: true }); // honeypot field — bots fill it, people don't see it
  const name = str(req.body.name, 120), email = str(req.body.email, 255).toLowerCase(), phone = str(req.body.phone, 40);
  const subject = str(req.body.subject, 200), message = str(req.body.message, 5000);
  if (!name) throw bad("Please enter your name.");
  if (!EMAIL_RE.test(email)) throw bad("Please enter a valid email address.");
  if (message.length < 5) throw bad("Please write a short message.");
  await pool.query("INSERT INTO contact_messages (name, email, phone, subject, message) VALUES (?, ?, ?, ?, ?)", [name, email, phone || null, subject || null, message]);
  res.json({ success: true, message: "Thanks — we'll get back to you within one business day." });
  sendMail(NOTIFY_EMAIL, `New enquiry from ${name}${subject ? ": " + subject : ""}`,
    `<p><b>${esc(name)}</b> &lt;${esc(email)}&gt;${phone ? " · " + esc(phone) : ""}</p><p style="white-space:pre-wrap">${esc(message)}</p>`);
}));

// ════════════════════════════════════════════════════════════
//  ADMIN
// ════════════════════════════════════════════════════════════
app.post("/api/admin/login", authLimiter, h(async (req, res) => {
  const username = str(req.body.username, 120), password = String(req.body.password || "");
  const [[admin]] = await pool.query("SELECT * FROM admin_users WHERE username = ?", [username]);
  if (!admin || !(await bcrypt.compare(password, admin.password_hash))) throw new HttpError(401, "Invalid username or password.");
  const token = jwt.sign({ id: admin.id, username: admin.username, role: "admin" }, ADMIN_SECRET, { expiresIn: "12h" });
  res.json({ token, username: admin.username });
}));

app.post("/api/admin/change-password", adminRequired, h(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (typeof new_password !== "string" || new_password.length < 10) throw bad("New password must be at least 10 characters.");
  const [[admin]] = await pool.query("SELECT * FROM admin_users WHERE id = ?", [req.admin.id]);
  if (!(await bcrypt.compare(String(current_password || ""), admin.password_hash))) throw new HttpError(401, "Current password is incorrect.");
  await pool.query("UPDATE admin_users SET password_hash = ? WHERE id = ?", [await bcrypt.hash(new_password, 12), req.admin.id]);
  res.json({ success: true });
}));

app.get("/api/admin/stats", adminRequired, h(async (req, res) => {
  const [[o]] = await pool.query(`SELECT COUNT(*) AS order_count, COALESCE(SUM(total),0) AS revenue,
      COALESCE(SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN total END),0) AS revenue_30d,
      SUM(CASE WHEN status IN ('paid','processing') THEN 1 ELSE 0 END) AS to_ship
    FROM orders WHERE payment_status = 'paid' AND status <> 'cancelled'`);
  const [[low]] = await pool.query("SELECT COUNT(*) AS c FROM products WHERE stock_qty < 10 AND stock_qty > 0 AND is_active = 1");
  const [[out]] = await pool.query("SELECT COUNT(*) AS c FROM products WHERE stock_qty <= 0 AND is_active = 1");
  const [[msgs]] = await pool.query("SELECT COUNT(*) AS c FROM contact_messages WHERE is_read = 0");
  const [[subs]] = await pool.query("SELECT COUNT(*) AS c FROM newsletter_subscribers");
  const [[cust]] = await pool.query("SELECT COUNT(*) AS c FROM users");
  const [top] = await pool.query(`SELECT oi.name, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price) AS sales
    FROM order_items oi JOIN orders ord ON ord.id = oi.order_id WHERE ord.payment_status = 'paid' AND ord.status <> 'cancelled'
    GROUP BY oi.name ORDER BY sales DESC LIMIT 5`);
  res.json({
    order_count: Number(o.order_count), revenue: Number(o.revenue), revenue_30d: Number(o.revenue_30d), to_ship: Number(o.to_ship || 0),
    low_stock_count: low.c, out_of_stock_count: out.c, unread_messages: msgs.c, subscribers: subs.c, customers: cust.c,
    top_products: top.map((t) => ({ ...t, units: Number(t.units), sales: Number(t.sales) })), currency: STORE.currency,
  });
}));

app.get("/api/admin/orders", adminRequired, h(async (req, res) => {
  let sql = "SELECT id, order_number, email, status, payment_status, payment_mode, total, shipping_full_name, created_at FROM orders WHERE 1=1";
  const args = [];
  if (req.query.status) { sql += " AND status = ?"; args.push(str(req.query.status, 20)); }
  if (req.query.q) { sql += " AND (order_number LIKE ? OR email LIKE ? OR shipping_full_name LIKE ?)"; const q = `%${str(req.query.q, 100)}%`; args.push(q, q, q); }
  sql += " ORDER BY created_at DESC LIMIT 300";
  const [orders] = await pool.query(sql, args);
  res.json(orders);
}));

app.get("/api/admin/orders/:id", adminRequired, h(async (req, res) => {
  const [[order]] = await pool.query("SELECT * FROM orders WHERE id = ?", [Number(req.params.id)]);
  if (!order) throw new HttpError(404, "Not found");
  await attachItems([order]);
  res.json(order);
}));

const ORDER_STATUSES = ["pending", "paid", "processing", "shipped", "completed", "cancelled"];
app.patch("/api/admin/orders/:id", adminRequired, h(async (req, res) => {
  const id = Number(req.params.id);
  const [[order]] = await pool.query("SELECT * FROM orders WHERE id = ?", [id]);
  if (!order) throw new HttpError(404, "Not found");
  const status = req.body.status !== undefined ? str(req.body.status, 20) : order.status;
  if (!ORDER_STATUSES.includes(status)) throw bad("Invalid status");
  const carrier = req.body.carrier !== undefined ? str(req.body.carrier, 80) : order.carrier;
  const tracking = req.body.tracking_number !== undefined ? str(req.body.tracking_number, 120) : order.tracking_number;
  const note = req.body.admin_note !== undefined ? str(req.body.admin_note, 2000) : order.admin_note;
  if (order.status === "cancelled" && status !== "cancelled") throw bad("Cancelled orders can't be reopened (stock was already returned).");

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("UPDATE orders SET status = ?, carrier = ?, tracking_number = ?, admin_note = ? WHERE id = ?", [status, carrier || null, tracking || null, note || null, id]);
    if (status === "cancelled" && order.status !== "cancelled") {
      const [items] = await conn.query("SELECT product_id, quantity FROM order_items WHERE order_id = ? AND product_id IS NOT NULL", [id]);
      for (const it of items) await conn.query("UPDATE products SET stock_qty = stock_qty + ? WHERE id = ?", [it.quantity, it.product_id]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }

  if (status !== order.status && req.body.notify !== false) {
    if (status === "shipped") {
      sendMail(order.email, `Your order ${order.order_number} has shipped`, `
        <div style="font-family:sans-serif;color:#2A2621;max-width:520px">
          <h2 style="font-family:Georgia,serif;font-weight:normal">Your order is on its way</h2>
          <p>Good news — order <b>${esc(order.order_number)}</b> has shipped${carrier ? ` with ${esc(carrier)}` : ""}.</p>
          ${tracking ? `<p>Tracking number: <b>${esc(tracking)}</b></p>` : ""}
          <p><a href="${BASE_URL}/order-confirmation.html?order=${encodeURIComponent(order.order_number)}&email=${encodeURIComponent(order.email)}">View your order</a></p>
          <p>— ${esc(STORE.name)}</p></div>`);
    } else if (status === "cancelled") {
      sendMail(order.email, `Your order ${order.order_number} was cancelled`,
        `<p>Order <b>${esc(order.order_number)}</b> has been cancelled. If you were charged, your refund will appear on your original payment method within 5–10 business days. Questions? Just reply to this email.</p><p>— ${esc(STORE.name)}</p>`);
    }
  }
  res.json({ success: true });
}));

app.post("/api/admin/orders/:id/refund", adminRequired, h(async (req, res) => {
  const [[order]] = await pool.query("SELECT * FROM orders WHERE id = ?", [Number(req.params.id)]);
  if (!order) throw new HttpError(404, "Not found");
  if (order.payment_status !== "paid") throw bad("Only paid orders can be refunded.");
  if (order.payment_mode === "stripe") {
    if (!stripe) throw bad("Stripe is not configured on this server.");
    await stripe.refunds.create({ payment_intent: order.payment_intent_id });
  }
  await pool.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [order.id]);
  res.json({ success: true, mode: order.payment_mode });
}));

// ── Products (admin) ─────────────────────────────────────────
function readProduct(b) {
  const p = {
    name: str(b.name, 255), price: Number(b.price), description: str(b.description, 10000),
    category_id: intIn(b.category_id, 1, 1e9), image_url: str(b.image_url, 500), is_featured: b.is_featured ? 1 : 0,
    is_active: b.is_active === false || b.is_active === 0 ? 0 : 1, stock_qty: Math.max(0, Math.floor(Number(b.stock_qty) || 0)),
    slug: slugify(str(b.slug, 200) || str(b.name, 200)), meta_title: str(b.meta_title, 255) || null, meta_description: str(b.meta_description, 500) || null,
  };
  if (!p.name) throw bad("Product name is required.");
  if (!(p.price > 0)) throw bad("Price must be greater than 0.");
  const gallery = Array.isArray(b.gallery) ? b.gallery.map((u) => str(u, 500)).filter(Boolean).slice(0, 12) : null;
  return { p, gallery };
}
async function uniqueSlug(slug, exceptId = 0) {
  let s = slug, n = 2;
  while (true) {
    const [[hit]] = await pool.query("SELECT id FROM products WHERE slug = ? AND id <> ?", [s, exceptId]);
    if (!hit) return s;
    s = `${slug}-${n++}`;
  }
}
async function saveGallery(productId, gallery) {
  if (!gallery) return;
  await pool.query("DELETE FROM product_images WHERE product_id = ?", [productId]);
  for (const [i, url] of gallery.entries()) await pool.query("INSERT IGNORE INTO product_images (product_id, image_url, sort_order) VALUES (?, ?, ?)", [productId, url, i + 1]);
}

app.get("/api/admin/products", adminRequired, h(async (req, res) => {
  const [rows] = await pool.query("SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON p.category_id = c.id ORDER BY p.id DESC");
  const [imgs] = await pool.query("SELECT product_id, image_url FROM product_images ORDER BY sort_order, id");
  res.json(rows.map((r) => ({ ...toBool(r), gallery: imgs.filter((i) => i.product_id === r.id).map((i) => i.image_url) })));
}));

app.post("/api/admin/products", adminRequired, h(async (req, res) => {
  const { p, gallery } = readProduct(req.body);
  p.slug = await uniqueSlug(p.slug);
  const [r] = await pool.query(`INSERT INTO products (name, price, description, category_id, image_url, is_featured, is_active, stock_qty, slug, meta_title, meta_description)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [p.name, p.price, p.description, p.category_id, p.image_url, p.is_featured, p.is_active, p.stock_qty, p.slug, p.meta_title, p.meta_description]);
  await saveGallery(r.insertId, gallery);
  res.json({ id: r.insertId, slug: p.slug, success: true });
}));

app.put("/api/admin/products/:id", adminRequired, h(async (req, res) => {
  const id = Number(req.params.id);
  const { p, gallery } = readProduct(req.body);
  p.slug = await uniqueSlug(p.slug, id);
  await pool.query(`UPDATE products SET name=?, price=?, description=?, category_id=?, image_url=?, is_featured=?, is_active=?, stock_qty=?, slug=?, meta_title=?, meta_description=? WHERE id=?`,
    [p.name, p.price, p.description, p.category_id, p.image_url, p.is_featured, p.is_active, p.stock_qty, p.slug, p.meta_title, p.meta_description, id]);
  await saveGallery(id, gallery);
  res.json({ success: true, slug: p.slug });
}));

app.delete("/api/admin/products/:id", adminRequired, h(async (req, res) => {
  await pool.query("DELETE FROM products WHERE id = ?", [Number(req.params.id)]);
  res.json({ success: true });
}));

// Image upload: JSON { filename, data: "data:image/jpeg;base64,..." } → /uploads/xxx.jpg
app.post("/api/admin/uploads", adminRequired, h(async (req, res) => {
  const m = /^data:(image\/(png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.data || ""));
  if (!m) throw bad("Please upload a PNG, JPG, WEBP or GIF image.");
  const buf = Buffer.from(m[3], "base64");
  if (buf.length > 5 * 1024 * 1024) throw bad("Image must be under 5 MB.");
  const sig = buf.subarray(0, 12).toString("hex");
  const real = sig.startsWith("89504e47") ? "png" : sig.startsWith("ffd8ff") ? "jpg" : sig.startsWith("47494638") ? "gif" : (sig.startsWith("52494646") && buf.subarray(8, 12).toString() === "WEBP") ? "webp" : null;
  if (!real) throw bad("That file doesn't look like a valid image.");
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const base = slugify(String(req.body.filename || "image").replace(/\.[^.]+$/, "")).slice(0, 40);
  const name = `${base}-${crypto.randomBytes(4).toString("hex")}.${real}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.json({ url: `/uploads/${name}` });
}));

// ── Categories (admin) ───────────────────────────────────────
app.post("/api/admin/categories", adminRequired, h(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw bad("Category name is required.");
  const [r] = await pool.query("INSERT INTO categories (name, slug, image_url) VALUES (?, ?, ?)", [name, slugify(name), str(req.body.image_url, 500) || null]);
  res.json({ id: r.insertId, success: true });
}));
app.put("/api/admin/categories/:id", adminRequired, h(async (req, res) => {
  const name = str(req.body.name, 100);
  if (!name) throw bad("Category name is required.");
  await pool.query("UPDATE categories SET name = ?, slug = ?, image_url = ? WHERE id = ?", [name, slugify(name), str(req.body.image_url, 500) || null, Number(req.params.id)]);
  res.json({ success: true });
}));
app.delete("/api/admin/categories/:id", adminRequired, h(async (req, res) => {
  await pool.query("DELETE FROM categories WHERE id = ?", [Number(req.params.id)]);
  res.json({ success: true });
}));

// ── Discount codes (admin) ───────────────────────────────────
function readPromo(b) {
  const p = {
    code: str(b.code, 60).toUpperCase().replace(/\s+/g, ""), type: ["percent", "fixed", "free_shipping"].includes(b.type) ? b.type : "percent",
    value: Math.max(0, Number(b.value) || 0), min_subtotal: Math.max(0, Number(b.min_subtotal) || 0),
    max_uses: b.max_uses === "" || b.max_uses == null ? null : Math.max(0, Math.floor(Number(b.max_uses))),
    active: b.active === false || b.active === 0 ? 0 : 1, expires_at: /^\d{4}-\d{2}-\d{2}$/.test(b.expires_at || "") ? b.expires_at : null,
  };
  if (!/^[A-Z0-9_-]{3,60}$/.test(p.code)) throw bad("Code must be 3–60 letters, numbers, - or _.");
  if (p.type === "percent" && (p.value <= 0 || p.value > 100)) throw bad("Percent must be between 1 and 100.");
  if (p.type === "fixed" && p.value <= 0) throw bad("Amount must be greater than 0.");
  return p;
}
app.get("/api/admin/discounts", adminRequired, h(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM discount_codes ORDER BY created_at DESC");
  res.json(rows);
}));
app.post("/api/admin/discounts", adminRequired, h(async (req, res) => {
  const p = readPromo(req.body);
  try {
    await pool.query("INSERT INTO discount_codes (code, type, value, min_subtotal, max_uses, active, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [p.code, p.type, p.value, p.min_subtotal, p.max_uses, p.active, p.expires_at]);
  } catch (e) { if (e.code === "ER_DUP_ENTRY") throw bad("That code already exists."); throw e; }
  res.json({ success: true });
}));
app.put("/api/admin/discounts/:id", adminRequired, h(async (req, res) => {
  const p = readPromo(req.body);
  await pool.query("UPDATE discount_codes SET code=?, type=?, value=?, min_subtotal=?, max_uses=?, active=?, expires_at=? WHERE id=?",
    [p.code, p.type, p.value, p.min_subtotal, p.max_uses, p.active, p.expires_at, Number(req.params.id)]);
  res.json({ success: true });
}));
app.delete("/api/admin/discounts/:id", adminRequired, h(async (req, res) => {
  await pool.query("DELETE FROM discount_codes WHERE id = ?", [Number(req.params.id)]);
  res.json({ success: true });
}));

// ── Messages, reviews, subscribers, customers (admin) ────────
app.get("/api/admin/messages", adminRequired, h(async (req, res) => {
  const [rows] = await pool.query("SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 300");
  res.json(rows);
}));
app.patch("/api/admin/messages/:id", adminRequired, h(async (req, res) => {
  await pool.query("UPDATE contact_messages SET is_read = ? WHERE id = ?", [req.body.is_read ? 1 : 0, Number(req.params.id)]);
  res.json({ success: true });
}));
app.delete("/api/admin/messages/:id", adminRequired, h(async (req, res) => {
  await pool.query("DELETE FROM contact_messages WHERE id = ?", [Number(req.params.id)]);
  res.json({ success: true });
}));

app.get("/api/admin/reviews", adminRequired, h(async (req, res) => {
  const [rows] = await pool.query(`SELECT r.*, p.name AS product_name FROM reviews r JOIN products p ON p.id = r.product_id ORDER BY r.created_at DESC LIMIT 300`);
  res.json(rows);
}));
app.patch("/api/admin/reviews/:id", adminRequired, h(async (req, res) => {
  await pool.query("UPDATE reviews SET is_hidden = ? WHERE id = ?", [req.body.is_hidden ? 1 : 0, Number(req.params.id)]);
  res.json({ success: true });
}));
app.delete("/api/admin/reviews/:id", adminRequired, h(async (req, res) => {
  await pool.query("DELETE FROM reviews WHERE id = ?", [Number(req.params.id)]);
  res.json({ success: true });
}));

app.get("/api/admin/customers", adminRequired, h(async (req, res) => {
  const [rows] = await pool.query(`SELECT u.id, u.name, u.email, u.created_at, COUNT(o.id) AS orders, COALESCE(SUM(CASE WHEN o.payment_status='paid' AND o.status<>'cancelled' THEN o.total END),0) AS spent
    FROM users u LEFT JOIN orders o ON o.user_id = u.id GROUP BY u.id ORDER BY u.created_at DESC LIMIT 500`);
  res.json(rows);
}));

const csvCell = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s; };
app.get("/api/admin/export/:what.csv", adminRequired, h(async (req, res) => {
  const queries = {
    subscribers: "SELECT email, created_at FROM newsletter_subscribers ORDER BY created_at DESC",
    orders: "SELECT order_number, created_at, email, shipping_full_name, status, payment_status, subtotal, discount_amount, shipping_amount, tax_amount, total, currency, shipping_city, shipping_country FROM orders ORDER BY created_at DESC",
    customers: "SELECT name, email, created_at FROM users ORDER BY created_at DESC",
  };
  const q = queries[req.params.what];
  if (!q) throw new HttpError(404, "Unknown export");
  const [rows] = await pool.query(q);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c] instanceof Date ? r[c].toISOString() : r[c])).join(","))].join("\n");
  res.set("Content-Disposition", `attachment; filename="${req.params.what}.csv"`).type("text/csv").send(csv);
}));

// ════════════════════════════════════════════════════════════
//  404 + ERROR HANDLING
// ════════════════════════════════════════════════════════════
app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
app.use((req, res) => renderPage(res, "404.html", { title: `Page not found — ${STORE.name}`, status: 404, noindex: true }));

app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === "entity.too.large") return res.status(413).json({ error: "That upload is too large." });
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid request body." });
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}\n`, err);
  res.status(500).json({ error: IS_PROD ? "Something went wrong on our side. Please try again." : err.message });
});

// ════════════════════════════════════════════════════════════
//  START
// ════════════════════════════════════════════════════════════
async function ensureDefaultAdmin() {
  const [[{ c }]] = await pool.query("SELECT COUNT(*) AS c FROM admin_users");
  if (c > 0) return;
  const password = process.env.ADMIN_INITIAL_PASSWORD || crypto.randomBytes(9).toString("base64url");
  await pool.query("INSERT INTO admin_users (username, password_hash) VALUES (?, ?)", ["admin", await bcrypt.hash(password, 12)]);
  console.warn("\n🔐 Created the admin account.");
  console.warn(`   username: admin   password: ${process.env.ADMIN_INITIAL_PASSWORD ? "(the ADMIN_INITIAL_PASSWORD from .env)" : password}`);
  console.warn("   Sign in at /admin.html and change it under Settings.\n");
}

if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`\n  ${STORE.name} running at ${BASE_URL}  (${IS_PROD ? "production" : "development"})\n`);
    try {
      await pool.query("SELECT 1");
      await ensureDefaultAdmin();
    } catch (e) {
      console.error("✗ Database not reachable:", e.message, "\n  Check MYSQL_* in .env, then run: npm run db:setup");
    }
  });
}

module.exports = app;
