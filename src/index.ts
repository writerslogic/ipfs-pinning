import { timingSafeEqual } from "node:crypto";
import { CID } from "multiformats/cid";

export const MAX_BODY_BYTES = 65_536;
const encoder = new TextEncoder();
const json = (value: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(value, { status, headers: {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  } });
const error = (status: number, reason: string, details: string, headers: HeadersInit = {}) =>
  json({ error: { reason, details } }, status, headers);

async function authorized(header: string | null, secret: string) {
  const match = /^Bearer ([A-Za-z0-9._~+\/-]{32,512}={0,2})$/i.exec(header ?? "");
  if (!match) return false;
  const [provided, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  return timingSafeEqual(new Uint8Array(provided), new Uint8Array(expected));
}

async function boundedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

function validPin(body: Uint8Array) {
  try {
    const pin = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!pin || typeof pin !== "object" || Array.isArray(pin) || typeof pin.cid !== "string" || pin.cid.length > 256) return false;
    CID.parse(pin.cid);
    if (pin.name !== undefined && (typeof pin.name !== "string" || pin.name.length > 255)) return false;
    if (pin.origins !== undefined && (!Array.isArray(pin.origins) || pin.origins.length > 20 || pin.origins.some((origin: unknown) => typeof origin !== "string" || origin.length > 1024 || !origin.startsWith("/")))) return false;
    if (pin.meta !== undefined && (!pin.meta || typeof pin.meta !== "object" || Array.isArray(pin.meta) || Object.keys(pin.meta).length > 50 || Object.entries(pin.meta).some(([key, value]) => key.length > 255 || typeof value !== "string" || value.length > 255))) return false;
    return true;
  } catch { return false; }
}

export async function handle(request: Request, env: Env, upstreamFetch: typeof fetch = fetch) {
  const url = new URL(request.url);
  if (url.pathname === "/" && request.method === "GET") return json({
    name: "WritersLogic IPFS Pinning API",
    controller: "did:web:writerslogic.com",
    records: "https://github.com/writerslogic/ipfs-pinning",
    discovery: "https://writerslogic.com/.well-known/",
    arkPolicy: "https://writerslogic.com/ark-policy",
    naan: "56439",
    operator: "https://orcid.org/0009-0003-1849-2963",
    configured: Boolean(env.PINNING_UPSTREAM && env.PINNING_PROVIDER_TOKEN && env.PINNING_ACCESS_TOKEN),
  });
  const collection = url.pathname === "/pins";
  if (!collection && !/^\/pins\/[A-Za-z0-9_-]{1,255}$/.test(url.pathname)) return error(404, "NOT_FOUND", "Unknown endpoint.");
  if (!env.PINNING_ACCESS_TOKEN || env.PINNING_ACCESS_TOKEN.length < 32) return error(503, "SERVICE_UNAVAILABLE", "Pinning is not configured.");
  if (!await authorized(request.headers.get("authorization"), env.PINNING_ACCESS_TOKEN)) return error(401, "UNAUTHORIZED", "A valid Bearer access token is required.", { "WWW-Authenticate": "Bearer" });
  const methods = collection ? ["GET", "POST"] : ["GET", "POST", "DELETE"];
  if (!methods.includes(request.method)) return error(405, "METHOD_NOT_ALLOWED", "Unsupported method.", { Allow: methods.join(", ") });
  if (!env.PINNING_UPSTREAM || !env.PINNING_PROVIDER_TOKEN) return error(503, "SERVICE_UNAVAILABLE", "No pinning provider is connected.");
  let target: URL;
  try {
    const base = new URL(env.PINNING_UPSTREAM);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Invalid upstream");
    target = new URL(`${base.pathname.replace(/\/$/, "")}${url.pathname}${url.search}`, base.origin);
  } catch { return error(503, "SERVICE_UNAVAILABLE", "Invalid pinning provider configuration."); }
  let body: Uint8Array<ArrayBuffer> | undefined;
  if (request.method === "POST") {
    if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) return error(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json.");
    let value: Uint8Array<ArrayBuffer> | null;
    try { value = await boundedBody(request); }
    catch { return error(400, "BAD_REQUEST", "The request body could not be read."); }
    if (value === null) return error(413, "PAYLOAD_TOO_LARGE", "Pin requests must not exceed 65536 bytes.");
    if (!validPin(value)) return error(400, "BAD_REQUEST", "Provide a valid CID and pin metadata.");
    body = value;
  }
  try {
    const upstream = await upstreamFetch(target, {
      method: request.method,
      headers: { Authorization: `Bearer ${env.PINNING_PROVIDER_TOKEN}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel();
      return error(502, "BAD_GATEWAY", "The pinning provider returned an unexpected redirect.");
    }
    if (upstream.status === 401 || upstream.status === 403 || upstream.status >= 500) {
      await upstream.body?.cancel();
      return error(502, "BAD_GATEWAY", "The pinning provider could not complete the request.");
    }
    if (upstream.status !== 204 && !upstream.headers.get("content-type")?.includes("application/json")) {
      await upstream.body?.cancel();
      return error(502, "BAD_GATEWAY", "The pinning provider returned an unexpected response.");
    }
    return new Response(upstream.body, { status: upstream.status, headers: {
      "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
      ...(upstream.headers.has("retry-after") ? { "Retry-After": upstream.headers.get("retry-after")! } : {}),
    } });
  } catch { return error(502, "BAD_GATEWAY", "The pinning provider is unavailable."); }
}

export default {
  async fetch(request: Request, env: Env) {
    const origin = request.headers.get("origin");
    const allowed = origin === "https://writerslogic.com" || origin === "https://writersproof.com";
    let response: Response;
    if (request.method === "OPTIONS") {
      const headers = (request.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map((header) => header.trim()).filter(Boolean);
      const method = request.headers.get("access-control-request-method") ?? "";
      response = allowed && ["GET", "POST", "DELETE"].includes(method) && headers.every((header) => ["authorization", "content-type"].includes(header))
        ? new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, POST, DELETE", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Max-Age": "600" } })
        : error(403, "FORBIDDEN", "This browser origin or method is not allowed.");
    } else {
      response = await handle(request, env);
    }
    response.headers.set("Vary", "Origin");
    if (allowed) response.headers.set("Access-Control-Allow-Origin", origin!);
    return response;
  },
};
