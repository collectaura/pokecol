// Robot PokéVault : récupère les fichiers publics de Cardmarket et prépare les données de l'appli.
// Lancé automatiquement par GitHub Actions (voir .github/workflows/update-prices.yml).
import fs from 'node:fs';
import zlib from 'node:zlib';

const GUIDE_URL = (process.env.CM_PRICE_GUIDE_URL || '').trim();
const PRODUCT_URLS = (process.env.CM_PRODUCTS_URLS || '').split(/[\s,]+/).filter(Boolean);
const HISTORY_DAYS = 730;
const DIR = 'data';

if (!GUIDE_URL) {
  console.error('Variable CM_PRICE_GUIDE_URL manquante : ajoute le lien du guide des prix Cardmarket dans Settings > Secrets and variables > Actions > Variables.');
  process.exit(1);
}

async function getJSON(url) {
  let buf;
  if (/^https?:/i.test(url)) {
    const res = await fetch(url, { headers: { 'User-Agent': 'PokeVault-Tracker (suivi de collection personnel)' } });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    buf = fs.readFileSync(url.replace(/^file:\/\//, ''));      // utile pour tester en local
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);   // fichiers compressés
  return JSON.parse(buf.toString('utf8'));
}
function rowsOf(j) {
  if (Array.isArray(j)) return j;
  if (j && Array.isArray(j.fields) && Array.isArray(j.rows)) return j.rows.map(r => Object.fromEntries(j.fields.map((f, i) => [f, r[i]])));
  for (const k of ['priceGuides', 'priceGuide', 'products', 'data', 'items', 'rows']) if (j && Array.isArray(j[k])) return j[k];
  const a = j && typeof j === 'object' && Object.values(j).find(Array.isArray);
  return a || [];
}
const pick = (r, ...ks) => { for (const k of ks) if (r[k] != null && r[k] !== '') return r[k]; return null; };
const n = v => (v == null || v === '' || !isFinite(+v)) ? null : Math.round(+v * 100) / 100;
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

fs.mkdirSync(DIR, { recursive: true });

// 1. Catalogue des produits (cartes et scellé)
const sealed = new Set();
if (PRODUCT_URLS.length) {
  const rows = [];
  for (const url of PRODUCT_URLS) {
    const j = await getJSON(url);
    const isNonSingles = /non.?single/i.test(url);
    for (const r of rowsOf(j)) {
      const id = n(pick(r, 'idProduct', 'id_product', 'productId', 'id'));
      const name = pick(r, 'name', 'enName', 'productName');
      if (id == null || !name) continue;
      const cat = String(pick(r, 'categoryName', 'category', 'type') || (isNonSingles ? 'Sealed' : 'Single'));
      const exp = String(pick(r, 'expansionName', 'expansion', 'setName') || '');
      rows.push([id, String(name), cat, exp]);
      if (isNonSingles || !/single/i.test(cat)) sealed.add(id);
    }
  }
  write(`${DIR}/catalog.json`, { createdAt: new Date().toISOString(), fields: ['idProduct', 'name', 'categoryName', 'expansionName'], rows });
  console.log(`Catalogue : ${rows.length} produits, dont ${sealed.size} scellés.`);
} else {
  const old = readJSON(`${DIR}/catalog.json`, null);
  if (old) for (const r of old.rows) if (!/single/i.test(r[2])) sealed.add(r[0]);
}

// 2. Guide des prix du jour
const g = await getJSON(GUIDE_URL);
const created = String((g && (g.createdAt || g.sourceCreatedAt || g.generatedAt)) || new Date().toISOString()).slice(0, 10);
const F = ['idProduct', 'trend', 'avg1', 'avg7', 'avg30', 'low', 'trend-holo', 'avg7-holo', 'avg30-holo'];
const latest = [];
for (const r of rowsOf(g)) {
  const id = n(pick(r, 'idProduct', 'id_product', 'productId', 'id'));
  if (id == null) continue;
  const row = [id, n(r.trend), n(r.avg1), n(r.avg7), n(r.avg30), n(r.low), n(pick(r, 'trend-holo', 'trend-foil', 'trendHolo')), n(pick(r, 'avg7-holo', 'avg7-foil', 'avg7Holo')), n(pick(r, 'avg30-holo', 'avg30-foil', 'avg30Holo'))];
  if (row.slice(1).some(v => v != null)) latest.push(row);
}
if (!latest.length) { console.error('Guide des prix vide ou format non reconnu.'); process.exit(1); }
write(`${DIR}/latest.json`, { createdAt: created, fields: F, rows: latest });
console.log(`Guide des prix du ${created} : ${latest.length} produits.`);

// 3. Historique : tout le scellé, plus les cartes listées dans data/tracked.json
const tracked = new Set(readJSON(`${DIR}/tracked.json`, []).map(Number));
const hist = readJSON(`${DIR}/history.json`, { fields: ['d', 'trend', 'avg1', 'avg7', 'avg30', 'low'], products: {} });
let added = 0;
for (const r of latest) {
  const id = r[0];
  if (!sealed.has(id) && !tracked.has(id)) continue;
  const pts = (hist.products[id] ||= []);
  if (pts.length && pts[pts.length - 1][0] === created) continue;     // déjà enregistré pour ce jour
  pts.push([created, r[1], r[2], r[3], r[4], r[5]]);
  if (pts.length > HISTORY_DAYS) pts.splice(0, pts.length - HISTORY_DAYS);
  added++;
}
hist.updatedAt = created;
write(`${DIR}/history.json`, hist);
console.log(`Historique : ${added} nouveaux points, ${Object.keys(hist.products).length} produits suivis.`);
