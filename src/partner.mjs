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
    webhookUrl: "",
    createdAt: new Date().toISOString(),
  };
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (!a.length || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function createPartner(dir) {
  const file = path.join(dir, FILE);
  fs.mkdirSync(dir, { recursive: true });
  let account = seedFromEnv();
  if (fs.existsSync(file)) {
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      const hadSeparateKeys = "clientId" in stored || "clientSecret" in stored;
      delete stored.clientId;
      delete stored.clientSecret;
      account = { ...seedFromEnv(), ...stored };
      if (hadSeparateKeys) save();
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
      clientId: process.env.VIZZION_PUBLIC_KEY || "",
      clientSecret: process.env.VIZZION_SECRET_KEY || "",
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
      return { ok: false, message: "A chave do parceiro é a chave da Vizzion. Ela não é gerada de novo aqui." };
    }
    if (typeof input.webhookUrl === "string") account.webhookUrl = input.webhookUrl.slice(0, 300);
    const nextPassword = String(input.newPassword || "").trim();
    if (nextPassword) account.password = nextPassword;
    save();
    return { ok: true, account: view() };
  }

  function credentialsMatch(clientId, clientSecret) {
    return sameSecret(clientId, process.env.VIZZION_PUBLIC_KEY || "")
      && sameSecret(clientSecret, process.env.VIZZION_SECRET_KEY || "");
  }

  return { login, session, update, credentialsMatch, clientId: () => process.env.VIZZION_PUBLIC_KEY || "" };
}
