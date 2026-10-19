import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as raw from "multiformats/codecs/raw";

const root = fileURLToPath(new URL("../", import.meta.url));
const paths = JSON.parse(await readFile(join(root, "source-paths.json"), "utf8"));
const files = [];
for (const path of paths) {
  if (typeof path !== "string" || !/^\/[A-Za-z0-9./_-]+$/.test(path) || path.split("/").includes("..")) throw new Error("Invalid source path");
  const source = new URL(path, "https://writerslogic.com").href;
  const response = await fetch(source, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw new Error(`Snapshot failed: ${path} (${response.status})`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_048_576) { await reader.cancel(); throw new Error(`Source exceeds 1 MiB: ${path}`); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = Buffer.concat(chunks);
  if (/-----BEGIN [^-]*PRIVATE KEY-----/.test(data.toString("utf8"))) throw new Error(`Private material rejected: ${path}`);
  if (/\.(json|c2pa)$/.test(path)) JSON.parse(data.toString("utf8"));
  if (response.headers.get("content-type")?.includes("text/html")) throw new Error(`SPA fallback rejected: ${path}`);
  const target = join(root, "public", path.slice(1));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
  files.push({ path, source, bytes, sha256: createHash("sha256").update(data).digest("hex"), cid: CID.createV1(raw.code, await sha256.digest(data)).toString(), contentType: response.headers.get("content-type") });
}
const catalog = {
  version: 1,
  generatedAt: new Date().toISOString(),
  publisher: "did:web:writerslogic.com",
  operator: "https://orcid.org/0009-0003-1849-2963",
  ark: { naan: "56439", policy: "https://writerslogic.com/ark-policy" },
  cidFormat: "CIDv1 raw blocks; computed byte addresses, not evidence of IPFS availability or pinning",
  files,
};
await writeFile(join(root, "public/catalog.json"), JSON.stringify(catalog, null, 2) + "\n");
const rows = files.map((file) => `        <li><a href=".${file.path}">${file.path}</a> · <a href="${file.source}">canonical URL</a></li>`).join("\n");
await writeFile(join(root, "public/index.html"), `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>WritersLogic Public Records</title><style>body{font:1rem/1.65 system-ui,sans-serif;max-width:65rem;margin:2rem auto;padding:0 1rem}a{overflow-wrap:anywhere}li{margin:.5rem 0}</style></head><body><main>
<h1>WritersLogic public records</h1><p>Public copies of identity documents, certificates, schemas, and site metadata. <a href="https://writerslogic.com/.well-known/">Browse the canonical directory</a>.</p>
<p><a href="catalog.json">SHA-256 and content-address catalog</a> · <a href="https://github.com/writerslogic/ipfs-pinning">Source and pinning API</a></p>
<p>Publisher: did:web:writerslogic.com. ARK NAAN: 56439. Operator: <a href="https://orcid.org/0009-0003-1849-2963">David Condrey</a>.</p><ul>
${rows}
</ul></main></body></html>\n`);
await writeFile(join(root, "public/.nojekyll"), "");
console.log(`Snapshotted ${files.length} public files (${files.reduce((n, f) => n + f.bytes, 0)} bytes).`);
