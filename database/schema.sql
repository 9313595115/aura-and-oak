-- ============================================================
--  Aura & Oak — MySQL / MariaDB schema (v3)
--  Fresh install:   npm run db:setup      (runs this + seed.sql + upgrades)
--  Manual:          mysql -u USER -p DB < database/schema.sql
--
--  Safe to re-run: CREATE TABLE IF NOT EXISTS everywhere.
--  Upgrading an existing v2 database? `npm run db:setup` adds the
--  new columns/indexes for you (see scripts/migrate.js).
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  name      VARCHAR(100) NOT NULL,
  slug      VARCHAR(100) NOT NULL UNIQUE,
  image_url VARCHAR(500)
);

CREATE TABLE IF NOT EXISTS products (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  name             VARCHAR(255)  NOT NULL,
  price            DECIMAL(10,2) NOT NULL,
  description      TEXT,
  category_id      INT,
  image_url        VARCHAR(500),
  is_featured      TINYINT(1)    DEFAULT 0,
  is_active        TINYINT(1)    NOT NULL DEFAULT 1,
  stock_qty        INT           DEFAULT 100,
  slug             VARCHAR(255),
  meta_title       VARCHAR(255),
  meta_description VARCHAR(500),
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_product_slug (slug),
  KEY idx_products_category (category_id),
  FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS product_images (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  image_url  VARCHAR(500) NOT NULL,
  sort_order INT DEFAULT 0,
  UNIQUE KEY uniq_product_image (product_id, image_url),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS addresses (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  user_id     INT NOT NULL,
  full_name   VARCHAR(255) NOT NULL,
  line1       VARCHAR(255) NOT NULL,
  line2       VARCHAR(255),
  city        VARCHAR(120) NOT NULL,
  state       VARCHAR(120),
  postal_code VARCHAR(30)  NOT NULL,
  country     VARCHAR(120) NOT NULL DEFAULT 'United States',
  phone       VARCHAR(40),
  is_default  TINYINT(1) DEFAULT 0,
  created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cart_items (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  user_id    INT DEFAULT NULL,
  product_id INT NOT NULL,
  quantity   INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_cart_session (session_id),
  KEY idx_cart_user (user_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS discount_codes (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  code         VARCHAR(60) NOT NULL UNIQUE,
  type         ENUM('percent','fixed','free_shipping') NOT NULL DEFAULT 'percent',
  value        DECIMAL(10,2) NOT NULL DEFAULT 0,
  min_subtotal DECIMAL(10,2) DEFAULT 0,
  max_uses     INT DEFAULT NULL,
  used_count   INT NOT NULL DEFAULT 0,
  active       TINYINT(1) DEFAULT 1,
  expires_at   DATE DEFAULT NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id                   INT AUTO_INCREMENT PRIMARY KEY,
  order_number         VARCHAR(40) NOT NULL UNIQUE,
  user_id              INT DEFAULT NULL,
  session_id           VARCHAR(255),
  email                VARCHAR(255) NOT NULL,
  status               ENUM('pending','paid','processing','shipped','completed','cancelled') NOT NULL DEFAULT 'pending',
  subtotal             DECIMAL(10,2) NOT NULL,
  discount_code        VARCHAR(60),
  discount_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  shipping_amount      DECIMAL(10,2) NOT NULL DEFAULT 0,
  tax_amount           DECIMAL(10,2) NOT NULL DEFAULT 0,
  total                DECIMAL(10,2) NOT NULL,
  currency             VARCHAR(3) NOT NULL DEFAULT 'USD',
  shipping_full_name   VARCHAR(255),
  shipping_line1       VARCHAR(255),
  shipping_line2       VARCHAR(255),
  shipping_city        VARCHAR(120),
  shipping_state       VARCHAR(120),
  shipping_postal_code VARCHAR(30),
  shipping_country     VARCHAR(120),
  shipping_phone       VARCHAR(40),
  payment_status       ENUM('unpaid','paid','failed','refunded') NOT NULL DEFAULT 'unpaid',
  payment_intent_id    VARCHAR(255),
  payment_mode         ENUM('stripe','simulated') NOT NULL DEFAULT 'simulated',
  carrier              VARCHAR(80),
  tracking_number      VARCHAR(120),
  admin_note           TEXT,
  created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_payment_intent (payment_intent_id),
  KEY idx_orders_user (user_id),
  KEY idx_orders_email (email),
  KEY idx_orders_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS order_items (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  order_id   INT NOT NULL,
  product_id INT,
  name       VARCHAR(255) NOT NULL,
  price      DECIMAL(10,2) NOT NULL,
  quantity   INT NOT NULL,
  image_url  VARCHAR(500),
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  product_id INT NOT NULL,
  user_id    INT DEFAULT NULL,
  name       VARCHAR(255) NOT NULL,
  rating     TINYINT NOT NULL,
  comment    TEXT,
  verified   TINYINT(1) NOT NULL DEFAULT 0,
  is_hidden  TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  KEY idx_reviews_product (product_id),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (rating BETWEEN 1 AND 5)
);

CREATE TABLE IF NOT EXISTS wishlists (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  user_id    INT NOT NULL,
  product_id INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_wish (user_id, product_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_users (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(120) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  email      VARCHAR(255) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id         INT AUTO_INCREMENT PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  email      VARCHAR(255) NOT NULL,
  phone      VARCHAR(40),
  subject    VARCHAR(255),
  message    TEXT NOT NULL,
  is_read    TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
