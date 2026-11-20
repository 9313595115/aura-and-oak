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
      <div class="cart-drawer-header"><h2>Your Cart</h2>
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
      <div class="drawer-item-info"><a href="${esc(productUrl(i))}">${esc(i.name)}</a><span>Qty ${i.quantity} · ${fmt(i.price * i.quantity)}</span></div>
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
      : `<a href="/account.html" class="nav-account-link">Sign In</a>`;
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

  if (s.whatsapp && !document.getElementById('waFab') && !/admin|checkout/.test(location.pathname)) {
    const a = document.createElement('a');
    a.id = 'waFab'; a.className = 'wa-fab'; a.target = '_blank'; a.rel = 'noopener'; a.setAttribute('aria-label', 'Chat with us on WhatsApp');
    a.href = `https://wa.me/${encodeURIComponent(s.whatsapp)}?text=${encodeURIComponent('Hi ' + (s.name || '') + ', I have a question')}`;
    a.innerHTML = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M20.5 3.5A11.8 11.8 0 0 0 12 0C5.4 0 0 5.4 0 12c0 2.1.6 4.2 1.6 6L0 24l6.2-1.6a12 12 0 0 0 5.8 1.5c6.6 0 12-5.4 12-12 0-3.2-1.2-6.2-3.5-8.4zM12 21.9c-1.8 0-3.6-.5-5.1-1.4l-.4-.2-3.7 1 1-3.6-.2-.4A9.9 9.9 0 0 1 2.1 12C2.1 6.5 6.5 2.1 12 2.1s9.9 4.4 9.9 9.9-4.4 9.9-9.9 9.9zm5.4-7.4c-.3-.1-1.8-.9-2-1s-.5-.1-.7.1-.8 1-.9 1.2-.3.2-.6.1a8.1 8.1 0 0 1-4-3.5c-.3-.5.3-.5.9-1.6.1-.2 0-.4 0-.5l-.9-2.2c-.2-.6-.5-.5-.7-.5h-.6c-.2 0-.5.1-.8.4-.3.3-1 1-1 2.5s1.1 2.9 1.2 3.1 2.1 3.2 5.1 4.5c1.9.8 2.6.9 3.6.7.6-.1 1.8-.7 2-1.4.3-.7.3-1.3.2-1.4l-.6-.2z"/></svg>';
    document.body.appendChild(a);
  }
}

// ── Boot
document.addEventListener('DOMContentLoaded', () => {
  getSessionId();
  renderAccountSlot();
  initMobileNav();
  applyStoreInfo();
  getConfig().then(applyStoreInfo);
  document.querySelectorAll('[data-cart-trigger]').forEach(el => el.addEventListener('click', (e) => { e.preventDefault(); openCartDrawer(); }));
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCartDrawer(); });
  if (document.getElementById('cartCount')) loadCartCount();
});
