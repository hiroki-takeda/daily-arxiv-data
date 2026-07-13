import { createHash } from "node:crypto";

export const ARXIV_CATEGORIES = Object.freeze(["hep-th", "gr-qc", "quant-ph"]);
export const ARXIV_LISTING_URLS = Object.freeze({
  "hep-th": "https://arxiv.org/list/hep-th/new",
  "gr-qc": "https://arxiv.org/list/gr-qc/new",
  "quant-ph": "https://arxiv.org/list/quant-ph/new",
});
export const ARXIV_FETCH_URLS = Object.freeze(Object.fromEntries(
  ARXIV_CATEGORIES.map((slug) => [slug, `${ARXIV_LISTING_URLS[slug]}?skip=0&show=2000`]),
));
export const ARXIV_PASTWEEK_LISTING_URLS = Object.freeze(Object.fromEntries(
  ARXIV_CATEGORIES.map((slug) => [slug, `https://arxiv.org/list/${slug}/pastweek`]),
));
export const ARXIV_PASTWEEK_FETCH_URLS = Object.freeze(Object.fromEntries(
  ARXIV_CATEGORIES.map((slug) => [slug, `${ARXIV_PASTWEEK_LISTING_URLS[slug]}?skip=0&show=2000`]),
));
export const MAX_ARXIV_LISTING_BYTES = 8 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 30_000;
const ARXIV_ID_PATTERN = /^\d{4}\.\d{4,5}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const SECTION_COUNT_PATTERN = /^(New submissions|Cross submissions) \(showing (0|[1-9]\d*) of (0|[1-9]\d*) entries\)$/;
const ANNOUNCEMENT_PATTERN = /^Showing new listings for (Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), ([1-9]|[12]\d|3[01]) (January|February|March|April|May|June|July|August|September|October|November|December) (\d{4})$/;
const PASTWEEK_HEADING_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([1-9]|[12]\d|3[01]) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) \(showing (0|[1-9]\d*) of (0|[1-9]\d*) entries \)$/;
const PASTWEEK_HEADING_PREFIX_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat),\s/;
const CROSS_LIST_MARKER_PATTERN = /\(cross-list from ([a-z][a-z0-9-]*(?:\.[A-Za-z0-9-]+)*)\)/g;
const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
const SHORT_WEEKDAYS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const MONTHS = Object.freeze([
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
]);
const SHORT_MONTHS = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes"]);

export class ArxivSourceError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "ArxivSourceError";
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new ArxivSourceError(code, message, options);
}

function exactKeys(value, expected, path, code = "SOURCE_INVALID") {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${path} must be an object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail(code, `${path} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function validateDate(value, path, code = "SOURCE_INVALID") {
  if (typeof value !== "string") fail(code, `${path} must use YYYY-MM-DD.`);
  const match = DATE_PATTERN.exec(value);
  if (!match) fail(code, `${path} must use YYYY-MM-DD.`);
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== Number(month) ||
    parsed.getUTCDate() !== Number(day)
  ) {
    fail(code, `${path} is not a real calendar date.`);
  }
  return value;
}

function supportedSlug(slug) {
  if (!Object.hasOwn(ARXIV_LISTING_URLS, slug)) {
    fail("SOURCE_INVALID", `Unsupported arXiv category ${JSON.stringify(slug)}.`);
  }
  return slug;
}

function findTagEnd(html, start) {
  let quote = null;
  for (let index = start + 1; index < html.length; index += 1) {
    const character = html[index];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === "\"" || character === "'") {
      quote = character;
    } else if (character === ">") {
      return index + 1;
    }
  }
  fail("SOURCE_INCOMPLETE", "arXiv listing contains an unterminated HTML tag.");
}

function findRawTextEnd(html, lowerHtml, name, start) {
  const needle = `</${name}`;
  let cursor = start;
  while (cursor < html.length) {
    const candidate = lowerHtml.indexOf(needle, cursor);
    if (candidate === -1) {
      fail("SOURCE_INCOMPLETE", `arXiv listing has no closing </${name}> tag.`);
    }
    const boundary = lowerHtml[candidate + needle.length];
    if (boundary === ">" || /\s/.test(boundary ?? "")) return candidate;
    cursor = candidate + needle.length;
  }
  fail("SOURCE_INCOMPLETE", `arXiv listing has no closing </${name}> tag.`);
}

function tokenizeHtml(html) {
  const tokens = [];
  const lowerHtml = html.toLowerCase();
  let cursor = 0;
  while (cursor < html.length) {
    const opening = html.indexOf("<", cursor);
    if (opening === -1) {
      if (cursor < html.length) tokens.push({ type: "text", start: cursor, end: html.length, text: html.slice(cursor) });
      break;
    }
    if (opening > cursor) {
      tokens.push({ type: "text", start: cursor, end: opening, text: html.slice(cursor, opening) });
    }
    if (html.startsWith("<!--", opening)) {
      const close = html.indexOf("-->", opening + 4);
      if (close === -1) fail("SOURCE_INCOMPLETE", "arXiv listing contains an unterminated HTML comment.");
      cursor = close + 3;
      continue;
    }
    if (/^<!doctype\b/i.test(html.slice(opening, opening + 16))) {
      cursor = findTagEnd(html, opening);
      continue;
    }
    if (html.startsWith("<!", opening) || html.startsWith("<?", opening)) {
      fail("SOURCE_INCOMPLETE", "arXiv listing contains unsupported HTML markup.");
    }

    const end = findTagEnd(html, opening);
    const source = html.slice(opening, end);
    const match = /^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)\b/.exec(source);
    if (!match) fail("SOURCE_INCOMPLETE", "arXiv listing contains malformed HTML markup.");
    const closing = match[1] === "/";
    const name = match[2].toLowerCase();
    const selfClosing = !closing && /\/\s*>$/.test(source);
    tokens.push({
      type: closing ? "end" : "start",
      name,
      start: opening,
      end,
      source,
      selfClosing,
    });
    cursor = end;

    if (!closing && !selfClosing && RAW_TEXT_ELEMENTS.has(name)) {
      const closeStart = findRawTextEnd(html, lowerHtml, name, cursor);
      if (closeStart > cursor) {
        tokens.push({ type: "text", start: cursor, end: closeStart, text: "" });
      }
      const closeEnd = findTagEnd(html, closeStart);
      tokens.push({
        type: "end",
        name,
        start: closeStart,
        end: closeEnd,
        source: html.slice(closeStart, closeEnd),
        selfClosing: false,
      });
      cursor = closeEnd;
    }
  }
  return tokens;
}

function decodeHtmlEntities(value, path) {
  return value.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi, (entity, body) => {
    const named = {
      amp: "&",
      apos: "'",
      gt: ">",
      lt: "<",
      nbsp: " ",
      quot: "\"",
    };
    const lower = body.toLowerCase();
    if (Object.hasOwn(named, lower)) return named[lower];
    const numeric = lower.startsWith("#x")
      ? Number.parseInt(lower.slice(2), 16)
      : lower.startsWith("#")
        ? Number.parseInt(lower.slice(1), 10)
        : Number.NaN;
    if (Number.isInteger(numeric) && numeric > 0 && numeric <= 0x10ffff && !(numeric >= 0xd800 && numeric <= 0xdfff)) {
      return String.fromCodePoint(numeric);
    }
    fail("SOURCE_INCOMPLETE", `${path} contains an unsupported HTML entity ${entity}.`);
  });
}

function parseAttributes(token) {
  const source = token.source;
  let cursor = 1;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  if (source[cursor] === "/") cursor += 1;
  while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  const tagMatch = /^[A-Za-z][A-Za-z0-9:-]*/.exec(source.slice(cursor));
  if (!tagMatch) fail("SOURCE_INCOMPLETE", `Malformed <${token.name}> tag.`);
  cursor += tagMatch[0].length;
  const attributes = {};

  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === ">") break;
    if (source[cursor] === "/" && /^\/\s*>$/.test(source.slice(cursor))) break;
    const nameMatch = /^[^\s=/>]+/.exec(source.slice(cursor));
    if (!nameMatch) fail("SOURCE_INCOMPLETE", `Malformed attribute in <${token.name}> tag.`);
    const name = nameMatch[0].toLowerCase();
    cursor += nameMatch[0].length;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let value = "";
    if (source[cursor] === "=") {
      cursor += 1;
      while (/\s/.test(source[cursor] ?? "")) cursor += 1;
      const quote = source[cursor];
      if (quote === "\"" || quote === "'") {
        const close = source.indexOf(quote, cursor + 1);
        if (close === -1) fail("SOURCE_INCOMPLETE", `Unterminated ${name} attribute in <${token.name}> tag.`);
        value = source.slice(cursor + 1, close);
        cursor = close + 1;
      } else {
        const valueMatch = /^[^\s>]+/.exec(source.slice(cursor));
        if (!valueMatch) fail("SOURCE_INCOMPLETE", `Missing ${name} attribute value in <${token.name}> tag.`);
        value = valueMatch[0];
        cursor += valueMatch[0].length;
      }
    }
    if (Object.hasOwn(attributes, name)) {
      fail("SOURCE_INCOMPLETE", `Duplicate ${name} attribute in <${token.name}> tag.`);
    }
    attributes[name] = decodeHtmlEntities(value, `<${token.name}>.${name}`);
  }
  return attributes;
}

function pairElement(tokens, startIndex, name) {
  let depth = 0;
  for (let index = startIndex; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.name !== name) continue;
    if (token.type === "start" && !token.selfClosing) depth += 1;
    if (token.type === "end") depth -= 1;
    if (depth === 0) return index;
    if (depth < 0) break;
  }
  fail("SOURCE_INCOMPLETE", `arXiv listing has no matching </${name}> tag.`);
}

function uniqueElementWithId(tokens, name, id) {
  const matches = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "start" || token.name !== name) continue;
    const attributes = parseAttributes(token);
    if (attributes.id === id) matches.push(index);
  }
  if (matches.length !== 1) {
    fail("SOURCE_INCOMPLETE", `arXiv listing must contain exactly one <${name} id="${id}"> element.`);
  }
  const startIndex = matches[0];
  const endIndex = pairElement(tokens, startIndex, name);
  return { startIndex, endIndex, start: tokens[startIndex].start, end: tokens[endIndex].end };
}

function elementText(tokens, startIndex, endIndex, path) {
  const text = tokens
    .slice(startIndex + 1, endIndex)
    .filter((token) => token.type === "text")
    .map((token) => token.text)
    .join("");
  return decodeHtmlEntities(text, path).replace(/\s+/g, " ").trim();
}

function collectHeadings(tokens, lowerBound, upperBound) {
  const headings = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.start < lowerBound || token.end > upperBound || token.type !== "start" || token.name !== "h3") continue;
    const endIndex = pairElement(tokens, index, "h3");
    if (tokens[endIndex].end > upperBound) fail("SOURCE_INCOMPLETE", "arXiv listing has a truncated <h3> heading.");
    headings.push({
      startIndex: index,
      endIndex,
      start: token.start,
      end: tokens[endIndex].end,
      text: elementText(tokens, index, endIndex, "arXiv heading"),
    });
    index = endIndex;
  }
  return headings;
}

function parseAnnouncementDate(heading) {
  const match = ANNOUNCEMENT_PATTERN.exec(heading);
  if (!match) fail("SOURCE_INCOMPLETE", "arXiv listing announcement date is missing or is not the expected English date heading.");
  const [, weekday, day, monthName, year] = match;
  const month = MONTHS.indexOf(monthName) + 1;
  const parsed = new Date(Date.UTC(Number(year), month - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== Number(day) ||
    WEEKDAYS[parsed.getUTCDay()] !== weekday
  ) {
    fail("SOURCE_INCOMPLETE", "arXiv listing announcement heading contains an invalid date or weekday.");
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parsePastweekHeading(heading) {
  const match = PASTWEEK_HEADING_PATTERN.exec(heading);
  if (!match) {
    fail("SOURCE_INCOMPLETE", "arXiv pastweek listing has a malformed English date/count heading.");
  }
  const [, weekday, day, monthName, year, shownText, totalText] = match;
  const month = SHORT_MONTHS.indexOf(monthName) + 1;
  const parsed = new Date(Date.UTC(Number(year), month - 1, Number(day)));
  if (
    parsed.getUTCFullYear() !== Number(year) ||
    parsed.getUTCMonth() + 1 !== month ||
    parsed.getUTCDate() !== Number(day) ||
    SHORT_WEEKDAYS[parsed.getUTCDay()] !== weekday
  ) {
    fail("SOURCE_INCOMPLETE", "arXiv pastweek heading contains an invalid date or weekday.");
  }
  const shown = Number(shownText);
  const total = Number(totalText);
  if (!Number.isSafeInteger(shown) || !Number.isSafeInteger(total) || shown > total) {
    fail("SOURCE_INCOMPLETE", `arXiv pastweek heading has invalid pagination (shown=${shownText}, total=${totalText}).`);
  }
  return Object.freeze({
    announcementDate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    shown,
    total,
  });
}

function parseSectionHeading(heading, expectedName) {
  const match = SECTION_COUNT_PATTERN.exec(heading.text);
  if (!match || match[1] !== expectedName) {
    fail("SOURCE_INCOMPLETE", `arXiv listing is missing the exact ${expectedName} count heading.`);
  }
  const shown = Number(match[2]);
  const total = Number(match[3]);
  if (!Number.isSafeInteger(shown) || !Number.isSafeInteger(total) || shown !== total) {
    fail("SOURCE_INCOMPLETE", `${expectedName} must show every entry (shown=${shown}, total=${total}).`);
  }
  return total;
}

function dtEntries(tokens, start, end, sectionName) {
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.start < start || token.end > end || token.type !== "start" || token.name !== "dt") continue;
    const endIndex = pairElement(tokens, index, "dt");
    if (tokens[endIndex].end > end) fail("SOURCE_INCOMPLETE", `${sectionName} contains a truncated <dt> entry.`);
    entries.push({ startIndex: index, endIndex });
    index = endIndex;
  }
  return entries;
}

function idFromDt(tokens, entry, sectionName, entryIndex) {
  const ids = [];
  for (let index = entry.startIndex + 1; index < entry.endIndex; index += 1) {
    const token = tokens[index];
    if (token.type !== "start" || token.name !== "a") continue;
    const { href, title } = parseAttributes(token);
    if (typeof href !== "string") continue;
    const match = /^\/abs\/(\d{4}\.\d{4,5})$/.exec(href);
    if (!match) continue;
    if (title !== "Abstract") {
      fail("SOURCE_INCOMPLETE", `${sectionName} <dt> ${entryIndex + 1} has a noncanonical abstract link.`);
    }
    ids.push(match[1]);
  }
  if (ids.length !== 1) {
    fail("SOURCE_INCOMPLETE", `${sectionName} <dt> ${entryIndex + 1} must contain exactly one unversioned modern arXiv abstract link.`);
  }
  return ids[0];
}

function parseSectionEntries(tokens, heading, nextHeadingStart, expectedName, { collectIds = true } = {}) {
  const total = parseSectionHeading(heading, expectedName);
  const entries = dtEntries(tokens, heading.end, nextHeadingStart, expectedName);
  if (entries.length !== total) {
    fail("SOURCE_INCOMPLETE", `${expectedName} declares ${total} entries but contains ${entries.length} <dt> entries.`);
  }
  const ids = collectIds ? entries.map((entry, index) => idFromDt(tokens, entry, expectedName, index)) : [];
  if (collectIds && new Set(ids).size !== ids.length) fail("SOURCE_INCOMPLETE", `${expectedName} contains duplicate arXiv IDs.`);
  return { total, ids };
}

export function parseArxivNewListing(html, slug) {
  supportedSlug(slug);
  if (typeof html !== "string" || html.length === 0) fail("SOURCE_INCOMPLETE", `${slug} listing must be non-empty HTML.`);
  if (Buffer.byteLength(html, "utf8") > MAX_ARXIV_LISTING_BYTES) {
    fail("SOURCE_TOO_LARGE", `${slug} listing exceeds ${MAX_ARXIV_LISTING_BYTES} bytes.`);
  }
  if (html.includes("\0")) fail("SOURCE_INCOMPLETE", `${slug} listing contains a NUL byte.`);

  const tokens = tokenizeHtml(html);
  const page = uniqueElementWithId(tokens, "div", "dlpage");

  const pageHeadings = collectHeadings(tokens, page.start, page.end);
  const announcementHeadings = pageHeadings.filter((heading) => heading.text.startsWith("Showing new listings for "));
  if (announcementHeadings.length !== 1) {
    fail("SOURCE_INCOMPLETE", `${slug} listing must contain exactly one English announcement-date heading.`);
  }
  const announcementDate = parseAnnouncementDate(announcementHeadings[0].text);

  // arXiv currently emits one <dl id="articles"> per New/Cross/Replacement
  // section. Older fixtures and mirrors may wrap all sections in one list, so
  // the stable boundary is the ordered h3 sequence inside #dlpage.
  const headings = pageHeadings;
  const newHeadings = headings.filter((heading) => heading.text.startsWith("New submissions"));
  const crossHeadings = headings.filter((heading) => heading.text.startsWith("Cross submissions"));
  if (newHeadings.length !== 1 || crossHeadings.length !== 1) {
    fail("SOURCE_INCOMPLETE", `${slug} listing must contain exactly one New submissions and one Cross submissions heading.`);
  }
  const newHeading = newHeadings[0];
  const crossHeading = crossHeadings[0];
  if (newHeading.start >= crossHeading.start) {
    fail("SOURCE_INCOMPLETE", `${slug} listing sections are out of order.`);
  }
  const afterCross = headings.find((heading) => heading.start > crossHeading.start)?.start ?? page.end;
  const primary = parseSectionEntries(tokens, newHeading, crossHeading.start, "New submissions");
  const cross = parseSectionEntries(tokens, crossHeading, afterCross, "Cross submissions", { collectIds: false });

  return Object.freeze({
    slug,
    sourceUrl: ARXIV_LISTING_URLS[slug],
    announcementDate,
    newCount: primary.total,
    crosslistCount: cross.total,
    newIds: Object.freeze([...primary.ids].sort()),
  });
}

function classifyPastweekEntry(tokens, entry, entryIndex, date) {
  const text = elementText(tokens, entry.startIndex, entry.endIndex, `pastweek ${date} <dt> ${entryIndex + 1}`);
  const markers = [...text.matchAll(CROSS_LIST_MARKER_PATTERN)];
  const stripped = text.replace(CROSS_LIST_MARKER_PATTERN, "");
  if (markers.length > 1 || /cross-list/iu.test(stripped)) {
    fail("SOURCE_INCOMPLETE", `pastweek ${date} <dt> ${entryIndex + 1} has a malformed or repeated cross-list marker.`);
  }
  // Cross-lists are excluded from evaluation and can legitimately use legacy
  // identifiers. Match the /new parser by validating modern IDs only for the
  // primary-New set that becomes the publication contract.
  if (markers.length === 1) return Object.freeze({ id: null, crosslist: true });
  const id = idFromDt(tokens, entry, `pastweek ${date}`, entryIndex);
  return Object.freeze({ id, crosslist: false });
}

export function parseArxivPastweekListing(html, slug) {
  supportedSlug(slug);
  if (typeof html !== "string" || html.length === 0) fail("SOURCE_INCOMPLETE", `${slug} pastweek listing must be non-empty HTML.`);
  if (Buffer.byteLength(html, "utf8") > MAX_ARXIV_LISTING_BYTES) {
    fail("SOURCE_TOO_LARGE", `${slug} pastweek listing exceeds ${MAX_ARXIV_LISTING_BYTES} bytes.`);
  }
  if (html.includes("\0")) fail("SOURCE_INCOMPLETE", `${slug} pastweek listing contains a NUL byte.`);

  const tokens = tokenizeHtml(html);
  const page = uniqueElementWithId(tokens, "div", "dlpage");
  const pageHeadings = collectHeadings(tokens, page.start, page.end);
  const dateHeadings = pageHeadings.filter((heading) => PASTWEEK_HEADING_PREFIX_PATTERN.test(heading.text));
  if (dateHeadings.length === 0) {
    fail("SOURCE_INCOMPLETE", `${slug} pastweek listing contains no English date/count headings.`);
  }
  if (dateHeadings.length !== pageHeadings.length) {
    fail("SOURCE_INCOMPLETE", `${slug} pastweek listing contains an unexpected or malformed date heading.`);
  }

  const parsedHeadings = dateHeadings.map((heading) => ({ heading, ...parsePastweekHeading(heading.text) }));
  const dates = parsedHeadings.map(({ announcementDate }) => announcementDate);
  if (new Set(dates).size !== dates.length) fail("SOURCE_INCOMPLETE", `${slug} pastweek listing repeats an announcement date.`);
  for (let index = 1; index < dates.length; index += 1) {
    if (dates[index - 1] <= dates[index]) {
      fail("SOURCE_INCOMPLETE", `${slug} pastweek announcement dates must be in strict newest-to-oldest order.`);
    }
  }

  const seenIds = new Set();
  const groups = parsedHeadings.map(({ heading, announcementDate, shown, total }, index) => {
    const complete = shown === total;
    if (!complete && index !== parsedHeadings.length - 1) {
      fail("SOURCE_INCOMPLETE", `${slug} pastweek group ${announcementDate} is partial but is not the oldest anchor group.`);
    }
    const nextStart = parsedHeadings[index + 1]?.heading.start ?? page.end;
    const entries = dtEntries(tokens, heading.end, nextStart, `pastweek ${announcementDate}`);
    if (entries.length !== shown) {
      fail("SOURCE_INCOMPLETE", `pastweek ${announcementDate} declares ${shown} shown entries but contains ${entries.length} <dt> entries.`);
    }
    const parsedEntries = entries.map((entry, entryIndex) => classifyPastweekEntry(
      tokens,
      entry,
      entryIndex,
      announcementDate,
    ));
    for (const { id } of parsedEntries) {
      if (id === null) continue;
      if (seenIds.has(id)) fail("SOURCE_INCOMPLETE", `${slug} pastweek listing repeats arXiv ID ${id}.`);
      seenIds.add(id);
    }
    const newIds = parsedEntries.filter(({ crosslist }) => !crosslist).map(({ id }) => id).sort();
    const crosslistCount = parsedEntries.length - newIds.length;
    return Object.freeze({
      announcementDate,
      shownCount: shown,
      totalCount: total,
      complete,
      newCount: newIds.length,
      crosslistCount,
      newIds: Object.freeze(newIds),
    });
  });

  return Object.freeze({
    slug,
    sourceUrl: ARXIV_PASTWEEK_LISTING_URLS[slug],
    groups: Object.freeze(groups),
  });
}

function validateListingRecord(record, expectedSlug, expectedUrls = ARXIV_LISTING_URLS) {
  exactKeys(record, ["slug", "sourceUrl", "announcementDate", "newCount", "crosslistCount", "newIds"], `${expectedSlug} listing`);
  if (record.slug !== expectedSlug) fail("SOURCE_INVALID", `${expectedSlug} listing has the wrong slug.`);
  if (record.sourceUrl !== expectedUrls[expectedSlug]) {
    fail("SOURCE_INVALID", `${expectedSlug} listing does not use its hardcoded official HTTPS URL.`);
  }
  validateDate(record.announcementDate, `${expectedSlug}.announcementDate`);
  for (const field of ["newCount", "crosslistCount"]) {
    if (!Number.isSafeInteger(record[field]) || record[field] < 0) {
      fail("SOURCE_INVALID", `${expectedSlug}.${field} must be a non-negative safe integer.`);
    }
  }
  if (!Array.isArray(record.newIds) || record.newIds.length !== record.newCount) {
    fail("SOURCE_INVALID", `${expectedSlug}.newIds must contain exactly newCount IDs.`);
  }
  if (record.newIds.some((id) => typeof id !== "string" || !ARXIV_ID_PATTERN.test(id))) {
    fail("SOURCE_INVALID", `${expectedSlug}.newIds contains an invalid arXiv ID.`);
  }
  if (new Set(record.newIds).size !== record.newIds.length) {
    fail("SOURCE_INVALID", `${expectedSlug}.newIds contains duplicates.`);
  }
}

function buildListingSnapshot(listings, expectedUrls) {
  if (!Array.isArray(listings) || listings.length !== ARXIV_CATEGORIES.length) {
    fail("SOURCE_INCOMPLETE", `Official snapshot requires exactly ${ARXIV_CATEGORIES.length} category listings.`);
  }
  const bySlug = new Map();
  for (const listing of listings) {
    if (listing === null || typeof listing !== "object" || Array.isArray(listing)) {
      fail("SOURCE_INCOMPLETE", "Official snapshot contains a non-object listing.");
    }
    supportedSlug(listing.slug);
    if (bySlug.has(listing.slug)) fail("SOURCE_INCOMPLETE", `Official snapshot repeats ${listing.slug}.`);
    validateListingRecord(listing, listing.slug, expectedUrls);
    bySlug.set(listing.slug, listing);
  }
  for (const slug of ARXIV_CATEGORIES) {
    if (!bySlug.has(slug)) fail("SOURCE_INCOMPLETE", `Official snapshot is missing ${slug}.`);
  }
  const dates = new Set([...bySlug.values()].map((listing) => listing.announcementDate));
  if (dates.size !== 1) fail("SOURCE_DATE_MISMATCH", "The three official arXiv listings do not have the same announcement date.");

  const seenIds = new Set();
  const categories = {};
  for (const slug of ARXIV_CATEGORIES) {
    const listing = bySlug.get(slug);
    const newIds = [...listing.newIds].sort();
    for (const id of newIds) {
      if (seenIds.has(id)) fail("SOURCE_INCOMPLETE", `Official new-submission ID ${id} appears in more than one primary category.`);
      seenIds.add(id);
    }
    categories[slug] = Object.freeze({
      slug,
      sourceUrl: expectedUrls[slug],
      newCount: listing.newCount,
      crosslistCount: listing.crosslistCount,
      newIds: Object.freeze(newIds),
    });
  }
  return Object.freeze({
    announcementDate: [...dates][0],
    categories: Object.freeze(categories),
  });
}

export function buildOfficialListingSnapshot(listings) {
  return buildListingSnapshot(listings, ARXIV_LISTING_URLS);
}

function validatePastweekParsedListing(listing, expectedSlug) {
  exactKeys(listing, ["slug", "sourceUrl", "groups"], `${expectedSlug} pastweek listing`, "SOURCE_INCOMPLETE");
  if (listing.slug !== expectedSlug) fail("SOURCE_INCOMPLETE", `${expectedSlug} pastweek listing has the wrong slug.`);
  if (listing.sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[expectedSlug]) {
    fail("SOURCE_INCOMPLETE", `${expectedSlug} pastweek listing does not use its hardcoded official HTTPS URL.`);
  }
  if (!Array.isArray(listing.groups) || listing.groups.length === 0) {
    fail("SOURCE_INCOMPLETE", `${expectedSlug} pastweek listing must contain at least one date group.`);
  }
  for (const [index, group] of listing.groups.entries()) {
    exactKeys(
      group,
      ["announcementDate", "shownCount", "totalCount", "complete", "newCount", "crosslistCount", "newIds"],
      `${expectedSlug}.groups[${index}]`,
      "SOURCE_INCOMPLETE",
    );
    validateDate(group.announcementDate, `${expectedSlug}.groups[${index}].announcementDate`, "SOURCE_INCOMPLETE");
    if (!Number.isSafeInteger(group.shownCount) || group.shownCount < 0 ||
        !Number.isSafeInteger(group.totalCount) || group.totalCount < group.shownCount) {
      fail("SOURCE_INCOMPLETE", `${expectedSlug}.groups[${index}] has invalid shown/total counts.`);
    }
    if (group.complete !== (group.shownCount === group.totalCount)) {
      fail("SOURCE_INCOMPLETE", `${expectedSlug}.groups[${index}].complete disagrees with shown/total counts.`);
    }
    if (!group.complete && index !== listing.groups.length - 1) {
      fail("SOURCE_INCOMPLETE", `${expectedSlug}.groups[${index}] is partial but is not the oldest anchor group.`);
    }
    const record = {
      slug: expectedSlug,
      sourceUrl: listing.sourceUrl,
      announcementDate: group.announcementDate,
      newCount: group.newCount,
      crosslistCount: group.crosslistCount,
      newIds: group.newIds,
    };
    validateListingRecord(record, expectedSlug, ARXIV_PASTWEEK_LISTING_URLS);
    if (group.newCount + group.crosslistCount !== group.shownCount) {
      fail("SOURCE_INCOMPLETE", `${expectedSlug}.groups[${index}] counts do not equal its shown entries.`);
    }
    if (index > 0 && listing.groups[index - 1].announcementDate <= group.announcementDate) {
      fail("SOURCE_INCOMPLETE", `${expectedSlug} pastweek dates must be in strict newest-to-oldest order.`);
    }
  }
}

export function buildOfficialPastweekWindow(listings) {
  if (!Array.isArray(listings) || listings.length !== ARXIV_CATEGORIES.length) {
    fail("SOURCE_INCOMPLETE", `Official pastweek window requires exactly ${ARXIV_CATEGORIES.length} category listings.`);
  }
  const bySlug = new Map();
  for (const listing of listings) {
    if (listing === null || typeof listing !== "object" || Array.isArray(listing)) {
      fail("SOURCE_INCOMPLETE", "Official pastweek window contains a non-object listing.");
    }
    supportedSlug(listing.slug);
    if (bySlug.has(listing.slug)) fail("SOURCE_INCOMPLETE", `Official pastweek window repeats ${listing.slug}.`);
    validatePastweekParsedListing(listing, listing.slug);
    bySlug.set(listing.slug, listing);
  }
  for (const slug of ARXIV_CATEGORIES) {
    if (!bySlug.has(slug)) fail("SOURCE_INCOMPLETE", `Official pastweek window is missing ${slug}.`);
  }

  const announcementDates = bySlug.get(ARXIV_CATEGORIES[0]).groups.map(({ announcementDate }) => announcementDate);
  for (const slug of ARXIV_CATEGORIES.slice(1)) {
    const candidateDates = bySlug.get(slug).groups.map(({ announcementDate }) => announcementDate);
    if (candidateDates.join("\0") !== announcementDates.join("\0")) {
      fail("SOURCE_DATE_MISMATCH", "The three official pastweek listings do not have identical ordered announcement dates.");
    }
  }

  const snapshots = [];
  for (const [index, announcementDate] of announcementDates.entries()) {
    const groups = ARXIV_CATEGORIES.map((slug) => bySlug.get(slug).groups[index]);
    if (groups.some(({ complete }) => !complete)) {
      if (index !== announcementDates.length - 1) {
        fail("SOURCE_INCOMPLETE", `Official pastweek group ${announcementDate} is partial but is not the oldest anchor group.`);
      }
      continue;
    }
    const records = ARXIV_CATEGORIES.map((slug, categoryIndex) => {
      const group = groups[categoryIndex];
      return {
        slug,
        sourceUrl: ARXIV_PASTWEEK_LISTING_URLS[slug],
        announcementDate,
        newCount: group.newCount,
        crosslistCount: group.crosslistCount,
        newIds: group.newIds,
      };
    });
    snapshots.push(buildListingSnapshot(records, ARXIV_PASTWEEK_LISTING_URLS));
  }

  return Object.freeze({
    announcementDates: Object.freeze([...announcementDates]),
    snapshots: Object.freeze(snapshots),
  });
}

function assertSnapshot(snapshot) {
  exactKeys(snapshot, ["announcementDate", "categories"], "snapshot");
  validateDate(snapshot.announcementDate, "snapshot.announcementDate");
  exactKeys(snapshot.categories, ARXIV_CATEGORIES, "snapshot.categories");
  const sourceFamilies = [ARXIV_LISTING_URLS, ARXIV_PASTWEEK_LISTING_URLS].filter((urls) => (
    ARXIV_CATEGORIES.every((slug) => snapshot.categories?.[slug]?.sourceUrl === urls[slug])
  ));
  if (sourceFamilies.length !== 1) {
    fail("SOURCE_INVALID", "snapshot categories must use one consistent hardcoded official listing URL family.");
  }
  const expectedUrls = sourceFamilies[0];
  const seenIds = new Set();
  for (const slug of ARXIV_CATEGORIES) {
    const category = snapshot.categories[slug];
    exactKeys(category, ["slug", "sourceUrl", "newCount", "crosslistCount", "newIds"], `snapshot.categories.${slug}`);
    const record = { ...category, announcementDate: snapshot.announcementDate };
    validateListingRecord(record, slug, expectedUrls);
    const sorted = [...category.newIds].sort();
    if (sorted.join("\0") !== category.newIds.join("\0")) {
      fail("SOURCE_INVALID", `snapshot.categories.${slug}.newIds must be sorted.`);
    }
    for (const id of category.newIds) {
      if (seenIds.has(id)) fail("SOURCE_INVALID", `Snapshot ID ${id} appears in more than one category.`);
      seenIds.add(id);
    }
  }
  return snapshot;
}

export function fingerprintSnapshot(snapshot) {
  assertSnapshot(snapshot);
  const canonical = {
    announcementDate: snapshot.announcementDate,
    categories: Object.fromEntries(ARXIV_CATEGORIES.map((slug) => {
      const category = snapshot.categories[slug];
      return [slug, {
        slug,
        sourceUrl: category.sourceUrl,
        newCount: category.newCount,
        crosslistCount: category.crosslistCount,
        newIds: [...category.newIds],
      }];
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

export function fingerprintSnapshotContent(snapshot) {
  assertSnapshot(snapshot);
  const canonical = {
    announcementDate: snapshot.announcementDate,
    categories: Object.fromEntries(ARXIV_CATEGORIES.map((slug) => {
      const category = snapshot.categories[slug];
      return [slug, {
        slug,
        newCount: category.newCount,
        crosslistCount: category.crosslistCount,
        newIds: [...category.newIds],
      }];
    })),
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function jstCalendarDate(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) fail("SOURCE_INVALID", "now must be a valid Date.");
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
}

export function classifySnapshotDate(snapshot, { latestDate, now = new Date() } = {}) {
  assertSnapshot(snapshot);
  validateDate(latestDate, "latestDate");
  const todayJst = jstCalendarDate(now);
  if (snapshot.announcementDate > todayJst) {
    fail("SOURCE_FUTURE", `Official announcement ${snapshot.announcementDate} is later than the current JST date ${todayJst}.`);
  }
  if (snapshot.announcementDate < latestDate) {
    fail("SOURCE_STALE", `Official announcement ${snapshot.announcementDate} is older than latestDate ${latestDate}.`);
  }
  return snapshot.announcementDate === latestDate ? "current" : "new";
}

function assertPastweekWindow(window) {
  exactKeys(window, ["announcementDates", "snapshots"], "pastweekWindow");
  if (!Array.isArray(window.announcementDates) || window.announcementDates.length === 0) {
    fail("SOURCE_INVALID", "pastweekWindow.announcementDates must be a non-empty array.");
  }
  for (const [index, date] of window.announcementDates.entries()) {
    validateDate(date, `pastweekWindow.announcementDates[${index}]`);
    if (index > 0 && window.announcementDates[index - 1] <= date) {
      fail("SOURCE_INVALID", "pastweekWindow.announcementDates must be in strict newest-to-oldest order.");
    }
  }
  if (!Array.isArray(window.snapshots)) fail("SOURCE_INVALID", "pastweekWindow.snapshots must be an array.");
  for (const [index, snapshot] of window.snapshots.entries()) {
    assertSnapshot(snapshot);
    for (const slug of ARXIV_CATEGORIES) {
      if (snapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
        fail("SOURCE_INVALID", `pastweekWindow.snapshots[${index}] must use official pastweek URLs.`);
      }
    }
  }
  const snapshotDates = window.snapshots.map(({ announcementDate }) => announcementDate);
  const allComplete = window.announcementDates;
  const partialOldest = window.announcementDates.slice(0, -1);
  if (
    snapshotDates.join("\0") !== allComplete.join("\0") &&
    snapshotDates.join("\0") !== partialOldest.join("\0")
  ) {
    fail("SOURCE_INVALID", "pastweekWindow snapshots must cover every complete group in window order.");
  }
  return window;
}

export function selectBackfillSnapshot({ currentSnapshot, pastweekWindow, latestDate, now = new Date() } = {}) {
  assertSnapshot(currentSnapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (currentSnapshot.categories[slug].sourceUrl !== ARXIV_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "currentSnapshot must come from the hardcoded official /new listings.");
    }
  }
  const classification = classifySnapshotDate(currentSnapshot, { latestDate, now });
  if (classification === "current") return null;

  assertPastweekWindow(pastweekWindow);
  if (pastweekWindow.announcementDates[0] !== currentSnapshot.announcementDate) {
    fail("SOURCE_CONTENT_MISMATCH", "The newest pastweek date does not match the current /new announcement date.");
  }
  const newestPastweek = pastweekWindow.snapshots[0];
  if (
    newestPastweek === undefined ||
    newestPastweek.announcementDate !== currentSnapshot.announcementDate ||
    fingerprintSnapshotContent(newestPastweek) !== fingerprintSnapshotContent(currentSnapshot)
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "The newest pastweek content does not exactly match the current /new listings.");
  }

  const anchorIndex = pastweekWindow.announcementDates.indexOf(latestDate);
  if (anchorIndex === -1) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      `latestDate ${latestDate} is outside the official pastweek announcement window; historical backfill requires manual review.`,
    );
  }
  const pendingDates = pastweekWindow.announcementDates.slice(0, anchorIndex);
  const snapshotsByDate = new Map(pastweekWindow.snapshots.map((snapshot) => [snapshot.announcementDate, snapshot]));
  for (const date of pendingDates) {
    if (!snapshotsByDate.has(date)) {
      fail("SOURCE_INCOMPLETE", `Pending pastweek announcement ${date} is not a complete snapshot.`);
    }
  }
  const eligiblePendingDates = pendingDates.filter((date) => {
    const snapshot = snapshotsByDate.get(date);
    return ARXIV_CATEGORIES.some((slug) => snapshot.categories[slug].newCount > 0);
  });
  const oldestPendingDate = eligiblePendingDates.at(-1);
  if (oldestPendingDate === undefined) {
    return null;
  }
  return Object.freeze({
    snapshot: snapshotsByDate.get(oldestPendingDate),
    pendingCount: eligiblePendingDates.length,
  });
}

export function revalidatePastweekSnapshot(snapshot, freshPastweekWindow) {
  assertSnapshot(snapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (snapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "The snapshot being revalidated must come from the official pastweek listings.");
    }
  }
  assertPastweekWindow(freshPastweekWindow);
  const freshSnapshot = freshPastweekWindow.snapshots.find(
    ({ announcementDate }) => announcementDate === snapshot.announcementDate,
  );
  if (freshSnapshot === undefined) {
    fail(
      "SOURCE_CONTENT_MISMATCH",
      `Selected pastweek announcement ${snapshot.announcementDate} is no longer fully available for revalidation.`,
    );
  }
  if (fingerprintSnapshot(freshSnapshot) !== fingerprintSnapshot(snapshot)) {
    fail(
      "SOURCE_CONTENT_MISMATCH",
      `Selected pastweek announcement ${snapshot.announcementDate} changed during generation.`,
    );
  }
  return freshSnapshot;
}

function reportMismatch(path, message) {
  fail("REPORT_SOURCE_MISMATCH", `${path}: ${message}`);
}

export function validateReportsAgainstSnapshot(reports, snapshot) {
  assertSnapshot(snapshot);
  try {
    exactKeys(reports, ARXIV_CATEGORIES, "reports", "REPORT_SOURCE_MISMATCH");
  } catch (error) {
    if (error instanceof ArxivSourceError) throw error;
    throw error;
  }
  for (const slug of ARXIV_CATEGORIES) {
    const report = reports[slug];
    if (report === null || typeof report !== "object" || Array.isArray(report)) reportMismatch(`reports.${slug}`, "must be an object");
    const source = snapshot.categories[slug];
    if (report.slug !== slug) reportMismatch(`reports.${slug}.slug`, `must equal ${slug}`);
    if (report.reportDate !== snapshot.announcementDate) {
      reportMismatch(`reports.${slug}.reportDate`, `must equal ${snapshot.announcementDate}`);
    }
    if (report.totalNew !== source.newCount) reportMismatch(`reports.${slug}.totalNew`, `must equal ${source.newCount}`);
    if (report.evaluatedCount !== source.newCount) reportMismatch(`reports.${slug}.evaluatedCount`, `must equal ${source.newCount}`);
    if (report.crosslistsExcluded !== source.crosslistCount) {
      reportMismatch(`reports.${slug}.crosslistsExcluded`, `must equal ${source.crosslistCount}`);
    }
    if (!Array.isArray(report.papers) || report.papers.length !== source.newCount) {
      reportMismatch(`reports.${slug}.papers`, `must contain exactly ${source.newCount} papers`);
    }
    const reportIds = [];
    for (const [index, paper] of report.papers.entries()) {
      if (paper === null || typeof paper !== "object" || Array.isArray(paper)) {
        reportMismatch(`reports.${slug}.papers[${index}]`, "must be an object");
      }
      if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
        reportMismatch(`reports.${slug}.papers[${index}].arxivId`, "must be an unversioned modern arXiv ID");
      }
      if (paper.primaryCategory !== slug) {
        reportMismatch(`reports.${slug}.papers[${index}].primaryCategory`, `must equal ${slug}`);
      }
      if (paper.arxivVersion !== "v1") reportMismatch(`reports.${slug}.papers[${index}].arxivVersion`, "must equal v1");
      if (paper.submissionType !== "new") reportMismatch(`reports.${slug}.papers[${index}].submissionType`, "must equal new");
      reportIds.push(paper.arxivId);
    }
    if (new Set(reportIds).size !== reportIds.length) reportMismatch(`reports.${slug}.papers`, "contains duplicate arXiv IDs");
    const sortedReportIds = [...reportIds].sort();
    if (sortedReportIds.join("\0") !== source.newIds.join("\0")) {
      reportMismatch(`reports.${slug}.papers`, "arXiv IDs do not exactly match the official New submissions IDs");
    }

    const audit = report.audit;
    if (audit === null || typeof audit !== "object" || Array.isArray(audit)) reportMismatch(`reports.${slug}.audit`, "must be an object");
    if (audit.listingUrl !== source.sourceUrl) reportMismatch(`reports.${slug}.audit.listingUrl`, `must equal ${source.sourceUrl}`);
    if (audit.announcementDate !== snapshot.announcementDate) {
      reportMismatch(`reports.${slug}.audit.announcementDate`, `must equal ${snapshot.announcementDate}`);
    }
    const counts = audit.sourceCounts;
    if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
      reportMismatch(`reports.${slug}.audit.sourceCounts`, "must be an object");
    }
    if (counts.newPrimary !== source.newCount) {
      reportMismatch(`reports.${slug}.audit.sourceCounts.newPrimary`, `must equal ${source.newCount}`);
    }
    if (counts.crosslistsExcluded !== source.crosslistCount) {
      reportMismatch(`reports.${slug}.audit.sourceCounts.crosslistsExcluded`, `must equal ${source.crosslistCount}`);
    }
    if (counts.titleAuthorAbstractEvaluated !== source.newCount) {
      reportMismatch(`reports.${slug}.audit.sourceCounts.titleAuthorAbstractEvaluated`, `must equal ${source.newCount}`);
    }
  }
  return true;
}

async function readBoundedHtml(response, sourceUrl) {
  if (response === null || typeof response !== "object") fail("SOURCE_FETCH", `${sourceUrl} did not return a Response.`);
  if (response.status !== 200 || response.ok !== true) {
    fail("SOURCE_FETCH", `${sourceUrl} returned HTTP ${String(response.status)}.`);
  }
  if (response.url !== sourceUrl) fail("SOURCE_FETCH", `${sourceUrl} redirected or returned an unexpected final URL.`);
  const contentType = response.headers?.get?.("content-type");
  if (typeof contentType !== "string" || !/^text\/html(?:\s*;|$)/i.test(contentType)) {
    fail("SOURCE_FETCH", `${sourceUrl} did not return text/html.`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) fail("SOURCE_FETCH", `${sourceUrl} returned an invalid Content-Length.`);
    if (Number(declaredLength) > MAX_ARXIV_LISTING_BYTES) {
      fail("SOURCE_TOO_LARGE", `${sourceUrl} exceeds ${MAX_ARXIV_LISTING_BYTES} bytes.`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) fail("SOURCE_FETCH", `${sourceUrl} response body is not a readable byte stream.`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) fail("SOURCE_FETCH", `${sourceUrl} returned a non-byte response chunk.`);
      total += value.byteLength;
      if (total > MAX_ARXIV_LISTING_BYTES) {
        await reader.cancel("response too large");
        fail("SOURCE_TOO_LARGE", `${sourceUrl} exceeds ${MAX_ARXIV_LISTING_BYTES} bytes.`);
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } catch (error) {
    if (error instanceof ArxivSourceError) throw error;
    fail("SOURCE_FETCH", `${sourceUrl} response could not be decoded as bounded UTF-8 HTML.`, { cause: error });
  }
  if (total === 0 || html.length === 0) fail("SOURCE_FETCH", `${sourceUrl} returned an empty response.`);
  return html;
}

async function fetchOfficialCategorySource({ fetchImpl, signal, fetchUrls, parser, build }) {
  if (typeof fetchImpl !== "function") fail("SOURCE_INVALID", "fetchImpl must be a function.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("SOURCE_INVALID", "signal must be an AbortSignal.");
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("arXiv listing fetch timed out")), FETCH_TIMEOUT_MS);
  timer.unref?.();
  const combinedSignal = signal === undefined
    ? timeoutController.signal
    : AbortSignal.any([signal, timeoutController.signal]);
  try {
    const listings = await Promise.all(ARXIV_CATEGORIES.map(async (slug) => {
      const sourceUrl = fetchUrls[slug];
      let response;
      try {
        response = await fetchImpl(sourceUrl, {
          method: "GET",
          headers: {
            Accept: "text/html",
            "User-Agent": "daily-arxiv-data/1.1 (+https://github.com/hiroki-takeda/daily-arxiv-data)",
          },
          redirect: "error",
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: combinedSignal,
        });
      } catch (error) {
        fail("SOURCE_FETCH", `${sourceUrl} could not be fetched.`, { cause: error });
      }
      return parser(await readBoundedHtml(response, sourceUrl), slug);
    }));
    return build(listings);
  } finally {
    if (!timeoutController.signal.aborted) {
      timeoutController.abort(new Error("arXiv snapshot fetch completed or failed; cancel sibling requests"));
    }
    clearTimeout(timer);
  }
}

export async function fetchOfficialListingSnapshot({ fetchImpl = globalThis.fetch, signal } = {}) {
  return fetchOfficialCategorySource({
    fetchImpl,
    signal,
    fetchUrls: ARXIV_FETCH_URLS,
    parser: parseArxivNewListing,
    build: buildOfficialListingSnapshot,
  });
}

export async function fetchOfficialPastweekWindow({ fetchImpl = globalThis.fetch, signal } = {}) {
  return fetchOfficialCategorySource({
    fetchImpl,
    signal,
    fetchUrls: ARXIV_PASTWEEK_FETCH_URLS,
    parser: parseArxivPastweekListing,
    build: buildOfficialPastweekWindow,
  });
}
