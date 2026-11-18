// @ts-check
// ISBN Brasil metadata source plugin for Dalibre.
// Queries BrasilAPI (https://brasilapi.com.br/docs#tag/ISBN — Câmara Brasileira do Livro /
// Mercado Editorial), with optional Open Library fallback covers/synopses and title-to-ISBN
// discovery via Open Library / Google Books when no ISBN is present.

const BRASILAPI = "https://brasilapi.com.br/api/isbn/v1";
const OPENLIBRARY = "https://openlibrary.org";
const OL_COVERS = "https://covers.openlibrary.org";
const GOOGLEBOOKS = "https://www.googleapis.com/books/v1";

/**
 * Look up Brazilian book metadata candidates via BrasilAPI.
 * @param {Dalibre.Book} book
 * @returns {Promise<Dalibre.Candidate[]>}
 */
export async function identify(book) {
  const s = dalibre.settings;
  const searchByTitle = (s.searchByTitle ?? "true") !== "false";
  const fallbackCover = (s.fallbackCover ?? "true") !== "false";

  const ids = book?.identifiers ?? {};
  const directIsbn = toISBN13(ids.isbn ?? "");
  if (directIsbn) {
    const rec = await fetchBrasilAPI(directIsbn);
    if (!rec) return [];
    const fallback = fallbackCover && (!validCoverUrl(rec.cover_url) || !cleanText(rec.synopsis))
      ? await fetchOpenLibraryFallback(directIsbn, !cleanText(rec.synopsis))
      : null;
    const cand = toCandidate(directIsbn, rec, fallback);
    return cand ? [cand] : [];
  }

  const title = (book?.title ?? "").trim();
  if (!searchByTitle || !title) return [];

  const isbns = await discoverBrazilianISBNs(title, book?.authors ?? []);
  if (!isbns.length) return [];

  const records = await Promise.all(
    isbns.slice(0, 3).map(async (isbn) => ({ isbn, rec: await fetchBrasilAPI(isbn) })),
  );

  /** @type {Dalibre.Candidate[]} */
  const out = [];
  for (const { isbn, rec } of records) {
    if (!rec || !rec.title) continue;
    const fallback = fallbackCover && (!validCoverUrl(rec.cover_url) || !cleanText(rec.synopsis))
      ? await fetchOpenLibraryFallback(isbn, !cleanText(rec.synopsis))
      : null;
    const cand = toCandidate(isbn, rec, fallback);
    if (cand) out.push(cand);
  }
  return out;
}

/**
 * Fetch an edition record from BrasilAPI. Returns null on 404.
 * @param {string} isbn
 * @returns {Promise<any | null>}
 */
async function fetchBrasilAPI(isbn) {
  const res = await fetch(`${BRASILAPI}/${encodeURIComponent(isbn)}`, {
    headers: { Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (res.status === 429) throw dalibre.error("rateLimited", "BrasilAPI asks to slow down. Try again in a minute.");
  if (res.status >= 500) throw dalibre.error("unavailable", `BrasilAPI answered ${res.status}.`);
  if (!res.ok) throw new Error(`BrasilAPI answered ${res.status} ${res.statusText}`);
  try {
    return await res.json();
  } catch {
    throw dalibre.error("unavailable", "BrasilAPI sent something that isn’t JSON.");
  }
}

/**
 * Look up missing cover image and synopsis in Open Library when CBL leaves them blank.
 * Errors are ignored so official CBL metadata is still returned.
 * @param {string} isbn @param {boolean} needDescription
 * @returns {Promise<{ cover?: string, description?: string } | null>}
 */
async function fetchOpenLibraryFallback(isbn, needDescription) {
  try {
    const res = await fetch(`${OPENLIBRARY}/isbn/${encodeURIComponent(isbn)}.json`, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    const edition = await res.json();
    const coverId = Array.isArray(edition?.covers) ? edition.covers.find((/** @type {number} */ n) => typeof n === "number" && n > 0) : undefined;
    const cover = coverId ? `${OL_COVERS}/b/id/${coverId}-L.jpg` : undefined;
    let description = cleanDescription(edition?.description);

    if (needDescription && !description) {
      const workKey = edition?.works?.[0]?.key;
      if (typeof workKey === "string" && workKey.startsWith("/works/")) {
        const wRes = await fetch(`${OPENLIBRARY}${workKey}.json`, {
          headers: { Accept: "application/json" },
        });
        if (wRes.ok) {
          const work = await wRes.json();
          description = cleanDescription(work?.description);
        }
      }
    }
    return { cover, description };
  } catch {
    return null;
  }
}

/**
 * Discover Brazilian ISBN-13 candidates from Open Library and Google Books when no ISBN was given.
 * @param {string} title @param {string[]} authors
 * @returns {Promise<string[]>}
 */
async function discoverBrazilianISBNs(title, authors) {
  const firstAuthor = authors[0]?.trim() ?? "";
  /** @type {string[]} */
  const found = [];

  try {
    /** @type {Record<string, string>} */
    const params = { title, fields: "title,author_name,isbn", limit: "10" };
    if (firstAuthor) params.author = firstAuthor;
    const res = await fetch(`${OPENLIBRARY}/search.json?${new URLSearchParams(params)}`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      for (const doc of data?.docs ?? []) {
        for (const raw of doc?.isbn ?? []) found.push(String(raw));
      }
    }
  } catch {
    // Fall through to Google Books discovery.
  }

  let ranked = rankBrazilianISBNs(found);
  if (ranked.length > 0) return ranked;

  try {
    const q = firstAuthor ? `${title} ${firstAuthor}` : title;
    const params = new URLSearchParams({
      q,
      langRestrict: "pt",
      printType: "books",
      maxResults: "10",
    });
    const res = await fetch(`${GOOGLEBOOKS}/volumes?${params}`, {
      headers: { Accept: "application/json" },
    });
    if (res.ok) {
      const data = await res.json();
      for (const item of data?.items ?? []) {
        for (const id of item?.volumeInfo?.industryIdentifiers ?? []) {
          if (id?.identifier) found.push(String(id.identifier));
        }
      }
      ranked = rankBrazilianISBNs(found);
    }
  } catch {
    // Best-effort discovery.
  }

  return ranked;
}

/**
 * Convert BrasilAPI ISBN payload (and optional fallback) into a Dalibre Candidate.
 * @param {string} fallbackIsbn @param {any} data @param {{ cover?: string, description?: string } | null} fallback
 * @returns {Dalibre.Candidate | null}
 */
function toCandidate(fallbackIsbn, data, fallback) {
  const id = toISBN13(String(data.isbn || fallbackIsbn)) || fallbackIsbn;
  const title = cleanText(data.title);
  if (!id || !title) return null;

  const authors = Array.isArray(data.authors)
    ? data.authors.map((/** @type {string} */ a) => String(a).trim()).filter(Boolean)
    : [];

  /** @type {Dalibre.Field[]} */
  const fields = [];
  const subtitle = cleanText(data.subtitle);
  if (subtitle) fields.push({ label: "Subtitle", value: subtitle });
  if (typeof data.page_count === "number" && data.page_count > 0) {
    fields.push({ label: "Pages", value: String(data.page_count) });
  }
  const dims = formatDimensions(data.dimensions);
  if (dims) fields.push({ label: "Dimensions", value: dims });
  const fmt = cleanText(data.format);
  if (fmt) fields.push({ label: "Format", value: fmt });
  const loc = cleanText(data.location);
  if (loc) fields.push({ label: "Location", value: loc });
  const src = formatProvider(data.provider);
  if (src) fields.push({ label: "Source", value: src });

  const year = data.year != null ? String(data.year).trim() : "";
  const pubdate = /^\d{4}$/.test(year) ? year : undefined;
  const description = cleanText(data.synopsis) || fallback?.description;
  const cover = validCoverUrl(data.cover_url) ?? fallback?.cover;

  return {
    id,
    title,
    authors,
    description,
    publisher: cleanText(data.publisher),
    language: isLusophoneISBN(id) ? "pt" : undefined,
    pubdate,
    tags: cleanSubjects(data.subjects),
    identifiers: { isbn: id },
    cover,
    fields: fields.slice(0, 12),
  };
}

/** @param {string[]} rawList */
function rankBrazilianISBNs(rawList) {
  const br13 = new Set();
  for (const raw of rawList) {
    const isbn = toISBN13(raw);
    if (isbn && (isbn.startsWith("97865") || isbn.startsWith("97885"))) {
      br13.add(isbn);
    }
  }
  return [...br13];
}

/**
 * Normalize an ISBN-13 or ISBN-10 to an ISBN-13 string when possible.
 * @param {string} raw
 * @returns {string}
 */
function toISBN13(raw) {
  const s = String(raw).replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 13 && /^\d{13}$/.test(s)) return s;
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    const core = `978${s.slice(0, 9)}`;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(core[i]) * (i % 2 ? 3 : 1);
    const check = (10 - (sum % 10)) % 10;
    return core + String(check);
  }
  return "";
}

/** @param {string} isbn13 */
function isLusophoneISBN(isbn13) {
  return (
    isbn13.startsWith("97865") ||
    isbn13.startsWith("97885") ||
    isbn13.startsWith("978972") ||
    isbn13.startsWith("978989")
  );
}

/** @param {string[] | undefined} subjects */
function cleanSubjects(subjects) {
  const seen = new Set();
  for (const entry of subjects ?? []) {
    for (const part of String(entry ?? "").split(";")) {
      const tag = part.trim();
      if (tag && !seen.has(tag)) {
        seen.add(tag);
        if (seen.size >= 10) return [...seen];
      }
    }
  }
  return [...seen];
}

/** @param {any} d */
function formatDimensions(d) {
  if (!d || typeof d.width !== "number" || typeof d.height !== "number") return undefined;
  const unit = d.unit === "CENTIMETER" ? "cm" : String(d.unit ?? "").toLowerCase();
  return unit ? `${d.width} × ${d.height} ${unit}` : `${d.width} × ${d.height}`;
}

/** @param {string | undefined} p */
function formatProvider(p) {
  const s = cleanText(p);
  if (!s) return undefined;
  if (s.toLowerCase() === "cbl") return "CBL (BrasilAPI)";
  return `${s} (BrasilAPI)`;
}

/** @param {unknown} v */
function validCoverUrl(v) {
  if (typeof v !== "string") return undefined;
  const u = v.trim();
  if (!/^https?:\/\/\S+$/i.test(u)) return undefined;
  return u.replace(/^http:\/\//i, "https://");
}

/** @param {any} desc */
function cleanDescription(desc) {
  const text = typeof desc === "string" ? desc : desc?.value ?? "";
  if (!text) return undefined;
  const cleaned = String(text).replace(/\r\n?/g, "\n").replace(/\n\s*-{4,}[\s\S]*$/, "").trim();
  return cleaned || undefined;
}

/** @param {unknown} v */
function cleanText(v) {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\r\n?/g, "\n").trim();
  return s || undefined;
}
