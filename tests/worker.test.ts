import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { handle, MAX_BODY_BYTES } from "../src/index.ts";

const accessToken = "a".repeat(43);
const providerToken = "b".repeat(43);
const env: Env = { PINNING_UPSTREAM: "https://provider.example/api", PINNING_ACCESS_TOKEN: accessToken, PINNING_PROVIDER_TOKEN: providerToken };
const pin = { cid: "bafkreibm6jg3ux5qujxjbnfgbfzj3tjwhr4c5yki6mo7l725rpjopztf5i", name: "Public record" };
const request = (path = "/pins", body?: string, token = accessToken) => new Request(`https://pins.writerslogic.com${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
});

test("unauthorized clients cannot reach the provider", async () => {
  for (const token of ["", "short", "x".repeat(43), "x".repeat(513)]) {
    const response = await handle(request("/pins", JSON.stringify(pin), token), env, async () => { throw new Error("Unauthorized request reached provider"); });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
  }
});

test("no provider configuration fails closed without reporting pins", async () => {
  const result = await handle(request("/pins", JSON.stringify(pin)), { ...env, PINNING_UPSTREAM: "" });
  assert.equal(result.status, 503);
  assert.match(await result.text(), /No pinning provider/);
});

test("a pin request uses the provider credential and preserves the asynchronous response", async () => {
  const response = await handle(request("/pins", JSON.stringify(pin)), env, async (url, options) => {
    assert.equal(String(url), "https://provider.example/api/pins");
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${providerToken}`);
    assert.equal(options?.redirect, "manual");
    assert.equal(new TextDecoder().decode(options?.body as Uint8Array), JSON.stringify(pin));
    return Response.json({ requestid: "request-1", status: "queued", pin }, { status: 202 });
  });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { requestid: "request-1", status: "queued", pin });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("pin body boundaries are enforced even without Content-Length", async () => {
  const original = JSON.stringify(pin);
  for (const bytes of [MAX_BODY_BYTES - 1, MAX_BODY_BYTES, MAX_BODY_BYTES + 1]) {
    let called = false;
    const response = await handle(request("/pins", original + " ".repeat(bytes - original.length)), env, async () => {
      called = true;
      return Response.json({ requestid: "request-1", status: "queued", pin }, { status: 202 });
    });
    assert.equal(response.status, bytes > MAX_BODY_BYTES ? 413 : 202);
    assert.equal(called, bytes <= MAX_BODY_BYTES);
  }
});

test("malformed CIDs, JSON, and pin fields do not reach the provider", async () => {
  const invalid = ["not-json", "null", "[]", JSON.stringify({ cid: "not-a-cid" }), JSON.stringify({ ...pin, origins: [42] }), JSON.stringify({ ...pin, meta: { token: {} } })];
  for (const body of invalid) {
    const result = await handle(request("/pins", body), env, async () => { throw new Error("Invalid request reached provider"); });
    assert.equal(result.status, 400);
  }
});

test("pin status, replacement, deletion and list filters retain standard methods", async () => {
  for (const [method, path] of [["GET", "/pins?status=pinned&limit=10"], ["GET", "/pins/request-1"], ["POST", "/pins/request-1"], ["DELETE", "/pins/request-1"]]) {
    const req = new Request(`https://pins.writerslogic.com${path}`, { method, headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }, ...(method === "POST" ? { body: JSON.stringify(pin) } : {}) });
    const result = await handle(req, env, async (url, options) => {
      assert.equal(String(url), `https://provider.example/api${path}`);
      assert.equal(options?.method, method);
      return method === "DELETE" ? new Response(null, { status: 204 }) : Response.json({ requestid: "request-1", status: "pinned", pin });
    });
    assert.equal(result.status, method === "DELETE" ? 204 : 200);
  }
});

test("provider redirects and authentication failures do not leak credentials", async () => {
  for (const status of [302, 401, 403, 500]) {
    const result = await handle(request(), env, async () => new Response(providerToken, { status, headers: { Location: "https://other.example/", "Content-Type": "application/json" } }));
    assert.equal(result.status, 502);
    assert.ok(!(await result.text()).includes(providerToken));
    assert.equal(result.headers.get("location"), null);
  }
});

test("unsafe upstream configuration and unrelated endpoints cannot proxy requests", async () => {
  for (const url of ["http://provider.example", "https://user:password@provider.example", "https://provider.example?token=secret", "not-a-url"]) {
    assert.equal((await handle(request(), { ...env, PINNING_UPSTREAM: url })).status, 503);
  }
  for (const path of ["/api/v0/pin/add", "/pins/a/b", "/pins/%2Fother"]) assert.equal((await handle(request(path), env)).status, 404);
});

test("browser integrations allow only the two WritersLogic application origins", async () => {
  for (const origin of ["https://writerslogic.com", "https://writersproof.com", "https://other.example"]) {
    const response = await worker.fetch(new Request("https://pins.writerslogic.com/pins", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type" } }), env);
    assert.equal(response.status, origin === "https://other.example" ? 403 : 204);
    assert.equal(response.headers.get("access-control-allow-origin"), origin === "https://other.example" ? null : origin);
  }
});
