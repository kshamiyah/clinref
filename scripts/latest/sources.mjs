// Harvest sources for the Latest feed.
//
// Two kinds of source:
//   - Structured (PubMed, gov.uk MHRA, gov.uk NHSE maternity): JSON candidates.
//   - Pages (NICE, RCOG, MBRRACE): HTML listing pages whose text we hand to the
//     triage model to extract candidates from. More resilient than a scraper.
//
// Every fetch is wrapped so one dead source never fails the whole run.

const UA = "PocketOG-Latest/1.0 (+https://github.com/kshamiyah/pocket_og)";
const PUBMED_TOOL = "pocket-og-latest";
const PUBMED_EMAIL = "k.shamiyah@gmail.com";

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

async function getText(url) {
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; PocketOG-Latest/1.0; +https://github.com/kshamiyah/pocket_og)",
      Accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
}

export { htmlToText, getText };

// gov.uk search has no date filter, so the 15 most recent drug safety updates
// reach back months (Drug Safety Update is a monthly bulletin). Without this,
// stale alerts sit in the candidate pool every run and can surface at any time.
function withinMaxAge(timestamp, maxAgeDays) {
  if (!maxAgeDays) return true;
  if (!timestamp) return false;
  const t = Date.parse(timestamp);
  if (Number.isNaN(t)) return false;
  return (Date.now() - t) <= maxAgeDays * 86400000;
}

function ymd(d) {
  return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
}

// Strip HTML to rough text and cap length so page excerpts stay bounded.
function htmlToText(html, cap = 6000) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.slice(0, cap);
}

// --- Tier 2: journal shortlist via PubMed E-utilities (entry-date window) ---
// Entry date (edat) tracks when PubMed indexed the paper, not the print-issue
// date, so a short window actually catches things when they appear online.
export async function harvestPubMed({ lookbackDays = 3, apiKey = "" } = {}) {
  const key = apiKey ? `&api_key=${apiKey}` : "";
  const now = new Date();
  const from = new Date(now.getTime() - lookbackDays * 86400000);
  const journals = [
    "N Engl J Med", "Lancet", "BJOG", "Obstet Gynecol", "Am J Obstet Gynecol",
    "Lancet Obstet Gynaecol Womens Health", "Hum Reprod", "Fertil Steril",
  ];
  const journalClause = journals.map(j => `"${j}"[Journal]`).join(" OR ");
  const topicClause = [
    "pregnancy", "obstetric", "postpartum", "labour", "labor", "gynaecolog",
    "gynecolog", "contracept", "menopause", "endometrio", "fetal", "maternal",
  ].map(t => `${t}[Title/Abstract]`).join(" OR ");
  const typeClause = [
    "Randomized Controlled Trial[Publication Type]",
    "Meta-Analysis[Publication Type]",
    "Guideline[Publication Type]",
    "Practice Guideline[Publication Type]",
  ].join(" OR ");
  const term = encodeURIComponent(`(${journalClause}) AND (${topicClause}) AND (${typeClause})`);
  const esearch = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&datetype=edat&mindate=${ymd(from)}&maxdate=${ymd(now)}&retmax=40&term=${term}&tool=${PUBMED_TOOL}&email=${PUBMED_EMAIL}${key}`;

  const search = await getJson(esearch);
  const ids = search?.esearchresult?.idlist ?? [];
  if (ids.length === 0) return [];

  const esummary = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(",")}&tool=${PUBMED_TOOL}&email=${PUBMED_EMAIL}${key}`;
  const summary = await getJson(esummary);
  const result = summary?.result ?? {};
  return (result.uids ?? []).map(uid => {
    const a = result[uid] ?? {};
    const doi = (a.articleids ?? []).find(x => x.idtype === "doi")?.value ?? "";
    return {
      source: "PubMed",
      kind_hint: (a.pubtype ?? []).some(t => /guideline/i.test(t)) ? "guideline" : "trial",
      title: a.title ?? "",
      journal: a.fulljournalname || a.source || "",
      date: a.sortpubdate || a.epubdate || a.pubdate || "",
      doi,
      url: doi ? `https://doi.org/${doi}` : `https://pubmed.ncbi.nlm.nih.gov/${uid}/`,
      pmid: uid,
    };
  });
}

// --- Tier 1: MHRA safety notices via the keyless gov.uk search API ---
export async function harvestGovUk({ maxAgeDays = 0 } = {}) {
  const types = ["drug_safety_update", "medical_safety_alert", "drug_device_alert"];
  const out = [];
  let stale = 0;
  for (const t of types) {
    try {
      const url = `https://www.gov.uk/api/search.json?filter_content_store_document_type=${t}&order=-public_timestamp&count=15&fields=title,link,public_timestamp,description`;
      const data = await getJson(url);
      for (const r of data?.results ?? []) {
        if (!withinMaxAge(r.public_timestamp, maxAgeDays)) { stale++; continue; }
        out.push({
          source: "MHRA",
          kind_hint: "safety",
          title: r.title ?? "",
          date: (r.public_timestamp ?? "").slice(0, 10),
          description: r.description ?? "",
          url: r.link?.startsWith("http") ? r.link : `https://www.gov.uk${r.link ?? ""}`,
        });
      }
    } catch (e) {
      console.warn(`gov.uk ${t}: ${e.message}`);
    }
  }
  if (stale) console.log(`gov.uk MHRA: skipped ${stale} item(s) older than ${maxAgeDays} days.`);
  return out;
}

function govUkLink(link = "") {
  return link.startsWith("http") ? link : `https://www.gov.uk${link}`;
}

function kindHintForGovUk(url, title = "") {
  if (/\/government\/statistics\b/i.test(url)) return "report";
  if (/screening|handbook|pathway|immunisation|vaccination/i.test(title)) return "guideline";
  if (/\/government\/publications\b/i.test(url)) return "guideline";
  if (/\/government\/news\b/i.test(url)) return "report";
  return "report";
}

// --- NHS England maternity publications & news via gov.uk search API ---
export async function harvestNhsEnglandMaternity({ count = 15, maxAgeDays = 0 } = {}) {
  try {
    const url =
      "https://www.gov.uk/api/search.json?" +
      `filter_organisations=nhs-england&q=maternity&order=-public_timestamp&count=${count}` +
      "&fields=title,link,public_timestamp,description";
    const data = await getJson(url);
    const results = data?.results ?? [];
    const fresh = results.filter(r => withinMaxAge(r.public_timestamp, maxAgeDays));
    if (fresh.length < results.length) {
      console.log(`gov.uk NHSE maternity: skipped ${results.length - fresh.length} item(s) older than ${maxAgeDays} days.`);
    }
    return fresh.map(r => ({
      source: "REPORT",
      kind_hint: kindHintForGovUk(govUkLink(r.link ?? ""), r.title ?? ""),
      title: r.title ?? "",
      date: (r.public_timestamp ?? "").slice(0, 10),
      description: r.description ?? "",
      url: govUkLink(r.link ?? ""),
    }));
  } catch (e) {
    console.warn(`gov.uk NHSE maternity: ${e.message}`);
    return [];
  }
}

// --- Tier 1/3: listing pages we hand to the model to extract from ---
const PAGES = [
  { source: "NICE", url: "https://www.nice.org.uk/guidance/published?ndt=Guidance&ngt=Antenatal,Intrapartum,Postnatal,Fertility,Gynaecology&type=apg,csg,cg,mpg,ng,qs" },
  { source: "NICE-news", url: "https://www.nice.org.uk/news/articles" },
  { source: "RCOG", url: "https://www.rcog.org.uk/news/" },
  { source: "MBRRACE", url: "https://www.npeu.ox.ac.uk/mbrrace-uk/reports" },
];

// Deep links worth fetching so the model can name the concrete change, not just
// that an update existed on a listing page.
const DEEP_HREF_RE = /href=["']([^"']+)["']/gi;
const DEEP_PATH_RE = /\/(?:guidance\/(?:ng|cg|ta|dg|qs|m|ipg|hte)\d+(?:\/chapter\/Update-information)?|guidance\/indevelopment\/[a-z0-9-]+|news\/articles\/[a-z0-9-]+|news\/[a-z0-9-]+\/?|guidance\/browse-all-guidance\/[^"'#?]+)/i;

function absolutize(href, base) {
  try { return new URL(href, base).href; } catch { return null; }
}

function isListingHub(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.replace(/\/$/, "") || "/";
    if (/nice\.org\.uk$/i.test(u.hostname) && (p === "/news" || p === "/news/articles" || p.startsWith("/guidance/published"))) return true;
    if (/rcog\.org\.uk$/i.test(u.hostname) && (p === "/news" || p === "/guidance" || p === "/guidance/browse-all-guidance")) return true;
    return false;
  } catch {
    return true;
  }
}

function isRcogNewsArticle(url) {
  try {
    const u = new URL(url);
    if (!/rcog\.org\.uk$/i.test(u.hostname) || isListingHub(url)) return false;
    return /^\/news\/[^/]+/.test(u.pathname);
  } catch {
    return false;
  }
}

function extractDeepLinks(html, baseUrl, cap = 30) {
  const found = [];
  const seen = new Set();
  let m;
  DEEP_HREF_RE.lastIndex = 0;
  while ((m = DEEP_HREF_RE.exec(html)) && found.length < cap) {
    const abs = absolutize(m[1], baseUrl);
    if (!abs || isListingHub(abs)) continue;
    let pathname;
    try { pathname = new URL(abs).pathname; } catch { continue; }
    if (!DEEP_PATH_RE.test(pathname)) continue;
    const key = abs.toLowerCase().replace(/\/$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(abs);
  }
  return found;
}

// Prefer NICE Update-information when we only have the overview URL.
function preferUpdateInfo(url) {
  try {
    const u = new URL(url);
    if (!/nice\.org\.uk$/i.test(u.hostname)) return [url];
    const m = u.pathname.match(/^\/guidance\/((?:ng|cg|ta|dg|qs|m|ipg|hte)\d+)\/?$/i);
    if (!m) return [url];
    return [
      `https://www.nice.org.uk/guidance/${m[1]}/chapter/Update-information`,
      url,
    ];
  } catch {
    return [url];
  }
}

export async function harvestPages() {
  const out = [];
  for (const p of PAGES) {
    try {
      const html = await getText(p.url);
      out.push({
        source: p.source,
        url: p.url,
        text: htmlToText(html),
        links: extractDeepLinks(html, p.url),
      });
    } catch (e) {
      console.warn(`page ${p.source}: ${e.message}`);
    }
  }
  return out;
}

function buildDeepQueue(pages) {
  const rcog = [];
  const other = [];
  const seen = new Set();
  for (const p of pages) {
    for (const link of p.links || []) {
      for (const url of preferUpdateInfo(link)) {
        const key = url.toLowerCase().replace(/\/$/, "");
        if (seen.has(key) || isListingHub(url)) continue;
        seen.add(key);
        const item = { source: p.source, url };
        if (isRcogNewsArticle(url)) rcog.push(item);
        else other.push(item);
      }
    }
  }
  return { rcog, other };
}

// Fetch article / Update-information pages. Reserve slots for RCOG news posts so
// NICE Update-information links do not crowd them out of the budget.
export async function fetchDeepExcerpts(pages, { max = 24, rcogReserve = 8, cap = 5000 } = {}) {
  const { rcog, other } = buildDeepQueue(pages);
  const rcogTake = Math.min(rcogReserve, rcog.length);
  const otherTake = Math.min(other.length, Math.max(0, max - rcogTake));
  const plan = [...rcog.slice(0, rcogTake), ...other.slice(0, otherTake)];

  const out = [];
  for (const item of plan) {
    try {
      const html = await getText(item.url);
      const text = htmlToText(html, cap);
      if (text.length < 80) continue;
      out.push({ source: item.source, url: item.url, text });
    } catch (e) {
      console.warn(`deep ${item.url}: ${e.message}`);
    }
  }
  return out;
}

export { isListingHub, isRcogNewsArticle };
