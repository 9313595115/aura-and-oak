// ============================================================
//  npm run db:setup   — creates tables, upgrades a v2 database
//                       in place, then loads sample data.
//  npm run db:setup -- --no-seed   — skip sample data
//
//  Idempotent: run it after every deploy.
// ============================================================
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const mysql = require("mysql2/promise");

const DB = process.env.MYSQL_DATABASE || "aura_oak";

async function columnExists(conn, table, column) {
  const [r] = await conn.query(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [DB, table, column]
  );
  return r.length > 0;
}
async function indexExists(conn, table, index) {
  const [r] = await conn.query(
    "SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ?",
    [DB, table, index]
  );
  return r.length > 0;
}
async function addColumn(conn, table, column, ddl) {
  if (!(await columnExists(conn, table, column))) {
    await conn.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    console.log(`  + ${table}.${column}`);
  }
}
async function addIndex(conn, table, index, ddl) {
  if (!(await indexExists(conn, table, index))) {
    await conn.query(`ALTER TABLE ${table} ADD ${ddl}`);
    console.log(`  + index ${table}.${index}`);
  }
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    multipleStatements: true,
    // Hosted MySQL (Aiven, TiDB Cloud…) needs TLS: set MYSQL_SSL=true, and
    // MYSQL_SSL_CA to the provider's CA certificate if it uses its own.
    ssl: process.env.MYSQL_SSL === "true"
      ? (process.env.MYSQL_SSL_CA ? { ca: process.env.MYSQL_SSL_CA.replace(/\\n/g, "\n") } : {})
      : undefined,
  });
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${DB}\``);

  console.log("Applying schema…");
  await conn.query(fs.readFileSync(path.join(__dirname, "..", "database", "schema.sql"), "utf8"));

  console.log("Upgrading older databases (no-op on fresh installs)…");
  await addColumn(conn, "products", "is_active", "TINYINT(1) NOT NULL DEFAULT 1");
  await addColumn(conn, "products", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  // Give every product a unique slug before enforcing uniqueness
  await conn.query(`
    UPDATE products SET slug = CONCAT(
      TRIM(BOTH '-' FROM LOWER(REGEXP_REPLACE(name, '[^A-Za-z0-9]+', '-'))), '-', id)
    WHERE slug IS NULL OR slug = ''`);
  await conn.query(`
    UPDATE products p JOIN (
      SELECT slug, MIN(id) AS keep_id FROM products GROUP BY slug HAVING COUNT(*) > 1
    ) d ON d.slug = p.slug AND p.id <> d.keep_id
    SET p.slug = CONCAT(p.slug, '-', p.id)`);
  await addIndex(conn, "products", "uniq_product_slug", "UNIQUE KEY uniq_product_slug (slug)");
  await conn.query(`DELETE a FROM product_images a JOIN product_images b
                    ON a.product_id = b.product_id AND a.image_url = b.image_url AND a.id > b.id`);
  await addIndex(conn, "product_images", "uniq_product_image", "UNIQUE KEY uniq_product_image (product_id, image_url)");
  await addIndex(conn, "cart_items", "idx_cart_session", "KEY idx_cart_session (session_id)");

  await conn.query("ALTER TABLE discount_codes MODIFY type ENUM('percent','fixed','free_shipping') NOT NULL DEFAULT 'percent'");
  await addColumn(conn, "discount_codes", "max_uses", "INT DEFAULT NULL");
  await addColumn(conn, "discount_codes", "used_count", "INT NOT NULL DEFAULT 0");
  await conn.query("UPDATE discount_codes SET type = 'free_shipping', value = 0 WHERE code = 'FREESHIP' AND type = 'fixed'");

  await addColumn(conn, "orders", "currency", "VARCHAR(3) NOT NULL DEFAULT 'USD'");
  await addColumn(conn, "orders", "carrier", "VARCHAR(80)");
  await addColumn(conn, "orders", "tracking_number", "VARCHAR(120)");
  await addColumn(conn, "orders", "admin_note", "TEXT");
  await addColumn(conn, "orders", "updated_at", "TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
  await addIndex(conn, "orders", "uniq_payment_intent", "UNIQUE KEY uniq_payment_intent (payment_intent_id)");
  await addIndex(conn, "orders", "idx_orders_email", "KEY idx_orders_email (email)");

  await addColumn(conn, "reviews", "verified", "TINYINT(1) NOT NULL DEFAULT 0");
  await addColumn(conn, "reviews", "is_hidden", "TINYINT(1) NOT NULL DEFAULT 0");

  // ── One-time rebrand: Eagle CNC Art & Craft home-decor samples → Eagle CNC Art & Craft catalogue.
  // Runs only while the old sample rows still exist (matched by their original slugs) and
  // updates them IN PLACE, so order history and carts keep pointing at valid products.
  const [[oldSample]] = await conn.query("SELECT COUNT(*) AS n FROM products WHERE slug = 'aged-brass-table-lamp'");
  if (oldSample.n > 0) {
    console.log("Rebranding sample catalogue to Eagle CNC Art & Craft…");
    const cats = [
      ["textiles", "Wall Art", "wall-art", "/images/world-map-wall-art.jpg"],
      ["lighting", "Name Plates", "name-plates", "/images/name-plate.jpg"],
      ["decor", "Mandir & Spiritual", "mandir", "/images/ganesha-panel.jpg"],
      ["furniture", "Jali & Panels", "jali-panels", "/images/om-jali-panel.jpg"],
      ["art", "Wall Clocks", "clocks", "/images/wall-clock.jpg"],
      ["rugs", "Gifts & Accessories", "gifts", "/images/coasters.jpg"],
    ];
    for (const [oldSlug, name, slug, img] of cats)
      await conn.query("UPDATE categories SET name = ?, slug = ?, image_url = ? WHERE slug = ? AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM categories WHERE slug = ?) x)", [name, slug, img, oldSlug, slug]);
    // old sample slug → new slug; the rest of each row comes from seed.sql
    const map = {
      "linen-throw-pillow-set": "carved-mandala-wall-art", "aged-brass-table-lamp": "personalised-wooden-name-plate",
      "hand-thrown-ceramic-vase": "om-jali-mandir-panel", "merino-wool-blanket": "geometric-wooden-coasters-set",
      "reclaimed-oak-side-table": "decorative-jali-partition-panel", "abstract-canvas-print": "world-map-wooden-wall-art",
      "soy-wax-candle-amber-cedar": "minimal-wooden-wall-clock", "jute-area-rug-5x8": "ganesha-mandir-back-panel",
    };
    const seedSql = fs.readFileSync(path.join(__dirname, "..", "database", "seed.sql"), "utf8");
    for (const [oldSlug, newSlug] of Object.entries(map)) {
      const [[row]] = await conn.query("SELECT id FROM products WHERE slug = ?", [oldSlug]);
      if (!row) continue;
      // Pull the new product's values straight out of seed.sql so there is one source of truth
      const m = new RegExp(`\\('([^']+)',\\s*([\\d.]+),\\s*'([^']+)',\\s*\\(SELECT id FROM categories WHERE slug='([^']+)'\\),\\s*'([^']+)',\\s*(\\d),\\s*(\\d+),\\s*'${newSlug}',\\s*'([^']+)',\\s*'([^']+)'\\)`).exec(seedSql);
      if (!m) { console.warn(`  ! no seed row for ${newSlug}`); continue; }
      const [, name, price, desc, catSlug, img, featured, stock, metaTitle, metaDesc] = m;
      await conn.query(`UPDATE products SET name = ?, price = ?, description = ?, category_id = (SELECT id FROM categories WHERE slug = ?),
        image_url = ?, is_featured = ?, stock_qty = ?, slug = ?, meta_title = ?, meta_description = ? WHERE id = ?`,
        [name, price, desc, catSlug, img, featured, stock, newSlug, metaTitle, metaDesc, row.id]);
      await conn.query("DELETE FROM product_images WHERE product_id = ?", [row.id]);   // old decor gallery photos
      await conn.query("DELETE FROM reviews WHERE product_id = ?", [row.id]);          // reviews were about the old item
      console.log(`  ~ ${oldSlug} → ${newSlug}`);
    }
    await conn.query("UPDATE discount_codes SET min_subtotal = 1499 WHERE code = 'FREESHIP' AND min_subtotal IN (75, 150)");
  }

  if (!process.argv.includes("--no-seed")) {
    console.log("Loading sample data (existing rows are left alone)…");
    await conn.query(fs.readFileSync(path.join(__dirname, "..", "database", "seed.sql"), "utf8"));
  }
  await conn.end();
  console.log(`\n✓ Database "${DB}" is ready.`);
})().catch((e) => {
  console.error("\n✗ Database setup failed:", e.message);
  console.error("  Check MYSQL_* values in .env and that MySQL/MariaDB is running.");
  process.exit(1);
});
