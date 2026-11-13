import crypto from "node:crypto";
import QRCode from "qrcode";
import { createPixCharge, findTransaction, gatewayMessage, vizzionConfigured } from "./vizzion.mjs";

const LOOKUP_GAP_MS = 25_000;

export function catalogCents(homeConfig) {
  const prices = (homeConfig.plans || []).map((plan) => Number(plan.price) || 0);
  const bump = homeConfig.offer?.orderBumpEnabled ? Number(homeConfig.offer.orderBumpPrice) || 0 : 0;
  const cents = new Set();
  for (const price of prices) {
    const base = Math.round(price * 100);
    if (base > 0) cents.add(base);
    if (bump > 0) cents.add(base + Math.round(bump * 100));
  }
  const offer = Math.round((Number(homeConfig.offer?.price) || 0) * 100);
  if (offer > 0) cents.add(offer);
  if (offer > 0 && bump > 0) cents.add(offer + Math.round(bump * 100));
  return cents;
}

export function parsePayload(raw, url) {
  const found = {};
  const candidates = [raw];
  try {
    const query = new URL(url, "http://local").searchParams.get("payload");
    if (query) candidates.push(query);
  } catch {
    /* ignore */
  }
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      walk(JSON.parse(candidate), found, new Set());
    } catch {
      /* body may be empty on GET */
    }
  }
  return found;
}

function walk(node, found, seen) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node.k) && Array.isArray(node.v)) {
    node.k.forEach((key, index) => {
      const value = node.v[index];
      if (value && typeof value === "object" && "s" in value) found[key] = value.s;
    });
  }
  for (const value of Object.values(node)) walk(value, found, seen);
}

function cents(amount) {
  return Math.round(Number(amount) * 100);
}

function phoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

export function validatePayer(input, { catalog = null } = {}) {
  const amount = Number(input.amount);
  const name = String(input.payerName || input.name || "").trim();
  const document = phoneDigits(input.payerDocument || input.document);
  const email = String(input.payerEmail || input.email || "").trim().toLowerCase();
  const phone = phoneDigits(input.payerPhone || input.phone);
  if (!name || name.length < 3) return { error: "Informe o nome completo." };
  if (document.length !== 11 && document.length !== 14) return { error: "Informe um CPF ou CNPJ válido." };
  if (!email.includes("@") || !email.includes(".")) return { error: "Informe um e-mail válido." };
  if (phone.length < 10 || phone.length > 13) return { error: "Informe um celular com DDD." };
  if (!Number.isFinite(amount) || amount < 1 || amount > 10000) return { error: "Valor inválido." };
  if (catalog && !catalog.has(cents(amount))) return { error: "Esse valor não corresponde a um plano do site." };
  return { amount, name, document, email, phone, description: String(input.description || "Assinatura Luna Harts").slice(0, 180) };
}

function publicWebhook(base) {
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return "";
    if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "";
    return `${url.origin}/api/v1/pix/webhook`;
  } catch {
    return "";
  }
}

function webhookTarget(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try { url = new URL(raw); } catch { return ""; }
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && host === "127.0.0.1" && process.env.NODE_ENV !== "production") return url.toString();
  if (blockedHost(host) || url.protocol !== "https:") return "";
  return url.toString();
}

function blockedHost(host) {
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host === "metadata.google.internal") return true;
  const match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return false;
  const a = Number(match[1]);
  const b = Number(match[2]);
  if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168)) return true;
  return a === 172 && b >= 16 && b <= 31;
}

export function createPixService({ store, homeConfig, publicBaseUrl, defaultNotifyUrl }) {
  const allowed = catalogCents(homeConfig);

  async function issue(input, { catalogOnly }) {
    if (!vizzionConfigured()) {
      return { ok: false, message: "Chaves da VizzionPay não configuradas no servidor." };
    }
    const payer = validatePayer(input, { catalog: catalogOnly ? allowed : null });
    if (payer.error) return { ok: false, message: payer.error };

    const id = `hl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const callbackUrl = publicWebhook(publicBaseUrl());
    let gateway;
    try {
      gateway = await createPixCharge({
        identifier: id,
        amount: payer.amount,
        client: {
          name: payer.name,
          email: payer.email,
          phone: payer.phone,
          document: payer.document,
        },
        products: [
          {
            id: "prod_assinatura_luna",
            name: payer.description,
            quantity: 1,
            price: payer.amount,
            physical: false,
          },
        ],
        ...(callbackUrl ? { callbackUrl } : {}),
      });
    } catch (error) {
      return { ok: false, message: error.message || "Não foi possível gerar o PIX." };
    }

    const pix = gateway.pix || {};
    const copyPaste = pix.code || "";
    if (!copyPaste) return { ok: false, message: gateway.errorDescription || "A VizzionPay não devolveu o código PIX." };
    const qrCodeBase64 = pix.image && String(pix.image).startsWith("data:")
      ? pix.image
      : await QRCode.toDataURL(copyPaste, { margin: 1, width: 320 });

    const row = {
      id,
      gatewayId: gateway.transactionId || "",
      webhookToken: gateway.webhookToken || "",
      amountCents: cents(payer.amount),
      status: gateway.transactionStatus || "PENDING",
      description: payer.description,
      payerName: payer.name,
      payerDocument: payer.document,
      externalRef: String(input.externalRef || "").slice(0, 120),
      notifyUrl: webhookTarget(input.webhookUrl) || webhookTarget(defaultNotifyUrl?.() || ""),
      partnerNotifiedAt: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
      lastLookupAt: 0,
    };
    await store.add(row);
    return {
      ok: true,
      status: "pending",
      data: {
        transactionId: id,
        amount: payer.amount,
        copyPaste,
        qrCodeBase64,
      },
    };
  }

  async function status(transactionId, { refresh = false } = {}) {
    const row = store.get(transactionId);
    if (!row) return { ok: false, message: "Cobrança não encontrada." };
    const stale = Date.now() - (row.lastLookupAt || 0) > LOOKUP_GAP_MS;
    if (refresh && row.status === "PENDING" && stale && vizzionConfigured()) {
      row.lastLookupAt = Date.now();
      try {
        const remote = await findTransaction({ id: row.gatewayId, clientIdentifier: row.id });
        applyStatus(row, remote.status);
        store.update(row.id, row);
        notifyIfPaid(row);
      } catch (error) {
        if (error.status !== 429) console.error("vizzion status", error.status || "", gatewayMessage(error.body || {}));
      }
    }
    notifyIfPaid(row);
    return { ok: true, status: frontendStatus(row.status), transactionId: row.id };
  }

  function applyWebhook(body) {
    const transaction = body?.transaction || body?.data?.transaction || {};
    const id = transaction.identifier || body?.identifier || "";
    const gatewayId = transaction.id || body?.transactionId || "";
    const row = store.get(id) || store.get(gatewayId);
    if (!row) return { ok: false, status: 404 };
    if (row.webhookToken && body?.token && body.token !== row.webhookToken) return { ok: false, status: 401 };
    const event = String(body?.event || "");
    let status = transaction.status || "";
    if (event === "TRANSACTION_PAID") status = "COMPLETED";
    if (event === "TRANSACTION_CANCELED") status = "CANCELED";
    if (event === "TRANSACTION_REFUNDED") status = "REFUNDED";
    if (event === "TRANSACTION_CHARGED_BACK") status = "CHARGED_BACK";
    if (status) applyStatus(row, status);
    store.update(row.id, row);
    notifyIfPaid(row);
    return { ok: true, status: 200 };
  }

  function notifyIfPaid(row) {
    if (!row || row.status !== "COMPLETED" || row.partnerNotifiedAt) return;
    const url = webhookTarget(row.notifyUrl) || webhookTarget(defaultNotifyUrl?.() || "");
    if (!url) return;
    row.notifyUrl = url;
    row.partnerNotifiedAt = new Date().toISOString();
    store.update(row.id, row);
    const payload = {
      event: "payment.completed",
      timestamp: row.paidAt || row.partnerNotifiedAt,
      data: {
        transactionId: row.id,
        status: "paid",
        amount: (row.amountCents || 0) / 100,
        payerName: row.payerName || "",
        payerDocument: row.payerDocument || "",
        description: row.description || "",
        ...(row.externalRef ? { externalRef: row.externalRef } : {}),
      },
    };
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "HotLuna/1.0" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(8000),
    }).then((response) => {
      if (response.ok) return;
      row.partnerNotifiedAt = null;
      store.update(row.id, row);
    }).catch(() => {
      row.partnerNotifiedAt = null;
      store.update(row.id, row);
    });
  }

  function notifyOutstanding() {
    for (const row of store.list()) {
      const full = store.get(row.id);
      if (full) notifyIfPaid(full);
    }
  }

  async function resend(transactionId) {
    const row = store.get(transactionId);
    if (!row) return { ok: false, message: "Cobrança não encontrada." };
    if (row.status !== "COMPLETED") return { ok: false, message: "Essa cobrança ainda não está paga." };
    const url = webhookTarget(row.notifyUrl) || webhookTarget(defaultNotifyUrl?.() || "");
    if (!url) return { ok: false, message: "Cadastre a URL de webhook no painel." };
    row.partnerNotifiedAt = null;
    row.notifyUrl = url;
    notifyIfPaid(row);
    return { ok: true };
  }

  return { issue, status, applyWebhook, notifyOutstanding, resend };
}

function applyStatus(row, status) {
  const next = String(status || "").toUpperCase();
  if (!next) return;
  row.status = next === "PAID" ? "COMPLETED" : next;
  if (row.status === "COMPLETED" && !row.paidAt) row.paidAt = new Date().toISOString();
}

function frontendStatus(status) {
  return status === "COMPLETED" ? "paid" : String(status || "pending").toLowerCase();
}
