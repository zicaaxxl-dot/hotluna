import fs from "node:fs";
import path from "node:path";

export function createStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "transactions.json");
  let rows = [];
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      fs.renameSync(file, `${file}.broken-${Date.now()}`);
    }
  }

  let writing = Promise.resolve();

  function persist() {
    const snapshot = JSON.stringify(rows);
    writing = writing.then(() => {
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, snapshot);
      fs.renameSync(tmp, file);
    });
    return writing;
  }

  return {
    list() {
      return rows.map(publicRow);
    },
    all() {
      return rows;
    },
    get(id) {
      return rows.find((row) => row.id === id || row.gatewayId === id) || null;
    },
    add(row) {
      rows.unshift(row);
      return persist();
    },
    update(id, patch) {
      const row = rows.find((item) => item.id === id || item.gatewayId === id);
      if (!row) return null;
      Object.assign(row, patch, { updatedAt: new Date().toISOString() });
      persist();
      return row;
    },
    summary() {
      const paid = rows.filter((row) => row.status === "COMPLETED");
      const pending = rows.filter((row) => row.status === "PENDING");
      const paidCents = paid.reduce((sum, row) => sum + Number(row.amountCents || 0), 0);
      return {
        total: rows.length,
        paid: paid.length,
        pending: pending.length,
        paidAmount: paidCents / 100,
      };
    },
  };
}

function publicRow(row) {
  return {
    id: row.id,
    gatewayId: row.gatewayId || "",
    amount: (row.amountCents || 0) / 100,
    status: row.status,
    description: row.description || "",
    payerName: row.payerName || "",
    payerDocument: maskDocument(row.payerDocument || ""),
    createdAt: row.createdAt,
    paidAt: row.paidAt || null,
  };
}

function maskDocument(value) {
  const digits = String(value).replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `***.***.*${digits.slice(-4, -2)}-${digits.slice(-2)}`;
}
