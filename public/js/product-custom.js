/* ============================================================
   Product page extras: customisation fields + live preview,
   price that follows the choices, delivery estimate, WhatsApp,
   sticky "Add to cart" bar on phones, full-screen photo viewer.
   ============================================================ */

function customFieldsHtml(p) {
  const o = p.options;
  if (!o || !o.fields || !o.fields.length) return '';
  const fields = o.fields.map((f) => {
    const id = 'opt_' + f.key;
    if (f.type === 'text') {
      return `<div class="opt-field">
        <label for="${id}">${esc(f.label)}${f.required ? ' <span class="req" aria-hidden="true">*</span>' : ' <span class="opt">(optional)</span>'}</label>
        <input type="text" id="${id}" data-key="${esc(f.key)}" data-type="text" maxlength="${Number(f.max)}" ${f.required ? 'required aria-required="true"' : ''}
          placeholder="${esc(f.placeholder || '')}" autocomplete="off" />
        <span class="opt-count" id="${id}_count">0 / ${Number(f.max)}</span>
      </div>`;
    }
    return `<fieldset class="opt-field opt-choice"><legend>${esc(f.label)}</legend><div class="opt-pills">
      ${f.values.map((v, i) => `<label class="opt-pill"><input type="radio" name="${id}" data-key="${esc(f.key)}" data-type="choice" value="${esc(v.label)}" data-delta="${Number(v.delta) || 0}" ${i === 0 ? 'checked' : ''} />
        <span>${esc(v.label)}${v.delta ? ` <em>${v.delta > 0 ? '+' : '−'}${fmt(Math.abs(v.delta)).replace(/\.00$/, '')}</em>` : ''}</span></label>`).join('')}
    </div></fieldset>`;
  }).join('');
  const preview = o.preview ? `<div class="opt-preview" aria-live="polite"><p class="opt-preview-label">Live preview</p><div id="optPreview"></div><p class="opt-preview-note">A guide to the layout — we send you a proper design proof before cutting.</p></div>` : '';
  return `<div class="custom-box" id="customBox"><p class="custom-title">Make it yours</p>${fields}${preview}<p class="opt-error" id="optError" role="alert"></p></div>`;
}

function readCustomization() {
  const values = {}, missing = [];
  let delta = 0;
  document.querySelectorAll('#customBox [data-type="text"]').forEach((el) => {
    const v = el.value.trim(); if (v) values[el.dataset.key] = v; else if (el.required) missing.push(el);
  });
  document.querySelectorAll('#customBox [data-type="choice"]:checked').forEach((el) => {
    values[el.dataset.key] = el.value; delta += Number(el.dataset.delta) || 0;
  });
  return { values, missing, delta };
}

const MATERIAL_LOOK = [
  [/teak/i, { bg: 'linear-gradient(135deg,#b07a45,#8a5a2f)', ink: '#2b1d10', edge: '#6e4523' }],
  [/acrylic/i, { bg: 'linear-gradient(135deg,#f4f1ec,#d9d2c6)', ink: '#3E362B', edge: '#a07e59' }],
  [/natural|birch|oak/i, { bg: 'linear-gradient(135deg,#e2c9a0,#caa877)', ink: '#3E362B', edge: '#a8865a' }],
  [/black/i, { bg: 'linear-gradient(135deg,#3a3530,#22201c)', ink: '#E9DFD0', edge: '#000' }],
  [/.*/, { bg: 'linear-gradient(135deg,#6b4a2e,#4a3220)', ink: '#F3E6D2', edge: '#2e1f13' }],   // walnut stain (default)
];

function renderPreview(p) {
  const box = document.getElementById('optPreview'); if (!box) return;
  const { values } = readCustomization();
  const fields = p.options.fields;
  const texts = fields.filter((f) => f.type === 'text');
  const material = Object.entries(values).find(([k]) => /material|finish/.test(k));
  const look = MATERIAL_LOOK.find(([re]) => re.test(material ? material[1] : ''))[1];
  const main = values[texts[0]?.key] || texts[0]?.placeholder || 'Your name here';
  const second = texts[1] ? (values[texts[1].key] || texts[1].placeholder || '') : '';
  if (p.options.preview === 'round') {
    box.innerHTML = `<div class="pv-round" style="background:${look.bg};border-color:${look.edge}">
      <span class="pv-greet" style="color:${look.ink}">${esc(second || 'Welcome')}</span>
      <span class="pv-main" style="color:${look.ink}">${esc(main)}</span></div>`;
  } else {
    box.innerHTML = `<div class="pv-plate" style="background:${look.bg};border-color:${look.edge}">
      <span class="pv-main" style="color:${look.ink}">${esc(main)}</span>
      ${second ? `<span class="pv-sub" style="color:${look.ink}">${esc(second)}</span>` : ''}
      <span class="pv-screw a"></span><span class="pv-screw b"></span></div>`;
  }
  const fit = box.querySelector('.pv-main');   // shrink long names to fit the board
  if (fit) { let size = 30; fit.style.fontSize = size + 'px'; while (fit.scrollWidth > fit.clientWidth && size > 12) fit.style.fontSize = (--size) + 'px'; }
}

function updateCustomUi(p) {
  const { delta } = readCustomization();
  const price = Number(p.price) + delta;
  const priceEl = document.querySelector('.product-price'); if (priceEl) priceEl.textContent = fmt(price);
  const bar = document.getElementById('stickyPrice'); if (bar) bar.textContent = fmt(price);
  document.querySelectorAll('#customBox [data-type="text"]').forEach((el) => {
    const c = document.getElementById(el.id + '_count'); if (c) c.textContent = `${el.value.length} / ${el.maxLength}`;
  });
  if (p.options && p.options.preview) renderPreview(p);
}

function deliveryHtml(p) {
  const w = deliveryWindow(p.made_to_order_days);
  return `<div class="delivery-box" id="deliveryBox">
    <div class="delivery-row"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 7h11v9H3zM14 10h4l3 3v3h-7z"/><circle cx="7" cy="17.5" r="1.6"/><circle cx="17" cy="17.5" r="1.6"/></svg>
      <div><strong id="deliveryText">Delivery by ${esc(w.text)}</strong>
      <span class="delivery-sub">${p.made_to_order_days ? `Made to order — dispatched within ${w.dispatch} working days` : `Dispatched within ${w.dispatch} working days`}</span></div></div>
    <form class="pin-form" onsubmit="event.preventDefault(); checkPin();">
      <label for="pinInput" class="sr-only">PIN code</label>
      <input id="pinInput" inputmode="numeric" maxlength="6" placeholder="Enter PIN code" autocomplete="postal-code" />
      <button type="submit">Check</button>
    </form>
    <p class="pin-msg" id="pinMsg" role="status"></p>
  </div>`;
}
function checkPin() {
  const v = document.getElementById('pinInput').value.trim(), msg = document.getElementById('pinMsg');
  if (!/^[1-9]\d{5}$/.test(v)) { msg.textContent = 'Please enter a valid 6-digit PIN code.'; msg.className = 'pin-msg err'; return; }
  try { localStorage.setItem('ao_pin', v); } catch {}
  const w = deliveryWindow(window.__product && window.__product.made_to_order_days);
  msg.textContent = `We deliver to ${v} — estimated ${w.text}.`; msg.className = 'pin-msg ok';
}

function whatsappHref(p) {
  const s = storeInfo(), { values } = readCustomization();
  const fields = (p.options && p.options.fields) || [];
  const picked = fields.filter(f => values[f.key]).map(f => `${f.label}: ${values[f.key]}`).join(' · ');
  const chosen = picked ? `\nMy choices so far: ${picked}` : '';
  return waLink(`Hi ${s.name || ''}, I'm interested in "${p.name}" (${location.origin + productUrl(p)}). Can you help me with size, finish or a custom version?${chosen}`);
}

function stickyBarHtml(p) {
  return `<div class="sticky-buy" id="stickyBuy" aria-hidden="true">
    <div class="sticky-info"><span class="sticky-name">${esc(p.name)}</span><span class="sticky-price" id="stickyPrice">${fmt(p.price)}</span></div>
    <button type="button" class="btn-primary" ${p.stock_qty <= 0 ? 'disabled' : ''} onclick="document.getElementById('addBtn').click()">${p.stock_qty <= 0 ? 'Out of stock' : p.customisable ? 'Add to cart' : 'Add to cart'}</button>
  </div>`;
}

function openLightbox(index) {
  const p = window.__product, imgs = (p && p.gallery) || [];
  if (!imgs.length) return;
  let i = index || 0;
  const lb = document.createElement('div');
  lb.className = 'lightbox'; lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Product photos');
  const draw = () => { lb.querySelector('img').src = imgs[i]; lb.querySelector('.lb-count').textContent = `${i + 1} / ${imgs.length}`; };
  lb.innerHTML = `<button class="lb-close" aria-label="Close">×</button>${imgs.length > 1 ? '<button class="lb-prev" aria-label="Previous photo">‹</button><button class="lb-next" aria-label="Next photo">›</button>' : ''}
    <img alt="${esc(p.name)}" /><span class="lb-count"></span>`;
  const close = () => { lb.remove(); document.body.style.overflow = ''; document.removeEventListener('keydown', key); };
  const step = (d) => { i = (i + d + imgs.length) % imgs.length; draw(); };
  const key = (e) => { if (e.key === 'Escape') close(); if (e.key === 'ArrowRight') step(1); if (e.key === 'ArrowLeft') step(-1); };
  lb.addEventListener('click', (e) => { if (e.target === lb || e.target.classList.contains('lb-close')) close(); if (e.target.classList.contains('lb-prev')) step(-1); if (e.target.classList.contains('lb-next')) step(1); });
  let x0 = null;
  lb.addEventListener('touchstart', (e) => { if (e.touches.length === 1) x0 = e.touches[0].clientX; }, { passive: true });
  lb.addEventListener('touchend', (e) => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 50 && imgs.length > 1) step(dx < 0 ? 1 : -1); x0 = null; });
  document.addEventListener('keydown', key);
  document.body.appendChild(lb); document.body.style.overflow = 'hidden'; draw(); lb.querySelector('.lb-close').focus();
}

function initProductExtras(p) {
  window.__product = p;
  const box = document.getElementById('customBox');
  if (box) {
    box.addEventListener('input', () => { updateCustomUi(p); document.getElementById('optError').textContent = ''; box.querySelectorAll('.field-invalid').forEach((e) => e.classList.remove('field-invalid')); });
    box.addEventListener('change', () => updateCustomUi(p));
    updateCustomUi(p);
  }
  try { const pin = localStorage.getItem('ao_pin'); if (pin) { document.getElementById('pinInput').value = pin; checkPin(); } } catch {}
  const main = document.getElementById('mainProductImg');
  if (main) { main.style.cursor = 'zoom-in'; main.addEventListener('click', () => openLightbox((p.gallery || []).indexOf(main.getAttribute('src')) || 0)); }
  // Sticky buy bar appears once the main "Add to cart" button scrolls out of view (phones only, via CSS)
  if (!document.getElementById('stickyBuy')) document.body.insertAdjacentHTML('beforeend', stickyBarHtml(p));
  const bar = document.getElementById('stickyBuy'), btn = document.getElementById('addBtn');
  if (btn && 'IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => { const show = !e.isIntersecting && e.boundingClientRect.top < 0; bar.classList.toggle('show', show); bar.setAttribute('aria-hidden', String(!show)); }).observe(btn);
  }
}

/** Called by Add to cart: returns customization values, or null (and highlights fields) if something required is missing. */
function collectCustomizationOrWarn() {
  if (!document.getElementById('customBox')) return {};
  const { values, missing } = readCustomization();
  if (missing.length) {
    missing.forEach((el) => el.classList.add('field-invalid'));
    const label = missing[0].closest('.opt-field').querySelector('label').textContent.replace('*', '').trim();
    document.getElementById('optError').textContent = `Please fill in "${label}" so we know what to engrave.`;
    missing[0].scrollIntoView({ behavior: 'smooth', block: 'center' }); missing[0].focus({ preventScroll: true });
    return null;
  }
  return values;
}
