import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ARXIV_CATEGORIES,
  ARXIV_FETCH_URLS,
  ARXIV_LISTING_URLS,
  ARXIV_PASTWEEK_FETCH_URLS,
  ARXIV_PASTWEEK_LISTING_URLS,
  MAX_ARXIV_LISTING_BYTES,
  buildOfficialListingSnapshot,
  buildOfficialPastweekWindow,
  classifySnapshotDate,
  fetchOfficialListingSnapshot,
  fetchOfficialPastweekWindow,
  fingerprintSnapshot,
  fingerprintSnapshotContent,
  parseArxivNewListing,
  parseArxivPastweekListing,
  probeOfficialFullTextReadiness,
  revalidatePastweekSnapshot,
  selectBackfillSnapshot,
  selectFullTextReadinessCanary,
  validateReportAgainstSnapshot,
  validateReportsAgainstSnapshot,
} from "../scripts/lib/arxiv-source.mjs";

const DATE = "2026-07-10";
const IDS = Object.freeze({
  "hep-th": ["2607.07785", "2607.08752"],
  "gr-qc": ["2607.08228"],
  "quant-ph": ["2607.07798", "2607.08767", "2607.08999"],
});
const CROSS_COUNTS = Object.freeze({ "hep-th": 2, "gr-qc": 1, "quant-ph": 2 });

function dt(id, { cross = false, decoy = "" } = {}) {
  return `<dt>
    <a name="item-${id}">[1]</a>
    <a href="/abs/${id}" title="Abstract" id="${id}">arXiv:${id}</a>
    ${cross ? "(cross-list from math-ph)" : ""}
  </dt><dd>Abstract text ${decoy}</dd>`;
}

function listingHtml({
  dateHeading = "Friday, 10 July 2026",
  newIds = IDS["hep-th"],
  crossIds = ["2607.05001", "2607.05002"],
  newShown = newIds.length,
  newTotal = newIds.length,
  crossShown = crossIds.length,
  crossTotal = crossIds.length,
  includeNew = true,
  includeCross = true,
} = {}) {
  return `<!doctype html>
  <html><head><title>Listing</title><script>const fake = '<h3>New submissions (showing 999 of 999 entries)</h3>';</script></head>
  <body><div id="dlpage">
    <h1>Category</h1>
    <h3>Showing new listings for ${dateHeading}</h3>
    ${includeNew ? `<dl id="articles"><h3>New submissions (showing ${newShown} of ${newTotal} entries)</h3>
      ${newIds.map((id, index) => dt(id, { decoy: index === 0 ? '<a href="/abs/9999.99999" title="Abstract">not a dt</a>' : "" })).join("\n")}</dl>` : ""}
    ${includeCross ? `<dl id="articles"><h3>Cross submissions (showing ${crossShown} of ${crossTotal} entries)</h3>
      ${crossIds.map((id) => dt(id, { cross: true })).join("\n")}</dl>` : ""}
    <dl id="articles"><h3>Replacement submissions (showing 0 of 0 entries)</h3></dl>
  </div></body></html>`;
}

const PASTWEEK_DATES = Object.freeze(["2026-07-13", "2026-07-10", "2026-07-09", "2026-07-08"]);
const PASTWEEK_HEADINGS = Object.freeze({
  "2026-07-13": "Mon, 13 Jul 2026",
  "2026-07-10": "Fri, 10 Jul 2026",
  "2026-07-09": "Thu, 9 Jul 2026",
  "2026-07-08": "Wed, 8 Jul 2026",
  "2026-07-07": "Tue, 7 Jul 2026",
});

function pastweekGroupsFor(slug, { dates = PASTWEEK_DATES, partialOldest = false } = {}) {
  const categoryOffset = ARXIV_CATEGORIES.indexOf(slug) * 1_000;
  return dates.map((date, index) => {
    const dateOffset = PASTWEEK_DATES.indexOf(date) >= 0 ? PASTWEEK_DATES.indexOf(date) * 10 : 90;
    const newIds = [`2607.${String(10001 + categoryOffset + dateOffset)}`];
    const crossIds = [`2607.${String(20001 + categoryOffset + dateOffset)}`];
    const shown = newIds.length + crossIds.length;
    return {
      date,
      newIds,
      crossIds,
      shown,
      total: partialOldest && index === dates.length - 1 ? shown + 1 : shown,
    };
  });
}

function pastweekHtml({ groups = pastweekGroupsFor("hep-th") } = {}) {
  return `<!doctype html><html><head><title>Past week</title></head><body>
  <div id="dlpage"><h1>Past week</h1>
    ${groups.map((group) => `<h3>${PASTWEEK_HEADINGS[group.date]} (showing ${group.shown} of ${group.total} entries )</h3>
      <dl id="articles">
        ${group.newIds.map((id) => dt(id)).join("\n")}
        ${group.crossIds.map((id) => dt(id, { cross: true })).join("\n")}
      </dl>`).join("\n")}
  </div></body></html>`;
}

function pastweekParsedListings({ partialOldest = false, datesBySlug = {} } = {}) {
  return ARXIV_CATEGORIES.map((slug) => parseArxivPastweekListing(pastweekHtml({
    groups: pastweekGroupsFor(slug, { dates: datesBySlug[slug] ?? PASTWEEK_DATES, partialOldest }),
  }), slug));
}

function currentSnapshotFromPastweek(window) {
  const newest = window.snapshots[0];
  return buildOfficialListingSnapshot(ARXIV_CATEGORIES.map((slug) => ({
    ...newest.categories[slug],
    sourceUrl: ARXIV_LISTING_URLS[slug],
    announcementDate: newest.announcementDate,
  })));
}

function parsedListing(slug, { date = DATE, ids = IDS[slug], crosslistCount = CROSS_COUNTS[slug] } = {}) {
  return {
    slug,
    sourceUrl: ARXIV_LISTING_URLS[slug],
    announcementDate: date,
    newCount: ids.length,
    crosslistCount,
    newIds: [...ids].sort(),
  };
}

function snapshotFixture({ date = DATE } = {}) {
  return buildOfficialListingSnapshot(ARXIV_CATEGORIES.map((slug) => parsedListing(slug, { date })));
}

function reportsFixture(snapshot = snapshotFixture()) {
  return Object.fromEntries(ARXIV_CATEGORIES.map((slug) => {
    const source = snapshot.categories[slug];
    return [slug, {
      schemaVersion: "1.3",
      reportDate: snapshot.announcementDate,
      slug,
      totalNew: source.newCount,
      crosslistsExcluded: source.crosslistCount,
      evaluatedCount: source.newCount,
      papers: [...source.newIds].reverse().map((arxivId) => ({
        arxivId,
        arxivVersion: "v1",
        submissionType: "new",
        primaryCategory: slug,
      })),
      audit: {
        listingUrl: source.sourceUrl,
        announcementDate: snapshot.announcementDate,
        sourceCounts: {
          newPrimary: source.newCount,
          crosslistsExcluded: source.crosslistCount,
          titleAuthorAbstractEvaluated: source.newCount,
        },
      },
    }];
  }));
}

function responseFor(html, url, { contentLength = true, chunks } = {}) {
  const encoded = new TextEncoder().encode(html);
  const bodyChunks = chunks ?? [encoded];
  return {
    status: 200,
    ok: true,
    url,
    headers: new Headers({
      "content-type": "text/html; charset=utf-8",
      ...(contentLength ? { "content-length": String(encoded.byteLength) } : {}),
    }),
    body: new ReadableStream({
      start(controller) {
        for (const chunk of bodyChunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function readinessResponse(url, {
  status = 200,
  contentType = "application/pdf",
} = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: new Headers({ "content-type": contentType }),
  };
}

test("full-text readiness canary is the greatest primary-new ID across all categories", () => {
  assert.equal(selectFullTextReadinessCanary(snapshotFixture()), "2607.08999");
  const empty = buildOfficialListingSnapshot(ARXIV_CATEGORIES.map((slug) => parsedListing(slug, {
    ids: [],
    crosslistCount: 0,
  })));
  assert.equal(selectFullTextReadinessCanary(empty), null);
});

test("full-text readiness uses only paced HEAD checks for the exact v1 PDF and e-print", async () => {
  const calls = [];
  const sleeps = [];
  const result = await probeOfficialFullTextReadiness(snapshotFixture(), {
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/pdf/")) return readinessResponse(url);
      return readinessResponse("https://arxiv.org/src/2607.08999v1", { contentType: "application/gzip" });
    },
    sleepImpl: async (milliseconds) => { sleeps.push(milliseconds); },
  });
  assert.equal(result.ready, true);
  assert.equal(result.arxivId, "2607.08999");
  assert.deepEqual(result.checks.map(({ kind, status }) => ({ kind, status })), [
    { kind: "pdf", status: 200 },
    { kind: "source", status: 200 },
  ]);
  assert.deepEqual(sleeps, [3000]);
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://arxiv.org/pdf/2607.08999v1",
    "https://arxiv.org/e-print/2607.08999v1",
  ]);
  assert.deepEqual(calls.map(({ options }) => options.method), ["HEAD", "HEAD"]);
  assert.deepEqual(calls.map(({ options }) => options.redirect), ["manual", "follow"]);
  for (const { options } of calls) {
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    assert.ok(options.signal instanceof AbortSignal);
  }
});

test("an unavailable canary short-circuits before e-print and can defer without Codex", async () => {
  const calls = [];
  const result = await probeOfficialFullTextReadiness(snapshotFixture(), {
    fetchImpl: async (url) => {
      calls.push(url);
      return readinessResponse(url, { status: 404, contentType: "text/html" });
    },
    sleepImpl: async () => assert.fail("sleep must not run after the first unavailable check"),
  });
  assert.equal(result.ready, false);
  assert.equal(result.unavailable.kind, "pdf");
  assert.equal(result.unavailable.status, 404);
  assert.deepEqual(calls, ["https://arxiv.org/pdf/2607.08999v1"]);
});

test("a readiness transport failure is reported as unavailable instead of starting expensive work", async () => {
  const result = await probeOfficialFullTextReadiness(snapshotFixture(), {
    fetchImpl: async () => { throw new TypeError("temporary network failure"); },
    sleepImpl: async () => {},
  });
  assert.equal(result.ready, false);
  assert.equal(result.unavailable.status, null);
  assert.equal(result.unavailable.reason, "fetch_error");
});

test("readiness rejects a successful response with the wrong URL or media type", async () => {
  await assert.rejects(
    probeOfficialFullTextReadiness(snapshotFixture(), {
      fetchImpl: async (url) => readinessResponse("https://example.com/paper.pdf"),
      sleepImpl: async () => {},
    }),
    /unexpected final URL/,
  );
  await assert.rejects(
    probeOfficialFullTextReadiness(snapshotFixture(), {
      fetchImpl: async (url) => readinessResponse(url, { contentType: "text/html" }),
      sleepImpl: async () => {},
    }),
    /application\/pdf/,
  );
});

test("parser accepts the exact English announcement and reads IDs only from New-submission dt entries", () => {
  const result = parseArxivNewListing(listingHtml({ newIds: [...IDS["hep-th"]].reverse() }), "hep-th");
  assert.deepEqual(result, {
    slug: "hep-th",
    sourceUrl: ARXIV_LISTING_URLS["hep-th"],
    announcementDate: DATE,
    newCount: 2,
    crosslistCount: 2,
    newIds: [...IDS["hep-th"]].sort(),
  });
  assert.ok(!result.newIds.includes("9999.99999"), "an abstract-link decoy in dd must not be parsed");
  assert.ok(!result.newIds.includes("2607.05001"), "a Cross-submission ID must not be parsed as new");
  const oldStyleCross = listingHtml().replace("/abs/2607.05001", "/abs/hep-th/9901001");
  assert.equal(parseArxivNewListing(oldStyleCross, "hep-th").crosslistCount, 2);
});

test("parser fails closed for incomplete sections, pagination, malformed dates, and dt/count disagreement", async (t) => {
  const cases = [
    ["missing new section", listingHtml({ includeNew: false }), /New submissions/],
    ["missing cross section", listingHtml({ includeCross: false }), /Cross submissions/],
    ["new section is paginated", listingHtml({ newShown: 1, newTotal: 2 }), /show every entry/],
    ["cross section is paginated", listingHtml({ crossShown: 1, crossTotal: 2 }), /show every entry/],
    ["declared count differs from dt count", listingHtml({ newShown: 3, newTotal: 3 }), /contains 2 <dt>/],
    ["non-English announcement", listingHtml({ dateHeading: "vendredi 10 juillet 2026" }), /expected English date heading/],
    ["weekday/date disagreement", listingHtml({ dateHeading: "Thursday, 10 July 2026" }), /invalid date or weekday/],
  ];
  for (const [name, html, pattern] of cases) {
    await t.test(name, () => assert.throws(() => parseArxivNewListing(html, "hep-th"), pattern));
  }
});

test("parser rejects duplicate, versioned, or noncanonical abstract links in New-submission dt entries", async (t) => {
  await t.test("duplicate ID", () => {
    const html = listingHtml({ newIds: ["2607.07785", "2607.07785"] });
    assert.throws(() => parseArxivNewListing(html, "hep-th"), /duplicate arXiv IDs/);
  });
  await t.test("versioned href", () => {
    const html = listingHtml({ newIds: ["2607.07785"] }).replace('href="/abs/2607.07785"', 'href="/abs/2607.07785v1"');
    assert.throws(() => parseArxivNewListing(html, "hep-th"), /exactly one unversioned/);
  });
  await t.test("wrong link title", () => {
    const html = listingHtml({ newIds: ["2607.07785"] }).replace('title="Abstract" id="2607.07785"', 'title="PDF" id="2607.07785"');
    assert.throws(() => parseArxivNewListing(html, "hep-th"), /noncanonical abstract link/);
  });
});

test("pastweek parser reads strict newest-to-oldest groups and excludes exact cross-list markers", () => {
  const groups = pastweekGroupsFor("hep-th");
  const result = parseArxivPastweekListing(pastweekHtml({ groups }), "hep-th");
  assert.equal(result.slug, "hep-th");
  assert.equal(result.sourceUrl, ARXIV_PASTWEEK_LISTING_URLS["hep-th"]);
  assert.deepEqual(result.groups.map(({ announcementDate }) => announcementDate), PASTWEEK_DATES);
  assert.deepEqual(result.groups[0], {
    announcementDate: "2026-07-13",
    shownCount: 2,
    totalCount: 2,
    complete: true,
    newCount: 1,
    crosslistCount: 1,
    newIds: [...groups[0].newIds],
  });
  assert.ok(!result.groups[0].newIds.includes(groups[0].crossIds[0]));

  const legacyCross = pastweekHtml({ groups }).replace(
    `/abs/${groups[0].crossIds[0]}`,
    "/abs/hep-th/9901001",
  );
  assert.equal(parseArxivPastweekListing(legacyCross, "hep-th").groups[0].crosslistCount, 1);
});

test("pastweek parser permits only a partial oldest anchor and the window snapshots only complete groups", async (t) => {
  const listings = pastweekParsedListings({ partialOldest: true });
  for (const listing of listings) {
    assert.equal(listing.groups.at(-1).complete, false);
    assert.equal(listing.groups.at(-1).shownCount, 2);
    assert.equal(listing.groups.at(-1).totalCount, 3);
  }
  const window = buildOfficialPastweekWindow(listings);
  assert.deepEqual(window.announcementDates, PASTWEEK_DATES);
  assert.deepEqual(window.snapshots.map(({ announcementDate }) => announcementDate), PASTWEEK_DATES.slice(0, -1));
  for (const snapshot of window.snapshots) {
    for (const slug of ARXIV_CATEGORIES) {
      assert.equal(snapshot.categories[slug].sourceUrl, ARXIV_PASTWEEK_LISTING_URLS[slug]);
    }
  }

  await t.test("non-oldest partial group", () => {
    const groups = pastweekGroupsFor("hep-th");
    groups[1].total += 1;
    assert.throws(
      () => parseArxivPastweekListing(pastweekHtml({ groups }), "hep-th"),
      /partial but is not the oldest anchor/,
    );
  });
  await t.test("malformed cross-list marker", () => {
    const html = pastweekHtml().replace("(cross-list from math-ph)", "(cross-list via math-ph)");
    assert.throws(() => parseArxivPastweekListing(html, "hep-th"), /malformed or repeated cross-list marker/);
  });
  await t.test("unrecognized intermediate heading", () => {
    const html = pastweekHtml().replace(
      "Fri, 10 Jul 2026 (showing 2 of 2 entries )",
      "Friday 10 July 2026 (2 entries)",
    );
    assert.throws(() => parseArxivPastweekListing(html, "hep-th"), /unexpected or malformed date heading/);
  });
});

test("pastweek window rejects malformed order and cross-category date-sequence mismatch", async (t) => {
  await t.test("parser requires newest-to-oldest order", () => {
    const groups = pastweekGroupsFor("hep-th");
    [groups[1], groups[2]] = [groups[2], groups[1]];
    assert.throws(() => parseArxivPastweekListing(pastweekHtml({ groups }), "hep-th"), /newest-to-oldest/);
  });
  await t.test("categories require identical ordered dates", () => {
    const listings = pastweekParsedListings({
      datesBySlug: { "quant-ph": ["2026-07-13", "2026-07-10", "2026-07-09", "2026-07-07"] },
    });
    assert.throws(() => buildOfficialPastweekWindow(listings), (error) => error.code === "SOURCE_DATE_MISMATCH");
  });
});

test("snapshot requires exactly the three hardcoded categories on one announcement date", async (t) => {
  const listings = ARXIV_CATEGORIES.map((slug) => parsedListing(slug));
  const snapshot = buildOfficialListingSnapshot([...listings].reverse());
  assert.equal(snapshot.announcementDate, DATE);
  assert.deepEqual(Object.keys(snapshot.categories), ARXIV_CATEGORIES);
  for (const slug of ARXIV_CATEGORIES) {
    assert.equal(snapshot.categories[slug].sourceUrl, ARXIV_LISTING_URLS[slug]);
    assert.deepEqual(snapshot.categories[slug].newIds, [...IDS[slug]].sort());
  }

  await t.test("missing category", () => assert.throws(
    () => buildOfficialListingSnapshot(listings.slice(0, 2)),
    /exactly 3/,
  ));
  await t.test("duplicate category", () => assert.throws(
    () => buildOfficialListingSnapshot([listings[0], listings[1], listings[1]]),
    /repeats gr-qc/,
  ));
  await t.test("date mismatch", () => assert.throws(
    () => buildOfficialListingSnapshot([
      listings[0],
      listings[1],
      parsedListing(ARXIV_CATEGORIES[2], { date: "2026-07-09" }),
    ]),
    /same announcement date/,
  ));
  await t.test("category overlap", () => assert.throws(
    () => buildOfficialListingSnapshot([
      listings[0],
      parsedListing(ARXIV_CATEGORIES[1], { ids: [IDS[ARXIV_CATEGORIES[0]][0]] }),
      listings[2],
    ]),
    /more than one primary category/,
  ));
});

test("snapshot fingerprint is canonical SHA-256 and stable across input order", () => {
  const forward = snapshotFixture();
  const reverse = buildOfficialListingSnapshot(ARXIV_CATEGORIES.toReversed().map((slug) => parsedListing(slug)));
  const fingerprint = fingerprintSnapshot(forward);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint, fingerprintSnapshot(reverse));

  const canonical = {
    announcementDate: forward.announcementDate,
    categories: Object.fromEntries(ARXIV_CATEGORIES.map((slug) => [slug, {
      slug,
      sourceUrl: ARXIV_LISTING_URLS[slug],
      newCount: forward.categories[slug].newCount,
      crosslistCount: forward.categories[slug].crosslistCount,
      newIds: [...forward.categories[slug].newIds],
    }])),
  };
  assert.equal(fingerprint, createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex"));
});

test("semantic snapshot fingerprint ignores the official /new versus /pastweek source URL", () => {
  const window = buildOfficialPastweekWindow(pastweekParsedListings());
  const pastweek = window.snapshots[0];
  const current = currentSnapshotFromPastweek(window);
  assert.notEqual(pastweek.categories["hep-th"].sourceUrl, current.categories["hep-th"].sourceUrl);
  assert.equal(fingerprintSnapshotContent(pastweek), fingerprintSnapshotContent(current));
  assert.notEqual(fingerprintSnapshot(pastweek), fingerprintSnapshot(current));
});

test("JST date guard classifies new/current and rejects stale/future snapshots", () => {
  const snapshot = snapshotFixture();
  const now = new Date("2026-07-12T15:30:00.000Z"); // 2026-07-13 00:30 JST
  assert.equal(classifySnapshotDate(snapshot, { latestDate: "2026-07-09", now }), "new");
  assert.equal(classifySnapshotDate(snapshot, { latestDate: DATE, now }), "current");
  assert.throws(
    () => classifySnapshotDate(snapshot, { latestDate: "2026-07-11", now }),
    (error) => error.code === "SOURCE_STALE",
  );
  const future = snapshotFixture({ date: "2026-07-14" });
  assert.throws(
    () => classifySnapshotDate(future, { latestDate: DATE, now }),
    (error) => error.code === "SOURCE_FUTURE",
  );
});

test("backfill selector verifies /new content and returns the oldest pending complete snapshot", async (t) => {
  const pastweekWindow = buildOfficialPastweekWindow(pastweekParsedListings({ partialOldest: true }));
  const currentSnapshot = currentSnapshotFromPastweek(pastweekWindow);
  const now = new Date("2026-07-13T03:00:00.000Z");

  const selected = selectBackfillSnapshot({
    currentSnapshot,
    pastweekWindow,
    latestDate: "2026-07-09",
    now,
  });
  assert.equal(selected.pendingCount, 2);
  assert.equal(selected.snapshot.announcementDate, "2026-07-10");
  assert.equal(selected.snapshot.categories["hep-th"].sourceUrl, ARXIV_PASTWEEK_LISTING_URLS["hep-th"]);

  await t.test("incomplete oldest group is a valid latestDate anchor", () => {
    const fromPartialAnchor = selectBackfillSnapshot({
      currentSnapshot,
      pastweekWindow,
      latestDate: "2026-07-08",
      now,
    });
    assert.equal(fromPartialAnchor.pendingCount, 3);
    assert.equal(fromPartialAnchor.snapshot.announcementDate, "2026-07-09");
  });
  await t.test("already current returns null without requiring a pastweek window", () => {
    assert.equal(selectBackfillSnapshot({ currentSnapshot, latestDate: "2026-07-13", now }), null);
  });
  await t.test("latestDate outside the bounded window fails closed", () => {
    assert.throws(
      () => selectBackfillSnapshot({ currentSnapshot, pastweekWindow, latestDate: "2026-07-07", now }),
      (error) => error.code === "SOURCE_BACKFILL_WINDOW",
    );
  });
  await t.test("newest pastweek content must match /new", () => {
    const listings = ARXIV_CATEGORIES.map((slug) => ({
      ...currentSnapshot.categories[slug],
      sourceUrl: ARXIV_LISTING_URLS[slug],
      announcementDate: currentSnapshot.announcementDate,
      ...(slug === "hep-th" ? { newIds: ["2607.39999"], newCount: 1 } : {}),
    }));
    const changedCurrent = buildOfficialListingSnapshot(listings);
    assert.throws(
      () => selectBackfillSnapshot({ currentSnapshot: changedCurrent, pastweekWindow, latestDate: "2026-07-09", now }),
      (error) => error.code === "SOURCE_CONTENT_MISMATCH",
    );
  });
  await t.test("zero-primary dates preserve continuity but are not publication work", () => {
    const zeroWindow = (zeroDates) => buildOfficialPastweekWindow(ARXIV_CATEGORIES.map((slug) => {
      const groups = pastweekGroupsFor(slug);
      for (const group of groups) {
        if (!zeroDates.includes(group.date)) continue;
        group.newIds = [];
        group.shown = group.crossIds.length;
        group.total = group.shown;
      }
      return parseArxivPastweekListing(pastweekHtml({ groups }), slug);
    }));

    const withEmptyMiddle = zeroWindow(["2026-07-10"]);
    const selectedNonEmpty = selectBackfillSnapshot({
      currentSnapshot: currentSnapshotFromPastweek(withEmptyMiddle),
      pastweekWindow: withEmptyMiddle,
      latestDate: "2026-07-08",
      now,
    });
    assert.equal(selectedNonEmpty.snapshot.announcementDate, "2026-07-09");
    assert.equal(selectedNonEmpty.pendingCount, 2);

    const allPendingEmpty = zeroWindow(["2026-07-13", "2026-07-10", "2026-07-09"]);
    assert.equal(selectBackfillSnapshot({
      currentSnapshot: currentSnapshotFromPastweek(allPendingEmpty),
      pastweekWindow: allPendingEmpty,
      latestDate: "2026-07-08",
      now,
    }), null);
  });
});

test("pastweek target revalidation ignores a newer head but rejects a missing or changed selected date", async (t) => {
  const originalWindow = buildOfficialPastweekWindow(pastweekParsedListings());
  const selected = originalWindow.snapshots.find(({ announcementDate }) => announcementDate === "2026-07-10");
  assert.equal(revalidatePastweekSnapshot(selected, originalWindow).announcementDate, "2026-07-10");

  await t.test("selected date fell out of the fresh window", () => {
    const dates = ["2026-07-13", "2026-07-09", "2026-07-08"];
    const freshWindow = buildOfficialPastweekWindow(pastweekParsedListings({
      datesBySlug: Object.fromEntries(ARXIV_CATEGORIES.map((slug) => [slug, dates])),
    }));
    assert.throws(
      () => revalidatePastweekSnapshot(selected, freshWindow),
      (error) => error.code === "SOURCE_CONTENT_MISMATCH",
    );
  });

  await t.test("selected date content changed", () => {
    const freshWindow = structuredClone(originalWindow);
    const target = freshWindow.snapshots.find(({ announcementDate }) => announcementDate === "2026-07-10");
    target.categories["hep-th"].newIds[0] = "2607.39999";
    assert.throws(
      () => revalidatePastweekSnapshot(selected, freshWindow),
      (error) => error.code === "SOURCE_CONTENT_MISMATCH",
    );
  });
});

test("report guard requires exact announcement, listing, counts, crosslists, and New-submission ID sets", async (t) => {
  const snapshot = snapshotFixture();
  const reports = reportsFixture(snapshot);
  assert.equal(validateReportsAgainstSnapshot(reports, snapshot), true);

  const mutations = [
    ["date", (value) => { value["hep-th"].reportDate = "2026-07-09"; }, /reportDate/],
    ["new count", (value) => { value["hep-th"].totalNew -= 1; }, /totalNew/],
    ["evaluated count", (value) => { value["hep-th"].evaluatedCount -= 1; }, /evaluatedCount/],
    ["crosslist count", (value) => { value["hep-th"].crosslistsExcluded -= 1; }, /crosslistsExcluded/],
    ["missing ID", (value) => { value["hep-th"].papers[0].arxivId = "2607.09999"; }, /do not exactly match/],
    ["duplicate ID", (value) => { value["hep-th"].papers[0].arxivId = value["hep-th"].papers[1].arxivId; }, /duplicate/],
    ["wrong primary", (value) => { value["hep-th"].papers[0].primaryCategory = "gr-qc"; }, /primaryCategory/],
    ["wrong version", (value) => { value["hep-th"].papers[0].arxivVersion = "v2"; }, /arxivVersion/],
    ["wrong source URL", (value) => { value["hep-th"].audit.listingUrl = "https://example.com/list"; }, /listingUrl/],
    ["audit crosslist count", (value) => { value["hep-th"].audit.sourceCounts.crosslistsExcluded -= 1; }, /sourceCounts.crosslistsExcluded/],
  ];
  for (const [name, mutate, pattern] of mutations) {
    await t.test(name, () => {
      const changed = structuredClone(reports);
      mutate(changed);
      assert.throws(() => validateReportsAgainstSnapshot(changed, snapshot), pattern);
    });
  }
});

test("single-report guard validates one category against the same official snapshot", () => {
  const snapshot = snapshotFixture();
  const report = reportsFixture(snapshot)["quant-ph"];
  assert.equal(validateReportAgainstSnapshot(report, snapshot, "quant-ph"), true);
  const changed = structuredClone(report);
  changed.papers[0].arxivVersion = "v2";
  assert.throws(() => validateReportAgainstSnapshot(changed, snapshot, "quant-ph"), /arxivVersion/);
});

test("fetcher requests only hardcoded HTTPS listing URLs and returns a same-date snapshot", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const slug = ARXIV_CATEGORIES.find((candidate) => ARXIV_FETCH_URLS[candidate] === url);
    assert.ok(slug, `unexpected URL ${url}`);
    const crossIds = Array.from({ length: CROSS_COUNTS[slug] }, (_, index) => `2606.${String(10000 + ARXIV_CATEGORIES.indexOf(slug) * 100 + index)}`);
    return responseFor(listingHtml({ newIds: IDS[slug], crossIds }), url);
  };
  const snapshot = await fetchOfficialListingSnapshot({ fetchImpl });
  assert.deepEqual(calls.map(({ url }) => url).sort(), Object.values(ARXIV_FETCH_URLS).sort());
  for (const { options } of calls) {
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
  }
  assert.equal(snapshot.announcementDate, DATE);
  assert.deepEqual(snapshot.categories["quant-ph"].newIds, [...IDS["quant-ph"]].sort());
});

test("pastweek fetcher requests only hardcoded bounded URLs and applies the same response guards", async (t) => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const slug = ARXIV_CATEGORIES.find((candidate) => ARXIV_PASTWEEK_FETCH_URLS[candidate] === url);
    assert.ok(slug, `unexpected URL ${url}`);
    return responseFor(pastweekHtml({ groups: pastweekGroupsFor(slug, { partialOldest: true }) }), url);
  };
  const window = await fetchOfficialPastweekWindow({ fetchImpl });
  assert.deepEqual(calls.map(({ url }) => url).sort(), Object.values(ARXIV_PASTWEEK_FETCH_URLS).sort());
  assert.deepEqual(window.announcementDates, PASTWEEK_DATES);
  assert.deepEqual(window.snapshots.map(({ announcementDate }) => announcementDate), PASTWEEK_DATES.slice(0, -1));
  for (const { options } of calls) {
    assert.equal(options.redirect, "error");
    assert.equal(options.credentials, "omit");
    assert.ok(options.signal instanceof AbortSignal);
  }

  await t.test("redirected pastweek response", async () => {
    const target = ARXIV_PASTWEEK_FETCH_URLS["hep-th"];
    await assert.rejects(fetchOfficialPastweekWindow({
      fetchImpl: async (url) => {
        const slug = ARXIV_CATEGORIES.find((candidate) => ARXIV_PASTWEEK_FETCH_URLS[candidate] === url);
        const response = responseFor(pastweekHtml({ groups: pastweekGroupsFor(slug) }), url);
        return url === target ? { ...response, url: "https://example.com/" } : response;
      },
    }), /redirected or returned an unexpected final URL/);
  });
});

test("an early category fetch failure aborts every still-pending sibling request", async () => {
  let pendingAborts = 0;
  const fetchImpl = (url, options) => {
    if (url === ARXIV_FETCH_URLS["hep-th"]) {
      return Promise.resolve({ status: 503, ok: false, url, headers: new Headers(), body: null });
    }
    return new Promise((resolvePromise, rejectPromise) => {
      options.signal.addEventListener("abort", () => {
        pendingAborts += 1;
        rejectPromise(options.signal.reason);
      }, { once: true });
    });
  };
  await assert.rejects(() => fetchOfficialListingSnapshot({ fetchImpl, maxAttempts: 1 }), /HTTP 503/);
  assert.equal(pendingAborts, 2);
});

test("a transient malformed UTF-8 category retries the complete three-category snapshot", async () => {
  const calls = new Map(ARXIV_CATEGORIES.map((slug) => [slug, 0]));
  const delays = [];
  const target = "gr-qc";
  const fetchImpl = async (url) => {
    const slug = ARXIV_CATEGORIES.find((candidate) => ARXIV_FETCH_URLS[candidate] === url);
    assert.ok(slug, `unexpected URL ${url}`);
    calls.set(slug, calls.get(slug) + 1);
    if (slug === target && calls.get(slug) === 1) {
      return {
        status: 200,
        ok: true,
        url,
        headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([0xc3, 0x28]));
            controller.close();
          },
        }),
      };
    }
    const crossIds = Array.from({ length: CROSS_COUNTS[slug] }, (_, index) => `2606.${String(10000 + ARXIV_CATEGORIES.indexOf(slug) * 100 + index)}`);
    return responseFor(listingHtml({ newIds: IDS[slug], crossIds }), url);
  };
  const snapshot = await fetchOfficialListingSnapshot({
    fetchImpl,
    maxAttempts: 2,
    sleepImpl: async (milliseconds) => { delays.push(milliseconds); },
  });
  assert.equal(snapshot.announcementDate, DATE);
  assert.deepEqual(Object.fromEntries(calls), {
    "quant-ph": 2,
    "gr-qc": 2,
    "hep-th": 2,
  });
  assert.deepEqual(delays, [3_000]);
});

test("fetcher rejects redirects, non-HTML, declared oversize, and streamed oversize bodies", async (t) => {
  const valid = listingHtml();
  const remaining = (wantedUrl, replacement) => async (url) => {
    if (url === wantedUrl) return replacement(url);
    return responseFor(valid, url);
  };
  await t.test("redirected final URL", async () => {
    const target = ARXIV_FETCH_URLS["hep-th"];
    await assert.rejects(
      fetchOfficialListingSnapshot({ fetchImpl: remaining(target, (url) => ({ ...responseFor(valid, url), url: "https://example.com/" })) }),
      /redirected or returned an unexpected final URL/,
    );
  });
  await t.test("non-HTML content type", async () => {
    const target = ARXIV_FETCH_URLS["hep-th"];
    await assert.rejects(fetchOfficialListingSnapshot({
      fetchImpl: remaining(target, (url) => {
        const response = responseFor(valid, url);
        response.headers.set("content-type", "application/json");
        return response;
      }),
    }), /did not return text\/html/);
  });
  await t.test("declared oversized body", async () => {
    const target = ARXIV_FETCH_URLS["hep-th"];
    await assert.rejects(fetchOfficialListingSnapshot({
      fetchImpl: remaining(target, (url) => {
        const response = responseFor(valid, url);
        response.headers.set("content-length", String(MAX_ARXIV_LISTING_BYTES + 1));
        return response;
      }),
    }), (error) => error.code === "SOURCE_TOO_LARGE");
  });
  await t.test("streamed oversized body without Content-Length", async () => {
    const target = ARXIV_FETCH_URLS["hep-th"];
    await assert.rejects(fetchOfficialListingSnapshot({
      fetchImpl: remaining(target, (url) => responseFor("x", url, {
        contentLength: false,
        chunks: [new Uint8Array(MAX_ARXIV_LISTING_BYTES), new Uint8Array(1)],
      })),
    }), (error) => error.code === "SOURCE_TOO_LARGE");
  });
});
