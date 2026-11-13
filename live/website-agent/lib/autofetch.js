'use strict';
/*
 * Auto context: read a business's OWN website and write the first draft
 * of its context document from what the site itself says.
 *
 *   - starts at the homepage, follows the main internal links (about,
 *     services, pricing, contact, FAQ, ...), at most MAX_PAGES pages;
 *   - pulls structured facts where the site offers them (schema.org
 *     JSON-LD: name, description, email, telephone, address, priceRange,
 *     openingHours / openingHoursSpecification, FAQs);
 *   - spots phone numbers, emails and opening-hours lines in the text;
 *   - writes the result into the business's live context document as one
 *     clearly marked AUTO block.
 *
 * OWNER-EDIT SAFETY (the behaviour chosen, stated plainly): the auto
 * block lives between <!-- AUTO:BEGIN --> and <!-- AUTO:END --> markers.
 * A refresh replaces ONLY that block. Text the owner wrote outside the
 * block is never touched: if the document has no block yet, the block is
 * appended at the end. Nothing the owner typed is ever overwritten.
 */
const db = require('./db');

const MAX_PAGES = 8;
const PER_PAGE_TEXT_CHARS = 2400;
const AUTO_BLOCK_MAX_CHARS = 15000;
const FETCH_TIMEOUT_MS = 12000;
const UA =
  'Mozilla/5.0 (compatible; ZeliksAssistant/2.0; +https://zeliks.tech)';

const AUTO_BEGIN = '<!-- AUTO:BEGIN -->';
const AUTO_END = '<!-- AUTO:END -->';

// Hosts that are ours (the service host and the demo host), never the
// business's own site. They are skipped only when a site has to be
// guessed from allowed_domains; a website the pack names explicitly is
// always trusted (zeliks.tech itself is a real business site: Zeliks's).
const SKIP_DOMAIN_SUFFIXES = [
  'moodtech.cloud',
  'pages.dev',
  'demos.zeliks.tech',
];

// ------------------------------------------------------------ fetching

async function fetchHtml(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(type)) return null;
    const text = await res.text();
    return { url: res.url || url, html: text.slice(0, 900000) };
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------ parsing

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) =>
      String.fromCodePoint(parseInt(n, 16))
    );
}

function htmlToText(html) {
  let raw = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  raw = raw.replace(/<[^>]+>/g, '\n');
  const lines = decodeEntities(raw)
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const out = [];
  for (const l of lines) if (out[out.length - 1] !== l) out.push(l);
  return out;
}

function pageTitle(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1].replace(/\s+/g, ' ').trim()).slice(0, 160) : '';
}

function metaDescription(html) {
  const m =
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return m ? decodeEntities(m[1]).slice(0, 400) : '';
}

function jsonLdBlocks(html) {
  const blocks = [];
  const re =
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      blocks.push(JSON.parse(m[1]));
    } catch (_) {
      /* a broken block is skipped, never fatal */
    }
  }
  return blocks;
}

function* walkNodes(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) yield* walkNodes(n);
    return;
  }
  yield node;
  for (const v of Object.values(node)) {
    if (v && typeof v === 'object') yield* walkNodes(v);
  }
}

function addressToString(addr) {
  if (!addr) return '';
  if (typeof addr === 'string') return addr;
  const parts = [
    addr.streetAddress,
    addr.addressLocality,
    addr.addressRegion,
    addr.postalCode,
    typeof addr.addressCountry === 'string'
      ? addr.addressCountry
      : addr.addressCountry && addr.addressCountry.name,
  ].filter(Boolean);
  return parts.join(', ');
}

function hoursFromSpec(spec) {
  const lines = [];
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    if (!s || typeof s !== 'object') continue;
    const days = Array.isArray(s.dayOfWeek)
      ? s.dayOfWeek.join(', ')
      : String(s.dayOfWeek || '');
    const cleanDays = days.replace(/https?:\/\/schema\.org\//g, '');
    if (s.opens && s.closes) {
      lines.push(`- ${cleanDays}: ${s.opens} to ${s.closes}`);
    }
  }
  return lines;
}

function extractStructured(blocks) {
  const facts = {
    name: '',
    description: '',
    email: '',
    phone: '',
    address: '',
    priceRange: '',
    hoursLines: [],
    faqs: [],
  };
  for (const block of blocks) {
    for (const node of walkNodes(block)) {
      const type = String(node['@type'] || '');
      if (/Organization|Business|Store|Restaurant|Salon|Dentist|LocalBusiness/i.test(type)) {
        if (!facts.name && node.name) facts.name = String(node.name);
        if (!facts.description && node.description)
          facts.description = String(node.description);
        if (!facts.email && node.email)
          facts.email = String(node.email).replace(/^mailto:/, '');
        if (!facts.phone && node.telephone)
          facts.phone = String(node.telephone);
        if (!facts.address && node.address)
          facts.address = addressToString(node.address);
        if (!facts.priceRange && node.priceRange)
          facts.priceRange = String(node.priceRange);
        if (node.openingHours) {
          const oh = Array.isArray(node.openingHours)
            ? node.openingHours
            : [node.openingHours];
          for (const line of oh) facts.hoursLines.push(`- ${String(line)}`);
        }
        if (node.openingHoursSpecification) {
          facts.hoursLines.push(...hoursFromSpec(node.openingHoursSpecification));
        }
        const cp = Array.isArray(node.contactPoint)
          ? node.contactPoint[0]
          : node.contactPoint;
        if (cp && typeof cp === 'object') {
          if (!facts.phone && cp.telephone) facts.phone = String(cp.telephone);
          if (!facts.email && cp.email)
            facts.email = String(cp.email).replace(/^mailto:/, '');
        }
      }
      if (type === 'WebSite' && !facts.description && node.description) {
        facts.description = String(node.description);
      }
      if (type === 'FAQPage' && Array.isArray(node.mainEntity)) {
        for (const q of node.mainEntity) {
          const a =
            q.acceptedAnswer && typeof q.acceptedAnswer === 'object'
              ? q.acceptedAnswer.text
              : '';
          if (q.name && a) facts.faqs.push({ q: String(q.name), a: String(a) });
        }
      }
    }
  }
  return facts;
}

// ------------------------------------------------- spotting in the text

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /\+\d[\d\s().-]{7,}\d/g;
const DAY_RE =
  /\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b|monday|tuesday|wednesday|thursday|friday|saturday|sunday/i;
// A line only counts as an hours statement when it carries an actual
// time (9am, 09:00, 9-5): a sentence that merely mentions the words
// "opening hours" (a product feature, a heading) is not the business's
// hours, and treating it as such would hand the agent a false fact.
const TIME_RE =
  /\b\d{1,2}(:\d{2})?\s*(am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*[-–]\s*\d{1,2}\s*(am|pm)?\b/i;

function spotFacts(pages) {
  const emails = new Set();
  const phones = new Set();
  const hoursLines = [];
  for (const page of pages) {
    for (const line of page.lines) {
      for (const e of line.match(EMAIL_RE) || []) {
        if (!/\.(png|jpe?g|svg|webp|gif)$/i.test(e)) emails.add(e);
      }
      for (const p of line.match(PHONE_RE) || []) {
        const digits = p.replace(/\D/g, '');
        if (digits.length >= 8 && digits.length <= 15) phones.add(p.trim());
      }
      const l = line;
      const looksHours =
        /24\/7|open 24 hours/i.test(l) ||
        (TIME_RE.test(l) &&
          (DAY_RE.test(l) ||
            /opening hours|business hours|working hours|open from|open:|hours:/i.test(l)));
      if (looksHours && l.length <= 160 && hoursLines.length < 10) {
        if (!hoursLines.includes(l)) hoursLines.push(l);
      }
    }
  }
  return {
    emails: [...emails].slice(0, 4),
    phones: [...phones].slice(0, 4),
    hoursLines,
  };
}

// ------------------------------------------------------------- crawling

const LINK_PRIORITY = [
  /service/i,
  /pricing|price/i,
  /about/i,
  /contact/i,
  /faq/i,
  /team/i,
  /work/i,
];

function internalLinks(html, baseUrl) {
  const found = [];
  const re = /<a[^>]+href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u;
    try {
      u = new URL(m[1], baseUrl);
    } catch (_) {
      continue;
    }
    if (u.hostname !== new URL(baseUrl).hostname) continue;
    if (/\.(png|jpe?g|svg|webp|gif|pdf|css|js|ico)$/i.test(u.pathname)) continue;
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, ' '))
      .replace(/\s+/g, ' ')
      .trim();
    found.push({ url: u.href, path: u.pathname, text });
  }
  return found;
}

function pickFollowUps(links, alreadyHave, limit) {
  const seen = new Set(alreadyHave);
  const scored = [];
  for (const l of links) {
    const key = l.url.replace(/#.*$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    let score = -1;
    LINK_PRIORITY.forEach((re, i) => {
      if (score < 0 && (re.test(l.path) || re.test(l.text))) {
        score = LINK_PRIORITY.length - i;
      }
    });
    if (/^\/(ar|ar\/|privacy|terms|security|careers|blog)/.test(l.path)) {
      score = -1; // legal / blog / other-language pages teach the agent little
    }
    if (score >= 0) scored.push({ ...l, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Decide which site belongs to this business: the pack's website
 * first (trusted as configured), else the first allowed domain that is
 * not one of our own hosts. */
function siteBaseForPack(pack) {
  const biz = (pack && pack.business) || {};
  let host = String(biz.website || '')
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .trim()
    .toLowerCase();
  if (!host) {
    const domains =
      (pack && pack.widget && pack.widget.allowed_domains) || [];
    for (const d of domains) {
      const cand = String(d).replace(/^\./, '').toLowerCase();
      if (SKIP_DOMAIN_SUFFIXES.some((s) => cand === s || cand.endsWith('.' + s))) {
        continue;
      }
      host = cand;
      break;
    }
  }
  if (!host || !host.includes('.')) return null;
  return `https://${host}/`;
}

async function crawlSite(baseUrl) {
  const home = await fetchHtml(baseUrl);
  if (!home) return null;
  const pages = [];
  const addPage = (fetched) => {
    pages.push({
      url: fetched.url,
      title: pageTitle(fetched.html),
      lines: htmlToText(fetched.html),
      blocks: jsonLdBlocks(fetched.html),
      meta: metaDescription(fetched.html),
    });
  };
  addPage(home);
  const links = internalLinks(home.html, home.url);
  const follow = pickFollowUps(links, [home.url, baseUrl], MAX_PAGES - 1);
  for (const l of follow) {
    const fetched = await fetchHtml(l.url);
    if (fetched) addPage(fetched);
  }
  return pages;
}

// ---------------------------------------------------- the auto document

function buildAutoBlock({ host, pages, structured, spotted }) {
  const lines = [];
  lines.push(AUTO_BEGIN);
  lines.push(`# Facts read automatically from ${host}`);
  lines.push('');
  lines.push(
    `Read from the business's own website on ${new Date().toISOString().slice(0, 10)}. ` +
      'Pages read: ' +
      pages.map((p) => new URL(p.url).pathname || '/').join(', ') +
      '.'
  );
  lines.push('');
  if (structured.description) {
    lines.push('## How the website describes the business');
    lines.push('');
    lines.push(structured.description);
    lines.push('');
  }
  lines.push('## Contact facts from the website');
  lines.push('');
  const email = structured.email || spotted.emails[0] || '';
  const phone = structured.phone || spotted.phones[0] || '';
  if (email) lines.push(`- Email: ${email}`);
  if (phone) lines.push(`- Phone / WhatsApp: ${phone}`);
  if (structured.address) lines.push(`- Address: ${structured.address}`);
  if (structured.priceRange)
    lines.push(`- Price range as the site states it: ${structured.priceRange}`);
  if (!email && !phone && !structured.address) {
    lines.push('- The website does not state an email, phone number or address.');
  }
  lines.push('');
  lines.push('## Opening hours');
  lines.push('');
  const hours = structured.hoursLines.length
    ? structured.hoursLines
    : spotted.hoursLines.map((l) => `- ${l}`);
  if (hours.length) {
    lines.push('As written on the website:');
    lines.push(...hours);
  } else {
    lines.push(
      'The website does not state opening hours. Do not invent any: if a ' +
        'visitor asks, say the hours are not published and offer the ' +
        'contact options above.'
    );
  }
  lines.push('');
  if (structured.faqs.length) {
    lines.push('## Questions the website itself answers');
    lines.push('');
    for (const f of structured.faqs.slice(0, 10)) {
      lines.push(`Q: ${f.q}`);
      lines.push(`A: ${f.a}`);
      lines.push('');
    }
  }
  lines.push('## What the pages say');
  // Lines already quoted from an earlier page (nav menus, footers) are
  // not repeated: they cost space and teach the agent nothing twice.
  const seenLines = new Set();
  for (const p of pages) {
    const fresh = p.lines.filter((l) => {
      if (seenLines.has(l)) return false;
      seenLines.add(l);
      return true;
    });
    const section =
      `\n### ${p.title || new URL(p.url).pathname} (${new URL(p.url).pathname || '/'})\n\n` +
      fresh.join('\n').slice(0, PER_PAGE_TEXT_CHARS);
    // Stop at a page boundary rather than cutting a page mid-sentence.
    if (lines.join('\n').length + section.length > AUTO_BLOCK_MAX_CHARS) break;
    lines.push(section);
  }
  lines.push('');
  lines.push(AUTO_END);
  return lines.join('\n');
}

/** Replace the AUTO block if one exists, else append it. Nothing
 * outside the markers is ever modified. */
function applyAutoBlock(existing, block) {
  const current = existing || '';
  const begin = current.indexOf(AUTO_BEGIN);
  const end = current.indexOf(AUTO_END);
  if (begin >= 0 && end > begin) {
    return {
      text:
        current.slice(0, begin) +
        block +
        current.slice(end + AUTO_END.length),
      mode: 'replaced',
    };
  }
  if (!current.trim()) return { text: block, mode: 'created' };
  return { text: current.replace(/\s+$/, '') + '\n\n' + block + '\n', mode: 'appended' };
}

// ------------------------------------------------------------ entrypoints

async function extractFromSite(baseUrl) {
  const pages = await crawlSite(baseUrl);
  if (!pages) return null;
  const structured = extractStructured(pages.flatMap((p) => p.blocks));
  const spotted = spotFacts(pages);
  const host = new URL(baseUrl).hostname;
  const block = buildAutoBlock({ host, pages, structured, spotted });
  return {
    host,
    pages_read: pages.map((p) => p.url),
    structured,
    spotted,
    block,
  };
}

/** Run extraction for a tenant and store the result in its live
 * context document (and the system_prompt copy, exactly like a context
 * page save). Returns a summary, or null when the business has no
 * readable website. */
async function refreshTenantContext(tenantId) {
  const res = await db.query(
    'SELECT pack, context_text FROM tenant_config WHERE tenant_id = $1',
    [tenantId]
  );
  if (!res.rows.length) return null;
  const pack = res.rows[0].pack;
  const base = siteBaseForPack(pack);
  if (!base) return null;
  const extracted = await extractFromSite(base);
  if (!extracted) return null;
  const { text, mode } = applyAutoBlock(res.rows[0].context_text, extracted.block);
  await db.query(
    `UPDATE tenant_config
        SET context_text = $2, system_prompt = $2, context_updated_at = now()
      WHERE tenant_id = $1`,
    [tenantId, text]
  );
  return {
    ok: true,
    tenant_id: tenantId,
    site: extracted.host,
    pages_read: extracted.pages_read,
    mode,
    email: extracted.structured.email || extracted.spotted.emails[0] || null,
    phone: extracted.structured.phone || extracted.spotted.phones[0] || null,
    hours_found:
      extracted.structured.hoursLines.length > 0 ||
      extracted.spotted.hoursLines.length > 0,
    context_chars: text.length,
  };
}

module.exports = {
  AUTO_BEGIN,
  AUTO_END,
  siteBaseForPack,
  extractFromSite,
  applyAutoBlock,
  refreshTenantContext,
};
