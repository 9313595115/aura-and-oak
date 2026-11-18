-- ============================================================
--  Aura & Oak — sample data. Safe to re-run: unique keys on
--  slug / code / (product_id,image_url) make INSERT IGNORE skip
--  rows that already exist (v2 duplicated products on re-run).
-- ============================================================

INSERT IGNORE INTO categories (name, slug, image_url) VALUES
  ('Textiles',  'textiles',  '/images/pillow.jpg'),
  ('Lighting',  'lighting',  '/images/lamp.jpg'),
  ('Decor',     'decor',     '/images/vase.jpg'),
  ('Furniture', 'furniture', '/images/table.jpg'),
  ('Art',       'art',       '/images/art.jpg'),
  ('Rugs',      'rugs',      '/images/rug.jpg');

INSERT IGNORE INTO products (name, price, description, category_id, image_url, is_featured, stock_qty, slug, meta_title, meta_description) VALUES
  ('Linen Throw Pillow Set',          68.00, 'A set of two perfectly weighted linen throw pillows in a muted natural tone. Removable covers, feather-down insert.',                      (SELECT id FROM categories WHERE slug='textiles'),  '/images/pillow.jpg',  1, 45, 'linen-throw-pillow-set',     'Linen Throw Pillow Set | Aura & Oak',      'Shop the Linen Throw Pillow Set - natural tone linen with removable, feather-down covers.'),
  ('Aged Brass Table Lamp',          189.00, 'Hand-finished aged brass base with a warm linen shade. Gives off a golden, amber glow that transforms any room.',                         (SELECT id FROM categories WHERE slug='lighting'),  '/images/lamp.jpg',    1, 20, 'aged-brass-table-lamp',      'Aged Brass Table Lamp | Aura & Oak',       'A hand-finished aged brass table lamp with a warm linen shade. Elevate any room with a golden, amber glow.'),
  ('Hand-thrown Ceramic Vase',        95.00, 'Each piece is unique — thrown by hand on a wheel and fired in a wood-burning kiln. Slight variations in glaze are intentional.',          (SELECT id FROM categories WHERE slug='decor'),     '/images/vase.jpg',    1, 32, 'hand-thrown-ceramic-vase',   'Hand-thrown Ceramic Vase | Aura & Oak',    'A one-of-a-kind hand-thrown ceramic vase, fired in a wood-burning kiln. No two are alike.'),
  ('Merino Wool Blanket',            145.00, '100% New Zealand merino wool. Breathable, temperature-regulating, and impossibly soft. Available in four natural colorways.',             (SELECT id FROM categories WHERE slug='textiles'),  '/images/blanket.jpg', 1, 55, 'merino-wool-blanket',        'Merino Wool Blanket | Aura & Oak',         '100% New Zealand merino wool blanket - breathable, temperature-regulating, and impossibly soft.'),
  ('Reclaimed Oak Side Table',       320.00, 'Cut from sustainably harvested reclaimed oak. Each table carries the natural character of the wood — grain, knots, and all.',             (SELECT id FROM categories WHERE slug='furniture'), '/images/table.jpg',   0,  8, 'reclaimed-oak-side-table',   'Reclaimed Oak Side Table | Aura & Oak',    'A side table cut from sustainably harvested reclaimed oak, carrying the natural grain and character of the wood.'),
  ('Abstract Canvas Print',          210.00, 'Original abstract painting reproduced on museum-quality canvas. Ships stretched and ready to hang.',                                     (SELECT id FROM categories WHERE slug='art'),       '/images/art.jpg',     0, 15, 'abstract-canvas-print',      'Abstract Canvas Print | Aura & Oak',       'Museum-quality canvas reproduction of an original abstract painting. Ships stretched and ready to hang.'),
  ('Soy Wax Candle — Amber & Cedar',  42.00, 'Hand-poured soy wax with a cotton wick. Notes of warm amber, cedarwood, and a hint of sandalwood. Burns for 60+ hours.',              (SELECT id FROM categories WHERE slug='decor'),     '/images/candle.jpg',  0, 80, 'soy-wax-candle-amber-cedar', 'Soy Wax Candle Amber & Cedar | Aura & Oak','Hand-poured soy wax candle with notes of amber, cedarwood, and sandalwood. Burns 60+ hours.'),
  ('Jute Area Rug 5x8',              275.00, 'Natural jute fibers hand-woven into a flat-weave rug. Durable enough for high-traffic areas, beautiful enough to anchor a living room.', (SELECT id FROM categories WHERE slug='rugs'),      '/images/rug.jpg',     0, 12, 'jute-area-rug-5x8',          'Jute Area Rug 5x8 | Aura & Oak',           'A hand-woven flat-weave jute area rug, durable for high-traffic spaces and beautiful enough to anchor a room.');

INSERT IGNORE INTO product_images (product_id, image_url, sort_order)
  SELECT id, '/images/hero.jpg', 1 FROM products WHERE slug = 'linen-throw-pillow-set';

INSERT IGNORE INTO discount_codes (code, type, value, min_subtotal, active) VALUES
  ('WELCOME10', 'percent',       10.00, 0,     1),
  ('FREESHIP',  'free_shipping',  0.00, 75.00, 1);

INSERT IGNORE INTO reviews (id, product_id, name, rating, comment) VALUES
  (1, (SELECT id FROM products WHERE slug='linen-throw-pillow-set'), 'Priya S.',  5, 'These pillows are gorgeous — the linen feels substantial and the color is exactly as pictured.'),
  (2, (SELECT id FROM products WHERE slug='linen-throw-pillow-set'), 'Marcus T.', 4, 'Lovely quality. Wish they came in a bit brighter tone but very happy overall.'),
  (3, (SELECT id FROM products WHERE slug='aged-brass-table-lamp'),  'Elena R.',  5, 'This lamp made my whole living room feel warmer. Worth every penny.'),
  (4, (SELECT id FROM products WHERE slug='hand-thrown-ceramic-vase'),'Dana K.',  5, 'Each vase really is unique. Mine has a beautiful drip glaze pattern.');

-- No admin is seeded here: server.js creates one on first boot
-- (password from ADMIN_INITIAL_PASSWORD, or a random one printed once).
