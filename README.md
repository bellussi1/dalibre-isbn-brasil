# ISBN Brasil for Dalibre

A metadata source plugin for [Dalibre](https://github.com/djyde/dalibre) that fetches official Brazilian book metadata (`978-65` and `978-85` prefixes from Câmara Brasileira do Livro / Mercado Editorial) via [BrasilAPI](https://brasilapi.com.br/docs#tag/ISBN).

Plugin de metadados para o Dalibre focado em edições brasileiras (CBL / Mercado Editorial via BrasilAPI), com suporte opcional a descoberta de ISBN por título/autor e fallback de capa e sinopse via Open Library.

## Features

- Looks up Brazilian editions directly by ISBN-13 or ISBN-10 (`978-65`, `978-85`, automatically converting ISBN-10 to ISBN-13).
- Returns title, authors, publisher, publication year, subjects/tags, synopsis, dimensions, format (`PHYSICAL` / `DIGITAL`), page count, city, and Portuguese language (`pt`).
- When an edition has no `isbn` yet, optionally searches Open Library and Google Books (`langRestrict=pt`) for matching `978-65` / `978-85` ISBNs and fetches the official CBL record from BrasilAPI.
- Falls back to Open Library when CBL returns an empty `cover_url` or `synopsis`.

## Installation

### From Dalibre

Requires Dalibre **0.6.0+** (for `permissions.covers: "any"`). Open **Plugins › Install from GitHub** and enter:

```text
bellussi1/dalibre-isbn-brasil
```

### Settings

- **Search by title and author when ISBN is missing** (`searchByTitle`, default `true`)
- **Look up missing covers and synopses in Open Library** (`fallbackCover`, default `true`)

## Development

```sh
node test.mjs
dalibre-plugin check .
dalibre-plugin identify . --isbn 9788535914849 --json
dalibre-plugin identify . --isbn 9786555871784 --json
dalibre-plugin identify . "Torto arado" --author "Itamar Vieira Junior" --json
```

## License

MIT
