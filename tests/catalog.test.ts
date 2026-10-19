import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CID } from "multiformats/cid";

test("every archived record matches its SHA-256 and raw-block CID", async () => {
  const catalog = JSON.parse(await readFile(new URL("../public/catalog.json", import.meta.url), "utf8"));
  assert.ok(catalog.files.length > 30);
  for (const record of catalog.files) {
    assert.ok(!record.path.split("/").includes(".."));
    const bytes = await readFile(new URL(`../public${record.path}`, import.meta.url));
    const hash = createHash("sha256").update(bytes).digest();
    assert.equal(hash.toString("hex"), record.sha256);
    assert.equal(bytes.length, record.bytes);
    assert.deepEqual(Buffer.from(CID.parse(record.cid).multihash.digest), hash);
    assert.ok(!/-----BEGIN [^-]*PRIVATE KEY-----/.test(bytes.toString("utf8")));
  }
});
