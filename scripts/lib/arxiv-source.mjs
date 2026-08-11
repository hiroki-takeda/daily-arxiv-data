import { createHash } from "node:crypto";

export const ARXIV_CATEGORIES = Object.freeze(["quant-ph", "gr-qc", "hep-th"]);
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
export const MAX_ARXIV_ABSTRACT_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_ARXIV_CATEGORY_METADATA_BYTES = 2 * 1024 * 1024;

const FETCH_TIMEOUT_MS = 30_000;
const SNAPSHOT_MAX_ATTEMPTS = 3;
const SNAPSHOT_RETRY_DELAYS_MS = Object.freeze([3_000, 10_000]);
const FULL_TEXT_READINESS_TIMEOUT_MS = 30_000;
const FULL_TEXT_READINESS_DELAY_MS = 3_000;
const METADATA_REQUEST_INTERVAL_MS = 3_000;
const METADATA_MAX_ATTEMPTS = 3;
const METADATA_RETRY_DELAYS_MS = Object.freeze([3_000, 10_000]);
const CATEGORY_METADATA_SCHEMA_VERSION = "1.0";
const METADATA_TEXT_LIMITS = Object.freeze({
  title: 2_000,
  abstract: 20_000,
  comments: 4_000,
  author: 512,
  authors: 500,
});
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
    const { retryable = false, ...errorOptions } = options ?? {};
    super(message, errorOptions);
    this.name = "ArxivSourceError";
    this.code = code;
    this.retryable = retryable;
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

function classTokens(token) {
  const value = parseAttributes(token).class;
  return typeof value === "string" ? value.split(/\s+/).filter(Boolean) : [];
}

function elementsWithClass(tokens, name, className) {
  const matches = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "start" || token.name !== name || !classTokens(token).includes(className)) continue;
    const endIndex = pairElement(tokens, index, name);
    matches.push({ startIndex: index, endIndex });
  }
  return matches;
}

function exactlyOneElementWithClass(tokens, name, className, path) {
  const matches = elementsWithClass(tokens, name, className);
  if (matches.length !== 1) {
    fail("SOURCE_INCOMPLETE", `${path} must contain exactly one <${name}> with class ${className}.`);
  }
  return matches[0];
}

function canonicalMetadataText(value, path, maxCharacters) {
  if (typeof value !== "string") fail("SOURCE_INCOMPLETE", `${path} must be text.`);
  const normalized = value.normalize("NFC").replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) fail("SOURCE_INCOMPLETE", `${path} must be non-empty.`);
  if (normalized.includes("\0") || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)) {
    fail("SOURCE_INCOMPLETE", `${path} contains a forbidden control character.`);
  }
  if ([...normalized].length > maxCharacters) {
    fail("SOURCE_TOO_LARGE", `${path} exceeds ${maxCharacters} characters.`);
  }
  return normalized;
}

function metaContents(tokens, name, { multiple = false } = {}) {
  const values = [];
  for (const token of tokens) {
    if (token.type !== "start" || token.name !== "meta") continue;
    const attributes = parseAttributes(token);
    if (attributes.name?.toLowerCase() !== name) continue;
    if (!Object.hasOwn(attributes, "content")) {
      fail("SOURCE_INCOMPLETE", `meta[name=${name}] is missing content.`);
    }
    values.push(attributes.content);
  }
  if (multiple ? values.length === 0 : values.length !== 1) {
    fail(
      "SOURCE_INCOMPLETE",
      multiple
        ? `arXiv abstract page must contain at least one meta[name=${name}].`
        : `arXiv abstract page must contain exactly one meta[name=${name}].`,
    );
  }
  return multiple ? values : values[0];
}

function stripDescriptor(value, descriptor, path) {
  const prefix = `${descriptor}:`;
  if (!value.startsWith(prefix)) fail("SOURCE_INCOMPLETE", `${path} is missing the exact ${prefix} descriptor.`);
  return value.slice(prefix.length).trim();
}

function authorIdentitySignature(value, path) {
  const normalized = canonicalMetadataText(value, path, METADATA_TEXT_LIMITS.author)
    .toLocaleLowerCase("en-US")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean)
    .sort();
  if (normalized.length === 0) fail("SOURCE_INCOMPLETE", `${path} has no comparable name tokens.`);
  return normalized.join("\0");
}

function compactNaturalAuthorIdentity(value, path) {
  return canonicalMetadataText(value, path, METADATA_TEXT_LIMITS.author)
    .toLocaleLowerCase("en-US")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function citationAuthorMatchesVisibleBody(citationAuthor, bodyAuthor, index) {
  if (
    authorIdentitySignature(bodyAuthor, `body author ${index + 1}`) ===
    authorIdentitySignature(citationAuthor, `citation author ${index + 1}`)
  ) {
    return true;
  }

  // arXiv normally emits citation_author as "surname, given names".  Some
  // TeX-encoded names make arXiv split the surname at a macro boundary, for example
  // "ević, Ivana Đorđ" beside the correct visible "Ivana Đorđević".
  // Accept that narrow rendering defect only when moving the exact prefix
  // before the comma back behind the suffix reconstructs the visible name in
  // exact code-point order after removing only whitespace, punctuation, and
  // symbols.  Genuine author substitutions still fail closed.
  const parts = citationAuthor.split(",");
  if (parts.length !== 2 || parts.some((part) => part.trim().length === 0)) return false;
  const citationNaturalOrder = `${parts[1]} ${parts[0]}`;
  return compactNaturalAuthorIdentity(bodyAuthor, `body author ${index + 1}`) ===
    compactNaturalAuthorIdentity(citationNaturalOrder, `citation author ${index + 1}`);
}

function parseBodyAuthors(tokens) {
  const authorsElement = exactlyOneElementWithClass(tokens, "div", "authors", "arXiv authors");
  const authors = [];
  for (let index = authorsElement.startIndex + 1; index < authorsElement.endIndex; index += 1) {
    const token = tokens[index];
    if (token.type !== "start" || token.name !== "a") continue;
    const endIndex = pairElement(tokens, index, "a");
    if (endIndex > authorsElement.endIndex) fail("SOURCE_INCOMPLETE", "arXiv authors contain a truncated link.");
    authors.push(canonicalMetadataText(
      elementText(tokens, index, endIndex, `arXiv author ${authors.length + 1}`),
      `arXiv author ${authors.length + 1}`,
      METADATA_TEXT_LIMITS.author,
    ));
    index = endIndex;
  }
  if (authors.length === 0 || authors.length > METADATA_TEXT_LIMITS.authors) {
    fail("SOURCE_INCOMPLETE", `arXiv authors must contain 1 through ${METADATA_TEXT_LIMITS.authors} linked names.`);
  }
  return authors;
}

function automaticLinkifierHref(tokens, startIndex, endIndex, path) {
  const visibleText = elementText(tokens, startIndex, endIndex, `${path} link`);
  const match = /^this (https?) URL$/.exec(visibleText);
  if (!match) return null;
  const href = parseAttributes(tokens[startIndex]).href;
  const scheme = `${match[1]}://`;
  if (
    typeof href !== "string"
    || !href.startsWith(scheme)
    || href.length <= scheme.length
    || href.length > METADATA_TEXT_LIMITS.abstract
    || /[\s\u0000-\u001f\u007f]/u.test(href)
  ) {
    fail("SOURCE_INCOMPLETE", `${path} has a malformed automatic URL-linkifier anchor.`);
  }
  return href;
}

function elementTextWithLinkifierUrls(tokens, startIndex, endIndex, path) {
  let text = "";
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const token = tokens[index];
    if (token.type === "text") {
      text += decodeHtmlEntities(token.text, path);
      continue;
    }
    if (token.type !== "start" || token.name !== "a") continue;
    const anchorEnd = pairElement(tokens, index, "a");
    if (anchorEnd > endIndex) fail("SOURCE_INCOMPLETE", `${path} contains a truncated link.`);
    const linkifierHref = automaticLinkifierHref(tokens, index, anchorEnd, path);
    if (linkifierHref !== null) {
      // Comments have no independent citation_comments field.  Preserve the
      // exact validated href rather than arXiv's lossy "this http(s) URL"
      // display placeholder; ordinary anchors retain their visible text.
      text += linkifierHref;
      index = anchorEnd;
    }
  }
  return text.replace(/\s+/gu, " ").trim();
}

function parseBodyComments(tokens, arxivId) {
  const labels = elementsWithClass(tokens, "td", "label").filter(({ startIndex, endIndex }) => (
    elementText(tokens, startIndex, endIndex, "arXiv metadata label") === "Comments:"
  ));
  const commentsCells = elementsWithClass(tokens, "td", "comments");
  if (labels.length === 0 && commentsCells.length === 0) return null;
  if (labels.length !== 1 || commentsCells.length !== 1) {
    fail("SOURCE_INCOMPLETE", "arXiv abstract page has malformed or repeated Comments metadata.");
  }
  const label = labels[0];
  const cell = commentsCells[0];
  const interveningTd = tokens.findIndex((token, index) => (
    index > label.endIndex && index < cell.startIndex && token.type === "start" && token.name === "td"
  ));
  if (cell.startIndex <= label.endIndex || interveningTd !== -1) {
    fail("SOURCE_INCOMPLETE", "arXiv Comments value is not adjacent to its label.");
  }
  return canonicalMetadataText(
    elementTextWithLinkifierUrls(tokens, cell.startIndex, cell.endIndex, `${arxivId} arXiv comments`),
    "arXiv comments",
    METADATA_TEXT_LIMITS.comments,
  );
}

function validateVisibleBodyField(tokens, element, { descriptor, path, maxCharacters }) {
  const descriptors = elementsWithClass(tokens, "span", "descriptor").filter(({ startIndex, endIndex }) => (
    startIndex > element.startIndex && endIndex < element.endIndex
  ));
  if (
    descriptors.length !== 1
    || elementText(tokens, descriptors[0].startIndex, descriptors[0].endIndex, `${path} descriptor`) !== `${descriptor}:`
  ) {
    fail("SOURCE_INCOMPLETE", `${path} must contain exactly one ${descriptor}: descriptor.`);
  }
  return canonicalMetadataText(
    stripDescriptor(
      elementText(tokens, element.startIndex, element.endIndex, path),
      descriptor,
      path,
    ),
    path,
    maxCharacters,
  );
}

/**
 * Parse one exact, version-pinned official arXiv abstract page.  Citation
 * metadata is canonical for title/abstract because arXiv renders TeX and
 * automatic links differently in the visible body.  The body must still have
 * the expected non-empty bounded structure, exact descriptors, v1 marker,
 * category, and independently ordered author identities.
 */
export function parseArxivAbstractPage(html, { arxivId, slug } = {}) {
  supportedSlug(slug);
  if (typeof arxivId !== "string" || !ARXIV_ID_PATTERN.test(arxivId)) {
    fail("SOURCE_INVALID", "arxivId must be an unversioned modern arXiv ID.");
  }
  if (typeof html !== "string" || html.length === 0) fail("SOURCE_INCOMPLETE", `${arxivId} abstract page must be non-empty HTML.`);
  if (Buffer.byteLength(html, "utf8") > MAX_ARXIV_ABSTRACT_PAGE_BYTES) {
    fail("SOURCE_TOO_LARGE", `${arxivId} abstract page exceeds ${MAX_ARXIV_ABSTRACT_PAGE_BYTES} bytes.`);
  }
  if (html.includes("\0")) fail("SOURCE_INCOMPLETE", `${arxivId} abstract page contains a NUL byte.`);

  const tokens = tokenizeHtml(html);
  const metaId = canonicalMetadataText(metaContents(tokens, "citation_arxiv_id"), "citation_arxiv_id", 32);
  if (metaId !== arxivId) fail("SOURCE_CONTENT_MISMATCH", `citation_arxiv_id must equal ${arxivId}.`);

  const versionedBodyIds = [];
  for (const [index, token] of tokens.entries()) {
    if (token.type !== "start" || token.name !== "strong") continue;
    const endIndex = pairElement(tokens, index, "strong");
    const match = /^arXiv:(\d{4}\.\d{4,5})v([1-9]\d*)$/.exec(elementText(tokens, index, endIndex, "arXiv version marker"));
    if (match) versionedBodyIds.push({ id: match[1], version: `v${match[2]}` });
  }
  if (versionedBodyIds.length !== 1 || versionedBodyIds[0].id !== arxivId || versionedBodyIds[0].version !== "v1") {
    fail("SOURCE_CONTENT_MISMATCH", `${arxivId} abstract page must contain exactly one matching arXiv:${arxivId}v1 marker.`);
  }

  const canonicalLinks = [];
  for (const token of tokens) {
    if (token.type !== "start" || token.name !== "link") continue;
    const attributes = parseAttributes(token);
    if (attributes.rel?.split(/\s+/).some((value) => value.toLowerCase() === "canonical")) {
      canonicalLinks.push(attributes.href);
    }
  }
  const expectedUrl = `https://arxiv.org/abs/${arxivId}`;
  if (canonicalLinks.length !== 1 || canonicalLinks[0] !== expectedUrl) {
    fail("SOURCE_CONTENT_MISMATCH", `${arxivId} abstract page must have the exact unversioned canonical URL.`);
  }
  const citationPdfUrl = canonicalMetadataText(metaContents(tokens, "citation_pdf_url"), "citation_pdf_url", 256);
  if (citationPdfUrl !== `https://arxiv.org/pdf/${arxivId}` && citationPdfUrl !== `https://arxiv.org/pdf/${arxivId}v1`) {
    fail("SOURCE_CONTENT_MISMATCH", `${arxivId} citation_pdf_url does not identify the expected paper.`);
  }

  const titleElement = exactlyOneElementWithClass(tokens, "h1", "title", "arXiv title");
  validateVisibleBodyField(tokens, titleElement, {
    descriptor: "Title",
    path: `${arxivId} visible title`,
    maxCharacters: METADATA_TEXT_LIMITS.title,
  });
  const metaTitle = canonicalMetadataText(metaContents(tokens, "citation_title"), "citation_title", METADATA_TEXT_LIMITS.title);

  const bodyAuthors = parseBodyAuthors(tokens);
  const metaAuthors = metaContents(tokens, "citation_author", { multiple: true });
  if (metaAuthors.length !== bodyAuthors.length) {
    fail("SOURCE_CONTENT_MISMATCH", `${arxivId} author count disagrees between citation metadata and the visible body.`);
  }
  for (const [index, bodyAuthor] of bodyAuthors.entries()) {
    if (!citationAuthorMatchesVisibleBody(metaAuthors[index], bodyAuthor, index)) {
      fail("SOURCE_CONTENT_MISMATCH", `${arxivId} author ${index + 1} disagrees between citation metadata and the visible body.`);
    }
  }

  const metaAbstract = canonicalMetadataText(
    metaContents(tokens, "citation_abstract"),
    "citation_abstract",
    METADATA_TEXT_LIMITS.abstract,
  );
  const abstractElement = exactlyOneElementWithClass(tokens, "blockquote", "abstract", "arXiv abstract");
  validateVisibleBodyField(tokens, abstractElement, {
    descriptor: "Abstract",
    path: `${arxivId} visible abstract`,
    maxCharacters: METADATA_TEXT_LIMITS.abstract,
  });

  const primaryElement = exactlyOneElementWithClass(tokens, "span", "primary-subject", "arXiv primary subject");
  const primaryText = elementText(tokens, primaryElement.startIndex, primaryElement.endIndex, "arXiv primary subject");
  const primaryMatch = /\(([a-z][a-z0-9-]*(?:\.[A-Za-z0-9-]+)*)\)$/.exec(primaryText);
  if (!primaryMatch || primaryMatch[1] !== slug) {
    fail("SOURCE_CONTENT_MISMATCH", `${arxivId} primary category must equal ${slug}.`);
  }

  return Object.freeze({
    arxivId,
    arxivVersion: "v1",
    submissionType: "new",
    url: expectedUrl,
    sourceUrl: `${expectedUrl}v1`,
    title: metaTitle,
    authors: Object.freeze([...bodyAuthors]),
    abstract: metaAbstract,
    comments: parseBodyComments(tokens, arxivId),
    primaryCategory: slug,
  });
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

function assertCanonicalMetadataField(value, path, maxCharacters) {
  if (typeof value !== "string" || canonicalMetadataText(value, path, maxCharacters) !== value) {
    fail("SOURCE_INVALID", `${path} must be canonical non-empty text.`);
  }
}

function canonicalCategoryMetadata(metadata) {
  return {
    schemaVersion: metadata.schemaVersion,
    announcementDate: metadata.announcementDate,
    slug: metadata.slug,
    snapshotFingerprint: metadata.snapshotFingerprint,
    papers: metadata.papers.map((paper) => ({
      arxivId: paper.arxivId,
      arxivVersion: paper.arxivVersion,
      submissionType: paper.submissionType,
      url: paper.url,
      sourceUrl: paper.sourceUrl,
      title: paper.title,
      authors: [...paper.authors],
      abstract: paper.abstract,
      comments: paper.comments,
      primaryCategory: paper.primaryCategory,
    })),
  };
}

/** Validate both the strict metadata schema and, when supplied, its snapshot binding. */
export function validateCategoryMetadata(metadata, { snapshot, slug } = {}) {
  exactKeys(
    metadata,
    ["schemaVersion", "announcementDate", "slug", "snapshotFingerprint", "papers"],
    "categoryMetadata",
  );
  if (metadata.schemaVersion !== CATEGORY_METADATA_SCHEMA_VERSION) {
    fail("SOURCE_INVALID", `categoryMetadata.schemaVersion must equal ${CATEGORY_METADATA_SCHEMA_VERSION}.`);
  }
  validateDate(metadata.announcementDate, "categoryMetadata.announcementDate");
  supportedSlug(metadata.slug);
  if (slug !== undefined) {
    supportedSlug(slug);
    if (metadata.slug !== slug) fail("SOURCE_CONTENT_MISMATCH", `categoryMetadata.slug must equal ${slug}.`);
  }
  if (typeof metadata.snapshotFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(metadata.snapshotFingerprint)) {
    fail("SOURCE_INVALID", "categoryMetadata.snapshotFingerprint must be a lowercase SHA-256 digest.");
  }
  if (!Array.isArray(metadata.papers)) fail("SOURCE_INVALID", "categoryMetadata.papers must be an array.");
  const ids = [];
  for (const [index, paper] of metadata.papers.entries()) {
    const path = `categoryMetadata.papers[${index}]`;
    exactKeys(
      paper,
      [
        "arxivId",
        "arxivVersion",
        "submissionType",
        "url",
        "sourceUrl",
        "title",
        "authors",
        "abstract",
        "comments",
        "primaryCategory",
      ],
      path,
    );
    if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
      fail("SOURCE_INVALID", `${path}.arxivId must be an unversioned modern arXiv ID.`);
    }
    if (paper.arxivVersion !== "v1") fail("SOURCE_INVALID", `${path}.arxivVersion must equal v1.`);
    if (paper.submissionType !== "new") fail("SOURCE_INVALID", `${path}.submissionType must equal new.`);
    if (paper.url !== `https://arxiv.org/abs/${paper.arxivId}`) {
      fail("SOURCE_INVALID", `${path}.url must be the exact unversioned official abstract URL.`);
    }
    if (paper.sourceUrl !== `https://arxiv.org/abs/${paper.arxivId}v1`) {
      fail("SOURCE_INVALID", `${path}.sourceUrl must be the exact version-fixed official abstract URL.`);
    }
    assertCanonicalMetadataField(paper.title, `${path}.title`, METADATA_TEXT_LIMITS.title);
    assertCanonicalMetadataField(paper.abstract, `${path}.abstract`, METADATA_TEXT_LIMITS.abstract);
    if (paper.comments !== null) {
      assertCanonicalMetadataField(paper.comments, `${path}.comments`, METADATA_TEXT_LIMITS.comments);
    }
    if (!Array.isArray(paper.authors) || paper.authors.length === 0 || paper.authors.length > METADATA_TEXT_LIMITS.authors) {
      fail("SOURCE_INVALID", `${path}.authors must contain 1 through ${METADATA_TEXT_LIMITS.authors} names.`);
    }
    for (const [authorIndex, author] of paper.authors.entries()) {
      assertCanonicalMetadataField(author, `${path}.authors[${authorIndex}]`, METADATA_TEXT_LIMITS.author);
    }
    if (paper.primaryCategory !== metadata.slug) {
      fail("SOURCE_CONTENT_MISMATCH", `${path}.primaryCategory must equal ${metadata.slug}.`);
    }
    ids.push(paper.arxivId);
  }
  if (new Set(ids).size !== ids.length) fail("SOURCE_CONTENT_MISMATCH", "categoryMetadata.papers contains duplicate arXiv IDs.");
  if ([...ids].sort().join("\0") !== ids.join("\0")) {
    fail("SOURCE_CONTENT_MISMATCH", "categoryMetadata.papers must retain the sorted snapshot ID order.");
  }

  if (snapshot !== undefined) {
    assertSnapshot(snapshot);
    const expectedSlug = slug ?? metadata.slug;
    supportedSlug(expectedSlug);
    if (metadata.slug !== expectedSlug) fail("SOURCE_CONTENT_MISMATCH", `categoryMetadata.slug must equal ${expectedSlug}.`);
    if (metadata.announcementDate !== snapshot.announcementDate) {
      fail("SOURCE_CONTENT_MISMATCH", "categoryMetadata.announcementDate does not match the official snapshot.");
    }
    if (metadata.snapshotFingerprint !== fingerprintSnapshot(snapshot)) {
      fail("SOURCE_CONTENT_MISMATCH", "categoryMetadata.snapshotFingerprint does not match the official snapshot.");
    }
    const expectedIds = snapshot.categories[expectedSlug].newIds;
    if (ids.join("\0") !== expectedIds.join("\0")) {
      fail("SOURCE_CONTENT_MISMATCH", `categoryMetadata.papers do not exactly match snapshot.categories.${expectedSlug}.newIds in order.`);
    }
  }

  const bytes = Buffer.byteLength(JSON.stringify(canonicalCategoryMetadata(metadata)), "utf8");
  if (bytes > MAX_ARXIV_CATEGORY_METADATA_BYTES) {
    fail("SOURCE_TOO_LARGE", `categoryMetadata exceeds ${MAX_ARXIV_CATEGORY_METADATA_BYTES} canonical JSON bytes.`);
  }
  return true;
}

export function buildOfficialCategoryMetadata({ snapshot, slug, papers } = {}) {
  assertSnapshot(snapshot);
  supportedSlug(slug);
  if (!Array.isArray(papers)) fail("SOURCE_INVALID", "papers must be an array.");
  const metadata = {
    schemaVersion: CATEGORY_METADATA_SCHEMA_VERSION,
    announcementDate: snapshot.announcementDate,
    slug,
    snapshotFingerprint: fingerprintSnapshot(snapshot),
    papers: papers.map((paper) => (
      paper !== null && typeof paper === "object" && !Array.isArray(paper)
        ? { ...paper, ...(Array.isArray(paper.authors) ? { authors: [...paper.authors] } : {}) }
        : paper
    )),
  };
  validateCategoryMetadata(metadata, { snapshot, slug });
  const frozenPapers = metadata.papers.map((paper) => Object.freeze({
    ...paper,
    authors: Object.freeze([...paper.authors]),
  }));
  return Object.freeze({ ...metadata, papers: Object.freeze(frozenPapers) });
}

export function fingerprintCategoryMetadata(metadata) {
  validateCategoryMetadata(metadata);
  return createHash("sha256")
    .update(JSON.stringify(canonicalCategoryMetadata(metadata)), "utf8")
    .digest("hex");
}

/**
 * Replace model-copied immutable bibliography fields with the host-fetched
 * canonical values.  The model still owns ranking, scores, and reader-facing
 * analysis; the host owns source identity and original bibliographic text.
 */
export function bindCategoryReportToMetadata(report, metadata) {
  validateCategoryMetadata(metadata);
  const reportPath = `reports.${metadata.slug}`;
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    reportMismatch(reportPath, "must be an object");
  }
  if (report.slug !== metadata.slug) reportMismatch(`${reportPath}.slug`, `must equal ${metadata.slug}`);
  if (report.reportDate !== metadata.announcementDate) {
    reportMismatch(`${reportPath}.reportDate`, `must equal ${metadata.announcementDate}`);
  }
  if (!Array.isArray(report.papers) || report.papers.length !== metadata.papers.length) {
    reportMismatch(`${reportPath}.papers`, `must contain exactly ${metadata.papers.length} papers`);
  }

  const canonicalById = new Map(metadata.papers.map((paper) => [paper.arxivId, paper]));
  const seenIds = new Set();
  const papers = report.papers.map((paper, index) => {
    const path = `${reportPath}.papers[${index}]`;
    if (paper === null || typeof paper !== "object" || Array.isArray(paper)) reportMismatch(path, "must be an object");
    if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
      reportMismatch(`${path}.arxivId`, "must be an unversioned modern arXiv ID");
    }
    if (seenIds.has(paper.arxivId)) reportMismatch(`${reportPath}.papers`, `contains duplicate arXiv ID ${paper.arxivId}`);
    seenIds.add(paper.arxivId);
    const canonical = canonicalById.get(paper.arxivId);
    if (canonical === undefined) reportMismatch(`${path}.arxivId`, "does not occur in canonical category metadata");
    return {
      ...paper,
      arxivVersion: canonical.arxivVersion,
      submissionType: canonical.submissionType,
      url: canonical.url,
      title: canonical.title,
      authors: [...canonical.authors],
      primaryCategory: canonical.primaryCategory,
    };
  });
  if (seenIds.size !== canonicalById.size) reportMismatch(`${reportPath}.papers`, "does not contain the complete canonical arXiv ID set");

  const bound = { ...report, papers };
  validateCategoryReportAgainstMetadata(bound, metadata);
  return bound;
}

export function validateCategoryReportAgainstMetadata(report, metadata) {
  validateCategoryMetadata(metadata);
  const reportPath = `reports.${metadata.slug}`;
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    reportMismatch(reportPath, "must be an object");
  }
  if (report.slug !== metadata.slug) reportMismatch(`${reportPath}.slug`, `must equal ${metadata.slug}`);
  if (report.reportDate !== metadata.announcementDate) {
    reportMismatch(`${reportPath}.reportDate`, `must equal ${metadata.announcementDate}`);
  }
  if (!Array.isArray(report.papers) || report.papers.length !== metadata.papers.length) {
    reportMismatch(`${reportPath}.papers`, `must contain exactly ${metadata.papers.length} papers`);
  }
  const canonicalById = new Map(metadata.papers.map((paper) => [paper.arxivId, paper]));
  const seenIds = new Set();
  for (const [index, paper] of report.papers.entries()) {
    const path = `${reportPath}.papers[${index}]`;
    if (paper === null || typeof paper !== "object" || Array.isArray(paper)) reportMismatch(path, "must be an object");
    if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
      reportMismatch(`${path}.arxivId`, "must be an unversioned modern arXiv ID");
    }
    if (seenIds.has(paper.arxivId)) reportMismatch(`${reportPath}.papers`, `contains duplicate arXiv ID ${paper.arxivId}`);
    seenIds.add(paper.arxivId);
    const canonical = canonicalById.get(paper.arxivId);
    if (canonical === undefined) reportMismatch(`${path}.arxivId`, "does not occur in canonical category metadata");
    for (const field of ["title", "primaryCategory", "arxivVersion", "submissionType", "url"]) {
      if (paper[field] !== canonical[field]) reportMismatch(`${path}.${field}`, "does not exactly match canonical category metadata");
    }
    if (!Array.isArray(paper.authors) || paper.authors.length !== canonical.authors.length ||
        paper.authors.some((author, authorIndex) => author !== canonical.authors[authorIndex])) {
      reportMismatch(`${path}.authors`, "does not exactly match the ordered canonical author list");
    }
  }
  if (seenIds.size !== canonicalById.size) reportMismatch(`${reportPath}.papers`, "does not contain the complete canonical arXiv ID set");
  return true;
}

function compareModernArxivIds(left, right) {
  const [leftMonth, leftSequence] = left.split(".").map(Number);
  const [rightMonth, rightSequence] = right.split(".").map(Number);
  return leftMonth - rightMonth || leftSequence - rightSequence;
}

export function selectFullTextReadinessCanary(snapshot) {
  assertSnapshot(snapshot);
  // One global tail canary detects normal same-batch propagation lag without
  // sending a readiness request for every New-submission ID. Individual
  // full-text failures still fail closed during the model's bounded review.
  const ids = ARXIV_CATEGORIES.flatMap((slug) => snapshot.categories[slug].newIds);
  if (ids.length === 0) return null;
  return ids.reduce((latest, candidate) => (
    compareModernArxivIds(candidate, latest) > 0 ? candidate : latest
  ));
}

function readinessCheckResult({ kind, arxivId, requestedUrl, response }) {
  if (response === null || typeof response !== "object") {
    fail("SOURCE_FETCH", `${requestedUrl} did not return a Response.`);
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    fail("SOURCE_FETCH", `${requestedUrl} returned an invalid HTTP status.`);
  }
  const contentType = response.headers?.get?.("content-type") ?? null;
  if (response.status !== 200 || response.ok !== true) {
    return Object.freeze({
      kind,
      arxivId,
      url: requestedUrl,
      status: response.status,
      contentType,
      ready: false,
    });
  }
  const expectedFinalUrl = kind === "pdf"
    ? requestedUrl
    : `https://arxiv.org/src/${arxivId}v1`;
  if (response.url !== expectedFinalUrl) {
    fail("SOURCE_FETCH", `${requestedUrl} redirected to an unexpected final URL.`);
  }
  if (kind === "pdf" && (typeof contentType !== "string" || !/^application\/pdf(?:\s*;|$)/i.test(contentType))) {
    fail("SOURCE_FETCH", `${requestedUrl} did not return application/pdf.`);
  }
  if (kind === "source" && (typeof contentType !== "string" || !/^application\/(?:gzip|x-gzip|x-eprint|x-eprint-tar|x-tar|octet-stream|pdf)(?:\s*;|$)/i.test(contentType))) {
    fail("SOURCE_FETCH", `${requestedUrl} did not return an expected e-print content type.`);
  }
  return Object.freeze({
    kind,
    arxivId,
    url: requestedUrl,
    status: response.status,
    contentType,
    ready: true,
  });
}

export async function probeOfficialFullTextReadiness(snapshot, {
  fetchImpl = globalThis.fetch,
  signal,
  sleepImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  assertSnapshot(snapshot);
  if (typeof fetchImpl !== "function") fail("SOURCE_INVALID", "fetchImpl must be a function.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("SOURCE_INVALID", "signal must be an AbortSignal.");
  if (typeof sleepImpl !== "function") fail("SOURCE_INVALID", "sleepImpl must be a function.");
  const arxivId = selectFullTextReadinessCanary(snapshot);
  if (arxivId === null) {
    return Object.freeze({ ready: true, arxivId: null, checks: Object.freeze([]) });
  }

  const requests = Object.freeze([
    Object.freeze({ kind: "pdf", url: `https://arxiv.org/pdf/${arxivId}v1`, redirect: "manual" }),
    Object.freeze({ kind: "source", url: `https://arxiv.org/e-print/${arxivId}v1`, redirect: "follow" }),
  ]);
  const checks = [];
  for (const [index, request] of requests.entries()) {
    if (index > 0) await sleepImpl(FULL_TEXT_READINESS_DELAY_MS);
    const timeoutController = new AbortController();
    const timer = setTimeout(
      () => timeoutController.abort(new Error("arXiv full-text readiness probe timed out")),
      FULL_TEXT_READINESS_TIMEOUT_MS,
    );
    timer.unref?.();
    const combinedSignal = signal === undefined
      ? timeoutController.signal
      : AbortSignal.any([signal, timeoutController.signal]);
    let response;
    try {
      response = await fetchImpl(request.url, {
        method: "HEAD",
        headers: {
          Accept: request.kind === "pdf"
            ? "application/pdf"
            : "application/gzip, application/x-eprint-tar, application/octet-stream, application/pdf",
          "User-Agent": "daily-arxiv-data/1.1 (+https://github.com/hiroki-takeda/daily-arxiv-data)",
        },
        redirect: request.redirect,
        cache: "no-store",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: combinedSignal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      return Object.freeze({
        ready: false,
        arxivId,
        checks: Object.freeze(checks),
        unavailable: Object.freeze({
          kind: request.kind,
          arxivId,
          url: request.url,
          status: null,
          contentType: null,
          ready: false,
          reason: "fetch_error",
        }),
      });
    } finally {
      clearTimeout(timer);
    }
    const check = readinessCheckResult({
      kind: request.kind,
      arxivId,
      requestedUrl: request.url,
      response,
    });
    checks.push(check);
    if (!check.ready) {
      return Object.freeze({
        ready: false,
        arxivId,
        checks: Object.freeze(checks),
        unavailable: check,
      });
    }
  }
  return Object.freeze({ ready: true, arxivId, checks: Object.freeze(checks) });
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

function classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now }) {
  assertSnapshot(currentSnapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (currentSnapshot.categories[slug].sourceUrl !== ARXIV_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "currentSnapshot must come from the hardcoded official /new listings.");
    }
  }
  return classifySnapshotDate(currentSnapshot, { latestDate, now });
}

function assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow) {
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
  return pastweekWindow;
}

function immediateWeekdaySuccessor(date) {
  validateDate(date, "latestDate");
  const cursor = new Date(`${date}T00:00:00Z`);
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return cursor.toISOString().slice(0, 10);
}

export function selectBackfillSnapshot({ currentSnapshot, pastweekWindow, latestDate, now = new Date() } = {}) {
  const classification = classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now });
  if (classification === "current") return null;
  assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow);

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
    pendingSnapshots: Object.freeze(
      [...eligiblePendingDates].reverse().map((date) => snapshotsByDate.get(date)),
    ),
  });
}

export function selectCheckpointRecoverySnapshot({
  storedSnapshot,
  currentSnapshot,
  pastweekWindow,
  latestDate,
  expectedDate,
  expectedSnapshotFingerprint,
  now = new Date(),
} = {}) {
  validateDate(latestDate, "latestDate");
  validateDate(expectedDate, "expectedDate");
  if (typeof expectedSnapshotFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(expectedSnapshotFingerprint)) {
    fail("SOURCE_INVALID", "expectedSnapshotFingerprint must be a lowercase SHA-256 digest.");
  }

  const classification = classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now });
  if (classification === "current") {
    fail("SOURCE_BACKFILL_WINDOW", "Checkpoint recovery requires an unpublished official announcement.");
  }
  assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow);

  assertSnapshot(storedSnapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (storedSnapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "The stored recovery snapshot must come from the official pastweek listings.");
    }
  }
  if (storedSnapshot.announcementDate !== expectedDate) {
    fail("SOURCE_CONTENT_MISMATCH", "The stored recovery snapshot does not match expectedDate.");
  }
  if (fingerprintSnapshot(storedSnapshot) !== expectedSnapshotFingerprint) {
    fail("SOURCE_CONTENT_MISMATCH", "The stored recovery snapshot does not match expectedSnapshotFingerprint.");
  }
  if (expectedDate <= latestDate) {
    fail("SOURCE_BACKFILL_WINDOW", "Checkpoint recovery target must be newer than latestDate.");
  }
  const interveningAnnouncementDates = pastweekWindow.announcementDates.filter(
    (date) => date > latestDate && date < expectedDate,
  );
  const latestIsLive = pastweekWindow.announcementDates.includes(latestDate);
  if (
    interveningAnnouncementDates.length !== 0
    || (!latestIsLive && immediateWeekdaySuccessor(latestDate) !== expectedDate)
  ) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      latestIsLive
        ? "Checkpoint recovery target must not skip an official announcement present in the validated pastweek window."
        : "Checkpoint recovery target must be the immediate weekday successor when latestDate is outside pastweek.",
    );
  }

  const freshSnapshot = revalidatePastweekSnapshot(storedSnapshot, pastweekWindow);
  const oldestComplete = pastweekWindow.snapshots.at(-1);
  if (oldestComplete === undefined || oldestComplete.announcementDate !== expectedDate) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      "Checkpoint recovery target must be the oldest complete official pastweek snapshot.",
    );
  }
  if (fingerprintSnapshot(freshSnapshot) !== expectedSnapshotFingerprint) {
    fail("SOURCE_CONTENT_MISMATCH", "Fresh recovery snapshot does not match expectedSnapshotFingerprint.");
  }

  const eligiblePendingCount = pastweekWindow.snapshots.filter((snapshot) => (
    snapshot.announcementDate >= expectedDate
    && ARXIV_CATEGORIES.some((slug) => snapshot.categories[slug].newCount > 0)
  )).length;
  if (eligiblePendingCount === 0) {
    fail("SOURCE_INCOMPLETE", "Checkpoint recovery target contains no eligible primary-new papers.");
  }
  const pendingSnapshots = pastweekWindow.snapshots.filter((snapshot) => (
    snapshot.announcementDate >= expectedDate
    && ARXIV_CATEGORIES.some((slug) => snapshot.categories[slug].newCount > 0)
  )).reverse();
  return Object.freeze({
    snapshot: freshSnapshot,
    pendingCount: eligiblePendingCount,
    pendingSnapshots: Object.freeze(pendingSnapshots),
  });
}

export function selectAgedCheckpointRecoverySnapshot({
  storedSnapshot,
  currentSnapshot,
  pastweekWindow,
  latestDate,
  expectedDate,
  expectedSnapshotFingerprint,
  now = new Date(),
} = {}) {
  validateDate(latestDate, "latestDate");
  validateDate(expectedDate, "expectedDate");
  if (typeof expectedSnapshotFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSnapshotFingerprint)) {
    fail("SOURCE_INVALID", "expectedSnapshotFingerprint must be a lowercase SHA-256 digest.");
  }

  const classification = classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now });
  if (classification === "current") {
    fail("SOURCE_BACKFILL_WINDOW", "Aged checkpoint recovery requires an unpublished official announcement.");
  }
  assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow);

  assertSnapshot(storedSnapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (storedSnapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "The stored aged-recovery snapshot must come from the official pastweek listings.");
    }
  }
  if (storedSnapshot.announcementDate !== expectedDate) {
    fail("SOURCE_CONTENT_MISMATCH", "The stored aged-recovery snapshot does not match expectedDate.");
  }
  if (fingerprintSnapshot(storedSnapshot) !== expectedSnapshotFingerprint) {
    fail("SOURCE_CONTENT_MISMATCH", "The stored aged-recovery snapshot does not match expectedSnapshotFingerprint.");
  }
  if (
    expectedDate <= latestDate
    || immediateWeekdaySuccessor(latestDate) !== expectedDate
  ) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      "Aged checkpoint recovery target must be the immediate weekday successor of latestDate.",
    );
  }

  const announcementDates = pastweekWindow.announcementDates;
  const completeSnapshotDates = pastweekWindow.snapshots.map(({ announcementDate }) => announcementDate);
  const oldestLiveDate = announcementDates.at(-1);
  const everyAnnouncementIsComplete = (
    completeSnapshotDates.length === announcementDates.length
    && completeSnapshotDates.join("\0") === announcementDates.join("\0")
  );
  if (
    !everyAnnouncementIsComplete
    || announcementDates.includes(expectedDate)
    || completeSnapshotDates.includes(expectedDate)
    || announcementDates.some((date) => date <= expectedDate)
    || immediateWeekdaySuccessor(expectedDate) !== oldestLiveDate
  ) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      "Aged checkpoint recovery target must immediately precede a fully complete official pastweek window.",
    );
  }

  const targetIsEligible = ARXIV_CATEGORIES.some(
    (slug) => storedSnapshot.categories[slug].newCount > 0,
  );
  if (!targetIsEligible) {
    fail("SOURCE_INCOMPLETE", "Aged checkpoint recovery target contains no eligible primary-new papers.");
  }
  const newerEligibleSnapshots = pastweekWindow.snapshots.filter((snapshot) => (
    snapshot.announcementDate > expectedDate
    && ARXIV_CATEGORIES.some((slug) => snapshot.categories[slug].newCount > 0)
  )).reverse();
  const pendingSnapshots = [storedSnapshot, ...newerEligibleSnapshots];
  return Object.freeze({
    snapshot: storedSnapshot,
    pendingCount: pendingSnapshots.length,
    pendingSnapshots: Object.freeze(pendingSnapshots),
  });
}

export function selectAgedWindowContinuationSnapshot({
  currentSnapshot,
  pastweekWindow,
  latestDate,
  now = new Date(),
} = {}) {
  const classification = classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now });
  if (classification === "current") {
    fail("SOURCE_BACKFILL_WINDOW", "Aged window continuation requires an unpublished official announcement.");
  }
  assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow);

  const announcementDates = pastweekWindow.announcementDates;
  const completeSnapshotDates = pastweekWindow.snapshots.map(({ announcementDate }) => announcementDate);
  const oldestAnnouncementDate = announcementDates.at(-1);
  const everyAnnouncementIsComplete = (
    completeSnapshotDates.length === announcementDates.length
    && completeSnapshotDates.join("\0") === announcementDates.join("\0")
  );
  if (
    announcementDates.includes(latestDate)
    || !everyAnnouncementIsComplete
    || announcementDates.some((date) => date <= latestDate)
    || immediateWeekdaySuccessor(latestDate) !== oldestAnnouncementDate
  ) {
    fail(
      "SOURCE_BACKFILL_WINDOW",
      "Aged window continuation requires a complete official window beginning immediately after latestDate.",
    );
  }

  const eligibleSnapshots = pastweekWindow.snapshots.filter((snapshot) => (
    snapshot.announcementDate > latestDate
    && ARXIV_CATEGORIES.some((slug) => snapshot.categories[slug].newCount > 0)
  )).reverse();
  const oldestEligibleSnapshot = eligibleSnapshots[0];
  if (oldestEligibleSnapshot === undefined) return null;
  return Object.freeze({
    snapshot: oldestEligibleSnapshot,
    pendingCount: eligibleSnapshots.length,
    pendingSnapshots: Object.freeze(eligibleSnapshots),
  });
}

const DURABLE_SELECTION_EVIDENCE_KEYS = Object.freeze([
  "schemaVersion",
  "selectionMode",
  "expectedLatestDate",
  "targetDate",
  "targetSnapshotFingerprint",
  "officialHeadDate",
  "officialHeadFingerprint",
  "pastweekAnnouncementDates",
  "completeSnapshotDates",
]);

function exactObjectKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("SOURCE_INVALID", `${label} must be a JSON object.`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join("\0") !== wanted.join("\0")) {
    fail("SOURCE_INVALID", `${label} must contain exactly: ${wanted.join(", ")}.`);
  }
}

function validateDurableSelectionEvidence(evidence, {
  latestDate,
  expectedDate,
  expectedSnapshotFingerprint,
} = {}) {
  exactObjectKeys(evidence, DURABLE_SELECTION_EVIDENCE_KEYS, "Durable selection evidence");
  if (evidence.schemaVersion !== "1.0") {
    fail("SOURCE_INVALID", "Durable selection evidence schemaVersion must be 1.0.");
  }
  if (![
    "normal",
    "checkpoint_recovery",
    "aged_checkpoint_recovery",
    "aged_window_continuation",
  ].includes(evidence.selectionMode)) {
    fail("SOURCE_INVALID", "Durable selection evidence selectionMode is invalid.");
  }
  for (const [label, date] of [
    ["expectedLatestDate", evidence.expectedLatestDate],
    ["targetDate", evidence.targetDate],
    ["officialHeadDate", evidence.officialHeadDate],
  ]) validateDate(date, `Durable selection evidence ${label}`);
  if (
    typeof evidence.targetSnapshotFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(evidence.targetSnapshotFingerprint)
    || typeof evidence.officialHeadFingerprint !== "string"
    || !/^[a-f0-9]{64}$/u.test(evidence.officialHeadFingerprint)
  ) {
    fail("SOURCE_INVALID", "Durable selection evidence fingerprints must be lowercase SHA-256 digests.");
  }
  if (
    evidence.expectedLatestDate !== latestDate
    || evidence.targetDate !== expectedDate
    || evidence.targetSnapshotFingerprint !== expectedSnapshotFingerprint
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "Durable selection evidence does not match the authorized continuation.");
  }
  for (const [label, dates] of [
    ["pastweekAnnouncementDates", evidence.pastweekAnnouncementDates],
    ["completeSnapshotDates", evidence.completeSnapshotDates],
  ]) {
    if (!Array.isArray(dates) || dates.length === 0 || new Set(dates).size !== dates.length) {
      fail("SOURCE_INVALID", `Durable selection evidence ${label} must be a non-empty unique date array.`);
    }
    dates.forEach((date) => validateDate(date, `Durable selection evidence ${label}`));
    if (dates.some((date, index) => index > 0 && dates[index - 1] <= date)) {
      fail("SOURCE_INVALID", `Durable selection evidence ${label} must be newest-to-oldest.`);
    }
  }
  if (
    evidence.pastweekAnnouncementDates[0] !== evidence.officialHeadDate
    || evidence.officialHeadDate < evidence.targetDate
  ) {
    fail("SOURCE_INVALID", "Durable selection evidence has inconsistent official announcement dates.");
  }
  if (evidence.selectionMode === "aged_checkpoint_recovery") {
    const allAnnouncementsWereComplete = (
      evidence.completeSnapshotDates.length === evidence.pastweekAnnouncementDates.length
      && evidence.completeSnapshotDates.join("\0") === evidence.pastweekAnnouncementDates.join("\0")
    );
    if (
      !allAnnouncementsWereComplete
      || evidence.pastweekAnnouncementDates.includes(evidence.targetDate)
      || evidence.completeSnapshotDates.includes(evidence.targetDate)
      || evidence.pastweekAnnouncementDates.some((date) => date <= evidence.targetDate)
      || immediateWeekdaySuccessor(evidence.expectedLatestDate) !== evidence.targetDate
      || immediateWeekdaySuccessor(evidence.targetDate) !== evidence.completeSnapshotDates.at(-1)
    ) {
      fail(
        "SOURCE_INVALID",
        "Aged checkpoint-recovery evidence must bridge two exact weekday-successor boundaries into a complete window.",
      );
    }
  } else if (evidence.selectionMode === "aged_window_continuation") {
    const allAnnouncementsWereComplete = (
      evidence.completeSnapshotDates.length === evidence.pastweekAnnouncementDates.length
      && evidence.completeSnapshotDates.join("\0") === evidence.pastweekAnnouncementDates.join("\0")
    );
    if (
      !allAnnouncementsWereComplete
      || evidence.pastweekAnnouncementDates.includes(evidence.expectedLatestDate)
      || !evidence.pastweekAnnouncementDates.includes(evidence.targetDate)
      || !evidence.completeSnapshotDates.includes(evidence.targetDate)
      || evidence.pastweekAnnouncementDates.some((date) => date <= evidence.expectedLatestDate)
      || immediateWeekdaySuccessor(evidence.expectedLatestDate) !== evidence.completeSnapshotDates.at(-1)
    ) {
      fail(
        "SOURCE_INVALID",
        "Aged window-continuation evidence must cover a complete window beginning immediately after its anchor.",
      );
    }
  } else {
    if (
      !evidence.pastweekAnnouncementDates.includes(evidence.targetDate)
      || !evidence.completeSnapshotDates.includes(evidence.targetDate)
    ) {
      fail("SOURCE_INVALID", "Durable selection evidence has inconsistent official announcement dates.");
    }
    if (evidence.selectionMode === "normal") {
      if (!evidence.pastweekAnnouncementDates.includes(evidence.expectedLatestDate)) {
        fail("SOURCE_INVALID", "Normal durable selection evidence must include its public latestDate anchor.");
      }
    } else {
      const intervening = evidence.pastweekAnnouncementDates.filter(
        (date) => date > evidence.expectedLatestDate && date < evidence.targetDate,
      );
      if (
        intervening.length !== 0
        || (
          !evidence.pastweekAnnouncementDates.includes(evidence.expectedLatestDate)
          && immediateWeekdaySuccessor(evidence.expectedLatestDate) !== evidence.targetDate
        )
      ) {
        fail("SOURCE_INVALID", "Checkpoint-recovery evidence may not skip a listed official announcement.");
      }
    }
  }
  return evidence;
}

export function buildDurableSelectionEvidence({
  selectionMode,
  snapshot,
  currentSnapshot,
  pastweekWindow,
  latestDate,
  now = new Date(),
} = {}) {
  if (![
    "normal",
    "checkpoint_recovery",
    "aged_checkpoint_recovery",
    "aged_window_continuation",
  ].includes(selectionMode)) {
    fail(
      "SOURCE_INVALID",
      "Durable selection mode must be normal, checkpoint_recovery, aged_checkpoint_recovery, "
      + "or aged_window_continuation.",
    );
  }
  const snapshotFingerprint = fingerprintSnapshot(snapshot);
  let selection;
  if (selectionMode === "normal") {
    selection = selectBackfillSnapshot({ currentSnapshot, pastweekWindow, latestDate, now });
  } else if (selectionMode === "checkpoint_recovery") {
    selection = selectCheckpointRecoverySnapshot({
      storedSnapshot: snapshot,
      currentSnapshot,
      pastweekWindow,
      latestDate,
      expectedDate: snapshot.announcementDate,
      expectedSnapshotFingerprint: snapshotFingerprint,
      now,
    });
  } else if (selectionMode === "aged_checkpoint_recovery") {
    selection = selectAgedCheckpointRecoverySnapshot({
      storedSnapshot: snapshot,
      currentSnapshot,
      pastweekWindow,
      latestDate,
      expectedDate: snapshot.announcementDate,
      expectedSnapshotFingerprint: snapshotFingerprint,
      now,
    });
  } else {
    selection = selectAgedWindowContinuationSnapshot({
      currentSnapshot,
      pastweekWindow,
      latestDate,
      now,
    });
  }
  if (
    selection === null
    || selection.snapshot.announcementDate !== snapshot.announcementDate
    || fingerprintSnapshot(selection.snapshot) !== snapshotFingerprint
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "The durable authorization target is not the exact selected snapshot.");
  }
  const evidence = {
    schemaVersion: "1.0",
    selectionMode,
    expectedLatestDate: latestDate,
    targetDate: snapshot.announcementDate,
    targetSnapshotFingerprint: snapshotFingerprint,
    officialHeadDate: currentSnapshot.announcementDate,
    officialHeadFingerprint: fingerprintSnapshot(currentSnapshot),
    pastweekAnnouncementDates: [...pastweekWindow.announcementDates],
    completeSnapshotDates: pastweekWindow.snapshots.map(({ announcementDate }) => announcementDate),
  };
  validateDurableSelectionEvidence(evidence, {
    latestDate,
    expectedDate: snapshot.announcementDate,
    expectedSnapshotFingerprint: snapshotFingerprint,
  });
  return Object.freeze({
    ...evidence,
    pastweekAnnouncementDates: Object.freeze(evidence.pastweekAnnouncementDates),
    completeSnapshotDates: Object.freeze(evidence.completeSnapshotDates),
  });
}

export function selectAuthorizedContinuationSnapshot({
  storedSnapshot,
  currentSnapshot,
  pastweekWindow,
  latestDate,
  expectedDate,
  expectedSnapshotFingerprint,
  evidence,
  now = new Date(),
} = {}) {
  validateDate(latestDate, "latestDate");
  validateDate(expectedDate, "expectedDate");
  if (typeof expectedSnapshotFingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(expectedSnapshotFingerprint)) {
    fail("SOURCE_INVALID", "expectedSnapshotFingerprint must be a lowercase SHA-256 digest.");
  }
  validateDurableSelectionEvidence(evidence, {
    latestDate,
    expectedDate,
    expectedSnapshotFingerprint,
  });
  const classification = classifyOfficialCurrentSnapshot(currentSnapshot, { latestDate, now });
  if (classification === "current") {
    fail("SOURCE_BACKFILL_WINDOW", "An active durable continuation requires an unpublished official announcement.");
  }
  assertPastweekHeadMatchesCurrent(currentSnapshot, pastweekWindow);
  assertSnapshot(storedSnapshot);
  for (const slug of ARXIV_CATEGORIES) {
    if (storedSnapshot.categories[slug].sourceUrl !== ARXIV_PASTWEEK_LISTING_URLS[slug]) {
      fail("SOURCE_INVALID", "The durable continuation snapshot must come from official pastweek listings.");
    }
  }
  if (
    storedSnapshot.announcementDate !== expectedDate
    || fingerprintSnapshot(storedSnapshot) !== expectedSnapshotFingerprint
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "The stored durable continuation snapshot changed.");
  }
  if (expectedDate <= latestDate) {
    fail("SOURCE_BACKFILL_WINDOW", "The durable continuation target must remain newer than public latestDate.");
  }
  if (
    currentSnapshot.announcementDate < evidence.officialHeadDate
    || currentSnapshot.announcementDate < expectedDate
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "The official announcement head moved behind the durable validation evidence.");
  }
  if (
    currentSnapshot.announcementDate === evidence.officialHeadDate
    && fingerprintSnapshot(currentSnapshot) !== evidence.officialHeadFingerprint
  ) {
    fail("SOURCE_CONTENT_MISMATCH", "The unchanged official head no longer matches durable validation evidence.");
  }
  if (
    evidence.selectionMode === "aged_window_continuation"
    && currentSnapshot.announcementDate === evidence.officialHeadDate
  ) {
    const currentAnnouncementDates = pastweekWindow.announcementDates;
    const currentCompleteDates = pastweekWindow.snapshots.map(({ announcementDate }) => announcementDate);
    if (
      currentAnnouncementDates.join("\0") !== evidence.pastweekAnnouncementDates.join("\0")
      || currentCompleteDates.join("\0") !== evidence.completeSnapshotDates.join("\0")
    ) {
      fail("SOURCE_CONTENT_MISMATCH", "The aged window-continuation evidence no longer matches the live window.");
    }
    const liveSelection = selectAgedWindowContinuationSnapshot({
      currentSnapshot,
      pastweekWindow,
      latestDate,
      now,
    });
    if (
      liveSelection === null
      || liveSelection.snapshot.announcementDate !== expectedDate
      || fingerprintSnapshot(liveSelection.snapshot) !== expectedSnapshotFingerprint
    ) {
      fail("SOURCE_CONTENT_MISMATCH", "The aged window continuation is not the oldest live eligible snapshot.");
    }
  }

  const freshSnapshot = pastweekWindow.snapshots.find(
    ({ announcementDate }) => announcementDate === expectedDate,
  );
  if (freshSnapshot !== undefined) {
    if (fingerprintSnapshot(freshSnapshot) !== expectedSnapshotFingerprint) {
      fail("SOURCE_CONTENT_MISMATCH", "The live durable continuation snapshot changed.");
    }
  } else {
    if (
      currentSnapshot.announcementDate <= expectedDate
      || pastweekWindow.announcementDates.some((date) => date <= expectedDate)
    ) {
      fail(
        "SOURCE_BACKFILL_WINDOW",
        "The durable target is absent without having safely aged behind the complete official pastweek window.",
      );
    }
  }
  const newerEligibleSnapshots = pastweekWindow.snapshots.filter((candidate) => (
    candidate.announcementDate > expectedDate
    && ARXIV_CATEGORIES.some((slug) => candidate.categories[slug].newCount > 0)
  )).reverse();
  return Object.freeze({
    snapshot: freshSnapshot ?? storedSnapshot,
    pendingCount: 1 + newerEligibleSnapshots.length,
    pendingSnapshots: Object.freeze([
      freshSnapshot ?? storedSnapshot,
      ...newerEligibleSnapshots,
    ]),
    durable: true,
    targetStillLive: freshSnapshot !== undefined,
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

function validateReportAgainstSnapshotUnchecked(report, snapshot, slug) {
  const reportPath = `reports.${slug}`;
  if (report === null || typeof report !== "object" || Array.isArray(report)) reportMismatch(reportPath, "must be an object");
  const source = snapshot.categories[slug];
  if (report.slug !== slug) reportMismatch(`${reportPath}.slug`, `must equal ${slug}`);
  if (report.reportDate !== snapshot.announcementDate) {
    reportMismatch(`${reportPath}.reportDate`, `must equal ${snapshot.announcementDate}`);
  }
  if (report.totalNew !== source.newCount) reportMismatch(`${reportPath}.totalNew`, `must equal ${source.newCount}`);
  if (report.evaluatedCount !== source.newCount) reportMismatch(`${reportPath}.evaluatedCount`, `must equal ${source.newCount}`);
  if (report.crosslistsExcluded !== source.crosslistCount) {
    reportMismatch(`${reportPath}.crosslistsExcluded`, `must equal ${source.crosslistCount}`);
  }
  if (!Array.isArray(report.papers) || report.papers.length !== source.newCount) {
    reportMismatch(`${reportPath}.papers`, `must contain exactly ${source.newCount} papers`);
  }
  const reportIds = [];
  for (const [index, paper] of report.papers.entries()) {
    if (paper === null || typeof paper !== "object" || Array.isArray(paper)) {
      reportMismatch(`${reportPath}.papers[${index}]`, "must be an object");
    }
    if (typeof paper.arxivId !== "string" || !ARXIV_ID_PATTERN.test(paper.arxivId)) {
      reportMismatch(`${reportPath}.papers[${index}].arxivId`, "must be an unversioned modern arXiv ID");
    }
    if (paper.primaryCategory !== slug) {
      reportMismatch(`${reportPath}.papers[${index}].primaryCategory`, `must equal ${slug}`);
    }
    if (paper.arxivVersion !== "v1") reportMismatch(`${reportPath}.papers[${index}].arxivVersion`, "must equal v1");
    if (paper.submissionType !== "new") reportMismatch(`${reportPath}.papers[${index}].submissionType`, "must equal new");
    reportIds.push(paper.arxivId);
  }
  if (new Set(reportIds).size !== reportIds.length) reportMismatch(`${reportPath}.papers`, "contains duplicate arXiv IDs");
  const sortedReportIds = [...reportIds].sort();
  if (sortedReportIds.join("\0") !== source.newIds.join("\0")) {
    reportMismatch(`${reportPath}.papers`, "arXiv IDs do not exactly match the official New submissions IDs");
  }

  const audit = report.audit;
  if (audit === null || typeof audit !== "object" || Array.isArray(audit)) reportMismatch(`${reportPath}.audit`, "must be an object");
  if (audit.listingUrl !== source.sourceUrl) reportMismatch(`${reportPath}.audit.listingUrl`, `must equal ${source.sourceUrl}`);
  if (audit.announcementDate !== snapshot.announcementDate) {
    reportMismatch(`${reportPath}.audit.announcementDate`, `must equal ${snapshot.announcementDate}`);
  }
  const counts = audit.sourceCounts;
  if (counts === null || typeof counts !== "object" || Array.isArray(counts)) {
    reportMismatch(`${reportPath}.audit.sourceCounts`, "must be an object");
  }
  if (counts.newPrimary !== source.newCount) {
    reportMismatch(`${reportPath}.audit.sourceCounts.newPrimary`, `must equal ${source.newCount}`);
  }
  if (counts.crosslistsExcluded !== source.crosslistCount) {
    reportMismatch(`${reportPath}.audit.sourceCounts.crosslistsExcluded`, `must equal ${source.crosslistCount}`);
  }
  if (counts.titleAuthorAbstractEvaluated !== source.newCount) {
    reportMismatch(`${reportPath}.audit.sourceCounts.titleAuthorAbstractEvaluated`, `must equal ${source.newCount}`);
  }
  return true;
}

export function validateReportAgainstSnapshot(report, snapshot, slug) {
  assertSnapshot(snapshot);
  supportedSlug(slug);
  return validateReportAgainstSnapshotUnchecked(report, snapshot, slug);
}

export function validateReportsAgainstSnapshot(reports, snapshot) {
  assertSnapshot(snapshot);
  exactKeys(reports, ARXIV_CATEGORIES, "reports", "REPORT_SOURCE_MISMATCH");
  for (const slug of ARXIV_CATEGORIES) {
    validateReportAgainstSnapshotUnchecked(reports[slug], snapshot, slug);
  }
  return true;
}

async function readBoundedHtml(response, sourceUrl, { maxBytes = MAX_ARXIV_LISTING_BYTES } = {}) {
  if (response === null || typeof response !== "object") fail("SOURCE_FETCH", `${sourceUrl} did not return a Response.`);
  if (response.status !== 200 || response.ok !== true) {
    fail("SOURCE_FETCH", `${sourceUrl} returned HTTP ${String(response.status)}.`, {
      // Retry every bounded server-side failure, including reverse-proxy 52x
      // responses.  501 and 505 describe stable protocol capability errors.
      retryable: [408, 425, 429].includes(response.status)
        || (response.status >= 500 && response.status <= 599 && ![501, 505].includes(response.status)),
    });
  }
  if (response.url !== sourceUrl) fail("SOURCE_FETCH", `${sourceUrl} redirected or returned an unexpected final URL.`);
  const contentType = response.headers?.get?.("content-type");
  if (typeof contentType !== "string" || !/^text\/html(?:\s*;|$)/i.test(contentType)) {
    fail("SOURCE_FETCH", `${sourceUrl} did not return text/html.`);
  }
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declaredLength)) fail("SOURCE_FETCH", `${sourceUrl} returned an invalid Content-Length.`);
    if (Number(declaredLength) > maxBytes) {
      fail("SOURCE_TOO_LARGE", `${sourceUrl} exceeds ${maxBytes} bytes.`);
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
      if (total > maxBytes) {
        await reader.cancel("response too large");
        fail("SOURCE_TOO_LARGE", `${sourceUrl} exceeds ${maxBytes} bytes.`);
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } catch (error) {
    if (error instanceof ArxivSourceError) throw error;
    fail("SOURCE_FETCH", `${sourceUrl} response could not be decoded as bounded UTF-8 HTML.`, {
      cause: error,
      retryable: true,
    });
  }
  if (total === 0 || html.length === 0) {
    fail("SOURCE_FETCH", `${sourceUrl} returned an empty response.`, { retryable: true });
  }
  return html;
}

async function fetchOfficialCategorySourceAttempt({ fetchImpl, signal, fetchUrls, parser, build }) {
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
        fail("SOURCE_FETCH", `${sourceUrl} could not be fetched.`, { cause: error, retryable: true });
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

function sleep(milliseconds, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) {
      rejectPromise(signal.reason ?? new Error("arXiv snapshot fetch was aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      rejectPromise(signal.reason ?? new Error("arXiv snapshot fetch was aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchOfficialCategorySource({
  fetchImpl,
  signal,
  fetchUrls,
  parser,
  build,
  sleepImpl,
  maxAttempts,
}) {
  if (typeof fetchImpl !== "function") fail("SOURCE_INVALID", "fetchImpl must be a function.");
  if (typeof sleepImpl !== "function") fail("SOURCE_INVALID", "sleepImpl must be a function.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("SOURCE_INVALID", "signal must be an AbortSignal.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > SNAPSHOT_MAX_ATTEMPTS) {
    fail("SOURCE_INVALID", `snapshot fetch attempts must be from 1 through ${SNAPSHOT_MAX_ATTEMPTS}.`);
  }
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) throw signal.reason ?? new Error("arXiv snapshot fetch was aborted");
    try {
      return await fetchOfficialCategorySourceAttempt({ fetchImpl, signal, fetchUrls, parser, build });
    } catch (error) {
      lastError = error;
      const retryable = error instanceof ArxivSourceError
        && (error.retryable === true || error.code === "SOURCE_INCOMPLETE");
      if (!retryable || signal?.aborted || attempt === maxAttempts) throw error;
      await sleepImpl(SNAPSHOT_RETRY_DELAYS_MS[attempt - 1], signal);
    }
  }
  throw lastError;
}

export async function fetchOfficialListingSnapshot({
  fetchImpl = globalThis.fetch,
  signal,
  sleepImpl = sleep,
  maxAttempts = SNAPSHOT_MAX_ATTEMPTS,
} = {}) {
  return fetchOfficialCategorySource({
    fetchImpl,
    signal,
    sleepImpl,
    maxAttempts,
    fetchUrls: ARXIV_FETCH_URLS,
    parser: parseArxivNewListing,
    build: buildOfficialListingSnapshot,
  });
}

export async function fetchOfficialPastweekWindow({
  fetchImpl = globalThis.fetch,
  signal,
  sleepImpl = sleep,
  maxAttempts = SNAPSHOT_MAX_ATTEMPTS,
} = {}) {
  return fetchOfficialCategorySource({
    fetchImpl,
    signal,
    sleepImpl,
    maxAttempts,
    fetchUrls: ARXIV_PASTWEEK_FETCH_URLS,
    parser: parseArxivPastweekListing,
    build: buildOfficialPastweekWindow,
  });
}

/**
 * Fetch exact v1 abstract pages serially.  Every HTTP attempt is paced and the
 * caller hook runs immediately before that attempt, which lets the unattended
 * host enforce one shared arXiv request interval across processes.
 */
export async function fetchOfficialCategoryMetadata({
  snapshot,
  slug,
  fetchImpl = globalThis.fetch,
  beforeRequest = async () => {},
  sleepImpl = sleep,
  maxAttempts = METADATA_MAX_ATTEMPTS,
  signal,
} = {}) {
  assertSnapshot(snapshot);
  supportedSlug(slug);
  if (typeof fetchImpl !== "function") fail("SOURCE_INVALID", "fetchImpl must be a function.");
  if (typeof beforeRequest !== "function") fail("SOURCE_INVALID", "beforeRequest must be a function.");
  if (typeof sleepImpl !== "function") fail("SOURCE_INVALID", "sleepImpl must be a function.");
  if (signal !== undefined && !(signal instanceof AbortSignal)) fail("SOURCE_INVALID", "signal must be an AbortSignal.");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > METADATA_MAX_ATTEMPTS) {
    fail("SOURCE_INVALID", `metadata fetch attempts must be from 1 through ${METADATA_MAX_ATTEMPTS}.`);
  }

  const papers = [];
  let requestCount = 0;
  for (const arxivId of snapshot.categories[slug].newIds) {
    const sourceUrl = `https://arxiv.org/abs/${arxivId}v1`;
    let paper;
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason ?? new Error("arXiv metadata fetch was aborted");
      if (requestCount > 0) {
        const delay = attempt > 1
          ? METADATA_RETRY_DELAYS_MS[attempt - 2]
          : METADATA_REQUEST_INTERVAL_MS;
        await sleepImpl(delay, signal);
      }

      const requestContext = Object.freeze({ arxivId, slug, sourceUrl, attempt });
      await beforeRequest(requestContext);
      requestCount += 1;

      const timeoutController = new AbortController();
      const timer = setTimeout(
        () => timeoutController.abort(new Error("arXiv abstract-page fetch timed out")),
        FETCH_TIMEOUT_MS,
      );
      timer.unref?.();
      const combinedSignal = signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([signal, timeoutController.signal]);
      try {
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
          if (signal?.aborted) throw error;
          fail("SOURCE_FETCH", `${sourceUrl} could not be fetched.`, { cause: error, retryable: true });
        }
        const html = await readBoundedHtml(response, sourceUrl, { maxBytes: MAX_ARXIV_ABSTRACT_PAGE_BYTES });
        paper = parseArxivAbstractPage(html, { arxivId, slug });
      } catch (error) {
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      if (paper !== undefined) break;
      const retryable = lastError instanceof ArxivSourceError && lastError.retryable === true;
      if (!retryable || signal?.aborted || attempt === maxAttempts) throw lastError;
    }
    if (paper === undefined) throw lastError;
    papers.push(paper);
  }
  return buildOfficialCategoryMetadata({ snapshot, slug, papers });
}
