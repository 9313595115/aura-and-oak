// ============================================================
//  Eagle CNC Art & Craft — server.js (v3)
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
const { parseOptionsText, formatOptionsText, readOptions, applyCustomization } = require("./lib/options");
const { missingLegal, privacyHtml, termsHtml } = require("./lib/legal");

const app        = express();
const PORT       = process.env.PORT || 3000;
const IS_PROD    = process.env.NODE_ENV === "production";
const PUBLIC_DIR = path.join(__dirname, "public");
const UPLOAD_DIR = path.join(PUBLIC_DIR, "uploads");
const BASE_URL   = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");

// ── Store / business settings (all from .env) ────────────────
// WhatsApp number in international form (wa.me needs it): STORE_WHATSAPP, else the store phone.
// A 10-digit Indian number gets 91 in front. STORE_WHATSAPP=off hides every WhatsApp button.
function waNumber(wa, phone) {
  if (/^(off|no|false|none)$/i.test(String(wa || "").trim())) return "";
  let d = String(wa || phone || "").replace(/\D/g, "").replace(/^0+/, "");
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 15 ? d : "";
}
const num = (v, d) => (v === undefined || v === "" || isNaN(Number(v)) ? d : Number(v));
const STORE = {
  name:          process.env.STORE_NAME || "Eagle CNC Art & Craft",
  tagline:       process.env.STORE_TAGLINE || "CNC-cut wall art, name plates, temple panels and personalised wooden gifts — precision cut, finished by hand.",
  email:         process.env.STORE_EMAIL || "",
  phone:         process.env.STORE_PHONE || "",
  whatsapp:      waNumber(process.env.STORE_WHATSAPP, process.env.STORE_PHONE),
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
  // Defaults suit the currency: ₹149 flat / free over ₹2,999 for INR, 12 / 150 otherwise
  shipping_flat: num(process.env.SHIPPING_FLAT_RATE, (process.env.STORE_CURRENCY || "").toUpperCase() === "INR" ? 149 : 12),
  free_shipping_threshold: num(process.env.FREE_SHIPPING_THRESHOLD, (process.env.STORE_CURRENCY || "").toUpperCase() === "INR" ? 2999 : 150),
  tax_rate:      num(process.env.TAX_RATE_PERCENT, 0),
  tax_label:     process.env.TAX_LABEL || "Tax",
  return_days:   num(process.env.RETURN_WINDOW_DAYS, 30),
  // Delivery estimate shown on product pages (working days; Sundays skipped)
  dispatch_days:   num(process.env.DISPATCH_DAYS, 2),
  transit_min:     num(process.env.TRANSIT_DAYS_MIN, 3),
  transit_max:     num(process.env.TRANSIT_DAYS_MAX, 7),
  instagram_url:   process.env.STORE_INSTAGRAM || "",
  facebook_url:    process.env.STORE_FACEBOOK || "",
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

// ── Razorpay (UPI, cards, netbanking, wallets) — on when both keys are set
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || "", RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";
const RAZORPAY_API = (process.env.RAZORPAY_API_BASE || "https://api.razorpay.com/v1").replace(/\/+$/, "");
const razorpayOn = !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
async function razorpay(method, pathName, body) {
  const r = await fetch(RAZORPAY_API + pathName, {
    method, signal: AbortSignal.timeout(20000),
    headers: { Authorization: "Basic " + Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString("base64"), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(502, `Payment provider error: ${(data.error && data.error.description) || r.status}`);
  return data;
}
const safeEqual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ── Cash on delivery — on with COD_ENABLED=true; optional fee and maximum order value
// Preview checkout (orders with no payment) is for testing only: on the live site it is off
// unless ALLOW_PREVIEW_CHECKOUT=true, so nobody can place an unpaid order by accident.
const PREVIEW_CHECKOUT = !IS_PROD || process.env.ALLOW_PREVIEW_CHECKOUT === "true";
const CHECKOUT_CLOSED_MSG = "Online ordering is opening soon. Please send us your order on WhatsApp or ask for a quote, and we'll confirm it with you.";
const COD = { enabled: process.env.COD_ENABLED === "true", fee: num(process.env.COD_FEE, 0), max: num(process.env.COD_MAX_ORDER, 0) };
if (!stripe && !razorpayOn && PREVIEW_CHECKOUT) console.warn(`${IS_PROD ? "⚠️  ALLOW_PREVIEW_CHECKOUT is on: anyone can place an order WITHOUT paying. Turn it off before launch." : "ℹ️  No Razorpay/Stripe keys — online payment runs in preview mode (no real charges)."}`);

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
// Two ways to send:
//  1. BREVO_API_KEY set → Brevo's HTTPS email API (works on hosts that block
//     SMTP ports, e.g. Render's free plan). Free for 300 emails/day.
//  2. SMTP_HOST set → any SMTP server (Gmail, Zoho, your host's mailbox…).
//  Neither → emails are printed to the server log (useful for testing).
const BREVO_API_KEY = process.env.BREVO_API_KEY || "";
const mailTransport = !BREVO_API_KEY && process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
    })
  : null;

// "Shop Name <shop@example.com>" → { name, email }
function parseFrom(v) {
  const m = /^\s*(.*?)\s*<([^>]+)>\s*$/.exec(v || "");
  return m ? { name: m[1].replace(/^"|"$/g, "") || STORE.name, email: m[2].trim() } : { name: STORE.name, email: (v || "").trim() };
}
const MAIL_FROM = parseFrom(process.env.MAIL_FROM || process.env.SMTP_FROM || (process.env.SMTP_USER ? `${STORE.name} <${process.env.SMTP_USER}>` : `${STORE.name} <${STORE.email}>`));

async function sendMail(to, subject, html) {
  if (!to) return { sent: false };
  if (BREVO_API_KEY) {
    try {
      const r = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST", signal: AbortSignal.timeout(15000),
        headers: { "api-key": BREVO_API_KEY, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ sender: MAIL_FROM, to: [{ email: to }], subject, htmlContent: html }),
      });
      if (!r.ok) throw new Error(`Brevo ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return { sent: true };
    } catch (e) {
      console.error("Email send failed (Brevo):", e.message);
      return { sent: false, error: e.message };
    }
  }
  if (!mailTransport) {
    // No email service configured: print the email (and any links in it, e.g. password-reset) to the server log
    const links = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    console.log(`\n✉️  [DEV EMAIL — no email service] To: ${to}\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 600)}${links.length ? "\nLinks: " + links.join("  ") : ""}\n`);
    return { sent: false, simulated: true };
  }
  try {
    await mailTransport.sendMail({ from: `${MAIL_FROM.name} <${MAIL_FROM.email}>`, to, subject, html });
    return { sent: true };
  } catch (e) {
    console.error("Email send failed (SMTP):", e.message, /timeout|ECONNREFUSED|ETIMEDOUT/i.test(e.message)
      ? "— the host may block SMTP ports (Render's free plan does). Use BREVO_API_KEY instead." : "");
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
function toBool(r) {
  const out = { ...r, is_featured: r.is_featured === 1, is_active: r.is_active === undefined ? true : r.is_active === 1 };
  if ("options" in r) {
    const o = readOptions(r.options);
    out.options = o;
    out.customisable = !!o;
    out.made_to_order_days = o ? Number(o.days) || 0 : 0;
  }
  if ("sold_90d" in r) out.popular = Number(r.sold_90d) >= POPULAR_MIN_SOLD;
  return out;
}
const POPULAR_MIN_SOLD = 5;   // units sold in 90 days before a product earns the "Popular" badge
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

// Razorpay webhook (optional; set RAZORPAY_WEBHOOK_SECRET and subscribe to payment.captured)
app.post("/api/razorpay/webhook", express.raw({ type: "application/json" }), h(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(400).send("Webhook not configured");
  const sig = crypto.createHmac("sha256", secret).update(req.body).digest("hex");
  if (!safeEqual(sig, req.headers["x-razorpay-signature"] || "")) return res.status(400).send("Bad signature");
  const event = JSON.parse(req.body.toString("utf8"));
  if (event.event === "payment.captured") {
    const pay = event.payload && event.payload.payment && event.payload.payment.entity;
    const [[order]] = pay ? await pool.query("SELECT id FROM orders WHERE payment_intent_id = ?", [pay.id]) : [[null]];
    if (pay && !order) setTimeout(async () => {           // give the browser a minute to finish checkout first
      const [[late]] = await pool.query("SELECT id FROM orders WHERE payment_intent_id = ?", [pay.id]);
      if (!late) {
        console.warn(`⚠️  Razorpay payment ${pay.id} captured with no matching order.`);
        sendMail(NOTIFY_EMAIL, `Action needed: payment without order (${pay.id})`,
          `<p>Razorpay payment <b>${esc(pay.id)}</b> for ${esc(money(pay.amount / 100))} from ${esc(pay.email || "a customer")} (${esc(pay.contact || "")}) succeeded but no order was created. Please check the Razorpay dashboard and contact the customer or refund.</p>`);
      }
    }, 60000);
  }
  res.json({ received: true });
}));

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
    image: absUrl("/images/hero.jpg"), logo: absUrl("/images/logo.png"),
    priceRange: STORE.currency === "INR" ? "₹₹" : "$$", currenciesAccepted: STORE.currency,
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

// Photos bundled in /public/images that have WebP copies (name.webp + name-sm.webp)
const IMG_VARIANTS = (() => {
  try { return fs.readdirSync(path.join(PUBLIC_DIR, "images")).filter((f) => f.endsWith("-sm.webp")).map((f) => f.slice(0, -8)); }
  catch { return []; }
})();
function imgSrcset(url) {
  const m = /^\/?images\/([\w-]+)\.jpg$/.exec(String(url || ""));
  return m && IMG_VARIANTS.includes(m[1]) ? ` srcset="/images/${m[1]}-sm.webp 600w, /images/${m[1]}.webp 1000w"` : "";
}
const priceShort = (n) => money(n).replace(/\.00$/, "");

// Plain HTML versions of what the page scripts draw, so search engines (and
// visitors before JavaScript runs) see real products, prices and links.
function cardHtml(p) {
  p = toBool(p);
  const url = esc(productPath(p));
  const badges = [p.popular ? '<span class="pbadge pbadge-popular">Popular</span>' : "", p.customisable ? '<span class="pbadge">Customisable</span>' : "",
    p.made_to_order_days ? '<span class="pbadge pbadge-quiet">Made to order</span>' : ""].join("");
  const alt = p.alt_image ? `<img class="card-alt" src="${esc(p.alt_image)}"${imgSrcset(p.alt_image)} sizes="(max-width: 640px) 46vw, 300px" alt="" loading="lazy" decoding="async" aria-hidden="true" />` : "";
  return `<div class="product-card${p.alt_image ? " has-alt" : ""}"><div class="product-card-img"><a href="${url}" aria-label="${esc(p.name)}"><img src="${esc(p.image_url)}"${imgSrcset(p.image_url)} sizes="(max-width: 640px) 46vw, 300px" width="1000" height="1250" alt="${esc(p.name)}" loading="lazy" decoding="async" />${alt}</a><div class="card-badges">${badges}</div></div>`
    + `<div class="product-card-body"><p class="product-card-category">${esc(p.category || "")}</p><h3 class="product-card-name"><a href="${url}">${esc(p.name)}</a></h3><p class="product-card-price">${p.customisable ? '<span class="from">From</span> ' : ""}${esc(money(p.price))}</p></div></div>`;
}
function categoryPath(c) { return c.slug ? `/shop/${encodeURIComponent(c.slug)}` : `/shop?category=${c.id}`; }

// Search-friendly wording per category (falls back to generic copy for new categories)
const CATEGORY_SEO = {
  "wall-art":   { phrase: "CNC Wooden Wall Art — Mandala, Tree of Life & More", intro: "Intricate CNC-cut wooden wall art — mandalas, tree of life panels and maps that turn a plain wall into a feature." },
  "name-plates":{ phrase: "Personalised Wooden Name Plates for Home", intro: "Personalised wooden and acrylic name plates for your front door, cut with your family name and house number." },
  "mandir":     { phrase: "Mandir Jali Panels, Om & Ganesha Wall Art", intro: "CNC-cut mandir back panels, Om and Ganesha designs and pooja room jali work, finished by hand." },
  "jali-panels":{ phrase: "Decorative CNC Jali & Partition Panels", intro: "Decorative CNC jali screens and partition panels that divide a space while letting light and air through." },
  "clocks":     { phrase: "Wooden Wall Clocks — Mandala & Designer Clocks", intro: "Designer wooden wall clocks with silent movements — CNC-cut patterns that keep time beautifully." },
  "gifts":      { phrase: "Personalised Wooden Gifts — Coasters, Keychains & Frames", intro: "Personalised wooden gifts — engraved coasters, keychains and photo frames for birthdays, weddings and corporate gifting." },
};
const categorySeo = (c) => CATEGORY_SEO[c.slug] || { phrase: c.name, intro: `Explore our ${c.name.toLowerCase()} collection — every piece chosen for craft, material and lasting beauty.` };

const SHOP_SELECT = `SELECT p.id, p.name, p.price, p.image_url, p.slug, p.category_id, p.is_featured, p.description, p.stock_qty, p.options, c.name AS category,
  (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id AND pi.image_url <> p.image_url ORDER BY pi.sort_order, pi.id LIMIT 1) AS alt_image,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = p.id AND o.status <> 'cancelled' AND o.created_at >= NOW() - INTERVAL 90 DAY) AS sold_90d
  FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.is_active = 1`;
const freeShipLine = () => (STORE.free_shipping_threshold > 0 ? ` Free shipping over ${priceShort(STORE.free_shipping_threshold)}.` : "");
const breadcrumbLd = (items) => ({ "@context": "https://schema.org", "@type": "BreadcrumbList",
  itemListElement: items.map(([name, url], i) => ({ "@type": "ListItem", position: i + 1, name, item: BASE_URL + url })) });

// Fill <!--SSR:key-->…<!--/SSR:key--> regions of a page with server-rendered HTML
function fillSsr(html, fill) {
  for (const [k, v] of Object.entries(fill)) html = html.replace(new RegExp(`<!--SSR:${k}-->[\\s\\S]*?<!--/SSR:${k}-->`), () => v);
  return html;
}

function renderPage(res, file, { title, description, canonical, image, type = "website", ld = [], status = 200, noindex = false, fill = null, head = "" } = {}) {
  let html = readPage(file);
  if (fill) html = fillSsr(html, fill);
  if (title) html = html.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  const tags = [];
  if (description) {
    html = html.replace(/<meta name="description"[^>]*>\s*/i, "").replace(/<meta property="og:[^"]+"[^>]*>\s*/gi, "");
    tags.push(`<meta name="description" content="${esc(description)}" />`);
    tags.push(`<meta property="og:title" content="${esc(title || STORE.name)}" />`, `<meta property="og:description" content="${esc(description)}" />`);
    tags.push(`<meta property="og:type" content="${esc(type)}" />`, `<meta property="og:site_name" content="${esc(STORE.name)}" />`);
    tags.push(`<meta name="twitter:card" content="summary_large_image" />`);
    if (image) tags.push(`<meta property="og:image" content="${esc(absUrl(image))}" />`, `<meta name="twitter:image" content="${esc(absUrl(image))}" />`);
    tags.push(`<meta property="og:locale" content="${esc(STORE.locale.replace("-", "_"))}" />`);
  }
  if (canonical) tags.push(`<link rel="canonical" href="${esc(canonical)}" />`, `<meta property="og:url" content="${esc(canonical)}" />`);
  if (noindex) tags.push(`<meta name="robots" content="noindex" />`);
  ld.forEach((o) => tags.push(jsonLd(o)));
  if (head) tags.push(head);
  html = html.includes("<!--SEO-->") ? html.replace("<!--SEO-->", tags.join("\n  ")) : html.replace("</head>", tags.join("\n") + "\n</head>");
  res.status(status).set("Cache-Control", "no-cache").type("html").send(html);
}

// Old .html addresses → permanent redirects to the clean URLs (one canonical address per page)
const redirectTo = (to) => (req, res) => {
  const q = req.originalUrl.indexOf("?");
  res.redirect(301, to + (q >= 0 ? req.originalUrl.slice(q) : ""));
};
app.get("/index.html", redirectTo("/"));
app.get("/contact.html", redirectTo("/contact"));
app.get("/shipping.html", redirectTo("/shipping"));
app.get("/returns.html", redirectTo("/returns"));
app.get("/shop.html", h(async (req, res) => {
  const catId = intIn(req.query.category, 1, 1e9);
  const rest = new URLSearchParams(req.query); rest.delete("category");
  const qs = rest.toString() ? "?" + rest : "";
  if (catId) {
    const [[c]] = await pool.query("SELECT id, slug FROM categories WHERE id = ?", [catId]);
    if (c) return res.redirect(301, categoryPath(c) + (c.slug ? qs : ""));
  }
  res.redirect(301, "/shop" + qs);
}));

app.get("/", h(async (req, res) => {
  const faqLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: HOME_FAQ.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a } })) };
  const [[featured], [cats]] = await Promise.all([
    pool.query(`${SHOP_SELECT} AND p.is_featured = 1 ORDER BY p.id`),
    pool.query("SELECT id, name, slug, image_url FROM categories ORDER BY name"),
  ]);
  const catHtml = cats.slice(0, 6).map((c) => `<a href="${esc(categoryPath(c))}" class="category-card"><img src="${esc(c.image_url)}"${imgSrcset(c.image_url)} sizes="(max-width: 640px) 92vw, 380px" width="1000" height="1250" alt="${esc(c.name)}" loading="lazy" decoding="async" /><div class="category-card-label"><span>${esc(c.name)}</span><small>Shop now</small></div></a>`).join("");
  renderPage(res, "index.html", {
    title: `${STORE.name} — CNC Wall Art, Name Plates & Custom Wooden Decor${STORE.city ? " in " + STORE.city : ""}`,
    description: `CNC-cut wooden wall art, name plates, mandir panels, jali screens and personalised gifts from ${STORE.name}${STORE.city ? ` in ${STORE.city}` : ""}. Custom designs welcome.${freeShipLine()}`,
    canonical: BASE_URL + "/", image: "/images/hero.jpg",
    fill: { featured: featured.map(cardHtml).join(""), categories: catHtml, quotepanel: quotePanelHtml(), reviews: await homeReviewsHtml() },
    ld: [localBusinessLd(), faqLd, { "@context": "https://schema.org", "@type": "WebSite", name: STORE.name, url: BASE_URL + "/",
         potentialAction: { "@type": "SearchAction", target: `${BASE_URL}/shop?q={search_term_string}`, "query-input": "required name=search_term_string" } }],
  });
}));

app.get(["/work", "/work.html"], h(async (req, res) => {
  if (req.path === "/work.html") return res.redirect(301, "/work");
  const [rows] = await pool.query(`${SHOP_SELECT} ORDER BY p.is_featured DESC, p.updated_at DESC, p.id DESC LIMIT 8`);
  const gallery = rows.map((p) => `<a href="${esc(productPath(p))}" class="reveal"><img src="${esc(p.image_url)}"${imgSrcset(p.image_url)} sizes="(max-width: 960px) 46vw, 280px" width="1000" height="1250" alt="${esc(p.name)}" loading="lazy" decoding="async" /><span class="cap">${esc(p.name)}</span></a>`).join("");
  renderPage(res, "work.html", {
    title: `Our work — Name Plates, Signage, Mandir & Jali | ${STORE.name}`,
    description: `What ${STORE.name} makes: name plates and signage, mandir panels, jali partitions, wall art, corporate gifts and custom CNC parts in wood and acrylic.`,
    canonical: BASE_URL + "/work", image: "/images/om-jali-panel.jpg", fill: { gallery },
    ld: [breadcrumbLd([["Home", "/"], ["Our work", "/work"]])],
  });
}));

app.get("/contact", (req, res) => renderPage(res, "contact.html", {
  title: `Contact & visit us${STORE.city ? " in " + STORE.city : ""} — ${STORE.name}`,
  description: `Get in touch with ${STORE.name}${STORE.city ? ` in ${STORE.city}` : ""}: store address, opening hours, phone and email. Questions about a piece, an order or styling your space? We reply within one business day.`,
  canonical: BASE_URL + "/contact", image: "/images/story.jpg",
  ld: [localBusinessLd(), breadcrumbLd([["Home", "/"], ["Contact", "/contact"]])],
}));
app.get("/shipping", (req, res) => renderPage(res, "shipping.html", {
  title: `Shipping information — ${STORE.name}`,
  description: `Delivery times, shipping rates and order tracking for ${STORE.name}.${freeShipLine()}`,
  canonical: BASE_URL + "/shipping", image: "/images/hero.jpg",
  ld: [breadcrumbLd([["Home", "/"], ["Shipping", "/shipping"]])],
}));
const legalCtx = () => ({ payments: [razorpayOn && "Razorpay", stripe && "Stripe"].filter(Boolean), cod: COD.enabled });
app.get(["/privacy", "/privacy.html", "/privacy-policy"], (req, res) => {
  if (req.path !== "/privacy") return res.redirect(301, "/privacy");
  renderPage(res, "privacy.html", {
    title: `Privacy policy — ${STORE.name}`,
    description: `How ${STORE.name} collects, uses and protects your personal information, and how to reach our grievance officer.`,
    canonical: BASE_URL + "/privacy", image: "/images/hero.jpg",
    ld: [breadcrumbLd([["Home", "/"], ["Privacy policy", "/privacy"]])],
    fill: { legal: privacyHtml(STORE, legalCtx(), esc) },
  });
});
app.get(["/terms", "/terms.html", "/terms-and-conditions"], (req, res) => {
  if (req.path !== "/terms") return res.redirect(301, "/terms");
  renderPage(res, "terms.html", {
    title: `Terms & conditions — ${STORE.name}`,
    description: `The terms for buying from ${STORE.name}: orders, personalisation, payment, delivery, returns and complaints.`,
    canonical: BASE_URL + "/terms", image: "/images/hero.jpg",
    ld: [breadcrumbLd([["Home", "/"], ["Terms & conditions", "/terms"]])],
    fill: { legal: termsHtml(STORE, legalCtx(), esc) },
  });
});
app.get("/returns", (req, res) => renderPage(res, "returns.html", {
  title: `Returns & exchanges — ${STORE.name}`,
  description: `Changed your mind? ${STORE.name} offers ${STORE.return_days}-day returns and exchanges on unused items. See how to start a return and when refunds arrive.`,
  canonical: BASE_URL + "/returns", image: "/images/hero.jpg",
  ld: [breadcrumbLd([["Home", "/"], ["Returns", "/returns"]])],
}));

// Home FAQ (kept in step with the questions shown on the page) — becomes FAQ rich results in Google
const HOME_FAQ = [
  ["How long will my order take?", "Ready designs are dispatched in 2–3 working days. Personalised and made-to-order pieces take 3–10 working days to make, depending on the design. Each product page shows an estimated delivery date for your PIN code."],
  ["Can you make a design in my size or with my own artwork?", "Yes. Send a sketch, photo, logo or DXF/SVG file with the size you need. We reply with a design preview and price, and nothing is cut until you approve it."],
  ["Which materials do you work with?", "Solid wood such as teak, MDF and HDHMR, birch and marine plywood, and clear, coloured or mirror acrylic."],
  ["Do you deliver across India?", "Yes. Orders are packed in protective cartons and shipped with tracking. Large panels may travel with a transport partner."],
  ["Can I return a personalised piece?", "Personalised and custom-sized pieces can't be returned unless they arrive damaged or differ from the approved design. Ready designs can be returned within the return window."],
  ["How do I look after wooden pieces?", "Dust with a soft dry cloth, keep indoor pieces away from direct water and avoid harsh cleaners on painted or stained finishes."],
];

// Real customer reviews for the home page — the whole section is left out until some exist
async function homeReviewsHtml() {
  const [rows] = await pool.query(`SELECT r.name, r.rating, r.comment, r.verified, p.name AS product, p.slug
    FROM reviews r JOIN products p ON p.id = r.product_id AND p.is_active = 1
    WHERE r.is_hidden = 0 AND r.rating >= 4 AND CHAR_LENGTH(r.comment) >= 20
    ORDER BY r.verified DESC, r.created_at DESC LIMIT 6`);
  if (!rows.length) return "";
  const cards = rows.map((r) => `<figure class="review-card reveal"><div class="review-stars" aria-label="${r.rating} out of 5 stars">${"★".repeat(r.rating)}<span>${"★".repeat(5 - r.rating)}</span></div>
    <blockquote>${esc(r.comment.length > 260 ? r.comment.slice(0, 257) + "…" : r.comment)}</blockquote>
    <figcaption><b>${esc(r.name)}</b>${r.verified ? ' <span class="verified">✓ Verified buyer</span>' : ""}<a href="${esc(productPath(r))}">${esc(r.product)}</a></figcaption></figure>`).join("");
  return `<section class="home-reviews" aria-labelledby="revH"><div class="reviews-inner"><p class="eyebrow">Customer reviews</p><h2 id="revH" class="section-title" style="margin:12px 0 30px">What customers say</h2><div class="review-grid">${cards}</div></div></section>`;
}

// Walnut panel beside the home-page quote form: phone, email, address and workshop hours
function quotePanelHtml() {
  const tel = (STORE.phone || "").replace(/[^\d+]/g, "");
  const addr = [STORE.street, STORE.city, STORE.region, STORE.postal_code].filter(Boolean).join(", ");
  const rows = [];
  if (STORE.phone || STORE.email) rows.push(`<div class="row"><h3>Visit or call</h3>${STORE.phone ? `<a href="tel:${esc(tel)}">${esc(STORE.phone)}</a>` : ""}${STORE.email ? `<a href="mailto:${esc(STORE.email)}">${esc(STORE.email)}</a>` : ""}${STORE.whatsapp ? `<a href="https://wa.me/${esc(String(STORE.whatsapp).replace(/\D/g, ""))}" rel="noopener">WhatsApp us</a>` : ""}</div>`);
  if (addr) rows.push(`<div class="row"><h3>Workshop</h3><span>${esc(addr)}</span>${STORE.maps_url ? `<a href="${esc(STORE.maps_url)}" rel="noopener">Get directions →</a>` : ""}</div>`);
  rows.push(`<div class="row"><h3>Workshop hours</h3><span>${esc(STORE.hours_display || "Mon–Sat · 10am–7pm")}</span></div>`);
  return rows.join("");
}

async function renderShop(req, res, cat) {
  const [[products], [cats]] = await Promise.all([
    pool.query(`${SHOP_SELECT}${cat ? " AND p.category_id = ?" : ""} ORDER BY p.is_featured DESC, p.id`, cat ? [cat.id] : []),
    pool.query("SELECT id, name, slug FROM categories ORDER BY name"),
  ]);
  const seo = cat ? categorySeo(cat) : null;
  const path_ = cat ? categoryPath(cat) : "/shop";
  const canonical = BASE_URL + path_;
  const title = cat ? `${seo.phrase} | ${STORE.name}` : `Shop CNC Wall Art, Name Plates & Wooden Gifts | ${STORE.name}`;
  const description = cat
    ? `${seo.intro} Shop ${cat.name.toLowerCase()} at ${STORE.name}.${freeShipLine()}`
    : `Shop the full ${STORE.name} collection: CNC-cut wall art, name plates, mandir panels, jali screens, wall clocks and personalised gifts.${freeShipLine()}`;
  const header = `<p class="page-header-eyebrow">${cat ? "Shop by category" : "The collection"}</p>\n    <h1 id="shopTitle">${esc(cat ? cat.name : "Shop all")}</h1>\n    <p id="shopIntro">${esc(cat ? seo.intro : "Every piece chosen for its craft, material, and lasting beauty.")}</p>`;
  // Crawlable links to every category (the interactive filter buttons are drawn by script)
  const catLinks = `<nav class="sr-only" aria-label="Categories">${cats.map((c) => `<a href="${esc(categoryPath(c))}">${esc(c.name)}</a>`).join(" ")}</nav>`;
  const crumbs = [["Home", "/"], ["Shop", "/shop"]]; if (cat) crumbs.push([cat.name, path_]);
  renderPage(res, "shop.html", {
    title, description, canonical, image: products[0] ? products[0].image_url : "/images/hero.jpg",
    fill: { header: header + catLinks, grid: products.map(cardHtml).join(""), count: `${products.length} product${products.length === 1 ? "" : "s"}` },
    head: cat ? `<script>window.__SHOP = { categoryId: ${Number(cat.id)} };</script>` : "",
    ld: [
      { "@context": "https://schema.org", "@type": "CollectionPage", name: cat ? cat.name : "Shop all", url: canonical, description,
        mainEntity: { "@type": "ItemList", numberOfItems: products.length,
          itemListElement: products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: BASE_URL + productPath(p), name: p.name })) } },
      breadcrumbLd(crumbs),
    ],
  });
}
app.get("/shop", h(async (req, res) => {
  // ?category=ID links from older pages → the category's own address
  const catId = intIn(req.query.category, 1, 1e9);
  if (catId) {
    const [[c]] = await pool.query("SELECT id, slug FROM categories WHERE id = ?", [catId]);
    if (c && c.slug) { const rest = new URLSearchParams(req.query); rest.delete("category"); return res.redirect(301, categoryPath(c) + (rest.toString() ? "?" + rest : "")); }
  }
  return renderShop(req, res, null);
}));
app.get("/shop/:slug", h(async (req, res) => {
  const [[c]] = await pool.query("SELECT id, name, slug FROM categories WHERE slug = ?", [req.params.slug]);
  if (!c) return renderPage(res, "404.html", { title: `Page not found — ${STORE.name}`, status: 404, noindex: true });
  return renderShop(req, res, c);
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
  const [gallery] = await pool.query("SELECT image_url FROM product_images WHERE product_id = ? ORDER BY sort_order", [p.id]);
  const [[catRow]] = p.category_id ? await pool.query("SELECT id, name, slug FROM categories WHERE id = ?", [p.category_id]) : [[null]];
  const country = STORE.country || "IN";
  const ld = {
    "@context": "https://schema.org", "@type": "Product", name: p.name, description: p.description || desc, url,
    image: [p.image_url, ...gallery.map((g) => g.image_url)].filter(Boolean).map(absUrl), sku: String(p.id),
    brand: { "@type": "Brand", name: STORE.name }, category: p.category || undefined,
    offers: { "@type": "Offer", url, priceCurrency: STORE.currency, price: Number(p.price).toFixed(2),
      availability: p.stock_qty > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock", itemCondition: "https://schema.org/NewCondition",
      seller: { "@type": "Organization", name: STORE.name },
      shippingDetails: { "@type": "OfferShippingDetails",
        shippingRate: { "@type": "MonetaryAmount", value: Number(p.price) >= STORE.free_shipping_threshold && STORE.free_shipping_threshold > 0 ? 0 : STORE.shipping_flat, currency: STORE.currency },
        shippingDestination: { "@type": "DefinedRegion", addressCountry: country } },
      hasMerchantReturnPolicy: { "@type": "MerchantReturnPolicy", applicableCountry: country, returnPolicyCategory: "https://schema.org/MerchantReturnFiniteReturnWindow",
        merchantReturnDays: STORE.return_days, returnMethod: "https://schema.org/ReturnByMail" } },
  };
  if (p.review_count > 0) ld.aggregateRating = { "@type": "AggregateRating", ratingValue: Number(p.avg_rating), reviewCount: Number(p.review_count) };
  const crumbList = [["Home", "/"], ["Shop", "/shop"]];
  if (catRow) crumbList.push([catRow.name, categoryPath(catRow)]);
  crumbList.push([p.name, productPath(p)]);
  const stockText = p.stock_qty <= 0 ? "Out of stock" : p.stock_qty < 10 ? "Low stock" : "In stock";
  const detail = `<div class="product-detail"><div class="product-images"><div class="product-main-img"><img src="${esc(p.image_url)}"${imgSrcset(p.image_url)} sizes="(max-width: 900px) 92vw, 560px" width="1000" height="1250" alt="${esc(p.name)}" fetchpriority="high" /></div></div>`
    + `<div class="product-info"><p class="product-category">${catRow ? `<a href="${esc(categoryPath(catRow))}">${esc(catRow.name)}</a>` : ""}</p><h1 class="product-name">${esc(p.name)}</h1><p class="product-price">${esc(money(p.price))}</p>`
    + `<hr class="product-divider" /><p class="product-desc">${esc(p.description || "")}</p>`
    + `<div class="product-meta"><div class="product-meta-row"><span class="label">Category</span><span class="value">${esc(p.category || "—")}</span></div><div class="product-meta-row"><span class="label">Availability</span><span class="value">${stockText}</span></div></div></div></div>`;
  const pTitle = p.meta_title && !/\| ?(Aura & Oak|Eagle CNC Art & Craft)$/.test(p.meta_title) ? p.meta_title : `${p.name}${p.category ? " — " + p.category : ""} | Buy Online at ${STORE.name}`;
  renderPage(res, "product.html", { title: pTitle, description: desc, canonical: url, image: p.image_url, type: "product",
    fill: { product: detail, crumb: esc(p.name) }, ld: [ld, breadcrumbLd(crumbList)] });
}));

app.get("/robots.txt", (req, res) => {
  res.type("text/plain").send([
    "User-agent: *",
    "Disallow: /admin.html", "Disallow: /account.html", "Disallow: /cart.html", "Disallow: /checkout.html",
    "Disallow: /order-confirmation.html", "Disallow: /reset-password.html", "Disallow: /api/",
    "", `Sitemap: ${BASE_URL}/sitemap.xml`, ""].join("\n"));
});

app.get("/sitemap.xml", h(async (req, res) => {
  const [products] = await pool.query("SELECT id, slug, name, image_url, updated_at FROM products WHERE is_active = 1");
  const [cats] = await pool.query("SELECT id, slug FROM categories");
  const newest = products.reduce((m, p) => (p.updated_at && new Date(p.updated_at) > m ? new Date(p.updated_at) : m), new Date(0));
  const urls = [
    { loc: "/", pr: "1.0", mod: newest.getTime() ? newest : null, img: "/images/hero.jpg" }, { loc: "/shop", pr: "0.9", mod: newest.getTime() ? newest : null },
    { loc: "/contact", pr: "0.7" }, { loc: "/work", pr: "0.8" }, { loc: "/shipping", pr: "0.3" }, { loc: "/returns", pr: "0.3" }, { loc: "/privacy", pr: "0.2" }, { loc: "/terms", pr: "0.2" },
    ...cats.map((c) => ({ loc: categoryPath(c), pr: "0.8" })),
    ...products.map((p) => ({ loc: productPath(p), pr: "0.8", mod: p.updated_at, img: p.image_url, title: p.name })),
  ];
  const body = urls.map((u) => `  <url><loc>${esc(BASE_URL + u.loc)}</loc>${u.mod ? `<lastmod>${new Date(u.mod).toISOString().slice(0, 10)}</lastmod>` : ""}<priority>${u.pr}</priority>`
    + (u.img ? `<image:image><image:loc>${esc(absUrl(u.img))}</image:loc>${u.title ? `<image:title>${esc(u.title)}</image:title>` : ""}</image:image>` : "") + `</url>`).join("\n");
  res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n${body}\n</urlset>\n`);
}));

// Uploaded images: served from the disk cache, else from the database (then re-cached)
const IMG_MIME = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
app.get("/uploads/:name", h(async (req, res, next) => {
  const name = req.params.name;
  if (!/^[a-z0-9-]{1,80}\.(jpg|png|gif|webp)$/.test(name)) return res.status(404).end();
  const file = path.join(UPLOAD_DIR, name);
  if (fs.existsSync(file)) return next();
  const [[row]] = await pool.query("SELECT mime, data FROM uploads WHERE name = ?", [name]);
  if (!row) return res.status(404).end();
  try { fs.mkdirSync(UPLOAD_DIR, { recursive: true }); fs.writeFileSync(file, row.data); } catch {}
  res.set({ "Content-Type": row.mime, "Cache-Control": "public, max-age=2592000", "X-Content-Type-Options": "nosniff" }).send(row.data);
}));

// Static files (only /public). Clean URLs: /shop → shop.html
app.use(express.static(PUBLIC_DIR, {
  extensions: ["html"],
  setHeaders(res, file) {
    if (file.endsWith(".html")) res.setHeader("Cache-Control", "no-cache");
    else if (/[\\/](images|uploads)[\\/]/.test(file)) res.setHeader("Cache-Control", "public, max-age=2592000");
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
    simulated: !stripe && !razorpayOn,
    previewCheckout: !stripe && !razorpayOn && PREVIEW_CHECKOUT,
    checkoutOpen: !!(stripe || razorpayOn || COD.enabled || PREVIEW_CHECKOUT),
    payments: { razorpay: razorpayOn, razorpayKeyId: razorpayOn ? RAZORPAY_KEY_ID : null, stripe: !!stripe,
                cod: COD.enabled, codFee: COD.fee, codMax: COD.max },
    store: { ...publicStore, tax_rate },
    imgVariants: IMG_VARIANTS,
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
  p.slug, p.created_at, p.options, c.name AS category, r.avg_rating, r.review_count,
  (SELECT pi.image_url FROM product_images pi WHERE pi.product_id = p.id AND pi.image_url <> p.image_url ORDER BY pi.sort_order, pi.id LIMIT 1) AS alt_image,
  (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE oi.product_id = p.id AND o.status <> 'cancelled' AND o.created_at >= NOW() - INTERVAL 90 DAY) AS sold_90d
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
  if (!u || !(await bcrypt.compare(String(current_password || ""), u.password_hash))) throw bad("Current password is incorrect.");
  if (current_password === new_password) throw bad("The new password must be different from the current one.");
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
        <p><a href="${esc(link)}" style="display:inline-block;background:#6E5843;color:#fff;padding:12px 22px;border-radius:4px;text-decoration:none">Reset password</a></p>
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
    SELECT ci.id, ci.product_id, ci.quantity, ci.customization, p.name, p.price AS base_price, p.options, p.image_url, p.stock_qty, p.slug, c.name AS category
    FROM cart_items ci JOIN products p ON ci.product_id = p.id AND p.is_active = 1
    LEFT JOIN categories c ON p.category_id = c.id
    WHERE ${w.sql} ORDER BY ci.created_at DESC, ci.id DESC`, [w.arg]);
  return rows.map((r) => {
    let saved = null; try { saved = r.customization ? JSON.parse(r.customization) : null; } catch {}
    let custom = { summary: "", delta: 0, values: null };
    try { custom = applyCustomization(r.options, saved || {}); } catch { /* options changed since it was added: keep defaults */ }
    const { options, customization, ...rest } = r;
    return { ...rest, price: Math.round((Number(r.base_price) + custom.delta) * 100) / 100, customization: custom.values, customization_summary: custom.summary };
  });
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
  const [[product]] = await pool.query("SELECT stock_qty, name, options FROM products WHERE id = ? AND is_active = 1", [pid]);
  if (!product) throw new HttpError(404, "Product not found");
  let custom;
  try { custom = applyCustomization(product.options, req.body.customization); } catch (e) { throw bad(e.message); }
  const w = cartWhere(ident);
  const [[existing]] = await pool.query(`SELECT id, quantity FROM cart_items WHERE ${w.sql} AND product_id = ? AND custom_key = ?`, [w.arg, pid, custom.key]);
  const [[{ inCart }]] = await pool.query(`SELECT COALESCE(SUM(quantity), 0) AS inCart FROM cart_items WHERE ${w.sql} AND product_id = ?`, [w.arg, pid]);
  const current = Number(inCart);
  if (current + qty > product.stock_qty) {
    throw bad(product.stock_qty - current > 0 ? `Only ${product.stock_qty - current} more available.` : `${product.name} is out of stock${current ? " (you already have the last ones in your cart)" : ""}.`);
  }
  if (existing) await pool.query("UPDATE cart_items SET quantity = quantity + ? WHERE id = ?", [qty, existing.id]);
  else await pool.query("INSERT INTO cart_items (session_id, user_id, product_id, quantity, customization, custom_key) VALUES (?, ?, ?, ?, ?, ?)",
    [ident.session_id || `user-${ident.user_id}`, ident.user_id, pid, qty, custom.values ? JSON.stringify(custom.values) : null, custom.key]);
  res.json({ success: true });
}));

app.put("/api/cart/:id", h(async (req, res) => {
  const qty = intIn(req.body.quantity, 1, 99);
  if (!qty) throw bad("Quantity must be between 1 and 99.");
  const item = await ownedCartItem(req);
  const w = cartWhere(cartIdentity(req));
  const [[{ others }]] = await pool.query(`SELECT COALESCE(SUM(quantity), 0) AS others FROM cart_items WHERE ${w.sql} AND product_id = ? AND id <> ?`, [w.arg, item.product_id, item.id]);
  if (qty + Number(others) > item.stock_qty) throw bad(`Only ${Math.max(item.stock_qty - Number(others), 0)} more in stock.`);
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
    const [[existing]] = await pool.query("SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ? AND custom_key = ?", [req.user.id, item.product_id, item.custom_key || ""]);
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

function computeTotals(items, discount, opts = {}) {
  const subtotal = round2(items.reduce((s, i) => s + Number(i.price) * i.quantity, 0));
  const discount_amount = discount && discount.valid ? round2(Math.min(discount.discount_amount, subtotal)) : 0;
  const afterDiscount = round2(subtotal - discount_amount);
  let shipping_amount = !items.length || afterDiscount >= STORE.free_shipping_threshold ? 0 : STORE.shipping_flat;
  if (discount && discount.valid && discount.free_shipping) shipping_amount = 0;
  const tax_amount = round2(afterDiscount * (STORE.tax_rate / 100));
  const cod_fee = opts.cod && items.length ? round2(COD.fee) : 0;
  return { subtotal, discount_amount, shipping_amount: round2(shipping_amount), tax_amount, cod_fee, total: round2(afterDiscount + shipping_amount + tax_amount + cod_fee),
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
  res.json({ items, totals: computeTotals(items, discount, { cod: req.body.payment_method === "cod" }), discount });
}));

// ════════════════════════════════════════════════════════════
//  CHECKOUT
// ════════════════════════════════════════════════════════════
const minorUnits = (amount) => Math.round(Number(amount) * 100);
const qtyByProduct = (items) => items.reduce((m, i) => m.set(i.product_id, (m.get(i.product_id) || 0) + i.quantity), new Map());

// Step 1: create (or simulate) a payment for the current cart
app.post("/api/checkout/intent", checkoutLimiter, h(async (req, res) => {
  const ident = cartIdentity(req);
  const items = await loadCart(ident);
  if (!items.length) throw bad("Your cart is empty.");
  for (const [pid, q] of qtyByProduct(items)) { const i = items.find((x) => x.product_id === pid); if (q > i.stock_qty) throw bad(`${i.name} only has ${i.stock_qty} in stock — please update your cart.`); }
  const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const discount = req.body.discount_code ? await evaluatePromo(req.body.discount_code, subtotal) : { valid: false };
  const method = str(req.body.payment_method, 20);
  const totals = computeTotals(items, discount, { cod: method === "cod" });
  if (method === "cod") {
    if (!COD.enabled) throw bad("Cash on delivery isn't available right now.");
    if (COD.max && totals.total > COD.max) throw bad(`Cash on delivery is available on orders up to ${money(COD.max)}. Please pay online for this order.`);
    return res.json({ method: "cod", totals });
  }
  if (razorpayOn) {
    const rzOrder = await razorpay("POST", "/orders", { amount: minorUnits(totals.total), currency: STORE.currency, receipt: "cart-" + crypto.randomBytes(5).toString("hex"),
      notes: { session_id: ident.session_id || "", user_id: ident.user_id ? String(ident.user_id) : "", email: str(req.body.email, 255) } });
    return res.json({ method: "razorpay", razorpayOrderId: rzOrder.id, keyId: RAZORPAY_KEY_ID, amount: rzOrder.amount, currency: rzOrder.currency, totals });
  }
  if (!stripe) {
    if (!PREVIEW_CHECKOUT) throw new HttpError(503, CHECKOUT_CLOSED_MSG);
    return res.json({ simulated: true, paymentIntentId: null, totals });
  }

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
  let paymentMode = "simulated", intent = null, paymentRef = null, rzPayment = null;
  const method = str(req.body.payment_method, 20);
  if (method === "cod") {
    if (!COD.enabled) throw bad("Cash on delivery isn't available right now.");
    paymentMode = "cod"; paymentRef = "cod_" + crypto.randomBytes(8).toString("hex");
  } else if (razorpayOn) {
    const oid = str(req.body.razorpay_order_id, 64), pid = str(req.body.razorpay_payment_id, 64), sig = str(req.body.razorpay_signature, 200);
    if (!oid || !pid || !sig) throw new HttpError(402, "Payment is required to place this order.");
    const expected = crypto.createHmac("sha256", RAZORPAY_KEY_SECRET).update(`${oid}|${pid}`).digest("hex");
    if (!safeEqual(expected, sig)) throw new HttpError(402, "We couldn't verify this payment. If money was deducted, it will be refunded automatically.");
    const [[already]] = await pool.query("SELECT order_number FROM orders WHERE payment_intent_id = ?", [pid]);
    if (already) return res.json({ success: true, order_number: already.order_number });   // double-click / retry
    rzPayment = await razorpay("GET", `/payments/${encodeURIComponent(pid)}`);
    if (rzPayment.order_id !== oid || !["captured", "authorized"].includes(rzPayment.status)) throw new HttpError(402, "Payment has not completed yet.");
    if (rzPayment.status === "authorized") rzPayment = await razorpay("POST", `/payments/${encodeURIComponent(pid)}/capture`, { amount: rzPayment.amount, currency: rzPayment.currency });
    paymentMode = "razorpay"; paymentRef = pid;
  } else if (stripe) {
    const piId = str(req.body.payment_intent_id, 255);
    if (!piId.startsWith("pi_")) throw new HttpError(402, "Payment is required to place this order.");
    const [[already]] = await pool.query("SELECT order_number FROM orders WHERE payment_intent_id = ?", [piId]);
    if (already) return res.json({ success: true, order_number: already.order_number }); // double-click / retry
    intent = await stripe.paymentIntents.retrieve(piId);
    if (intent.status !== "succeeded") throw new HttpError(402, "Payment has not completed yet.");
    paymentMode = "stripe"; paymentRef = piId;
  } else {
    if (!PREVIEW_CHECKOUT) throw new HttpError(503, CHECKOUT_CLOSED_MSG);
    paymentRef = "sim_" + crypto.randomBytes(8).toString("hex");
  }

  const refundIfPaid = async (reason) => {
    if (intent) { try { await stripe.refunds.create({ payment_intent: intent.id }); } catch (e) { console.error("Auto-refund failed:", e.message); } }
    if (rzPayment) { try { await razorpay("POST", `/payments/${encodeURIComponent(rzPayment.id)}/refund`, {}); } catch (e) { console.error("Razorpay auto-refund failed:", e.message); } }
    return new HttpError(409, reason + (intent || rzPayment ? " Your payment has been refunded automatically." : ""));
  };

  const conn = await pool.getConnection();
  let order_number, totals, items;
  try {
    await conn.beginTransaction();
    items = await loadCart(ident, conn);
    if (!items.length) { await conn.rollback(); throw await refundIfPaid("Your cart is empty."); }

    for (const [pid, q] of qtyByProduct(items)) {
      const [[fresh]] = await conn.query("SELECT stock_qty FROM products WHERE id = ? FOR UPDATE", [pid]);
      if (!fresh || fresh.stock_qty < q) { await conn.rollback(); throw await refundIfPaid(`${items.find((x) => x.product_id === pid).name} no longer has enough stock.`); }
    }

    const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const discount = discountCode ? await evaluatePromo(discountCode, subtotal, conn) : { valid: false };
    totals = computeTotals(items, discount, { cod: paymentMode === "cod" });
    if (paymentMode === "cod" && COD.max && totals.total > COD.max) { await conn.rollback(); throw bad(`Cash on delivery is available on orders up to ${money(COD.max)}.`); }
    if (rzPayment && (rzPayment.amount !== minorUnits(totals.total) || rzPayment.currency !== STORE.currency)) {
      await conn.rollback();
      throw await refundIfPaid("Your cart changed during checkout, so the amount paid didn't match.");
    }

    if (intent && (intent.amount !== minorUnits(totals.total) || intent.currency !== STORE.currency.toLowerCase())) {
      await conn.rollback();
      throw await refundIfPaid("Your cart changed during checkout, so the amount paid didn't match.");
    }

    order_number = orderNumber();
    const [orderResult] = await conn.query(`
      INSERT INTO orders (order_number, user_id, session_id, email, status, subtotal, discount_code, discount_amount,
        shipping_amount, tax_amount, total, currency, shipping_full_name, shipping_line1, shipping_line2, shipping_city,
        shipping_state, shipping_postal_code, shipping_country, shipping_phone, payment_status, payment_intent_id, payment_mode)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [order_number, ident.user_id, ident.session_id, email, paymentMode === "cod" ? "processing" : "paid", totals.subtotal, discount.valid ? discount.code : null, totals.discount_amount,
       round2(totals.shipping_amount + (totals.cod_fee || 0)), totals.tax_amount, totals.total, STORE.currency, ship.full_name, ship.line1, ship.line2 || null, ship.city,
       ship.state || null, ship.postal_code, ship.country, ship.phone || null, paymentMode === "cod" ? "unpaid" : "paid", paymentRef, paymentMode]);
    const orderId = orderResult.insertId;

    for (const it of items) {
      await conn.query("INSERT INTO order_items (order_id, product_id, name, price, quantity, image_url, customization) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [orderId, it.product_id, it.name, it.price, it.quantity, it.image_url, it.customization_summary || null]);
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
  sendMail(email, `Order confirmed — ${order_number}`, orderEmailHtml({ order_number, items, totals, ship, viewUrl, cod: paymentMode === "cod" }));
  sendMail(NOTIFY_EMAIL, `🛍️ New order ${order_number} — ${money(totals.total)}`,
    `<p>New order <b>${esc(order_number)}</b> from ${esc(email)} for <b>${esc(money(totals.total))}</b>.</p>
     <p>${items.map((i) => `${esc(i.name)} × ${i.quantity}${i.customization_summary ? ` — <i>${esc(i.customization_summary)}</i>` : ""}`).join("<br/>")}</p><p><a href="${BASE_URL}/admin.html">Open admin dashboard</a></p>`);
}));

function orderEmailHtml({ order_number, items, totals, ship, viewUrl, cod = false }) {
  const rows = items.map((i) => `<tr><td style="padding:6px 0">${esc(i.name)} × ${i.quantity}${(i.customization_summary || (typeof i.customization === "string" && i.customization)) ? `<br/><span style="color:#6B6055;font-size:13px">${esc(i.customization_summary || i.customization)}</span>` : ""}</td><td style="padding:6px 0;text-align:right">${esc(money(i.price * i.quantity))}</td></tr>`).join("");
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
      ${totals.cod_fee > 0 ? line("Cash on delivery fee", esc(money(totals.cod_fee))) : ""}
      ${totals.tax_amount > 0 ? line(esc(STORE.tax_label), esc(money(totals.tax_amount))) : ""}
      <tr><td style="padding-top:8px"><strong>Total</strong></td><td style="text-align:right;padding-top:8px"><strong>${esc(money(totals.total))}</strong></td></tr>
    </table>
    <p style="margin-top:20px"><strong>Shipping to</strong><br/>${esc(ship.full_name)}<br/>${esc(ship.line1)}${ship.line2 ? "<br/>" + esc(ship.line2) : ""}<br/>${esc(ship.city)}, ${esc(ship.state)} ${esc(ship.postal_code)}<br/>${esc(ship.country)}</p>
    ${cod ? `<p style="background:#FFF4DE;padding:10px 12px;border-radius:6px"><strong>Cash on delivery:</strong> please keep <strong>${esc(money(totals.total))}</strong> ready when your order arrives.</p>` : ""}
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

// ── Pre-launch clean-up: remove test data before the shop opens ─────
// Preview orders (no payment was ever taken) can always be removed, and their stock is put back.
// Customers, messages, reviews and subscribers can only be cleared while there are NO real orders,
// so this can never wipe a real customer's data after launch.
async function cleanupCounts() {
  const one = async (sql) => Number((await pool.query(sql))[0][0].n);
  const real = await one("SELECT COUNT(*) AS n FROM orders WHERE payment_mode <> 'simulated'");
  return {
    preview_orders: await one("SELECT COUNT(*) AS n FROM orders WHERE payment_mode = 'simulated'"),
    real_orders: real,
    customers: await one("SELECT COUNT(*) AS n FROM users"),
    messages: await one("SELECT COUNT(*) AS n FROM contact_messages"),
    reviews: await one("SELECT COUNT(*) AS n FROM reviews"),
    subscribers: await one("SELECT COUNT(*) AS n FROM newsletter_subscribers"),
    locked: real > 0,
  };
}
app.get("/api/admin/cleanup", adminRequired, h(async (req, res) => res.json(await cleanupCounts())));
app.post("/api/admin/cleanup", adminRequired, h(async (req, res) => {
  if (req.body.confirm !== "DELETE") throw bad('Type DELETE to confirm.');
  const before = await cleanupCounts();
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    // put back the stock that preview orders took (cancelled ones were already restocked)
    await conn.query(`UPDATE products p JOIN (
        SELECT oi.product_id, SUM(oi.quantity) AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.payment_mode = 'simulated' AND o.status <> 'cancelled' AND oi.product_id IS NOT NULL GROUP BY oi.product_id
      ) t ON t.product_id = p.id SET p.stock_qty = p.stock_qty + t.q`);
    await conn.query("DELETE FROM orders WHERE payment_mode = 'simulated'");   // order items go with them
    if (!before.locked) {
      await conn.query("DELETE FROM users");                  // addresses, carts, wishlists, reset links go with them
      await conn.query("DELETE FROM cart_items");
      await conn.query("DELETE FROM reviews");
      await conn.query("DELETE FROM contact_messages");
      await conn.query("DELETE FROM newsletter_subscribers");
      await conn.query("UPDATE discount_codes SET used_count = 0");
    }
    await conn.commit();
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
  res.json({ success: true, removed: before.locked ? { preview_orders: before.preview_orders } : before, after: await cleanupCounts() });
}));

app.post("/api/admin/change-password", adminRequired, h(async (req, res) => {
  const { current_password, new_password } = req.body;
  if (typeof new_password !== "string" || new_password.length < 10) throw bad("New password must be at least 10 characters.");
  const [[admin]] = await pool.query("SELECT * FROM admin_users WHERE id = ?", [req.admin.id]);
  if (!(await bcrypt.compare(String(current_password || ""), admin.password_hash))) throw bad("Current password is incorrect.");
  if (current_password === new_password) throw bad("The new password must be different from the current one.");
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
  if (order.payment_mode === "razorpay") {
    if (!razorpayOn) throw bad("Razorpay is not configured on this server.");
    await razorpay("POST", `/payments/${encodeURIComponent(order.payment_intent_id)}/refund`, {});
  }
  await pool.query("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", [order.id]);
  res.json({ success: true, mode: order.payment_mode });
}));

// Cash on delivery: record the payment once the courier has collected it
app.post("/api/admin/orders/:id/mark-paid", adminRequired, h(async (req, res) => {
  const [[order]] = await pool.query("SELECT id, payment_status, payment_mode FROM orders WHERE id = ?", [Number(req.params.id)]);
  if (!order) throw new HttpError(404, "Not found");
  if (order.payment_status !== "unpaid") throw bad("This order is not waiting for payment.");
  await pool.query("UPDATE orders SET payment_status = 'paid' WHERE id = ?", [order.id]);
  res.json({ success: true });
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
  let options = null;
  try { options = parseOptionsText(String(b.options_text || "").slice(0, 4000)); } catch (e) { throw bad("Customisation options — " + e.message); }
  p.options = options ? JSON.stringify(options) : null;
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
  res.json(rows.map((r) => ({ ...toBool(r), options_text: formatOptionsText(readOptions(r.options)), gallery: imgs.filter((i) => i.product_id === r.id).map((i) => i.image_url) })));
}));

app.post("/api/admin/products", adminRequired, h(async (req, res) => {
  const { p, gallery } = readProduct(req.body);
  p.slug = await uniqueSlug(p.slug);
  const [r] = await pool.query(`INSERT INTO products (name, price, description, category_id, image_url, is_featured, is_active, stock_qty, slug, meta_title, meta_description, options)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [p.name, p.price, p.description, p.category_id, p.image_url, p.is_featured, p.is_active, p.stock_qty, p.slug, p.meta_title, p.meta_description, p.options]);
  await saveGallery(r.insertId, gallery);
  res.json({ id: r.insertId, slug: p.slug, success: true });
}));

app.put("/api/admin/products/:id", adminRequired, h(async (req, res) => {
  const id = Number(req.params.id);
  const { p, gallery } = readProduct(req.body);
  p.slug = await uniqueSlug(p.slug, id);
  await pool.query(`UPDATE products SET name=?, price=?, description=?, category_id=?, image_url=?, is_featured=?, is_active=?, stock_qty=?, slug=?, meta_title=?, meta_description=?, options=? WHERE id=?`,
    [p.name, p.price, p.description, p.category_id, p.image_url, p.is_featured, p.is_active, p.stock_qty, p.slug, p.meta_title, p.meta_description, p.options, id]);
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
  // Saved in the database so photos survive restarts and redeploys (Render's disk is temporary);
  // the copy on disk is only a cache.
  await pool.query("INSERT INTO uploads (name, mime, size, data) VALUES (?, ?, ?, ?)", [name, IMG_MIME[real], buf.length, buf]);
  try { fs.writeFileSync(path.join(UPLOAD_DIR, name), buf); } catch {}
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
    products: "SELECT p.name, p.slug, c.name AS category, p.price, p.stock_qty, p.is_featured, p.is_active, p.image_url, p.updated_at FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY c.name, p.name",
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
    const legalTodo = missingLegal(STORE);
    if (legalTodo.length) console.warn(`⚠️  Privacy/Terms pages need: ${legalTodo.join(", ")} (set them in the environment)`);
    if (!stripe && !razorpayOn && !COD.enabled && !PREVIEW_CHECKOUT) console.warn("⚠️  No payment method is on (RAZORPAY_* or COD_ENABLED), so checkout shows 'opening soon'.");
    try {
      await pool.query("SELECT 1");
      await ensureDefaultAdmin();
    } catch (e) {
      console.error("✗ Database not reachable:", e.message, "\n  Check MYSQL_* in .env, then run: npm run db:setup");
    }
  });
}

module.exports = app;
