import assert from "node:assert/strict";

globalThis.dalibre = {
  settings: { searchByTitle: "true", fallbackCover: "true" },
  error(kind, message) {
    const err = new Error(message || kind);
    err.kind = kind;
    return err;
  },
};

const { identify } = await import("./main.js");
assert.equal(typeof identify, "function", "main.js must export identify()");

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// 1. Direct ISBN-13 with CBL metadata + semicolon-split deduplicated tags + Open Library fallback cover
{
  globalThis.dalibre.settings = { searchByTitle: "true", fallbackCover: "true" };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://brasilapi.com.br/api/isbn/v1/9788535914849") {
      return jsonResponse({
        isbn: "9788535914849",
        title: "1984",
        subtitle: "Edição especial",
        authors: ["George Orwell", "Alexandre Hubner"],
        publisher: "Companhia das Letras",
        synopsis: "Distopia clássica.\n",
        dimensions: { width: 13, height: 21, unit: "CENTIMETER" },
        year: 2009,
        format: "PHYSICAL",
        page_count: 416,
        subjects: ["Literatura; Ficção", "Literatura", "Distopia"],
        location: "São Paulo, SP",
        cover_url: null,
        provider: "cbl",
      });
    }
    if (u === "https://openlibrary.org/isbn/9788535914849.json") {
      return jsonResponse({
        key: "/books/OL26449397M",
        covers: [8172473],
        works: [{ key: "/works/OL1168083W" }],
      });
    }
    throw new Error(`Unexpected URL in test 1: ${u}`);
  };

  const out = await identify({
    title: "",
    authors: [],
    identifiers: { isbn: "978-85-359-1484-9" },
  });
  assert.equal(out.length, 1);
  const c = out[0];
  assert.equal(c.id, "9788535914849");
  assert.equal(c.title, "1984");
  assert.deepEqual(c.authors, ["George Orwell", "Alexandre Hubner"]);
  assert.equal(c.publisher, "Companhia das Letras");
  assert.equal(c.description, "Distopia clássica.");
  assert.equal(c.pubdate, "2009");
  assert.equal(c.language, "pt");
  assert.deepEqual(c.tags, ["Literatura", "Ficção", "Distopia"]);
  assert.equal(c.cover, "https://covers.openlibrary.org/b/id/8172473-L.jpg");
  assert.deepEqual(c.identifiers, { isbn: "9788535914849" });
  assert.ok(c.fields.some((f) => f.label === "Subtitle" && f.value === "Edição especial"));
  assert.ok(c.fields.some((f) => f.label === "Pages" && f.value === "416"));
  assert.ok(c.fields.some((f) => f.label === "Dimensions" && f.value.includes("13 × 21 cm")));
  assert.ok(c.fields.some((f) => f.label === "Format" && f.value === "PHYSICAL"));
  assert.ok(c.fields.some((f) => f.label === "Location" && f.value === "São Paulo, SP"));
  assert.ok(c.fields.some((f) => f.label === "Source" && f.value.includes("CBL")));
}

// 2. ISBN-10 conversion to ISBN-13 + Open Library work synopsis fallback when BrasilAPI synopsis is null
{
  const called = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    called.push(u);
    if (u === "https://brasilapi.com.br/api/isbn/v1/9786580309313") {
      return jsonResponse({
        isbn: "9786580309313",
        title: "Torto arado",
        subtitle: null,
        authors: ["Itamar Vieira Junior"],
        publisher: "Todavia Editora",
        synopsis: null,
        dimensions: null,
        year: 2019,
        format: "PHYSICAL",
        page_count: 264,
        subjects: ["Literatura brasileira"],
        location: "São Paulo, SP",
        cover_url: null,
        provider: "cbl",
      });
    }
    if (u === "https://openlibrary.org/isbn/9786580309313.json") {
      return jsonResponse({
        key: "/books/OL35663926M",
        covers: [12369648],
        works: [{ key: "/works/OL24141556W" }],
      });
    }
    if (u === "https://openlibrary.org/works/OL24141556W.json") {
      return jsonResponse({
        key: "/works/OL24141556W",
        description: "Nas profundezas do sertão baiano.",
      });
    }
    throw new Error(`Unexpected URL in test 2: ${u}`);
  };

  const out = await identify({
    title: "",
    authors: [],
    identifiers: { isbn: "6580309318" },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].identifiers.isbn, "9786580309313");
  assert.equal(out[0].description, "Nas profundezas do sertão baiano.");
  assert.equal(out[0].cover, "https://covers.openlibrary.org/b/id/12369648-L.jpg");
  assert.ok(called.includes("https://brasilapi.com.br/api/isbn/v1/9786580309313"));
}

// 3. Direct cover_url from BrasilAPI (upgrading http:// -> https://) skips fallback cover fetch
{
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://brasilapi.com.br/api/isbn/v1/9786555871784") {
      return jsonResponse({
        isbn: "9786555871784",
        title: "Tudo é rio",
        authors: ["Carla Madeira"],
        publisher: "Editora Record",
        synopsis: "Romance brasileiro.",
        cover_url: "http://s3.amazonaws.com/example/cover.jpg",
        provider: "cbl",
      });
    }
    throw new Error(`Should not fetch fallback when cover_url & synopsis exist: ${u}`);
  };

  const [c] = await identify({ title: "", authors: [], identifiers: { isbn: "9786555871784" } });
  assert.equal(c.cover, "https://s3.amazonaws.com/example/cover.jpg");
}

// 4. Title + Author ISBN discovery (Open Library -> BrasilAPI CBL, plus Google Books fallback)
{
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://openlibrary.org/search.json?")) {
      return jsonResponse({
        docs: [
          {
            title: "Torto Arado",
            author_name: ["Itamar Vieira Junior"],
            isbn: ["9781839766428", "6580309318", "9786580309313"],
          },
        ],
      });
    }
    if (u === "https://brasilapi.com.br/api/isbn/v1/9786580309313") {
      return jsonResponse({
        isbn: "9786580309313",
        title: "Torto arado",
        authors: ["Itamar Vieira Junior"],
        publisher: "Todavia Editora",
        synopsis: "Vencedor do Prêmio Jabuti.",
        year: 2019,
        cover_url: "https://covers.example.com/torto.jpg",
        provider: "cbl",
      });
    }
    throw new Error(`Unexpected URL in test 4: ${u}`);
  };

  const out = await identify({ title: "Torto arado", authors: ["Itamar Vieira Junior"], identifiers: {} });
  assert.equal(out.length, 1);
  assert.equal(out[0].identifiers.isbn, "9786580309313");
  assert.equal(out[0].publisher, "Todavia Editora");

  // Google Books fallback when Open Library returns no BR ISBNs
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith("https://openlibrary.org/search.json?")) return jsonResponse({ docs: [] });
    if (u.startsWith("https://www.googleapis.com/books/v1/volumes?")) {
      return jsonResponse({
        items: [
          {
            volumeInfo: {
              title: "Tudo é rio",
              authors: ["Carla Madeira"],
              industryIdentifiers: [{ type: "ISBN_13", identifier: "9786555871784" }],
            },
          },
        ],
      });
    }
    if (u === "https://brasilapi.com.br/api/isbn/v1/9786555871784") {
      return jsonResponse({
        isbn: "9786555871784",
        title: "Tudo é rio",
        authors: ["Carla Madeira"],
        publisher: "Editora Record",
        synopsis: "Sinopse.",
        cover_url: "https://covers.example.com/tudo.jpg",
        provider: "cbl",
      });
    }
    throw new Error(`Unexpected URL in Google fallback test: ${u}`);
  };
  const gbOut = await identify({ title: "Tudo é rio", authors: ["Carla Madeira"], identifiers: {} });
  assert.equal(gbOut.length, 1);
  assert.equal(gbOut[0].identifiers.isbn, "9786555871784");

  // Open Library free-text (?q=) fallback when ?title= finds only an editionless translated work
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin === "https://openlibrary.org" && u.pathname === "/search.json") {
      if (u.searchParams.has("title")) {
        return jsonResponse({ docs: [{ key: "/works/OL44197921W", title: "Condição artificial" }] });
      }
      if (u.searchParams.get("q") === "Condição Artificial Martha Wells") {
        return jsonResponse({
          docs: [{ key: "/works/OL19747311W", title: "Artificial Condition", isbn: ["9788576577263", "9781250186935"] }],
        });
      }
    }
    if (u.href === "https://brasilapi.com.br/api/isbn/v1/9788576577263") {
      return jsonResponse({
        isbn: "9788576577263",
        title: "Condição artificial",
        authors: ["Martha Wells", "Laura Pohl"],
        publisher: "Editora Aleph",
        synopsis: "Continuação de Alerta Vermelho.",
        cover_url: "https://covers.openlibrary.org/b/id/15129488-L.jpg",
        provider: "cbl",
      });
    }
    throw new Error(`Unexpected URL in OL free-text test: ${u.href}`);
  };
  const olQOut = await identify({ title: "Condição Artificial", authors: ["Martha Wells"], identifiers: {} });
  assert.equal(olQOut.length, 1);
  assert.equal(olQOut[0].identifiers.isbn, "9788576577263");
  assert.equal(olQOut[0].publisher, "Editora Aleph");

  // Search-box combined query ("Condição Artificial Martha Wells", empty authors)
  globalThis.fetch = async (url) => {
    const u = new URL(String(url));
    if (u.origin === "https://openlibrary.org" && u.pathname === "/search.json") {
      if (u.searchParams.has("title")) return jsonResponse({ docs: [] });
      if (u.searchParams.get("q") === "Condição Artificial Martha Wells") {
        return jsonResponse({
          docs: [{ key: "/works/OL19747311W", title: "Artificial Condition", isbn: ["9788576577263"] }],
        });
      }
    }
    if (u.href === "https://brasilapi.com.br/api/isbn/v1/9788576577263") {
      return jsonResponse({
        isbn: "9788576577263",
        title: "Condição artificial",
        authors: ["Martha Wells"],
        publisher: "Editora Aleph",
        synopsis: "Sinopse.",
        cover_url: "https://covers.example.com/cond.jpg",
        provider: "cbl",
      });
    }
    throw new Error(`Unexpected URL in search-box test: ${u.href}`);
  };
  const boxOut = await identify({ title: "Condição Artificial Martha Wells", authors: [], identifiers: {} });
  assert.equal(boxOut.length, 1);
  assert.equal(boxOut[0].identifiers.isbn, "9788576577263");
}

// 5. Settings (searchByTitle: false, fallbackCover: false), 404 -> [], and 429 -> rateLimited
{
  globalThis.dalibre.settings = { searchByTitle: "false", fallbackCover: "false" };
  globalThis.fetch = async () => {
    throw new Error("Should not fetch when searchByTitle=false and no ISBN");
  };
  assert.deepEqual(await identify({ title: "Torto arado", authors: [], identifiers: {} }), []);

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === "https://brasilapi.com.br/api/isbn/v1/9788535914849") {
      return jsonResponse({ isbn: "9788535914849", title: "1984", cover_url: null, synopsis: null, provider: "cbl" });
    }
    throw new Error(`Unexpected fallback fetch when fallbackCover=false: ${u}`);
  };
  const noCover = await identify({ title: "", authors: [], identifiers: { isbn: "9788535914849" } });
  assert.equal(noCover[0].cover, undefined);

  globalThis.fetch = async () => jsonResponse({}, 404);
  assert.deepEqual(await identify({ title: "", authors: [], identifiers: { isbn: "9780000000000" } }), []);

  globalThis.fetch = async () => jsonResponse({}, 429);
  await assert.rejects(
    () => identify({ title: "", authors: [], identifiers: { isbn: "9788535914849" } }),
    (err) => err?.kind === "rateLimited",
  );
}

console.log("dalibre-isbn-brasil unit tests passed!");
