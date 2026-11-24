// ============================================================
//  Product customisation options
//
//  Owners write options as simple lines in the admin panel:
//
//    text* Name to engrave | 40 | The Sharma Family     ← * = required · max length · placeholder
//    text House number | 10
//    choice Size: 45 × 15 cm, 60 × 20 cm (+700)        ← first value is the default; (+700) adds ₹700
//    choice Material: Walnut-stained MDF, Teak wood (+600)
//    preview nameplate                                  ← live preview: nameplate | round
//    days 5                                             ← extra working days to make it (made to order)
//
//  Stored on the product as JSON: { fields: [...], preview, days }.
//  The customer's choices are validated here and the price is always
//  computed on the server from the product's own option list.
// ============================================================
"use strict";

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
const keyOf = (label) => clean(label, 60).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "option";

/** Lines → options object (throws Error with a friendly message on bad input). Empty → null. */
function parseOptionsText(text) {
  const lines = String(text || "").split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (!lines.length) return null;
  const out = { fields: [], preview: null, days: 0 };
  const seen = new Set();
  lines.forEach((line, i) => {
    const n = i + 1;
    let m;
    if ((m = /^text(\*?)\s+(.+)$/i.exec(line))) {
      const [label, max, placeholder] = m[2].split("|").map((s) => s.trim());
      if (!label) throw new Error(`Line ${n}: a text option needs a label.`);
      const field = { type: "text", key: keyOf(label), label: clean(label, 60), required: m[1] === "*",
        max: Math.min(Math.max(parseInt(max, 10) || 40, 1), 200), placeholder: clean(placeholder || "", 80) };
      if (seen.has(field.key)) throw new Error(`Line ${n}: "${label}" is listed twice.`);
      seen.add(field.key); out.fields.push(field);
    } else if ((m = /^choice\s+([^:]+):\s*(.+)$/i.exec(line))) {
      const label = clean(m[1], 60);
      const values = m[2].split(",").map((v) => v.trim()).filter(Boolean).map((v) => {
        const d = /\(\s*([+-])\s*(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)\s*\)\s*$/i.exec(v);
        const delta = d ? (d[1] === "-" ? -1 : 1) * Number(d[2].replace(/,/g, "")) : 0;
        return { label: clean(d ? v.slice(0, d.index) : v, 80), delta };
      }).filter((v) => v.label);
      if (values.length < 2) throw new Error(`Line ${n}: "${label}" needs at least two values separated by commas.`);
      const field = { type: "choice", key: keyOf(label), label, values };
      if (seen.has(field.key)) throw new Error(`Line ${n}: "${label}" is listed twice.`);
      seen.add(field.key); out.fields.push(field);
    } else if ((m = /^preview\s+(nameplate|round)\s*$/i.exec(line))) {
      out.preview = m[1].toLowerCase();
    } else if ((m = /^days\s+(\d{1,2})\s*$/i.exec(line))) {
      out.days = Number(m[1]);
    } else {
      throw new Error(`Line ${n} isn't understood: "${line.slice(0, 40)}". Start lines with text, text*, choice, preview or days.`);
    }
  });
  if (out.fields.length > 8) throw new Error("Up to 8 options per product, please.");
  return out;
}

/** Options object → editable lines for the admin panel. */
function formatOptionsText(opts) {
  if (!opts || !opts.fields) return "";
  const lines = opts.fields.map((f) => f.type === "text"
    ? `text${f.required ? "*" : ""} ${f.label} | ${f.max}${f.placeholder ? ` | ${f.placeholder}` : ""}`
    : `choice ${f.label}: ${f.values.map((v) => v.label + (v.delta ? ` (${v.delta > 0 ? "+" : "-"}${Math.abs(v.delta)})` : "")).join(", ")}`);
  if (opts.preview) lines.push(`preview ${opts.preview}`);
  if (opts.days) lines.push(`days ${opts.days}`);
  return lines.join("\n");
}

function readOptions(raw) {
  if (!raw) return null;
  try { const o = typeof raw === "string" ? JSON.parse(raw) : raw; return o && Array.isArray(o.fields) && o.fields.length ? o : null; }
  catch { return null; }
}

/**
 * Validate a customer's choices against the product's options.
 * Returns { values, summary, delta, key } — values in field order, a readable summary,
 * the price adjustment, and a stable key used to merge identical cart lines.
 */
function applyCustomization(optsRaw, input) {
  const opts = readOptions(optsRaw);
  if (!opts) return { values: null, summary: "", delta: 0, key: "" };
  input = input && typeof input === "object" ? input : {};
  const values = {}, parts = [];
  let delta = 0;
  for (const f of opts.fields) {
    if (f.type === "text") {
      const v = clean(input[f.key], f.max);
      if (!v && f.required) { const e = new Error(`Please enter "${f.label}".`); e.status = 400; throw e; }
      if (v) { values[f.key] = v; parts.push(`${f.label}: ${v}`); }
    } else {
      const wanted = clean(input[f.key], 80);
      const choice = f.values.find((x) => x.label === wanted) || f.values[0];   // default = first value
      values[f.key] = choice.label; delta += Number(choice.delta) || 0; parts.push(`${f.label}: ${choice.label}`);
    }
  }
  return { values, summary: parts.join(" · "), delta: Math.round(delta * 100) / 100, key: parts.length ? JSON.stringify(values) : "" };
}

module.exports = { parseOptionsText, formatOptionsText, readOptions, applyCustomization };
