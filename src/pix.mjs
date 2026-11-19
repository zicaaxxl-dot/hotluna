import crypto from "node:crypto";
import QRCode from "qrcode";
import { PARTNER_WEBHOOK_URL } from "./partner.mjs";
import { createPixCharge, findTransaction, gatewayMessage, gatewayName, vizzionConfigured } from "./vizzion.mjs";

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

export function validatePayer(input, { catalog = null, donation = false } = {}) {
  const amount = Number(input.amount);
  const name = String(input.payerName || input.name || "").trim();
  const document = phoneDigits(input.payerDocument || input.document);
  const email = String(input.payerEmail || input.email || "").trim().toLowerCase();
  const phone = phoneDigits(input.payerPhone || input.phone);
  if (!name || name.length < 3) return { error: "Informe o nome completo." };
  if (document.length !== 11 && document.length !== 14) return { error: "Informe um CPF ou CNPJ válido." };
  if (!email.includes("@") || !email.includes(".")) return { error: "Informe um e-mail válido." };
  if (phone.length < 10 || phone.length > 13) return { error: "Informe um celular com DDD." };
  const rounded = Math.round(amount * 100);
  if (donation) {
    if (!Number.isFinite(amount) || rounded < 10000 || rounded > 1000000) return { error: "A doação mínima é de R$ 100." };
  } else if (!Number.isFinite(amount) || amount < 1 || amount > 10000) {
    return { error: "Valor inválido." };
  }
  if (catalog && !catalog.has(cents(amount))) return { error: "Esse valor não corresponde a um plano do site." };
  return {
    amount,
    name,
    document,
    email,
    phone,
    description: donation ? "Doação" : String(input.description || "Assinatura Luna Harts").slice(0, 180),
  };
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

  async function issue(input, { catalogOnly, gateway = "a" }) {
    const which = gatewayName(gateway);
    const donation = Boolean(catalogOnly) && (
      String(input.donation || "") === "1" || String(input.description || "").trim() === "Doação"
    );
    const payer = validatePayer(input, { catalog: donation || !catalogOnly ? null : allowed, donation });
    if (payer.error) return { ok: false, message: payer.error };
    if (!vizzionConfigured(which)) {
      return {
        ok: false,
        message: which === "b"
          ? "Chaves da gateway B não configuradas no servidor."
          : "Chaves da VizzionPay não configuradas no servidor.",
      };
    }

    const id = `hl_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
    const callbackUrl = publicWebhook(publicBaseUrl());
    let charge;
    try {
      charge = await createPixCharge({
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
      }, which);
    } catch (error) {
      return { ok: false, message: error.message || "Não foi possível gerar o PIX." };
    }

    const pix = charge.pix || {};
    const copyPaste = pix.code || "";
    if (!copyPaste) return { ok: false, message: charge.errorDescription || "A VizzionPay não devolveu o código PIX." };
    const qrCodeBase64 = pix.image && String(pix.image).startsWith("data:")
      ? pix.image
      : await QRCode.toDataURL(copyPaste, { margin: 1, width: 320 });

    const row = {
      id,
      gateway: which,
      gatewayId: charge.transactionId || "",
      webhookToken: charge.webhookToken || "",
      amountCents: cents(payer.amount),
      status: charge.transactionStatus || "PENDING",
      description: payer.description,
      payerName: payer.name,
      payerDocument: payer.document,
      externalRef: String(input.externalRef || input.external_id || input.orderId || "").slice(0, 120),
      notifyUrl: PARTNER_WEBHOOK_URL,
      partnerNotifiedAt: null,
      createdAt: new Date().toISOString(),
      paidAt: null,
      lastLookupAt: 0,
    };
    await store.add(row);
    return {
      ok: true,
      success: true,
      id,
      transactionId: id,
      status: "pending",
      amount: payer.amount,
      pix_code: copyPaste,
      copyPaste,
      qrCodeBase64,
      data: {
        id,
        transactionId: id,
        amount: payer.amount,
        status: "pending",
        copyPaste,
        pix_code: copyPaste,
        qrCodeBase64,
      },
    };
  }

  async function status(transactionId, { refresh = false, gateway = "a" } = {}) {
    const row = store.get(transactionId);
    if (!row) return { ok: false, message: "Cobrança não encontrada." };
    const which = row.gateway === "b" || row.gateway === "a" ? row.gateway : gatewayName(gateway);
    const stale = Date.now() - (row.lastLookupAt || 0) > LOOKUP_GAP_MS;
    if (refresh && row.status === "PENDING" && stale && vizzionConfigured(which)) {
      row.lastLookupAt = Date.now();
      try {
        const remote = await findTransaction({ id: row.gatewayId, clientIdentifier: row.id }, which);
        applyStatus(row, remote.status);
        store.update(row.id, row);
        await notifyIfPaid(row);
      } catch (error) {
        if (error.status !== 429) console.error("vizzion status", error.status || "", gatewayMessage(error.body || {}));
      }
    }
    await notifyIfPaid(row);
    return { ok: true, id: row.id, status: frontendStatus(row.status), transactionId: row.id, gateway: which };
  }

  async function applyWebhook(body) {
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
    await notifyIfPaid(row);
    return { ok: true, status: 200 };
  }

  function paidPayload(row, transactionId) {
    const amount = (row.amountCents || 0) / 100;
    const gateway = row.gateway === "b" ? "b" : "a";
    return {
      event: "TRANSACTION_PAID",
      gateway,
      transactionId,
      status: "PAID",
      transaction: {
        id: row.gatewayId || transactionId,
        identifier: transactionId,
        status: "COMPLETED",
        amount,
      },
      data: {
        id: transactionId,
        transactionId,
        status: "paid",
        amount,
        gateway,
        payerName: row.payerName || "",
        payerDocument: row.payerDocument || "",
        description: row.description || "",
        ...(row.externalRef ? { externalRef: row.externalRef } : {}),
      },
    };
  }

  async function postPaid(row, transactionId) {
    const response = await fetch(PARTNER_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "HotLuna/1.0" },
      body: JSON.stringify(paidPayload(row, transactionId)),
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    const accepted = response.ok && !body.toLowerCase().includes("pendente");
    console.log(`webhook lulapay ${response.status} ${accepted ? "aceito" : "pendente"}`);
    return accepted;
  }

  async function notifyIfPaid(row) {
    if (!row || row.status !== "COMPLETED" || row.partnerNotifiedAt) return;
    try {
      const ids = [...new Set([row.id, row.gatewayId, row.externalRef].filter(Boolean))];
      let accepted = false;
      for (const transactionId of ids) {
        accepted = await postPaid(row, transactionId);
        if (accepted) break;
      }
      if (!accepted) return;
      row.notifyUrl = PARTNER_WEBHOOK_URL;
      row.partnerNotifiedAt = new Date().toISOString();
      store.update(row.id, row);
    } catch (error) {
      console.error("webhook lulapay", error.message || error);
    }
  }

  async function notifyOutstanding() {
    for (const row of store.list()) {
      const full = store.get(row.id);
      if (full) await notifyIfPaid(full);
    }
  }

  async function resend(transactionId) {
    const row = store.get(transactionId);
    if (!row) return { ok: false, message: "Cobrança não encontrada." };
    if (row.status !== "COMPLETED") return { ok: false, message: "Essa cobrança ainda não está paga." };
    row.partnerNotifiedAt = null;
    row.notifyUrl = PARTNER_WEBHOOK_URL;
    await notifyIfPaid(row);
    return row.partnerNotifiedAt
      ? { ok: true }
      : { ok: false, message: "A LulaPay recebeu o aviso e ainda deixou a cobrança pendente." };
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
