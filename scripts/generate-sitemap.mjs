// Writes ./sitemap.xml at the site root (wrangler.toml serves the repo root, so this is /sitemap.xml).
// Run: node scripts/generate-sitemap.mjs   (the .githooks/pre-commit hook runs it on every commit)
// SITE_URL overrides the origin.
import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The app is a single page. offline.html, tests/ and verification files are not for crawlers.
// ponytail: hand-listed pages, add a path here when a new public page ships.
const PAGES = ["/"]

const site = (process.env.SITE_URL || "https://millionscope.com").replace(/\/$/, "")
const lastmod = new Date().toLocaleDateString("sv-SE") // local YYYY-MM-DD; day granularity: one diff per day, not per commit

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...PAGES.map((p) => `  <url>\n    <loc>${site}${p}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`),
  "</urlset>",
  "",
].join("\n")

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "sitemap.xml")
await fs.writeFile(out, xml, "utf8")
console.log("Wrote", path.relative(process.cwd(), out) || out)
