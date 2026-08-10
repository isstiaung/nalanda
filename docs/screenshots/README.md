# Screenshots

Everything here was captured from **seeded demo data**, never from a real household
catalogue — no private notes, borrowers, or account details appear in any of them. To
regenerate:

```sh
npx wrangler d1 migrations apply nalanda --local --persist-to .wrangler/demo-state
npm run dev:demo    # terminal 1 — :8788, its own state directory
npm run seed:demo   # terminal 2 — twenty items, one loan, one published share
```

The demo instance is fully separate from `npm run dev`: a different port and a different
`--persist-to` directory, so seeding can't touch your own local database.

Shots are 1280px wide, light mode except `shelf-dark.png`. Headless browsers inherit the
system appearance, so capturing light mode on a dark-themed machine means neutralising the
`@media (prefers-color-scheme: dark)` block in `public/app.css` before the screenshot.

The cover art visible in these images was fetched by the app from Open Library, Google
Books, and Discogs at seed time. It remains the property of the respective publishers and
rights holders, and appears here only to show the software working.
