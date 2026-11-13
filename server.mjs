import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, loadEnv } from "./src/env.mjs";
import { createPixService, parsePayload } from "./src/pix.mjs";
import { createPartner } from "./src/partner.mjs";
import { createStore } from "./src/store.mjs";
import { vizzionConfigured } from "./src/vizzion.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(root, ".env"));

const publicDir = path.join(root, "public");
const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4173);
const store = createStore(dataDir(root));
const partner = createPartner(dataDir(root));
const sessions = new Map();
const loginAttempts = new Map();

const FN = {
  home: "7381fafd58e93c75197fdc9a463fcb4f3fdaa93d113786a7ccac32eddd3d5dea",
  unusedGet: "843805a7394b8d93e5c8e4e4200c73b3098157030e7e69db9b2b044a599d8c7c",
  slug: "c4f229f13d75ea72f2966a86c15c9c3e5ac6be3b24117957861dfda2b52d0db3",
  pixCreate: "e58311c6fbb4baf522f0b45a7ba243559db1c5f222cadd233633b8a7442cfa59",
  pixStatus: "e323b89dfe50b48098cd2430fe7639b0273f98dba91ec51736f31b75bf49c2a2",
  partnerLogin: "81ea9d9181cd9212af226609ff373301484dcce3d7461649990bf379cba24f39",
  partnerSession: "dacfd1919a603b8049546aed3702041cd20dcbe8c4a38370c087dbb8935e11dc",
  partnerUpdate: "b63ef4c925a59aced0080df0c6cb283e717bc141b275c56e426ada517a7c3c3c",
};

const PAGES = new Map([
  ["/", "index.html"],
  ["/admin", "admin.html"],
  ["/admin2", "admin2.html"],
  ["/admito-aura", "admin.html"],
  ["/doxsc-maximo", "doxsc-maximo.html"],
  ["/paineladmin2", "paineladmin2.html"],
  ["/lunaharts", "lunaharts.html"],
]);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function extractState(html) {
  const start = html.indexOf("$_TSR.router=");
  const call = html.indexOf(')($R["tsr"])', start);
  if (start < 0 || call < 0) return null;
  const expr = html.slice(start + "$_TSR.router=".length, call + ')($R["tsr"])'.length);
  const $R = { tsr: [] };
  return eval(expr);
}

function loaderData(file) {
  const html = fs.readFileSync(path.join(publicDir, file), "utf8");
  const state = extractState(html);
  const match = state?.matches?.find((entry) => entry && entry.l);
  if (!match) throw new Error(`No loader data in ${file}`);
  return structuredClone(match.l);
}

const homeConfig = loaderData("index.html");
const lunahartsConfig = loaderData("lunaharts.html");
const slugShell = fs.readFileSync(path.join(publicDir, "slug-fallback.html"));

function publicBaseUrl(requestHost) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL;
  if (process.env.RENDER_EXTERNAL_URL) return process.env.RENDER_EXTERNAL_URL;
  return `http://${requestHost || `127.0.0.1:${PORT}`}`;
}

const pix = createPixService({
  store,
  homeConfig,
  publicBaseUrl: () => publicBaseUrl(),
});

function configForSlug(slug) {
  const clean = String(slug || "").replace(/^@+/, "").toLowerCase();
  if (clean === "lunaharts") return structuredClone(lunahartsConfig);
  const fallback = structuredClone(homeConfig);
  fallback.found = false;
  return fallback;
}

function send(res, status, body, type, extraHeaders = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    "content-type": type,
    "content-length": payload.length,
    "cache-control": "no-cache",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  res.end(payload);
}

function sendJson(res, status, value, extraHeaders) {
  send(res, status, JSON.stringify(value), "application/json; charset=utf-8", extraHeaders);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  return String(req.socket.remoteAddress || "local");
}

function adminSession(req) {
  const token = cookies(req).hl_session;
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return session;
}

function requireAdmin(req, res) {
  if (adminSession(req)) return true;
  sendJson(res, 401, { ok: false, message: "Faça login no painel." });
  return false;
}

function maskedPublicKey() {
  const key = process.env.VIZZION_PUBLIC_KEY || "";
  if (key.length < 12) return key ? "configurada" : "";
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

async function handleAdmin(req, res, pathname) {
  if (pathname === "/api/admin/login" && req.method === "POST") {
    const ip = clientIp(req);
    const attempt = loginAttempts.get(ip) || { count: 0, reset: Date.now() + 10 * 60 * 1000 };
    if (Date.now() > attempt.reset) {
      attempt.count = 0;
      attempt.reset = Date.now() + 10 * 60 * 1000;
    }
    if (attempt.count > 8) {
      sendJson(res, 429, { ok: false, message: "Muitas tentativas. Espere alguns minutos." });
      return;
    }
    const body = JSON.parse((await readBody(req)) || "{}");
    const expected = process.env.ADMIN_PASSWORD || "";
    if (!expected || !safeEqual(body.password || "", expected)) {
      attempt.count += 1;
      loginAttempts.set(ip, attempt);
      sendJson(res, 401, { ok: false, message: "Senha incorreta." });
      return;
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, { expires: Date.now() + 12 * 60 * 60 * 1000 });
    sendJson(res, 200, { ok: true }, {
      "set-cookie": `hl_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`,
    });
    return;
  }
  if (pathname === "/api/admin/logout" && req.method === "POST") {
    sessions.delete(cookies(req).hl_session);
    sendJson(res, 200, { ok: true }, { "set-cookie": "hl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0" });
    return;
  }
  if (!requireAdmin(req, res)) return;
  if (pathname === "/api/admin/summary") {
    sendJson(res, 200, {
      ok: true,
      ...store.summary(),
      gatewayConfigured: vizzionConfigured(),
      publicKey: maskedPublicKey(),
    });
    return;
  }
  if (pathname === "/api/admin/transactions") {
    sendJson(res, 200, { ok: true, transactions: store.list().slice(0, 200) });
    return;
  }
  sendJson(res, 404, { ok: false, message: "Rota não encontrada." });
}

async function handlePixApi(req, res, pathname, search) {
  if (pathname === "/api/v1/pix/webhook" && req.method === "POST") {
    const raw = await readBody(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch { body = {}; }
    const result = pix.applyWebhook(body);
    sendJson(res, result.status, { ok: result.ok });
    return;
  }
  const apiKey = req.headers["x-api-key"] || "";
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const clientId = req.headers.ci || req.headers["x-client-id"] || req.headers["x-public-key"] || "";
  const clientSecret = req.headers.cs || req.headers["x-client-secret"] || req.headers["x-secret-key"] || bearer || "";
  const expected = process.env.HOTLUNA_API_KEY || "";
  const byApiKey = (expected && (safeEqual(apiKey, expected) || safeEqual(bearer, expected)))
    || partner.secretMatches(apiKey)
    || partner.secretMatches(bearer);
  const byClient = partner.credentialsMatch(String(clientId), String(clientSecret));
  if (!byApiKey && !byClient) {
    sendJson(res, 401, { ok: false, message: "Chave da API Hotluna inválida." });
    return;
  }
  if (pathname === "/api/v1/pix/create" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await pix.issue(body, { catalogOnly: false });
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  if (pathname === "/api/v1/pix/status" && req.method === "GET") {
    const id = new URLSearchParams(search).get("transactionId") || "";
    const result = await pix.status(id, { refresh: true });
    sendJson(res, result.ok ? 200 : 404, result);
    return;
  }
  sendJson(res, 404, { ok: false, message: "Rota não encontrada." });
}

function safeStatic(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch { return null; }
  if (!(decoded.startsWith("/assets/") || decoded.startsWith("/media/"))) return null;
  const full = path.resolve(publicDir, `.${decoded}`);
  if (full !== publicDir && !full.startsWith(publicDir + path.sep)) return null;
  return full;
}

function pageFor(pathname) {
  const normalized = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (PAGES.has(normalized)) return fs.readFileSync(path.join(publicDir, PAGES.get(normalized)));
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 1 && /^[A-Za-z0-9._-]{1,80}$/.test(parts[0])) {
    return Buffer.from(slugShell.toString("utf8").replaceAll("robots.txt", parts[0]), "utf8");
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = new URL(req.url || "/", `http://${host}`);
  const pathname = url.pathname;
  try {
    if (pathname === "/api/health") {
      sendJson(res, 200, { ok: true, pix: vizzionConfigured() });
      return;
    }
    if (pathname.startsWith("/api/admin/")) {
      await handleAdmin(req, res, pathname);
      return;
    }
    if (pathname.startsWith("/api/v1/pix/")) {
      await handlePixApi(req, res, pathname, url.search);
      return;
    }
    if (pathname.startsWith("/_serverFn/")) {
      const rawBody = await readBody(req);
      const id = pathname.slice("/_serverFn/".length).split("/")[0];
      const fields = parsePayload(rawBody, url.href);
      let value;
      if (id === FN.home) value = structuredClone(homeConfig);
      else if (id === FN.slug) value = configForSlug(fields.slug || "");
      else if (id === FN.pixCreate) value = await pix.issue(fields, { catalogOnly: true });
      else if (id === FN.pixStatus) value = await pix.status(fields.transactionId || "", { refresh: true });
      else if (id === FN.partnerLogin) value = partner.login(fields);
      else if (id === FN.partnerSession) value = partner.session(fields.email, fields.password) || { ok: false, message: "Sessão expirada. Entre de novo." };
      else if (id === FN.partnerUpdate) value = partner.update(fields);
      else if (id === FN.unusedGet) value = {};
      else value = { ok: false, message: "Esta ação do painel antigo não faz parte desta cópia. Use /admin." };
      sendJson(res, 200, { result: value });
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      send(res, 405, "Method not allowed", "text/plain; charset=utf-8");
      return;
    }
    const staticPath = safeStatic(pathname);
    if (staticPath) {
      if (!fs.existsSync(staticPath) || !fs.statSync(staticPath).isFile()) {
        send(res, 404, "Not found", "text/plain; charset=utf-8");
        return;
      }
      const body = fs.readFileSync(staticPath);
      const type = TYPES[path.extname(staticPath).toLowerCase()] || "application/octet-stream";
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-type": type, "content-length": body.length });
        res.end();
        return;
      }
      send(res, 200, body, type);
      return;
    }
    const page = pageFor(pathname);
    if (!page) {
      send(res, 404, "Not found", "text/plain; charset=utf-8");
      return;
    }
    if (req.method === "HEAD") {
      res.writeHead(200, { "content-type": TYPES[".html"], "content-length": page.length });
      res.end();
      return;
    }
    send(res, 200, page, TYPES[".html"]);
  } catch (error) {
    console.error(error.message || error);
    if (!res.headersSent) sendJson(res, 500, { ok: false, message: "Erro interno." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Hotluna em http://127.0.0.1:${PORT}/`);
  console.log(`Admin em http://127.0.0.1:${PORT}/admin`);
  console.log(`VizzionPay ${vizzionConfigured() ? "configurada" : "sem chave"}`);
});
