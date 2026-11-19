import fs from "node:fs";
import path from "node:path";

function empty() {
  return { a: { publicKey: "", secretKey: "" }, b: { publicKey: "", secretKey: "" } };
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
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const which of ["a", "b"]) {
        saved[which] = {
          publicKey: String(parsed?.[which]?.publicKey || ""),
          secretKey: String(parsed?.[which]?.secretKey || ""),
        };
      }
    } catch {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }

  function persist() {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ a: saved.a, b: saved.b }));
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

  return { keys, savePair, publicInfo };
}
