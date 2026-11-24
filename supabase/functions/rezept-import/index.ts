// Wochenmenü – Supabase Edge Function «rezept-import»
// Holt ein Rezept von einem Link (z. B. fooby.ch) und gibt Name, Portionen und Zutaten zurück.
// Nur für eingeloggte Mitglieder (Familien-Code) nutzbar.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---------- Hilfsfunktionen ----------
function decodeEntities(s) {
  return String(s || "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+)uml;/gi, (_, c) => ({ a: "ä", o: "ö", u: "ü", A: "Ä", O: "Ö", U: "Ü" }[c] || c));
}
function stripTags(s) { return decodeEntities(String(s || "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim(); }
function asArray(x) { return Array.isArray(x) ? x : x == null ? [] : [x]; }
function isRecipe(o) { return o && typeof o === "object" && asArray(o["@type"]).some((t) => String(t).toLowerCase() === "recipe"); }

function findRecipe(node) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) { for (const n of node) { const r = findRecipe(n); if (r) return r; } return null; }
  if (isRecipe(node)) return node;
  for (const k of ["@graph", "mainEntity", "itemListElement", "item"]) { const r = findRecipe(node[k]); if (r) return r; }
  return null;
}

function fromJsonLd(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { try { data = JSON.parse(decodeEntities(m[1].trim())); } catch { continue; } }
    const r = findRecipe(data);
    if (r) {
      const ings = asArray(r.recipeIngredient || r.ingredients).map((x) => stripTags(typeof x === "string" ? x : x && x.name)).filter(Boolean);
      if (ings.length) {
        const y = asArray(r.recipeYield)[0];
        return { name: stripTags(r.name), servings: y != null ? stripTags(String(y)) : "", ingredients: ings, method: "jsonld" };
      }
    }
  }
  return null;
}

function fromMicrodata(html) {
  const ings = [];
  const re = /<[^>]+itemprop=["'](?:recipeIngredient|ingredients)["'][^>]*>([\s\S]*?)<\/(?:li|span|div|p|td)>/gi;
  let m;
  while ((m = re.exec(html))) { const t = stripTags(m[1]); if (t) ings.push(t); }
  if (!ings.length) return null;
  return { name: titleOf(html), servings: "", ingredients: ings, method: "microdata" };
}

// Fooby-AMP-Seite: Zutaten stehen als Tabellenzeilen (Menge | Zutat)
function fromTable(html) {
  const ings = [];
  const rows = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) || []).map(stripTags);
    if (cells.length >= 2 && cells.length <= 3) {
      const line = cells.filter(Boolean).join(" ").trim();
      if (line && line.length < 160) ings.push(line);
    }
  }
  if (ings.length < 2) return null;
  const sv = (html.match(/(?:für|for|pour|per)\s+(\d+)\s*(?:Person|person|personne|persone|Portion|Stück|Stk)/i) || [])[1] || "";
  return { name: titleOf(html), servings: sv, ingredients: ings, method: "table" };
}

function titleOf(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
  if (og) return stripTags(og[1]);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) return stripTags(h1[1]);
  const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return t ? stripTags(t[1]).replace(/\s*[|–-]\s*FOOBY.*$/i, "") : "";
}

function foobyAmpUrl(u) {
  // https://fooby.ch/de/rezepte/12476/alpler... -> https://fooby.ch/de/rezepte/amp.id-12476.html
  const m = u.pathname.match(/^\/(de|fr|it|en)\/(rezepte|recettes|ricette|recipes)\/(?:amp\.id-)?(\d+)/i);
  return m ? `https://fooby.ch/${m[1]}/${m[2]}/amp.id-${m[3]}.html` : null;
}

async function getHtml(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, {
      signal: ctl.signal, redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (Wochenmenue Rezept-Import)", "Accept": "text/html,application/xhtml+xml", "Accept-Language": "de-CH,de;q=0.9" },
    });
    if (!r.ok) throw new Error("Seite antwortet mit Fehler " + r.status);
    const txt = await r.text();
    return txt.slice(0, 3_000_000);
  } finally { clearTimeout(t); }
}

export function parseRecipe(html) {
  return fromJsonLd(html) || fromMicrodata(html) || fromTable(html);
}

// ---------- Ist die anfragende Person Mitglied? ----------
async function isMember(req) {
  const auth = req.headers.get("Authorization") || "";
  const url = Deno.env.get("SUPABASE_URL"), key = Deno.env.get("SUPABASE_ANON_KEY");
  if (!auth || !url || !key) return false;
  const r = await fetch(url + "/rest/v1/rpc/is_member", { method: "POST", headers: { Authorization: auth, apikey: key, "Content-Type": "application/json" }, body: "{}" });
  if (!r.ok) return false;
  return (await r.json()) === true;
}

// ---------- Einstieg ----------
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Nur POST" }, 405);
  try {
    if (!(await isMember(req))) return json({ error: "Kein Zugriff" }, 403);
    const body = await req.json().catch(() => ({}));
    const raw = String(body.url || "").trim();
    let u;
    try { u = new URL(raw); } catch { return json({ error: "Das ist kein gültiger Link." }, 400); }
    if (!/^https?:$/.test(u.protocol)) return json({ error: "Nur Web-Links (https) sind möglich." }, 400);
    const host = u.hostname.toLowerCase();
    if (host === "localhost" || host.endsWith(".local") || host.endsWith(".internal") || /^[\d.]+$/.test(host) || host.includes(":")) {
      return json({ error: "Dieser Link ist nicht erlaubt." }, 400);
    }

    let html = await getHtml(u.href);
    let rec = parseRecipe(html);
    if ((!rec || rec.ingredients.length < 2) && host.endsWith("fooby.ch")) {
      const amp = foobyAmpUrl(u);
      if (amp && amp !== u.href) { html = await getHtml(amp); rec = parseRecipe(html) || rec; }
    }
    if (!rec || !rec.ingredients.length) return json({ error: "Auf dieser Seite habe ich kein Rezept mit Zutaten gefunden." }, 422);
    rec.name = rec.name || titleOf(html) || "Neues Gericht";
    rec.ingredients = rec.ingredients.slice(0, 60);
    return json({ ok: true, url: u.href, ...rec });
  } catch (e) {
    return json({ error: "Die Seite konnte nicht geladen werden: " + (e && e.message ? e.message : e) }, 502);
  }
});
