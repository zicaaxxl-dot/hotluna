import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const FILE = "partner.json";

function token(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}

function seedFromEnv() {
  return {
    name: "Conta Principal",
    email: (process.env.PARTNER_EMAIL || "parceiro@hotluna.com").trim().toLowerCase(),
    password: process.env.PARTNER_PASSWORD || `luna-${token(6)}`,
    clientId: process.env.LUNA_CLIENT_ID || `ci_${token(12)}`,
    clientSecret: process.env.LUNA_CLIENT_SECRET || `cs_${token(24)}`,
    webhookUrl: "",
    createdAt: new Date().toISOString(),
  };
}

export function createPartner(dir) {
  const file = path.join(dir, FILE);
  fs.mkdirSync(dir, { recursive: true });
  let account = seedFromEnv();
  if (fs.existsSync(file)) {
    try {
      account = { ...account, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    } catch {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  } else {
    fs.writeFileSync(file, JSON.stringify(account, null, 2));
  }

  function save() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(account, null, 2));
    fs.renameSync(tmp, file);
  }

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
    if (input.regenerateKeys) {
      account.clientId = `ci_${token(12)}`;
      account.clientSecret = `cs_${token(24)}`;
    }
    if (typeof input.webhookUrl === "string") account.webhookUrl = input.webhookUrl.slice(0, 300);
    const nextPassword = String(input.newPassword || "").trim();
    if (nextPassword) account.password = nextPassword;
    save();
    return { ok: true, account: view() };
  }

  function credentialsMatch(clientId, clientSecret) {
    return Boolean(clientId && clientSecret)
      && clientId === account.clientId
      && clientSecret === account.clientSecret;
  }

  return { login, session, update, credentialsMatch, clientId: () => account.clientId };
}
