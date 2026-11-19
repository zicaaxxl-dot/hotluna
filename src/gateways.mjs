import fs from "node:fs";
import path from "node:path";

function empty() {
  return { a: { publicKey: "", secretKey: "" }, b: { publicKey: "", secretKey: "" } };
}

function webhookState(value) {
  return {
    enabled: value?.enabled !== false,
    since: String(value?.since || ""),
  };
}

function envPair(which) {
  if (which === "b") {
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

export function createGateways(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "gateways.json");
  let saved = empty();
  let bWebhook = webhookState();
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const which of ["a", "b"]) {
        saved[which] = {
          publicKey: String(parsed?.[which]?.publicKey || ""),
          secretKey: String(parsed?.[which]?.secretKey || ""),
        };
      }
      bWebhook = webhookState(parsed?.bWebhook);
    } catch {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }

  function persist() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ a: saved.a, b: saved.b, bWebhook }));
    fs.renameSync(tmp, file);
  }

  function keys(which) {
    const name = which === "b" ? "b" : "a";
    const row = saved[name];
    const env = envPair(name);
    return {
      publicKey: row.publicKey || env.publicKey || "",
      secretKey: row.secretKey || env.secretKey || "",
    };
  }

  function savePair(which, publicKey, secretKey) {
    const name = which === "b" ? "b" : "a";
    if (typeof publicKey === "string") saved[name].publicKey = publicKey.trim();
    if (typeof secretKey === "string" && secretKey.trim()) saved[name].secretKey = secretKey.trim();
    persist();
  }

  function publicInfo(which) {
    const got = keys(which);
    return { publicKey: got.publicKey, secretSet: Boolean(got.secretKey) };
  }

  function bWebhookPolicy() {
    return { enabled: bWebhook.enabled !== false, since: bWebhook.since || "" };
  }

  function setBWebhook(enabled) {
    const on = Boolean(enabled);
    const wasOn = bWebhook.enabled !== false;
    if (on === wasOn) return false;
    bWebhook.enabled = on;
    if (on) bWebhook.since = new Date().toISOString();
    persist();
    return on;
  }

  return { keys, savePair, publicInfo, bWebhookPolicy, setBWebhook };
}
