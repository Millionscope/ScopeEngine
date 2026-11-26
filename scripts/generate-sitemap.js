import fs from "fs/promises"
import path from "path"

const cwd = process.cwd()
const distDir = path.join(cwd, "dist")

async function fileExists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

async function gatherHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      const sub = await gatherHtmlFiles(full)
      files.push(...sub)
    } else if (e.isFile() && e.name.endsWith(".html")) {
      files.push(full)
    }
  }
  return files
}

async function writeSitemap(files, baseDir, siteUrl, outDir) {
  const urls = []
  for (const file of files) {
    let rel = path.relative(baseDir, file).replace(/\\/g, "/")
    if (rel === "index.html") rel = "/"
    else {
      // strip trailing index.html
      rel = "/" + rel.replace(/index\.html$/, "")
      if (rel.endsWith(".html")) rel = rel.replace(/\.html$/, "")
    }
    if (!rel.startsWith("/")) rel = "/" + rel
    if (rel !== "/" && rel.endsWith("/")) rel = rel.replace(/\/+$/, "/")
    const stat = await fs.stat(file)
    const lastmod = stat.mtime.toISOString()
    const loc = siteUrl.replace(/\/$/, "") + (rel === "/" ? "/" : rel)
    urls.push({ loc, lastmod })
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls.map((u) => `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.lastmod}</lastmod>\n  </url>`),
    "</urlset>",
  ].join("\n")

  const outPath = path.join(outDir, "sitemap.xml")
  await fs.writeFile(outPath, xml, "utf8")
  console.log("Wrote sitemap to", outPath)
}

async function main() {
  const pkgPath = path.join(cwd, "package.json")
  let pkg = {}
  try {
    pkg = JSON.parse(await fs.readFile(pkgPath, "utf8"))
  } catch {}

  const siteUrl = process.env.SITE_URL || pkg.homepage || "https://millionscope.com"

  if (!(await fileExists(distDir))) {
    console.error("dist directory not found. Run after `vite build`.")
    // fallback to public
    const publicDir = path.join(cwd, "public")
    if (!(await fileExists(publicDir))) {
      process.exit(1)
    }
    const files = await gatherHtmlFiles(publicDir)
    if (files.length === 0) {
      console.error("No HTML files found in public/")
      process.exit(1)
    }
    await writeSitemap(files, publicDir, siteUrl, publicDir)
    return
  }

  const files = await gatherHtmlFiles(distDir)
  if (files.length === 0) {
    console.error("No HTML files in dist/ to include in sitemap")
    process.exit(1)
  }
  await writeSitemap(files, distDir, siteUrl, distDir)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
