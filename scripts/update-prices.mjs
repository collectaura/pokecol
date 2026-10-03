// Robot PokéVault : construit chaque jour le catalogue et les prix Cardmarket utilisés par l'appli.
// - Scellé : catalogue officiel Cardmarket (un produit = un prix).
// - Cartes : base TCGdex (noms français, numéros, extensions), qui donne pour chaque carte son identifiant Cardmarket.
// Lancé automatiquement par GitHub Actions (voir .github/workflows/update-prices.yml).
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execSync } from 'node:child_process';

const GUIDE_URL = (process.env.CM_PRICE_GUIDE_URL || '').trim();
const PRODUCT_URLS = (process.env.CM_PRODUCTS_URLS || '').split(/[\s,]+/).filter(Boolean);
const TCGDEX_DIR = process.env.TCGDEX_DIR || '.tcgdex';
const DIR = 'data';
const KEEP_DAYS = 120;          // nombre de relevés quotidiens conservés

if (!GUIDE_URL) { console.error('Variable CM_PRICE_GUIDE_URL manquante (Settings > Secrets and variables > Actions > Variables).'); process.exit(1); }

async function getJSON(url) {
  let buf;
  if (/^https?:/i.test(url)) {
    const res = await fetch(url, { headers: { 'User-Agent': 'PokeVault-Tracker (suivi de collection personnel)' } });
    if (!res.ok) throw new Error(`Téléchargement impossible (${res.status}) : ${url}`);
    buf = Buffer.from(await res.arrayBuffer());
  } else buf = fs.readFileSync(url.replace(/^file:\/\//, ''));
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
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
const write = (f, o) => fs.writeFileSync(f, JSON.stringify(o));
fs.mkdirSync(`${DIR}/days`, { recursive: true });

/* ---------- 1. Prix du jour ---------- */
const g = await getJSON(GUIDE_URL);
const created = String((g && (g.createdAt || g.sourceCreatedAt || g.generatedAt)) || new Date().toISOString()).slice(0, 10);
const price = new Map();
for (const r of rowsOf(g)) {
  const id = n(pick(r, 'idProduct', 'id_product', 'productId', 'id'));
  if (id == null) continue;
  const row = [n(r.trend), n(r.avg1), n(r.avg7), n(r.avg30), n(r.low), n(pick(r, 'trend-holo', 'trend-foil')), n(pick(r, 'avg7-holo', 'avg7-foil')), n(pick(r, 'avg30-holo', 'avg30-foil'))];
  if (row.some(v => v != null)) price.set(id, row);
}
if (!price.size) { console.error('Guide des prix vide ou format non reconnu.'); process.exit(1); }
console.log(`Guide des prix du ${created} : ${price.size} produits.`);

/* ---------- 2. Extensions et cartes (TCGdex) ---------- */
if (!fs.existsSync(path.join(TCGDEX_DIR, 'data'))) {
  console.log('Téléchargement de la base de cartes TCGdex…');
  execSync(`git clone -q --depth 1 --filter=blob:none --sparse https://github.com/tcgdex/cards-database ${TCGDEX_DIR}`, { stdio: 'inherit' });
  execSync(`git -C ${TCGDEX_DIR} sparse-checkout set data`, { stdio: 'inherit' });
}
const read = f => fs.readFileSync(f, 'utf8');
const langs = block => { const o = {}; for (const m of (block || '').matchAll(/\b(fr|en)\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) o[m[1]] = m[3].replace(/\\(["'`])/g, '$1'); return o; };
const topName = txt => { const m = txt.match(/\n\tname\s*:\s*\{([^}]*)\}/); return m ? langs(m[1]) : {}; };
const SETS = {}, setByEn = [];
const cards = [];
const DATA = path.join(TCGDEX_DIR, 'data');
for (const serieFile of fs.readdirSync(DATA).filter(f => f.endsWith('.ts'))) {
  const serieName = serieFile.slice(0, -3);
  const serieDir = path.join(DATA, serieName);
  if (!fs.existsSync(serieDir)) continue;
  const serieTxt = read(path.join(DATA, serieFile));
  const serie = topName(serieTxt);
  const serieId = (serieTxt.match(/\n\tid\s*:\s*["']([^"']+)["']/) || [])[1] || '';
  for (const setFile of fs.readdirSync(serieDir).filter(f => f.endsWith('.ts'))) {
    const st = read(path.join(serieDir, setFile));
    const id = (st.match(/\n\tid\s*:\s*["']([^"']+)["']/) || [])[1];
    if (!id) continue;
    const nm = topName(st);
    const date = (st.match(/releaseDate\s*:\s*["']([^"']+)["']/) || [])[1] || '';
    const official = (st.match(/official\s*:\s*(\d+)/) || [])[1] || '';
    SETS[id] = [nm.fr || nm.en || id, nm.en || nm.fr || id, serie.fr || serie.en || serieName, date];
    if (nm.en) setByEn.push([nm.en, id]);
    const setDir = path.join(serieDir, setFile.slice(0, -3));
    if (!fs.existsSync(setDir)) continue;
    for (const cf of fs.readdirSync(setDir).filter(f => f.endsWith('.ts'))) {
      const txt = read(path.join(setDir, cf));
      const ids = [...new Set([...txt.matchAll(/cardmarket\s*:\s*(\d+)/g)].map(m => +m[1]))].filter(i => price.has(i));
      if (!ids.length) continue;
      const cn = topName(txt);
      const rarity = (txt.match(/\n\trarity\s*:\s*["']([^"']+)["']/) || [])[1] || '';
      const local = cf.slice(0, -3);
      const num = official && /^\d+$/.test(local) ? `${local.padStart(String(official).length, '0')}/${official}` : local;
      const img = serieId ? `${serieId}/${id}/${local}` : '';         // image de la carte sur assets.tcgdex.net
      ids.forEach((cm, i) => cards.push([cm, 'c', cn.fr || cn.en || '?', cn.en && cn.en !== cn.fr ? cn.en : '', id, num + (ids.length > 1 && i ? ` (v${i + 1})` : ''), rarity, 'CARD', 'EU', img]));
    }
  }
}
setByEn.sort((a, b) => b[0].length - a[0].length);
console.log(`TCGdex : ${Object.keys(SETS).length} extensions, ${cards.length} cartes avec un prix Cardmarket.`);

/* ---------- 3. Produits scellés (catalogue Cardmarket) ---------- */
const sealed = [];
const typeOf = (cat, name) => {
  if (/Display/i.test(cat)) return /bundle/i.test(name) ? 'BUNDLE' : /half/i.test(name) ? 'HALF_DISPLAY' : 'DISPLAY';
  if (/Elite Trainer/i.test(cat)) return 'ETB';
  if (/Booster/i.test(cat)) return 'BOOSTER';
  if (/Blister/i.test(cat)) return /3.?pack|three/i.test(name) ? 'TRIPACK' : 'BLISTER';
  if (/Box Set/i.test(cat)) return /ultra.?premium/i.test(name) ? 'UPC' : 'COFFRET';
  if (/Tin/i.test(cat)) return 'TIN';
  if (/Deck|Trainer Kit/i.test(cat)) return 'DECK';
  return null;                                          // pièces, lots… ignorés
};
// Nom français du produit scellé : « Surging Sparks Booster Box » devient « Display Étincelles Déferlantes ».
const FR_TYPES = [
  [/^booster box \(18 boosters\)$/i, 'Demi-display (18 boosters)'], [/^booster box$/i, 'Display (36 boosters)'], [/^jp booster box$/i, 'Display japonais'],
  [/^pok[ée]mon center elite trainer box$/i, 'Coffret Dresseur d’Élite Pokémon Center'], [/^elite trainer box$/i, 'Coffret Dresseur d’Élite'],
  [/^booster bundle$/i, 'Bundle 6 boosters'], [/^booster bundle display$/i, 'Display de bundles'], [/^sleeved booster$/i, 'Booster sous blister'],
  [/^booster$/i, 'Booster'], [/^jp booster$/i, 'Booster japonais'], [/^booster \(6 cards\)$/i, 'Booster (6 cartes)'], [/^fun pack \(3 cards\)$/i, 'Fun pack (3 cartes)'],
  [/^build & battle box$/i, 'Coffret Avant-Première'], [/^build & battle stadium box$/i, 'Coffret Stade Avant-Première'],
  [/^ultra.?premium collection$/i, 'Ultra Premium Collection'], [/^6 booster box case$/i, 'Carton de 6 displays'], [/^10 elite trainer box case$/i, 'Carton de 10 coffrets Dresseur d’Élite'],
  [/^24 sleeved booster case$/i, 'Présentoir de 24 boosters sous blister'],
];
function frName(name, en, fr) {
  const rest = name.slice(en.length).replace(/^[\s:–-]+/, '').trim();
  if (!rest) return fr;
  const t = FR_TYPES.find(([re]) => re.test(rest));
  return t ? `${t[1]} ${fr}` : `${fr} : ${rest}`;
}
const langOf = name => /\bJP\b|japanese|japan/i.test(name) ? 'JP' : /chinese|\bCS\d|\bCSV\d|\bCBB/i.test(name) ? 'CN' : /korean|\bKR\b/i.test(name) ? 'KR' : 'EU';
for (const url of PRODUCT_URLS) {
  const j = await getJSON(url);
  const isNon = /non.?single/i.test(url);
  for (const r of rowsOf(j)) {
    const id = n(pick(r, 'idProduct', 'id_product', 'productId', 'id'));
    const name = String(pick(r, 'name', 'enName', 'productName') || '');
    const cat = String(pick(r, 'categoryName', 'category') || (isNon ? 'Box Set' : 'Single'));
    if (id == null || !name || /single/i.test(cat) || !price.has(id)) continue;
    const type = typeOf(cat, name); if (!type) continue;
    const m = setByEn.find(([en]) => name === en || name.startsWith(en + ' ') || name.startsWith(en + ':'));
    sealed.push([id, 's', m ? frName(name, m[0], SETS[m[1]][0]) : name, name, m ? m[1] : '', '', '', type, langOf(name), '']);
  }
}
console.log(`Scellé : ${sealed.length} produits avec un prix.`);
if (!PRODUCT_URLS.length) console.log('Astuce : ajoute la variable CM_PRODUCTS_URLS pour inclure le scellé.');

/* ---------- 3b. Photos du scellé : catalogue TCGplayer via TCGCSV (rafraîchi chaque semaine) ---------- */
const IMG_CACHE = `${DIR}/tcg-sealed.json`;
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
let tcg = readJSON(IMG_CACHE, null);
if (!tcg || !Array.isArray(tcg.rows) || Date.now() - (tcg.at || 0) > 6.5 * 864e5) {
  try {
    const groups = (await getJSON('https://tcgcsv.com/tcgplayer/3/groups')).results || [];
    const rows = []; let gi = 0;
    const worker = async () => {
      while (gi < groups.length) {
        const g = groups[gi++];
        try {
          const j = await getJSON(`https://tcgcsv.com/tcgplayer/3/${g.groupId}/products`);
          for (const p of j.results || []) {
            if ((p.extendedData || []).some(e => e.name === 'Number')) continue;      // une carte, pas un produit scellé
            if (/code card/i.test(p.name)) continue;
            rows.push([p.productId, p.name, g.name]);
          }
        } catch (e) { /* groupe ignoré */ }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (rows.length) { tcg = { at: Date.now(), rows }; write(IMG_CACHE, tcg); }
    console.log(`Photos : catalogue TCGplayer rafraîchi (${rows.length} produits scellés).`);
  } catch (e) { console.log('Photos : catalogue TCGplayer indisponible pour l’instant (' + e.message + ').'); }
}
if (tcg && tcg.rows) {
  const nrm = x => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bpokemon\b|\(exclusive\)|\bexclusive\b/g, ' ')
    .replace(/booster pack/g, 'booster').replace(/single pack blister|1-pack blister|1 pack blister/g, '1 pack blister')
    .replace(/3-pack|three pack/g, '3 pack').replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const grp = x => nrm(String(x).replace(/^[A-Za-z]{1,4}\d*\s*[:\-–]\s*/, ''));
  // « reste » du nom une fois retiré le nom de l'extension : « Scarlet & Violet 151 Elite Trainer Box » → « elite trainer box »
  const rest = (n, set) => { if (set && n.startsWith(set + ' ')) return n.slice(set.length + 1); const st = new Set(set.split(' ')); return n.split(' ').filter(w => !st.has(w)).join(' '); };
  const all = tcg.rows.map(([id, name, g]) => { const n = nrm(name), gg = grp(g), r = rest(n, gg); return { id, n, g: gg, r, t: new Set(r.split(' ')) }; });
  const exact = new Map(); for (const x of all) (exact.get(x.n) || exact.set(x.n, []).get(x.n)).push(x.id);
  const jac = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i); };
  let found = 0;
  for (const row of sealed) {
    const n = nrm(row[3]);
    let id = null;
    const ex = exact.get(n);
    if (ex && ex.length === 1) id = ex[0];
    else {
      const setEn = row[4] && SETS[row[4]] ? nrm(SETS[row[4]][1]) : '';
      const pool = setEn ? all.filter(x => x.g === setEn || x.g.endsWith(' ' + setEn)) : [];
      const r = rest(n, setEn), t = new Set(r.split(' '));
      const same = pool.filter(x => x.r === r);
      const sc = same.length === 1 ? [[same[0], 1]] : pool.map(x => [x, jac(t, x.t)]).sort((a, b) => b[1] - a[1]);
      if (sc.length && sc[0][1] >= .8 && (!sc[1] || sc[0][1] - sc[1][1] >= .1)) id = sc[0][0].id;
    }
    row[9] = ''; row[10] = id || '';
    if (id) found++;
  }
  console.log(`Photos : ${found} produits scellés sur ${sealed.length} ont une photo.`);
}
for (const row of sealed) { if (row.length < 11) { row[9] = row[9] || ''; row[10] = ''; } }
for (const row of cards) row[10] = '';

/* ---------- 4. Fichiers pour l'appli ---------- */
const products = [...sealed, ...cards];
const used = new Set(products.map(p => p[0]));
write(`${DIR}/products.json`, { createdAt: created, fields: ['cm', 'k', 'name', 'en', 'set', 'num', 'rarity', 'type', 'lang', 'img', 'pimg'], sets: SETS, rows: products });
const F = ['idProduct', 'trend', 'avg1', 'avg7', 'avg30', 'low', 'trend-holo', 'avg7-holo', 'avg30-holo'];
write(`${DIR}/latest.json`, { createdAt: created, fields: F, rows: [...price].filter(([id]) => used.has(id)).map(([id, r]) => [id, ...r]) });
// Relevé du jour, compact : [identifiant, tendance, moyenne 7 j, moyenne 30 j, prix bas]
write(`${DIR}/days/${created}.json`, { d: created, rows: [...price].filter(([id]) => used.has(id)).map(([id, r]) => [id, r[0], r[2], r[3], r[4]]) });
const days = fs.readdirSync(`${DIR}/days`).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) fs.unlinkSync(`${DIR}/days/${f}`);
write(`${DIR}/days/index.json`, { days: days.slice(-KEEP_DAYS).map(f => f.slice(0, 10)) });
for (const old of ['catalog.json', 'history.json', 'tracked.json']) if (fs.existsSync(`${DIR}/${old}`)) fs.unlinkSync(`${DIR}/${old}`);
console.log(`Catalogue de l'appli : ${products.length} produits. Relevés conservés : ${Math.min(days.length, KEEP_DAYS)} jours.`);
