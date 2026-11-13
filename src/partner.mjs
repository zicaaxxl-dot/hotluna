import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE = "partner.json";
const RETIRED_CLIENT_ID = "ci_e4e626ce6b68908ecb3be4d8";

function token(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function freshKeys() {
  return { clientId: `ci_${token(12)}`, clientSecret: `cs_${token(24)}` };
}

export function createPartner(dir) {
  const file = path.join(dir, FILE);
  fs.mkdirSync(dir, { recursive: true });
  let account = {
    name: "Conta Principal",
    email: (process.env.PARTNER_EMAIL || "parceiro@hotluna.com").trim().toLowerCase(),
    password: process.env.PARTNER_PASSWORD || `luna-${token(6)}`,
    webhookUrl: "",
    createdAt: new Date().toISOString(),
    clientId: "",
    clientSecret: "",
  };
  if (fs.existsSync(file)) {
    try {
      account = { ...account, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }

  const envId = process.env.LUNA_CLIENT_ID || "";
  const envSecret = process.env.LUNA_CLIENT_SECRET || "";
  if (envId && envSecret && envId !== RETIRED_CLIENT_ID) {
    account.clientId = envId;
    account.clientSecret = envSecret;
  } else if (!account.clientId || !account.clientSecret || account.clientId === RETIRED_CLIENT_ID) {
    Object.assign(account, freshKeys());
  }

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2));
    fs.renameSync(tmp, file);
  }
  save();

  function matches(email, password) {
    return account.email === String(email || "").trim().toLowerCase()
      && account.password === String(password || "");
  }

  function view() {
    return {
      id: "acc-luna",
      name: account.name,
      email: account.email,
      password: account.password,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      webhookUrl: account.webhookUrl || "",
      discordWebhookUrl: "",
      telegramBotToken: "",
      telegramChatId: "",
      active: true,
      status: "approved",
      feePercent: 0,
      feeFixed: 0,
      gatewayConfig: {
        provider: "vizzionpay",
        pixExpirationMinutes: 30,
        payerConfig: {
          mode: "custom",
          nameMode: "dynamic",
          cpfMode: "dynamic",
          emailMode: "dynamic",
          phoneMode: "dynamic",
        },
      },
      vitrine: { enabled: true, slug: "lunaharts" },
    };
  }

  function session(email, password) {
    if (!matches(email, password)) return null;
    return { ok: true, account: view(), payments: [] };
  }

  function login(input) {
    const mode = String(input.mode || "login");
    if (mode !== "login") {
      return {
        ok: false,
        pendingApproval: true,
        message: "O cadastro novo fica fechado. Entre com o usuário que já está aprovado.",
      };
    }
    const found = session(input.email, input.password);
    if (!found) return { ok: false, message: "E-mail ou senha incorretos." };
    return found;
  }

  function update(input) {
    if (!matches(input.email, input.password)) return { ok: false, message: "E-mail ou senha incorretos." };
    if (input.regenerateKeys) Object.assign(account, freshKeys());
    if (typeof input.webhookUrl === "string") account.webhookUrl = input.webhookUrl.slice(0, 300);
    const nextPassword = String(input.newPassword || "").trim();
    if (nextPassword) account.password = nextPassword;
    save();
    return { ok: true, account: view() };
  }

  function matchesPair(clientId, clientSecret, expectedId, expectedSecret) {
    return sameSecret(clientId, expectedId) && sameSecret(clientSecret, expectedSecret);
  }

  function credentialsMatch(clientId, clientSecret) {
    return matchesPair(clientId, clientSecret, account.clientId, account.clientSecret)
      || matchesPair(clientId, clientSecret, process.env.VIZZION_PUBLIC_KEY || "", process.env.VIZZION_SECRET_KEY || "");
  }

  function secretMatches(value) {
    return sameSecret(value, account.clientSecret);
  }

  return {
    login,
    session,
    update,
    credentialsMatch,
    secretMatches,
    clientId: () => account.clientId,
  };
}
