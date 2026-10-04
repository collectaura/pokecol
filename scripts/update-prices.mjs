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
if (!fs.existsSync(path.join(TCGDEX_DIR, 'data')) || !fs.existsSync(path.join(TCGDEX_DIR, 'data-asia'))) {
  if (fs.existsSync(TCGDEX_DIR)) fs.rmSync(TCGDEX_DIR, { recursive: true, force: true });
  console.log('Téléchargement de la base de cartes TCGdex…');
  execSync(`git clone -q --depth 1 --filter=blob:none --sparse https://github.com/tcgdex/cards-database ${TCGDEX_DIR}`, { stdio: 'inherit' });
  execSync(`git -C ${TCGDEX_DIR} sparse-checkout set data data-asia`, { stdio: 'inherit' });
}
const read = f => fs.readFileSync(f, 'utf8');
const langs = block => { const o = {}; for (const m of (block || '').matchAll(/\b(fr|en)\s*:\s*(["'`])((?:\\.|(?!\2).)*)\2/g)) o[m[1]] = m[3].replace(/\\(["'`])/g, '$1'); return o; };
const topName = txt => { const m = txt.match(/\n\tname\s*:\s*\{([^}]*)\}/); return m ? langs(m[1]) : {}; };
const SETS = {}, setByEn = [], DEXFR = {};
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
    SETS[id] = [nm.fr || nm.en || id, nm.en || nm.fr || id, serie.fr || serie.en || serieName, date, serieId];
    if (nm.en) setByEn.push([nm.en, id]);
    const setDir = path.join(serieDir, setFile.slice(0, -3));
    if (!fs.existsSync(setDir)) continue;
    for (const cf of fs.readdirSync(setDir).filter(f => f.endsWith('.ts'))) {
      const txt = read(path.join(setDir, cf));
      const ids = [...new Set([...txt.matchAll(/cardmarket\s*:\s*(\d+)/g)].map(m => +m[1]))].filter(i => price.has(i));
      if (!ids.length) continue;
      const cn = topName(txt);
      const dex = (txt.match(/dexId\s*:\s*\[\s*(\d+)\s*\]/) || [])[1];
      if (dex && cn.fr && !/\n\tsuffix\s*:/.test(txt) && !/\b(ex|EX|GX|V|VMAX|VSTAR|BREAK)\b/.test(cn.fr)) { const m = (DEXFR[dex] ||= {}); m[cn.fr] = (m[cn.fr] || 0) + 1; }
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

/* ---------- 2b. Cartes japonaises (TCGdex, dossier data-asia) ---------- */
// Les noms n'existent qu'en japonais : on leur donne le nom français du Pokémon (via son numéro de Pokédex) + son suffixe (ex, V…).
const dexName = {};
for (const [d, m] of Object.entries(DEXFR)) dexName[d] = Object.entries(m).sort((a, b) => b[1] - a[1])[0][0];
const ASIA = path.join(TCGDEX_DIR, 'data-asia');
const block = (txt, key) => { const m = txt.match(new RegExp('\\n\\t' + key + '\\s*:\\s*\\{([^}]*)\\}')); const o = {}; if (m) for (const x of m[1].matchAll(/(?:'([\w-]+)'|(\w+))\s*:\s*(["'`])((?:\\.|(?!\3).)*)\3/g)) o[x[1] || x[2]] = x[4]; return o; };
let jpCount = 0;
if (fs.existsSync(ASIA)) {
  for (const serieFile of fs.readdirSync(ASIA).filter(f => f.endsWith('.ts'))) {
    const serieDir = path.join(ASIA, serieFile.slice(0, -3));
    if (!fs.existsSync(serieDir)) continue;
    const serieTxt = read(path.join(ASIA, serieFile));
    const serieId = (serieTxt.match(/\n\tid\s*:\s*["']([^"']+)["']/) || [])[1] || serieFile.slice(0, -3);
    const serieNm = block(serieTxt, 'name');
    for (const setFile of fs.readdirSync(serieDir).filter(f => f.endsWith('.ts'))) {
      const st = read(path.join(serieDir, setFile));
      const sid = (st.match(/\n\tid\s*:\s*["']([^"']+)["']/) || [])[1];
      const nm = block(st, 'name'), rd = block(st, 'releaseDate');
      if (!sid || !nm.ja) continue;                                  // uniquement les éditions japonaises
      const official = (st.match(/official\s*:\s*(\d+)/) || [])[1] || '';
      const label = nm.ja;
      const key = 'jp-' + sid;
      SETS[key] = [`${label} (${sid})`, label, 'Japon — ' + (serieNm.id || serieNm.ja || serieId), rd.ja || (st.match(/releaseDate\s*:\s*["']([^"']+)["']/) || [])[1] || '', ''];
      const setDir = path.join(serieDir, setFile.slice(0, -3));
      if (!fs.existsSync(setDir)) continue;
      for (const cf of fs.readdirSync(setDir).filter(f => f.endsWith('.ts'))) {
        const txt = read(path.join(setDir, cf));
        const ids = [...new Set([...txt.matchAll(/cardmarket\s*:\s*(\d+)/g)].map(m => +m[1]))].filter(i => price.has(i));
        if (!ids.length) continue;
        const cn = block(txt, 'name');
        const dex = (txt.match(/dexId\s*:\s*\[\s*(\d+)\s*\]/) || [])[1];
        const suf = ((cn.ja || '').match(/(ex|EX|GX|V|VMAX|VSTAR|V-UNION|BREAK|LV\.X|δ)$/) || [])[1] || '';
        const name = dex && dexName[dex] ? `${dexName[dex]}${suf ? ' ' + (suf === 'EX' && /^S|^SV|^M/.test(serieId) ? 'ex' : suf) : ''}` : (cn.ja || cn.id || '?');
        const rarity = (txt.match(/\n\trarity\s*:\s*["']([^"']+)["']/) || [])[1] || '';
        const local = cf.slice(0, -3);
        const num = official && +official > 0 && /^\d+$/.test(local) ? `${local.padStart(String(official).length, '0')}/${official}` : local;
        ids.forEach((cm, i) => { cards.push([cm, 'c', name, cn.ja || '', key, num + (ids.length > 1 && i ? ` (v${i + 1})` : ''), rarity, 'CARD', 'JP', `ja:${serieId}/${sid}/${local}`]); jpCount++; });
      }
    }
  }
}
console.log(`Cartes japonaises : ${jpCount} avec un prix Cardmarket.`);

/* ---------- 2c. Historique des cartes depuis 2024 : projet public rarebox-price-history ---------- */
// On repère seulement les fichiers disponibles (sans les télécharger) pour relier chaque extension au bon fichier.
// L'appli ira chercher l'historique d'une carte directement dans ce projet, quand elle en a besoin.
const rbFiles = new Set();
try {
  fs.rmSync('.rarebox', { recursive: true, force: true });
  execSync('git clone -q --depth 1 --filter=blob:none --no-checkout https://github.com/novaoc/rarebox-price-history .rarebox', { stdio: 'ignore' });
  const out = execSync('git -C .rarebox ls-tree -r --name-only HEAD data/pokemon data/pokemon-ja', { maxBuffer: 64 * 1024 * 1024 }).toString();
  for (const f of out.split('\n')) { const m = f.match(/^data\/(pokemon(?:-ja)?)\/(.+)\.json$/); if (m) rbFiles.add(m[1] + '/' + m[2]); }
} catch (e) { console.log('Historique des cartes : projet rarebox indisponible (' + e.message + ').'); }
function rbKey(id) {
  if (id.startsWith('jp-')) { const k = 'pokemon-ja/' + id.slice(3).toLowerCase(); return rbFiles.has(k) ? k : ''; }
  const s = id.toLowerCase(), c = [];
  const m = s.match(/^([a-z]+)0*(\d+)(?:\.(5))?(.*)$/);
  if (m) { const [, p, n, half, rest] = m; if (half) c.push(`${p}${n}pt5${rest}`, `${p}${n}5${rest}`); else c.push(`${p}${n}${rest}`); }
  c.push(s, s.replace('.', ''), s.replace('.5', 'pt5'));
  if (s === 'swsh10.5') c.push('pgo');
  for (const k of c) if (rbFiles.has('pokemon/' + k)) return 'pokemon/' + k;
  return '';
}
{
  let n = 0;
  for (const [id, v] of Object.entries(SETS)) { v[5] = rbKey(id); if (v[5]) n++; }
  console.log(`Historique des cartes : ${n} extensions reliées à l'historique depuis 2024.`);
}

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
// Traduction des types de produits dans les noms restants : le type passe en tête, à la française.
// « Flamigo Mini Tin » → « Mini Pokébox Flamigo », « Regirock 3-Pack Blister » → « Tripack Regirock ».
const FR_PHRASES = [
  [/pok[ée]mon center elite trainer box/i, 'Coffret Dresseur d’Élite Pokémon Center'], [/elite trainer box/i, 'Coffret Dresseur d’Élite'],
  [/booster box/i, 'Display'], [/booster bundle/i, 'Bundle 6 boosters'], [/sleeved booster/i, 'Booster sous blister'],
  [/build (?:&|and) battle stadium/i, 'Coffret Stade Avant-Première'], [/build (?:&|and) battle box/i, 'Coffret Avant-Première'],
  [/ultra.?premium collection/i, 'Coffret Ultra Premium'], [/premium checklane blister/i, 'Blister Premium'],
  [/premium poster collection/i, 'Coffret Poster Premium'], [/premium figure collection/i, 'Coffret Figurine Premium'],
  [/premium collection/i, 'Coffret Collection Premium'], [/special collection/i, 'Coffret Collection Spéciale'],
  [/binder collection/i, 'Coffret Classeur'], [/poster collection/i, 'Coffret Poster'], [/pin collection/i, 'Coffret Pin’s'],
  [/figure collection/i, 'Coffret Figurine'], [/collector(?:'|’)?s? chest/i, 'Coffre du Collectionneur'], [/gift box/i, 'Coffret cadeau'],
  [/3.?pack blister/i, 'Tripack'], [/2.?pack blister/i, 'Duopack'], [/1.?pack blister|single pack blister/i, 'Blister'],
  [/stacking tin/i, 'Pokébox empilable'], [/mini tin/i, 'Mini Pokébox'], [/\btin\b/i, 'Pokébox'],
  [/league battle deck/i, 'Deck de Combat de Ligue'], [/battle deck/i, 'Deck de combat'], [/theme deck/i, 'Deck à thème'],
  [/start(?:er)? deck/i, 'Deck de démarrage'], [/trainer(?:'|’)?s? toolkit/i, 'Kit du Dresseur'], [/trainer kit/i, 'Kit du Dresseur'],
  [/collection box/i, 'Coffret Collection'], [/\bcollection$/i, 'Coffret'], [/\bbox$/i, 'Coffret'],
];
function frenchify(x) {
  for (const [re, fr] of FR_PHRASES) {
    const m = x.match(re);
    if (m) { const rest = (x.slice(0, m.index) + ' ' + x.slice(m.index + m[0].length)).replace(/\s+/g, ' ').replace(/^[\s:–-]+|[\s:–-]+$/g, '').trim(); return rest ? `${fr} ${rest}` : fr; }
  }
  return x;
}
function frName(name, en, fr) {
  const rest = name.slice(en.length).replace(/^[\s:–-]+/, '').trim();
  if (!rest) return fr;
  const t = FR_TYPES.find(([re]) => re.test(rest));
  return t ? `${t[1]} ${fr}` : `${fr} : ${frenchify(rest)}`;
}
const langOf = name => /\bJP\b|japanese|japan/i.test(name) ? 'JP' : /chinese|\bCS\d|\bCSV\d|\bCBB|taiwan|simplified|traditional/i.test(name) ? 'CN' : /korean|\bKR\b/i.test(name) ? 'KR' : /indonesian|\bthai\b|asia(n)?\b|\bSEA\b/i.test(name) ? 'AS' : 'EU';
for (const url of PRODUCT_URLS) {
  const j = await getJSON(url);
  const isNon = /non.?single/i.test(url);
  for (const r of rowsOf(j)) {
    const id = n(pick(r, 'idProduct', 'id_product', 'productId', 'id'));
    const name = String(pick(r, 'name', 'enName', 'productName') || '');
    const cat = String(pick(r, 'categoryName', 'category') || (isNon ? 'Box Set' : 'Single'));
    if (id == null || !name || /single/i.test(cat) || !price.has(id)) continue;
    const type = typeOf(cat, name); if (!type) continue;
    if (langOf(name) !== 'EU' || /\bUS version\b|\(US\)/i.test(name)) continue;   // uniquement les produits vendus en Europe (version française)
    const m = setByEn.find(([en]) => name === en || name.startsWith(en + ' ') || name.startsWith(en + ':'));
    sealed.push([id, 's', m ? frName(name, m[0], SETS[m[1]][0]) : frenchify(name), name, m ? m[1] : '', '', '', type, langOf(name), '']);
  }
}
console.log(`Scellé : ${sealed.length} produits avec un prix.`);
if (!PRODUCT_URLS.length) console.log('Astuce : ajoute la variable CM_PRODUCTS_URLS pour inclure le scellé.');

/* ---------- 3b. Photos du scellé : catalogue TCGplayer via TCGCSV (rafraîchi chaque semaine) ---------- */
const IMG_CACHE = `${DIR}/tcg.json`;
const readJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } };
let tcg = readJSON(IMG_CACHE, null);
async function tcgCategory(catId) {
  const groups = (await getJSON(`https://tcgcsv.com/tcgplayer/${catId}/groups`)).results || [];
  const sealedRows = [], cardRows = []; let gi = 0;
  const worker = async () => {
    while (gi < groups.length) {
      const g = groups[gi++];
      try {
        const j = await getJSON(`https://tcgcsv.com/tcgplayer/${catId}/${g.groupId}/products`);
        for (const p of j.results || []) {
          const num = ((p.extendedData || []).find(e => e.name === 'Number') || {}).value;
          if (num) cardRows.push([p.productId, g.name, g.abbreviation || '', String(num)]);
          else if (!/code card/i.test(p.name)) sealedRows.push([p.productId, p.name, g.name]);
        }
      } catch (e) { /* groupe ignoré */ }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  return { sealedRows, cardRows };
}
if (!tcg || !Array.isArray(tcg.rows) || !Array.isArray(tcg.cards) || Date.now() - (tcg.at || 0) > 6.5 * 864e5) {
  try {
    const en = await tcgCategory(3);
    let jp = { cardRows: [] };
    try {
      const cats = (await getJSON('https://tcgcsv.com/tcgplayer/categories')).results || [];
      const jc = cats.find(c => /pok[eé]mon japan/i.test(`${c.name} ${c.displayName}`));
      if (jc) jp = await tcgCategory(jc.categoryId);
    } catch (e) { console.log('Photos : catalogue japonais TCGplayer indisponible (' + e.message + ').'); }
    if (en.sealedRows.length) { tcg = { at: Date.now(), rows: en.sealedRows, cards: en.cardRows, jp: jp.cardRows }; write(IMG_CACHE, tcg); }
    console.log(`Photos : catalogue TCGplayer rafraîchi (${en.sealedRows.length} scellés, ${en.cardRows.length} cartes, ${jp.cardRows.length} cartes japonaises).`);
  } catch (e) { console.log('Photos : catalogue TCGplayer indisponible pour l’instant (' + e.message + ').'); }
  if (fs.existsSync(`${DIR}/tcg-sealed.json`)) fs.unlinkSync(`${DIR}/tcg-sealed.json`);
}
if (tcg && tcg.rows) {
  const nrm = x => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/\bpokemon\b|\(exclusive\)|\bexclusive\b/g, ' ')
    .replace(/booster pack/g, 'booster').replace(/single pack blister|1-pack blister|1 pack blister/g, '1 pack blister')
    .replace(/3-pack|three pack/g, '3 pack').replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const grp = x => nrm(String(x).replace(/^[A-Za-z]{1,4}\d*\s*[:\-–]\s*/, ''));
  // « reste » du nom une fois retiré le nom de l'extension : « Scarlet & Violet 151 Elite Trainer Box » → « elite trainer box »
  const rest = (n, set) => { if (set && n.startsWith(set + ' ')) return n.slice(set.length + 1); const st = new Set(set.split(' ')); return n.split(' ').filter(w => !st.has(w)).join(' '); };
  const all = tcg.rows.map(([id, name, g]) => { const n = nrm(name), gg = grp(g), r = rest(n, gg); return { id, n, g: gg, r, t: new Set(r.split(' ')), full: new Set(n.split(' ')) }; });
  const exact = new Map(); for (const x of all) (exact.get(x.n) || exact.set(x.n, []).get(x.n)).push(x.id);
  const jac = (a, b) => { let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i); };
  const KINDS = [/elite trainer box/, /\btin\b/, /blister/, /deck/, /booster box/, /booster bundle/, /prerelease/, /collection/, /\bbox\b/, /booster/];
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
    if (!id) {
      // Dernier essai sur tout le catalogue : noms très proches (« Lillie Premium Tournament Collection » ↔ « … Collection Box »)
      const t = new Set(n.split(' '));
      let best = null, b1 = 0, b2 = 0;
      for (const x of all) {
        const s2 = jac(t, x.full);
        if (s2 > b1) { b2 = b1; b1 = s2; best = x; } else if (s2 > b2) b2 = s2;
      }
      if (best && b1 >= .75 && b1 - b2 >= .1) id = best.id;
    }
    // Deuxième essai dans l'extension : la plupart des mots du nom Cardmarket se retrouvent chez TCGplayer,
    // avec le même genre de produit (« Gengar Mini Tin » ↔ « 151 Mini Tin [Gengar & Poliwag] »).
    if (!id && row[4] && SETS[row[4]]) {
      const setEn = nrm(SETS[row[4]][1]), r = rest(n, setEn), t = new Set(r.split(' ').filter(Boolean));
      const kind = KINDS.find(k => k.test(r));
      const pool = all.filter(x => (x.g === setEn || x.g.endsWith(' ' + setEn)) && (!kind || kind.test(x.r)) && !/\bcase\b|display|set of/.test(x.r) === !/\bcase\b|display|set of/.test(r));
      const sc = pool.map(x => { let i = 0; for (const w of t) if (x.t.has(w)) i++; return [x, t.size ? i / t.size : 0, x.t.size]; }).sort((a, b) => b[1] - a[1] || a[2] - b[2]);
      if (sc.length && sc[0][1] >= .6 && (!sc[1] || sc[0][1] - sc[1][1] >= .1 || sc[0][2] < sc[1][2])) id = sc[0][0].id;
    }
    row[9] = ''; row[10] = id || '';
    if (id) found++;
  }
  // Photo indicative pour le reste : même extension, même genre de produit (booster, display, coffret…).
  const typeKey = { BOOSTER: /^booster$/, DISPLAY: /^booster box$/, HALF_DISPLAY: /^booster box$/, ETB: /^elite trainer box$/, BUNDLE: /^booster bundle$/, TIN: /\btin\b/, BLISTER: /blister/, TRIPACK: /3 pack blister/, DECK: /deck/, COFFRET: /collection|box/, UPC: /premium collection|collection/ };
  let indic = 0, logos = 0;
  for (const row of sealed) {
    if (row[10] || !row[4] || !SETS[row[4]]) continue;
    const setEn = nrm(SETS[row[4]][1]);
    const pool = all.filter(x => x.g === setEn || x.g.endsWith(' ' + setEn));
    const want = typeKey[row[7]];
    const pick = (want && pool.find(x => want.test(x.r) && !/\bcase\b|display|set of/.test(x.r))) || pool.find(x => /^booster box$/.test(x.r)) || pool.find(x => /^booster$/.test(x.r));
    if (pick) { row[10] = '~' + pick.id; indic++; }
    else if (SETS[row[4]][4]) { row[10] = `logo:${SETS[row[4]][4]}/${row[4]}`; logos++; }
  }
  console.log(`Photos : ${found} produits scellés sur ${sealed.length} ont leur photo exacte, ${indic} une photo indicative, ${logos} le logo de l'extension.`);
}
for (const row of sealed) { if (row.length < 11) { row[9] = row[9] || ''; row[10] = ''; } }
// On ne garde que les produits de la gamme française / européenne : rattachés à une extension
// internationale, ou présents dans le catalogue TCGplayer. Les éditions propres à l'Asie sont écartées.
if (tcg && tcg.rows) {
  const before = sealed.length;
  for (let i = sealed.length - 1; i >= 0; i--) if (!sealed[i][4] && !sealed[i][10]) sealed.splice(i, 1);
  console.log(`Scellé : ${before - sealed.length} produits hors gamme française retirés, ${sealed.length} gardés.`);
}
for (const row of cards) row[10] = '';

/* ---------- 3b'. Photos de secours des cartes : même extension, même numéro chez TCGplayer ---------- */
if (tcg && Array.isArray(tcg.cards)) {
  const nrm2 = x => String(x).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\bpokemon\b/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const grp2 = x => nrm2(String(x).replace(/^[A-Za-z]{1,4}\d*\s*[:\-–]\s*/, ''));
  const numKey = x => String(x).split('/')[0].trim().toUpperCase().replace(/^0+(?=\d)/, '');
  const byGroup = new Map();
  for (const [pid, g, , num] of tcg.cards) { const k = grp2(g); if (!byGroup.has(k)) byGroup.set(k, new Map()); const m = byGroup.get(k); const nk = numKey(num); if (!m.has(nk)) m.set(nk, pid); }
  const keys = [...byGroup.keys()];
  const setCache = new Map();
  const forSet = setEn => {
    if (setCache.has(setEn)) return setCache.get(setEn);
    // le groupe exact d'abord, puis ses sous-séries (« … Trainer Gallery », « … Base Set »), puis « Scarlet & Violet 151 » pour « 151 »
    const sub = /^(base set|trainer gallery|galarian gallery|shiny vault|radiant collection|classic collection)$/;
    const rank = k => k === setEn ? 0 : k.startsWith(setEn + ' ') && sub.test(k.slice(setEn.length + 1)) ? 1 : k.endsWith(' ' + setEn) ? 2 : 9;
    const maps = keys.filter(k => rank(k) < 9).sort((a, b) => rank(a) - rank(b)).map(k => byGroup.get(k));
    setCache.set(setEn, maps); return maps;
  };
  const jpRows = Array.isArray(tcg.jp) ? tcg.jp : [];
  const jpCache = new Map();
  const forJp = sid => {
    if (jpCache.has(sid)) return jpCache.get(sid);
    const re = new RegExp('(^|[^a-z0-9])' + sid.replace(/[-.]/g, '\\$&') + '([^a-z0-9]|$)', 'i');
    const m = new Map();
    for (const [pid, g, ab, num] of jpRows) if (ab.toLowerCase() === sid.toLowerCase() || re.test(g)) { const nk = numKey(num); if (!m.has(nk)) m.set(nk, pid); }
    jpCache.set(sid, m); return m;
  };
  let eu = 0, jpn = 0;
  for (const r of cards) {
    const nk = numKey(String(r[5]).replace(/ \(v\d+\)$/, ''));
    let pid = null;
    if (r[8] === 'JP') { const sid = String(r[4]).replace(/^jp-/, ''); pid = forJp(sid).get(nk) || null; if (pid) jpn++; }
    else if (SETS[r[4]]) { for (const m of forSet(nrm2(SETS[r[4]][1]))) { if (m.has(nk)) { pid = m.get(nk); break; } } if (pid) eu++; }
    r[12] = pid || '';
  }
  console.log(`Photos de secours des cartes : ${eu} cartes internationales et ${jpn} cartes japonaises.`);
}

/* ---------- 3c. Doublons : un seul produit visible par nom ---------- */
// Les doublons restent dans le fichier (pour les objets déjà dans une collection) mais sont masqués du catalogue.
{
  const seen = new Map(); let hidden = 0;
  const score = r => (typeof r[10] === 'number' || /^\d+$/.test(String(r[10])) ? 4 : r[10] ? 2 : 0) + (price.get(r[0])?.[0] ? 1 : 0);
  for (const r of sealed) {
    const k = r[2].toLowerCase().replace(/\s+/g, ' ').trim() + '|' + r[7];
    const prev = seen.get(k);
    if (!prev) { seen.set(k, r); continue; }
    if (score(r) > score(prev)) { prev[11] = 1; seen.set(k, r); } else r[11] = 1;
    hidden++;
  }
  for (const r of cards) if (/ \(v\d+\)$/.test(r[5])) { r[11] = 1; hidden++; }
  console.log(`Doublons masqués : ${hidden}.`);
}

/* ---------- 4. Fichiers pour l'appli ---------- */
const products = [...sealed, ...cards];
const used = new Set(products.map(p => p[0]));
write(`${DIR}/products.json`, { createdAt: created, fields: ['cm', 'k', 'name', 'en', 'set', 'num', 'rarity', 'type', 'lang', 'img', 'pimg', 'hid', 'tid'], sets: SETS, rows: products });
const F = ['idProduct', 'trend', 'avg1', 'avg7', 'avg30', 'low', 'trend-holo', 'avg7-holo', 'avg30-holo'];
write(`${DIR}/latest.json`, { createdAt: created, fields: F, rows: [...price].filter(([id]) => used.has(id)).map(([id, r]) => [id, ...r]) });
// Relevé du jour, compact : [identifiant, tendance, moyenne 7 j, moyenne 30 j, prix bas]
write(`${DIR}/days/${created}.json`, { d: created, rows: [...price].filter(([id]) => used.has(id)).map(([id, r]) => [id, r[0], r[2], r[3], r[4]]) });
const days = fs.readdirSync(`${DIR}/days`).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
for (const f of days.slice(0, Math.max(0, days.length - KEEP_DAYS))) fs.unlinkSync(`${DIR}/days/${f}`);
write(`${DIR}/days/index.json`, { days: days.slice(-KEEP_DAYS).map(f => f.slice(0, 10)) });
for (const old of ['catalog.json', 'history.json', 'tracked.json']) if (fs.existsSync(`${DIR}/${old}`)) fs.unlinkSync(`${DIR}/${old}`);

/* ---------- 5. Historique long du scellé, depuis février 2024 (archive TCGCSV des prix TCGplayer) ---------- */
// Une fois par semaine de février 2024 au 16 septembre 2026 : prix du marché TCGplayer (dollars), ramené au niveau
// du prix Cardmarket actuel du même produit. Le travail est réparti sur plusieurs passages du robot (limite de temps).
// Fichiers communs à tous les visiteurs : data/longhist/tcg-<n>.json (n = identifiant Cardmarket modulo 32).
{
  const LH = `${DIR}/longhist`, SH = 32, T0 = Date.now(), BUDGET = 14 * 60e3;
  fs.mkdirSync(LH, { recursive: true });
  const meta = readJSON(`${LH}/meta.json`, { v: 1, done: [], ref: null });
  const raw = readJSON(`${LH}/raw.json`, {});                   // { tcgId: [[date, usd], ...] }
  const targets = new Map();
  for (const r of sealed) if (r[10] && /^\d+$/.test(String(r[10]))) targets.set(Number(r[10]), r[0]);
  const ymd = t => new Date(t).toISOString().slice(0, 10);
  const want = []; for (let t = Date.UTC(2024, 1, 8); t < Date.UTC(2026, 8, 16); t += 7 * 864e5) want.push(ymd(t));
  const refDue = !meta.ref || Date.now() - Date.parse(meta.ref.date) > 7 * 864e5;
  const refDate = ymd(Date.now() - 864e5);
  const todo = want.filter(d => !meta.done.includes(d));
  if (refDue) todo.unshift(refDate);
  // Outil de décompression 7-Zip : déjà présent sur la plupart des machines GitHub, sinon installé.
  const find7z = () => { for (const b of ['7z', '7zz', '7za']) { try { execSync(`${b} i`, { stdio: 'ignore' }); return b; } catch { /* suivant */ } } return null; };
  let z = find7z();
  if (!z) { try { execSync('sudo apt-get update -qq && (sudo apt-get install -y -qq 7zip || sudo apt-get install -y -qq p7zip-full)', { stdio: 'ignore' }); } catch { /* échec d'installation */ } z = find7z(); }
  const have7z = !!z;
  if (!have7z) console.log('Historique long : outil 7-Zip introuvable, historique reporté au prochain passage.');
  // Le site peut refuser les robots : on essaie plusieurs façons de demander le fichier, comme un navigateur.
  const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
  let method = null;
  async function getArchive(url, dest) {
    const tries = [
      ['navigateur', () => fetch(url, { headers: { 'User-Agent': BROWSER, 'Accept': '*/*', 'Referer': 'https://tcgcsv.com/', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8' } })],
      ['simple', () => fetch(url)],
      ['curl', async () => { try { execSync(`curl -sSfL --retry 2 -A "${BROWSER}" -e "https://tcgcsv.com/" -o ${dest} "${url}"`, { stdio: 'ignore' }); return { ok: true, status: 200, curl: true }; } catch { return { ok: false, status: 403, statusText: 'curl', url }; } }],
    ];
    const order = method ? [tries.find(t => t[0] === method), ...tries.filter(t => t[0] !== method)] : tries;
    let last = null; const codes = [];
    for (const [name, fn] of order) {
      let r; try { r = await fn(); } catch (e) { r = { ok: false, status: 0, statusText: e.message }; }
      if (r.ok) {
        if (!r.curl) fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
        if (method !== name) { method = name; console.log(`Historique long : téléchargement réussi (méthode « ${name} »).`); }
        return { ok: true };
      }
      if (!r.curl && r.status) codes.push(r.status);
      last = { ok: false, status: r.status, statusText: r.statusText || '', url };
    }
    if (codes.includes(404)) return { ok: false, status: 404, statusText: 'Not Found', url };
    if (codes.length) return { ok: false, status: codes[0], statusText: '', url };
    return last;
  }
  let processed = 0, changed = false, fails = 0;
  console.log(`Historique long : ${targets.size} produits à suivre, ${todo.length} archives à récupérer.`);
  if (have7z && targets.size && todo.length) {
    for (const d of todo) {
      if (Date.now() - T0 > BUDGET) break;
      const arc = '/tmp/pv-prices.7z', out = '/tmp/pv-prices';
      try {
        const url = `${process.env.ARCHIVE_BASE || 'https://tcgcsv.com/archive/tcgplayer'}/prices-${d}.ppmd.7z`;
        const res = await getArchive(url, arc);
        if (!res.ok && res.status === 404) { if (d !== refDate) meta.done.push(d); continue; }   // jour absent de l'archive
        if (!res.ok) {
          fails++;
          if (fails <= 3) console.log(`Historique long : archive du ${d} refusée (code ${res.status} ${res.statusText}) — ${res.url}`);
          if (fails >= 5 && processed === 0) { console.log('Historique long : le site des archives refuse les téléchargements, nouvel essai au prochain passage.'); break; }
          continue;
        }
        fails = 0;
        fs.rmSync(out, { recursive: true, force: true });
        execSync(`${z} x -y -bd -o${out} ${arc}`, { stdio: 'ignore' });
        const base = fs.readdirSync(out).map(x => path.join(out, x, '3')).find(p => fs.existsSync(p));
        const day = {};
        if (base) for (const g of fs.readdirSync(base)) {
          const f = path.join(base, g, 'prices'); if (!fs.existsSync(f)) continue;
          let j; try { j = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { continue; }
          for (const p of j.results || []) {
            if (!targets.has(p.productId) || day[p.productId] != null) continue;
            const v = p.marketPrice ?? p.midPrice; if (v > 0) day[p.productId] = Math.round(v * 100) / 100;
          }
        }
        if (d === refDate) meta.ref = { date: d, prices: day };
        else { for (const [pid, v] of Object.entries(day)) (raw[pid] ||= []).push([d, v]); meta.done.push(d); }
        processed++; changed = true;
      } catch (e) { console.log(`Historique long : ${d} ignoré (${e.message}).`); }
      finally { fs.rmSync(arc, { force: true }); fs.rmSync(out, { recursive: true, force: true }); }
    }
  }
  // Source n°2 : TickerMint (historique quotidien TCGplayer depuis février 2024, gratuit avec un lien vers leur site).
  // Accès groupé : l'historique complet de 50 produits par demande. Les numéros sont ceux de TCGplayer.
  meta.tm ||= { done: [], at: null };
  const TM = process.env.TICKERMINT_BASE || 'https://api.tickermint.cards';
  const tmTodo = [...targets.keys()].filter(pid => !meta.tm.done.includes(pid) && !(raw[pid] && raw[pid].length > 20));
  const tmRefresh = !meta.tm.at || Date.now() - Date.parse(meta.tm.at) > 7 * 864e5;
  const pickPts = obj => {
    // Lit une série de prix quelle que soit sa forme : [[date, prix]] ou [{ date, market }], éventuellement par impression.
    const out = [];
    const toPt = x => {
      if (Array.isArray(x) && x.length >= 2) return [String(x[0]).slice(0, 10), +x[1]];
      if (x && typeof x === 'object') {
        const d = x.date || x.day || x.d || x.as_of || x.timestamp; const v = x.market ?? x.market_price ?? x.marketPrice ?? x.price ?? x.value ?? x.m ?? x.mid;
        if (d && v != null) return [String(typeof d === 'number' && d < 1e6 ? new Date(d * 864e5).toISOString() : d).slice(0, 10), +v];
      }
      return null;
    };
    if (Array.isArray(obj)) { for (const x of obj) { const p = toPt(x); if (p && p[1] > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p[0])) out.push(p); } }
    return out;
  };
  const findSeries = (j) => {
    // Renvoie { idProduit: [[date, prix], ...] } en parcourant la réponse.
    const res = {};
    const visit = (o, idHint) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) { const pts = pickPts(o); if (pts.length && idHint != null) { (res[idHint] ||= []).push(...pts); return; } o.forEach(x => visit(x, idHint)); return; }
      const id = o.product_id ?? o.productId ?? o.tcgplayer_id ?? o.tcgplayerId ?? o.id ?? idHint;
      const printing = String(o.printing || o.subTypeName || o.variant || '');
      if (printing && /reverse|1st/i.test(printing)) return;
      for (const [k, v] of Object.entries(o)) {
        if (/^\d+$/.test(k)) visit(v, +k);
        else if (Array.isArray(v) || (v && typeof v === 'object')) visit(v, id);
      }
    };
    visit(j, null);
    for (const k of Object.keys(res)) { const m = new Map(res[k].map(p => [p[0], p[1]])); res[k] = [...m].sort((a, b) => a[0].localeCompare(b[0])); }
    return res;
  };
  if ((tmTodo.length || tmRefresh) && targets.size) {
    const ids = tmTodo.length ? tmTodo : [...targets.keys()];
    let got = 0, calls = 0, logged = false;
    for (let i = 0; i < ids.length && Date.now() - T0 < BUDGET; i += 50) {
      const batch = ids.slice(i, i + 50);
      let j = null;
      const tries = [
        () => fetch(`${TM}/v1/bulk/history?game=pokemon&ids=${batch.join(',')}`, { headers: { 'Accept': 'application/json', 'User-Agent': 'PokeVault-Tracker (suivi de collection personnel)' } }),
        () => fetch(`${TM}/v1/bulk/history`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': 'PokeVault-Tracker (suivi de collection personnel)' }, body: JSON.stringify({ game: 'pokemon', product_ids: batch, ids: batch }) }),
      ];
      for (const t of tries) {
        try { const r = await t(); calls++; if (r.ok) { j = await r.json(); break; } if (!logged) { console.log(`Historique long (TickerMint) : réponse ${r.status} ${r.statusText}.`); logged = true; } } catch (e) { if (!logged) { console.log('Historique long (TickerMint) : ' + e.message); logged = true; } }
      }
      if (!j) { if (i === 0) break; continue; }
      const ser = findSeries(j);
      if (i === 0) console.log(`Historique long (TickerMint) : première réponse lue, ${Object.keys(ser).length} produits trouvés. Extrait : ${JSON.stringify(j).slice(0, 300)}`);
      for (const pid of batch) {
        const pts = ser[pid];
        if (pts && pts.length) { const old = pts.filter(p => p[0] < '2026-09-16'); if (old.length) { raw[pid] = old; got++; changed = true; } }
        meta.tm.done.push(pid);
      }
      await new Promise(r => setTimeout(r, 1200));                       // politesse : environ une demande par seconde
    }
    meta.tm.at = new Date().toISOString();
    console.log(`Historique long (TickerMint) : ${got} produits avec un historique récupéré (${calls} demandes).`);
  }
  if (changed || !fs.existsSync(`${LH}/tcg-0.json`)) {
    // Mise à l'échelle : prix Cardmarket du jour / prix TCGplayer de référence, appliqué à toute la courbe américaine.
    const shards = Array.from({ length: SH }, () => ({}));
    let n = 0;
    for (const [pid, cm] of targets) {
      const pts = raw[pid]; const cmNow = price.get(cm)?.[0];
      const refUsd = (meta.ref && meta.ref.prices[pid]) || (pts && pts.length ? pts.sort((a, b) => a[0].localeCompare(b[0]))[pts.length - 1][1] : null);
      if (!pts || !pts.length || !(refUsd > 0) || !(cmNow > 0)) continue;
      const k = cmNow / refUsd; if (k < .2 || k > 5) continue;                       // correspondance douteuse : écartée
      shards[cm % SH][cm] = pts.sort((a, b) => a[0].localeCompare(b[0])).map(([d, v]) => [d, Math.round(v * k * 100) / 100]);
      n++;
    }
    shards.forEach((o, i) => write(`${LH}/tcg-${i}.json`, o));
    write(`${LH}/raw.json`, raw);
    meta.n = (meta.n || 0) + 1; meta.products = n; meta.at = new Date().toISOString();
    write(`${LH}/meta.json`, meta);
    console.log(`Historique long : ${n} produits scellés avec un historique depuis 2024 (archive TCGCSV : ${meta.done.length}/${want.length} semaines).`);
  } else console.log(meta.done.length >= want.length ? `Historique long : complet (${want.length}/${want.length} semaines).` : `Historique long : rien de nouveau ce passage (${meta.done.length}/${want.length} semaines).`);
}
console.log(`Catalogue de l'appli : ${products.length} produits. Relevés conservés : ${Math.min(days.length, KEEP_DAYS)} jours.`);
