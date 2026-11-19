const BASE = "https://app.vizzionpay.com.br/api/v1";

function envKeys(gateway) {
  if (gateway === "b") {
    return {
      publicKey: process.env.VIZZION_B_PUBLIC_KEY || "",
      secretKey: process.env.VIZZION_B_SECRET_KEY || "",
    };
  }
  return {
    publicKey: process.env.VIZZION_PUBLIC_KEY || "",
    secretKey: process.env.VIZZION_SECRET_KEY || "",
  };
}

let resolveKeys = envKeys;

export function useGatewayKeys(fn) {
  resolveKeys = typeof fn === "function" ? fn : envKeys;
}

export function gatewayName(value) {
  return value === "b" ? "b" : "a";
}

export function vizzionConfigured(gateway = "a") {
  const keys = resolveKeys(gatewayName(gateway));
  return Boolean(keys.publicKey && keys.secretKey);
}

function headers(gateway) {
  const keys = resolveKeys(gatewayName(gateway));
  return {
    "content-type": "application/json",
    accept: "application/json",
    "user-agent": "HotLuna/1.0",
    "x-public-key": keys.publicKey,
    "x-secret-key": keys.secretKey,
  };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

export function gatewayMessage(body) {
  if (typeof body?.raw === "string" && body.raw.includes("403")) {
    return "A VizzionPay bloqueou a requisição. Confira as chaves e se a conta pode receber pela API.";
  }
  return (
    body?.errorDescription ||
    body?.message ||
    body?.error?.message ||
    body?.error?.code ||
    body?.errorCode ||
    "A VizzionPay recusou a cobrança."
  );
}

export async function createPixCharge(input, gateway = "a") {
  const response = await fetch(`${BASE}/gateway/pix/receive`, {
    method: "POST",
    headers: headers(gateway),
    body: JSON.stringify(input),
  });
  const body = await readJson(response);
  if (!response.ok || body.status === "FAILED" || body.status === "REJECTED") {
    const error = new Error(gatewayMessage(body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

export async function findTransaction({ id, clientIdentifier }, gateway = "a") {
  const query = new URLSearchParams();
  if (id) query.set("id", id);
  if (clientIdentifier) query.set("clientIdentifier", clientIdentifier);
  const response = await fetch(`${BASE}/gateway/transactions?${query}`, {
    method: "GET",
    headers: headers(gateway),
  });
  const body = await readJson(response);
  if (!response.ok) {
    const error = new Error(gatewayMessage(body));
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
