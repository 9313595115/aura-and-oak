// ============================================================
//  Privacy policy and Terms & conditions.
//  Written for an Indian online store (IT Act 2000, DPDP Act 2023,
//  Consumer Protection (E-Commerce) Rules 2020). The business details
//  come from .env so the owner never edits code:
//    LEGAL_NAME, LEGAL_ADDRESS, GSTIN, LEGAL_JURISDICTION,
//    GRIEVANCE_OFFICER_NAME, GRIEVANCE_OFFICER_EMAIL, GRIEVANCE_OFFICER_PHONE,
//    POLICY_UPDATED
//  Have a lawyer or CA review them before launch.
// ============================================================

function legalDetails(STORE) {
  const address = process.env.LEGAL_ADDRESS
    || [STORE.street, STORE.city, STORE.region, STORE.postal_code].filter(Boolean).join(", ");
  return {
    name: process.env.LEGAL_NAME || STORE.name,
    trade: STORE.name,
    address,
    gstin: (process.env.GSTIN || "").toUpperCase(),
    jurisdiction: process.env.LEGAL_JURISDICTION || STORE.city || "",
    email: STORE.email,
    phone: STORE.phone,
    grievance: {
      name: process.env.GRIEVANCE_OFFICER_NAME || "",
      email: process.env.GRIEVANCE_OFFICER_EMAIL || STORE.email,
      phone: process.env.GRIEVANCE_OFFICER_PHONE || STORE.phone,
    },
    updated: process.env.POLICY_UPDATED || "24 November 2026",
  };
}

// What the owner still has to fill in (shown in the server log, never on the site)
function missingLegal(STORE) {
  const d = legalDetails(STORE), miss = [];
  if (!process.env.LEGAL_NAME) miss.push("LEGAL_NAME");
  if (!d.address) miss.push("LEGAL_ADDRESS (or STORE_STREET/STORE_CITY)");
  if (!d.grievance.name) miss.push("GRIEVANCE_OFFICER_NAME");
  if (!d.grievance.email) miss.push("GRIEVANCE_OFFICER_EMAIL (or STORE_EMAIL)");
  return miss;
}

function sellerBlock(d, esc) {
  const tel = String(d.phone || "").replace(/[^\d+]/g, "");
  return `<div class="legal-card">
    <p><strong>${esc(d.name)}</strong>${d.name !== d.trade ? ` (trading as ${esc(d.trade)})` : ""}</p>
    ${d.address ? `<p>${esc(d.address)}</p>` : ""}
    ${d.gstin ? `<p>GSTIN: ${esc(d.gstin)}</p>` : ""}
    <p>${d.email ? `Email: <a href="mailto:${esc(d.email)}">${esc(d.email)}</a>` : ""}${d.email && d.phone ? " · " : ""}${d.phone ? `Phone: <a href="tel:${esc(tel)}">${esc(d.phone)}</a>` : ""}</p>
  </div>`;
}

function grievanceBlock(d, esc) {
  const g = d.grievance, tel = String(g.phone || "").replace(/[^\d+]/g, "");
  return `<div class="legal-card" id="grievance-officer">
    <p><strong>Grievance officer</strong></p>
    ${g.name ? `<p>${esc(g.name)}, ${esc(d.name)}</p>` : `<p>${esc(d.name)}</p>`}
    ${d.address ? `<p>${esc(d.address)}</p>` : ""}
    <p>${g.email ? `Email: <a href="mailto:${esc(g.email)}">${esc(g.email)}</a>` : ""}${g.email && g.phone ? " · " : ""}${g.phone ? `Phone: <a href="tel:${esc(tel)}">${esc(g.phone)}</a>` : ""}</p>
    <p>We acknowledge every complaint within 48 hours and aim to resolve it within one month of receiving it.</p>
  </div>`;
}

function privacyHtml(STORE, { payments }, esc) {
  const d = legalDetails(STORE);
  const pay = payments.length ? payments.join(" and ") : "our payment partner";
  return `
  <h1>Privacy policy</h1>
  <p class="sub">Last updated ${esc(d.updated)}. This policy explains what personal information ${esc(d.trade)} collects through this website, why we collect it, and the choices you have.</p>

  <h2>Who we are</h2>
  <p>This website is run by:</p>
  ${sellerBlock(d, esc)}

  <h2>What we collect</h2>
  <ul>
    <li><strong>When you order:</strong> your name, email, phone number, delivery address, the items you buy and any text or choices you enter to personalise them.</li>
    <li><strong>When you create an account:</strong> your name, email and a password. We store only a scrambled (hashed) version of the password, never the password itself.</li>
    <li><strong>When you contact us</strong> through the contact or quote form, WhatsApp, email or phone: your message and the contact details you give us.</li>
    <li><strong>When you join our mailing list:</strong> your email address.</li>
    <li><strong>When you write a review:</strong> your name as you enter it, your rating and comment.</li>
    <li><strong>Payments:</strong> card, UPI and bank details are entered directly with ${esc(pay)}. We never see or store your full card number or UPI PIN; we only receive a payment reference and whether the payment succeeded.</li>
  </ul>

  <h2>Why we use it</h2>
  <ul>
    <li>To make, ship and deliver your order, and to send order and shipping updates.</li>
    <li>To reply to your questions, quotes and complaints.</li>
    <li>To process refunds, returns and exchanges.</li>
    <li>To keep the records that tax and accounting laws require.</li>
    <li>To send newsletters, only if you signed up. Every newsletter has a way to unsubscribe.</li>
    <li>To keep the website secure and stop fraud and abuse.</li>
  </ul>
  <p>We do not sell or rent your personal information to anyone.</p>

  <h2>Who we share it with</h2>
  <p>Only with the services we need to run the shop, and only what each one needs:</p>
  <ul>
    <li><strong>Payment partners</strong> (${esc(pay)}) to take payments and issue refunds.</li>
    <li><strong>Courier and transport partners</strong> to deliver your order (name, phone and address).</li>
    <li><strong>Email delivery service</strong> to send order emails and replies.</li>
    <li><strong>Website hosting and database providers</strong> that store the website and its data.</li>
    <li><strong>Government authorities</strong> when the law requires it.</li>
  </ul>
  <p>Some of these providers may store data on servers outside India. We use providers that protect data with industry-standard security.</p>

  <h2>Cookies and browser storage</h2>
  <p>We don't use advertising or tracking cookies. The website saves a few small items in your browser so it works: your cart, whether you're signed in, and the PIN code you last checked for delivery. You can clear them at any time in your browser settings; you'll be signed out and your cart will empty. The site loads its fonts from Google Fonts, which receives your device's IP address when it does.</p>

  <h2>How long we keep it</h2>
  <p>Order and invoice records are kept for as long as tax and accounting laws require (generally up to 8 years). Account details are kept until you ask us to delete your account. Contact messages are deleted once they're no longer needed. Mailing list addresses are removed as soon as you unsubscribe.</p>

  <h2>How we protect it</h2>
  <p>The website uses HTTPS encryption, passwords are hashed, and access to customer records is limited to the people who run the shop. No system is perfectly secure, but we take reasonable care and will tell you promptly if a breach affects your data, as the law requires.</p>

  <h2>Your rights</h2>
  <p>Under India's Digital Personal Data Protection Act, 2023 you can ask us to:</p>
  <ul>
    <li>tell you what personal information we hold about you;</li>
    <li>correct or update it (you can also do this yourself in <a href="/account.html">My account</a>);</li>
    <li>delete it, unless the law requires us to keep it;</li>
    <li>stop sending you marketing emails;</li>
    <li>withdraw your consent at any time.</li>
  </ul>
  <p>Email or write to our grievance officer below. We'll reply within 30 days.</p>

  <h2>Children</h2>
  <p>This shop is meant for adults. If you are under 18, please order with the help of a parent or guardian.</p>

  <h2>Questions and complaints</h2>
  ${grievanceBlock(d, esc)}

  <h2>Changes to this policy</h2>
  <p>If we change this policy, we'll update the date at the top of this page. Big changes will also be shown on the website or sent to you by email.</p>`;
}

function termsHtml(STORE, { payments, cod }, esc, fmt) {
  const d = legalDetails(STORE);
  const methods = [...payments, ...(cod ? ["cash on delivery"] : [])];
  return `
  <h1>Terms &amp; conditions</h1>
  <p class="sub">Last updated ${esc(d.updated)}. By using this website or placing an order, you agree to these terms. Please read them along with our <a href="/privacy">privacy policy</a>, <a href="/shipping">shipping information</a> and <a href="/returns">returns policy</a>.</p>

  <h2>About us</h2>
  <p>This website and the products sold on it are provided by:</p>
  ${sellerBlock(d, esc)}

  <h2>Products</h2>
  <ul>
    <li>Our pieces are cut on CNC machines and finished by hand. Natural wood varies in grain and colour, so your piece may differ slightly from the photos. These natural differences are not defects.</li>
    <li>Sizes are given in centimetres and may vary by a few millimetres.</li>
    <li>Colours can look different on different screens.</li>
  </ul>

  <h2>Personalised and custom orders</h2>
  <ul>
    <li>We cut exactly the names, text and choices you enter. Please check spelling, size and finish carefully before you order.</li>
    <li>For custom designs, we may send you a design to approve before cutting. Work starts once you approve it.</li>
    <li>Personalised and custom-made pieces can't be returned or exchanged unless they arrive damaged or differ from what you ordered or approved. See our <a href="/returns">returns policy</a>.</li>
    <li>Please only send us names, logos or images you have the right to use. We may refuse designs that are offensive, unlawful or that copy someone else's work.</li>
  </ul>

  <h2>Prices and payment</h2>
  <ul>
    <li>Prices are in Indian rupees (${esc(STORE.currency)}).${STORE.tax_rate > 0 ? ` ${esc(STORE.tax_label)} is added at checkout.` : " Prices shown are final; any applicable taxes are included."} Shipping is shown at checkout before you pay.</li>
    <li>The price is fixed when you place your order. If a price on the website is clearly wrong because of a mistake, we'll contact you before going ahead and you may cancel for a full refund.</li>
    <li>${methods.length ? `We accept ${esc(methods.join(", "))}.` : "Accepted payment methods are shown at checkout."} Online payments are handled securely by our payment partner.</li>
    <li>Discount codes have their own conditions, shown when you apply them. Only one code can be used per order.</li>
  </ul>

  <h2>Orders</h2>
  <ul>
    <li>When you place an order you'll receive a confirmation email. This confirms we've received your order.</li>
    <li>We may cancel an order if an item is unavailable, a payment fails, or we suspect fraud. If you've already paid, we'll refund you in full.</li>
    <li>You can cancel an order free of charge before we start cutting it. Contact us as soon as possible. Once production of a personalised or custom piece has started, it can't be cancelled.</li>
  </ul>

  <h2>Delivery</h2>
  <p>Delivery times shown on the website are estimates. Large panels may travel by transport and take longer. Full details are on our <a href="/shipping">shipping page</a>. Please check your parcel when it arrives and tell us about any damage within 48 hours, with photos of the parcel and the piece.</p>

  <h2>Returns and refunds</h2>
  <p>Ready designs can be returned within ${Number(STORE.return_days) || 30} days if unused and in their original packaging. Refunds go back to the original payment method, usually within 5–7 business days after we receive the return. Cash-on-delivery orders are refunded to your bank account or UPI. Full details are on our <a href="/returns">returns page</a>.</p>

  <h2>Your account</h2>
  <p>Keep your password private. You're responsible for orders placed from your account. Tell us straight away if you think someone else has used it.</p>

  <h2>Reviews and messages</h2>
  <p>Reviews must be honest and about a product you bought. We may remove reviews or messages that are abusive, unlawful, misleading or advertising.</p>

  <h2>Our designs and content</h2>
  <p>The designs, photos, text and logo on this website belong to ${esc(d.trade)}. You may not copy them or use them for commercial purposes without our written permission. Personal sharing with a link back to us is welcome.</p>

  <h2>Our responsibility</h2>
  <p>If something we sell you is faulty or not as described, you're entitled to a repair, replacement or refund under Indian consumer law, and nothing in these terms takes those rights away. Beyond that, our total responsibility for any order is limited to the amount you paid for it, and we're not responsible for indirect losses or for delays caused by events outside our control, such as natural disasters, strikes or courier disruptions.</p>

  <h2>Complaints and grievance officer</h2>
  <p>If you're unhappy with anything, please contact us first and we'll do our best to put it right. In line with the Consumer Protection (E-Commerce) Rules, 2020, our grievance officer is:</p>
  ${grievanceBlock(d, esc)}

  <h2>Governing law</h2>
  <p>These terms are governed by the laws of India.${d.jurisdiction ? ` Any dispute will be handled by the courts of ${esc(d.jurisdiction)}, without affecting your right to approach a consumer commission.` : ""}</p>

  <h2>Changes to these terms</h2>
  <p>We may update these terms from time to time. The version shown when you place your order applies to that order.</p>`;
}

module.exports = { legalDetails, missingLegal, privacyHtml, termsHtml };
