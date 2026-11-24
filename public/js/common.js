/* ============================================================
   Eagle CNC Art & Craft — shared front-end helpers (loaded on every page)
   API client, auth, cart drawer, mobile nav, money formatting,
   HTML escaping, stars, stock badges, wishlist, store info.
   ============================================================ */

// ── Safety: escape anything user- or database-supplied before it goes into innerHTML
function esc(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}
// For values placed inside a JS string inside an HTML attribute (onclick="fn('...')")
function escJs(v) { return esc(String(v ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")); }

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ── Session id for guest carts
function getSessionId() {
  let id = store.get('ao_session');
  if (!id || !/^[\w-]{8,64}$/.test(id)) {
    id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
    store.set('ao_session', id);
  }
  return id;
}

// ── Auth
function getToken() { return store.get('ao_token'); }
function getUser() { try { return JSON.parse(store.get('ao_user') || 'null'); } catch { return null; } }
function isLoggedIn() { return !!getToken() && !!getUser(); }
function setAuth(token, user) { store.set('ao_token', token); store.set('ao_user', JSON.stringify(user)); }
function clearAuth() { store.del('ao_token'); store.del('ao_user'); }

// ── API client: JSON, auth header, guest session header, friendly errors
async function api(path, options = {}) {
  const headers = Object.assign({ 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() }, options.headers || {});
  const token = getToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try { res = await fetch(path, Object.assign({}, options, { headers })); }
  catch { throw new Error('Network error — please check your connection.'); }
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && token && !path.startsWith('/api/auth/login')) { clearAuth(); renderAccountSlot(); }
  if (!res.ok) throw new Error((data && data.error) || 'Something went wrong. Please try again.');
  return data;
}

// ── Store config (currency, contact details, shipping rules)
let __cfg = null, __cfgPromise = null;
try { __cfg = JSON.parse(sessionStorage.getItem('ao_cfg') || 'null'); } catch {}
function getConfig() {
  if (!__cfgPromise) {
    __cfgPromise = fetch('/api/config').then(r => r.json()).then(c => {
      __cfg = c; try { sessionStorage.setItem('ao_cfg', JSON.stringify(c)); } catch {}
      return c;
    }).catch(() => __cfg || { store: {} });
  }
  return __cfgPromise;
}
// wa.me link to the store with a ready-written message ('' when WhatsApp is off)
function waLink(text) {
  const n = String(storeInfo().whatsapp || '').replace(/\D/g, '');
  return n ? `https://wa.me/${n}${text ? '?text=' + encodeURIComponent(text) : ''}` : '';
}
const WA_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';
function storeInfo() { return (__cfg && __cfg.store) || {}; }

function fmt(n) {
  const s = storeInfo();
  try { return new Intl.NumberFormat(s.locale || 'en-US', { style: 'currency', currency: s.currency || 'USD' }).format(Number(n) || 0); }
  catch { return '$' + (Number(n) || 0).toFixed(2); }
}

// Bundled photos in /images/ ship with WebP copies (name.webp + a small name-sm.webp).
// Returns a srcset attribute for those so phones download the small file; '' for anything else.
function imgSrcset(url) {
  const m = /^\/?images\/([\w-]+)\.jpg$/.exec(String(url || ''));
  const v = (__cfg && __cfg.imgVariants) || [];
  return m && v.includes(m[1]) ? `srcset="/images/${m[1]}-sm.webp 600w, /images/${m[1]}.webp 1000w"` : '';
}

function productUrl(p) {
  return p && p.slug ? '/product/' + encodeURIComponent(p.slug) : '/product.html?id=' + encodeURIComponent((p && (p.product_id || p.id)) || '');
}

// ── Toast
function showToastGlobal(msg) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  t.setAttribute('role', 'status');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

// ── Ratings + stock
function renderStars(avg, count) {
  count = Number(count) || 0;
  if (!count) return '<span class="review-count">No reviews yet</span>';
  const r = Math.round(Number(avg) || 0);
  return `<span class="stars" aria-label="Rated ${esc(avg)} out of 5">${'★'.repeat(r)}<span class="star-empty">${'★'.repeat(5 - r)}</span></span> <span class="review-count">${esc(Number(avg).toFixed(1))} (${count})</span>`;
}
function stockBadge(qty) {
  qty = Number(qty);
  if (qty <= 0) return '<span class="stock-badge out">Out of stock</span>';
  if (qty < 10) return `<span class="stock-badge low">Only ${qty} left</span>`;
  return '';
}

// ── Wishlist
async function toggleWishlist(productId, btn) {
  if (!isLoggedIn()) {
    showToastGlobal('Sign in to save items to your wishlist');
    setTimeout(() => { location.href = '/account.html?next=' + encodeURIComponent(location.pathname + location.search); }, 900);
    return;
  }
  const active = btn && btn.classList.contains('active');
  try {
    if (active) await api('/api/wishlist/' + productId, { method: 'DELETE' });
    else await api('/api/wishlist', { method: 'POST', body: JSON.stringify({ product_id: productId }) });
    if (btn) { btn.classList.toggle('active', !active); btn.setAttribute('aria-pressed', String(!active)); }
    showToastGlobal(active ? 'Removed from wishlist' : 'Saved to wishlist');
  } catch (e) { showToastGlobal(e.message); }
}

// ── Cart count + slide-in drawer
async function fetchCart() {
  try { return await api('/api/cart'); } catch { return []; }
}
async function loadCartCount() {
  const items = await fetchCart();
  const n = items.reduce((s, i) => s + Number(i.quantity), 0);
  document.querySelectorAll('#cartCount, .cart-count').forEach(el => {
    el.textContent = n; el.style.display = n ? 'flex' : 'none';
  });
  return items;
}

function ensureCartDrawer() {
  if (document.getElementById('cartDrawer')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="cart-drawer-overlay" id="cartDrawerOverlay"></div>
    <aside class="cart-drawer" id="cartDrawer" aria-label="Shopping cart" aria-hidden="true">
      <div class="cart-drawer-header"><h2>Your cart</h2>
        <button class="drawer-close" id="cartDrawerClose" aria-label="Close cart">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button></div>
      <div class="cart-drawer-body" id="cartDrawerBody"></div>
      <div class="cart-drawer-footer" id="cartDrawerFooter"></div>
    </aside>`;
  document.body.append(...wrap.children);
  document.getElementById('cartDrawerOverlay').addEventListener('click', closeCartDrawer);
  document.getElementById('cartDrawerClose').addEventListener('click', closeCartDrawer);
}
async function openCartDrawer() {
  ensureCartDrawer();
  const drawer = document.getElementById('cartDrawer');
  drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
  document.getElementById('cartDrawerOverlay').classList.add('open');
  const body = document.getElementById('cartDrawerBody'), foot = document.getElementById('cartDrawerFooter');
  body.innerHTML = '<p class="drawer-empty">Loading…</p>'; foot.innerHTML = '';
  await getConfig();
  const items = await loadCartCount();
  if (!items.length) {
    body.innerHTML = '<p class="drawer-empty">Your cart is empty.</p>';
    foot.innerHTML = '<a href="/shop.html" class="btn-primary drawer-btn">Browse the Shop</a>';
    return;
  }
  const subtotal = items.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
  const s = storeInfo(), left = (s.free_shipping_threshold || 0) - subtotal;
  body.innerHTML = items.map(i => `
    <div class="drawer-item">
      <img src="${esc(i.image_url)}" alt="${esc(i.name)}" />
      <div class="drawer-item-info"><a href="${esc(productUrl(i))}">${esc(i.name)}</a>${i.customization_summary ? `<small class="item-custom">${esc(i.customization_summary)}</small>` : ''}<span>Qty ${i.quantity} · ${fmt(i.price * i.quantity)}</span></div>
      <button class="drawer-remove" aria-label="Remove ${esc(i.name)}" onclick="drawerRemove(${Number(i.id)})">×</button>
    </div>`).join('');
  foot.innerHTML = `
    ${left > 0 && s.free_shipping_threshold ? `<p class="drawer-note">Add ${fmt(left)} more for free shipping</p>` : '<p class="drawer-note">You qualify for free shipping ✓</p>'}
    <div class="drawer-subtotal"><span>Subtotal</span><strong>${fmt(subtotal)}</strong></div>
    <a href="/checkout.html" class="btn-primary drawer-btn">Checkout</a>
    <a href="/cart.html" class="drawer-link">View full cart</a>`;
}
async function drawerRemove(id) {
  try { await api('/api/cart/' + id, { method: 'DELETE' }); openCartDrawer(); } catch (e) { showToastGlobal(e.message); }
}
function closeCartDrawer() {
  const d = document.getElementById('cartDrawer');
  if (d) { d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); }
  const o = document.getElementById('cartDrawerOverlay'); if (o) o.classList.remove('open');
}

// ── Nav: account link, hamburger
function renderAccountSlot() {
  const user = getUser();
  document.querySelectorAll('.nav-account-slot').forEach(slot => {
    slot.innerHTML = user && getToken()
      ? `<a href="/account.html" class="nav-account-link">Hi, ${esc(String(user.name || '').split(' ')[0] || 'there')}</a>`
      : `<a href="/account.html" class="nav-account-link">Sign in</a>`;
  });
}
function initMobileNav() {
  const btn = document.getElementById('hamburgerBtn'), drawer = document.getElementById('mobileNavDrawer'),
        overlay = document.getElementById('mobileNavOverlay'), close = document.getElementById('mobileNavClose');
  if (!btn || !drawer) return;
  const set = (open) => {
    drawer.classList.toggle('open', open); if (overlay) overlay.classList.toggle('open', open);
    btn.setAttribute('aria-expanded', String(open)); document.body.style.overflow = open ? 'hidden' : '';
  };
  btn.addEventListener('click', () => set(true));
  if (close) close.addEventListener('click', () => set(false));
  if (overlay) overlay.addEventListener('click', () => set(false));
  drawer.querySelectorAll('a').forEach(a => a.addEventListener('click', () => set(false)));
  if (!drawer.querySelector('a[href*="contact"]')) {
    const a = document.createElement('a'); a.href = '/contact.html'; a.textContent = 'Contact & Visit'; drawer.appendChild(a);
  }
}

// ── Store details: footer NAP block, WhatsApp button, [data-money], [data-year], [data-store]
function applyStoreInfo() {
  const s = storeInfo();
  document.querySelectorAll('[data-year]').forEach(el => el.textContent = new Date().getFullYear());
  document.querySelectorAll('[data-money]').forEach(el => {
    const key = el.dataset.money, v = isNaN(key) ? s[key] : Number(key);
    if (v !== undefined && v !== null) el.textContent = fmt(v);
  });
  document.querySelectorAll('[data-store]').forEach(el => { const v = s[el.dataset.store]; if (v !== undefined && v !== '') el.textContent = v; });

  const addr = [s.street, [s.city, s.region].filter(Boolean).join(', '), s.postal_code].filter(Boolean).join(', ');
  document.querySelectorAll('[data-store-nap]').forEach(el => {
    el.innerHTML = [
      addr && `<span>📍 ${s.maps_url ? `<a href="${esc(s.maps_url)}" target="_blank" rel="noopener">${esc(addr)}</a>` : esc(addr)}</span>`,
      s.phone && `<span>📞 <a href="tel:${esc(s.phone.replace(/[^\d+]/g, ''))}">${esc(s.phone)}</a></span>`,
      s.email && `<span>✉️ <a href="mailto:${esc(s.email)}">${esc(s.email)}</a></span>`,
      s.hours_display && `<span>🕒 ${esc(s.hours_display)}</span>`,
    ].filter(Boolean).join('');
  });

  // Social links in the footer (only those that are set in the store settings)
  document.querySelectorAll('[data-store-social]').forEach(el => {
    const ig = s.instagram_url || s.instagram, fb = s.facebook_url || s.facebook;
    el.innerHTML = [
      ig && `<a href="${esc(ig)}" target="_blank" rel="noopener" aria-label="Instagram"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r="1" fill="currentColor"/></svg></a>`,
      fb && `<a href="${esc(fb)}" target="_blank" rel="noopener" aria-label="Facebook"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v8h4v-8h3l1-4h-4V8z"/></svg></a>`,
      s.whatsapp && `<a href="https://wa.me/${esc(s.whatsapp)}" target="_blank" rel="noopener" aria-label="WhatsApp"><svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm4.5 12.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3c.2-.6.2-1.1.1-1.3l-.5-.3z"/></svg></a>`,
    ].filter(Boolean).join('');
  });

  if (s.whatsapp && !document.getElementById('waFab') && !/admin|checkout|order-confirmation|reset-password/.test(location.pathname)) {
    const a = document.createElement('a');
    a.id = 'waFab'; a.className = 'wa-fab'; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', 'Chat with us on WhatsApp'); a.title = 'Chat with us on WhatsApp';
    const page = document.querySelector('h1') ? document.querySelector('h1').textContent.trim() : '';
    a.href = waLink(`Hi ${s.name || ''}, I have a question` + (/\/product\//.test(location.pathname) && page ? ` about "${page}" (${location.href})` : '') + '.');
    a.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M20.5 3.5A11.8 11.8 0 0 0 12 0C5.4 0 0 5.4 0 12c0 2.1.6 4.2 1.6 6L0 24l6.2-1.6a12 12 0 0 0 5.8 1.5c6.6 0 12-5.4 12-12 0-3.2-1.2-6.2-3.5-8.4zM12 21.9c-1.8 0-3.6-.5-5.1-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.9 9.9 0 0 1 2.1 12C2.1 6.5 6.5 2.1 12 2.1s9.9 4.4 9.9 9.9-4.4 9.9-9.9 9.9zm5.4-7.4c-.3-.1-1.8-.9-2-1s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.1 8.1 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1 2.1 3.2 5.1 4.5c1.9.8 2.6.9 3.6.7.6-.1 1.8-.7 2-1.4.3-.7.3-1.3.2-1.4l-.6-.2z"/></svg>';
    document.body.appendChild(a);
  }
}

// ── Boot
document.addEventListener('DOMContentLoaded', () => {
  // Gentle fade-up as sections scroll into view (skipped for people who prefer reduced motion)
  if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.documentElement.classList.add('motion');
    document.querySelectorAll('.product-card, .category-card, .eh-steps li, .section-title, .story-img, .eh-quote-inner, .svc, .mat, .gallery a')
      .forEach(el => el.classList.add('reveal'));
    const io = new IntersectionObserver((entries) => entries.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px' });
    const watch = (root) => root.querySelectorAll('.reveal:not(.in)').forEach((el, i) => { el.style.setProperty('--d', (i % 4) * 70 + 'ms'); io.observe(el); });
    watch(document);
    // Safety nets: never leave content hidden — reveal anything already on/above screen after fast scrolls or
    // anchor jumps, everything before printing, and everything after a few seconds if the observer is slow.
    const sweep = () => document.querySelectorAll('.reveal:not(.in)').forEach(el => { if (el.getBoundingClientRect().top < innerHeight) el.classList.add('in'); });
    let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(sweep, 120); }, { passive: true });
    addEventListener('load', () => setTimeout(sweep, 300));
    addEventListener('beforeprint', () => document.querySelectorAll('.reveal').forEach(el => el.classList.add('in')));
    setTimeout(() => document.querySelectorAll('.reveal:not(.in)').forEach(el => el.classList.add('in')), 6000);
    // product grids drawn later by script get the same treatment
    new MutationObserver((ms) => ms.forEach(m => m.addedNodes.forEach(n => { if (n.nodeType === 1) { if (n.matches('.product-card, .category-card')) n.classList.add('reveal'); n.querySelectorAll && n.querySelectorAll('.product-card, .category-card').forEach(c => c.classList.add('reveal')); watch(n.parentNode || document); } })))
      .observe(document.body, { childList: true, subtree: true });
  }
  // Soft shadow under the shared header once the page scrolls
  const siteNav = document.querySelector('nav.site-nav');
  if (siteNav) { const t = () => siteNav.classList.toggle('scrolled', window.scrollY > 8); t(); window.addEventListener('scroll', t, { passive: true }); }
  getSessionId();
  renderAccountSlot();
  initMobileNav();
  applyStoreInfo();
  getConfig().then(applyStoreInfo);
  document.querySelectorAll('[data-cart-trigger]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); openCartDrawer(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCartDrawer(); });
  if (document.getElementById('cartCount')) loadCartCount();
});

// ── Product cards (shared by home, shop and product pages) ─────────────────
// Badges only show what is true: customisable, made to order, popular (real sales), low stock.
function productBadges(p) {
  const b = [];
  if (p.popular) b.push('<span class="pbadge pbadge-popular">Popular</span>');
  if (p.customisable) b.push('<span class="pbadge">Customisable</span>');
  if (p.made_to_order_days) b.push(`<span class="pbadge pbadge-quiet">Made to order</span>`);
  return b.join('');
}
function cardMarkup(p, addFn) {
  const out = p.stock_qty <= 0, url = productUrl(p);
  const sizes = '(max-width: 640px) 46vw, 300px';
  const alt = p.alt_image ? `<img class="card-alt" src="${esc(p.alt_image)}" ${imgSrcset(p.alt_image)} sizes="${sizes}" alt="" loading="lazy" decoding="async" aria-hidden="true" />` : '';
  // Customisable pieces need choices first, so the quick button opens the product instead of adding to cart
  const quick = p.customisable
    ? `<a class="overlay-btn add" href="${esc(url)}">Customise</a>`
    : `<button class="overlay-btn add" ${out ? 'disabled' : ''} onclick="${addFn}(${Number(p.id)}, '${escJs(p.name)}')">${out ? 'Sold out' : 'Add to cart'}</button>`;
  const rating = Number(p.review_count) > 0 ? `<div class="card-rating">${renderStars(p.avg_rating, p.review_count)}</div>` : '';
  return `
    <div class="product-card${p.alt_image ? ' has-alt' : ''}">
      <div class="product-card-img">
        <a href="${esc(url)}" aria-label="${esc(p.name)}"><img src="${esc(p.image_url)}" ${imgSrcset(p.image_url)} sizes="${sizes}" width="1000" height="1250" alt="${esc(p.name)}" loading="lazy" decoding="async" />${alt}</a>
        <div class="card-badges">${productBadges(p)}</div>
        <div class="product-card-overlay"><a class="overlay-btn" href="${esc(url)}">View</a>${quick}</div>
      </div>
      <div class="product-card-body">
        <p class="product-card-category">${esc(p.category || '')}</p>
        <h3 class="product-card-name"><a href="${esc(url)}">${esc(p.name)}</a></h3>
        <p class="product-card-price">${p.customisable ? '<span class="from">From</span> ' : ''}${fmt(p.price)}</p>
        ${rating}
        ${p.stock_qty > 0 && p.stock_qty < 10 ? `<div style="margin-top:6px">${stockBadge(p.stock_qty)}</div>` : out ? `<div style="margin-top:6px">${stockBadge(0)}</div>` : ''}
      </div>
    </div>`;
}

// ── Delivery estimate: working days, Sundays skipped ───────────────────────
function addWorkingDays(date, n) {
  const d = new Date(date);
  while (n > 0) { d.setDate(d.getDate() + 1); if (d.getDay() !== 0) n--; }
  return d;
}
function deliveryWindow(makeDays) {
  const s = storeInfo();
  const dispatch = Math.max(Number(s.dispatch_days ?? 2), Number(makeDays) || 0);
  const from = addWorkingDays(new Date(), dispatch + Number(s.transit_min ?? 3));
  const to = addWorkingDays(new Date(), dispatch + Number(s.transit_max ?? 7));
  const f = (d) => d.toLocaleDateString(s.locale || 'en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
  return { dispatch, from, to, text: `${f(from)} – ${f(to)}` };
}
