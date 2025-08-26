import fs from "fs";
import path from "path";
import { parse } from "csv-parse/sync";
import { sendMessageAndLog } from "./baileysManager";
import { pool } from "./config/db";
import { sanitizePhone } from "./utils/phone";

const MAX_RECIPIENTS = Number(process.env.BROADCAST_MAX_RECIPIENTS || 2000);
const CONCURRENCY = Number(process.env.BROADCAST_CONCURRENCY || 5);

export function parseContactsFromBuffer(buffer: Buffer, filename: string): string[] {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const text = buffer.toString("utf8");
  const phones: string[] = [];
  if (ext === "csv") {
    const records = parse(text, { skip_empty_lines: true });
    for (const r of records) {
      const entry = Array.isArray(r) ? r[0] : Object.values(r)[0];
      const s = String(entry || "").trim();
      if (s) phones.push(s);
    }
  } else {
    text.split(/\r?\n/).forEach((l) => { const s = l.trim(); if (s) phones.push(s); });
  }
  const cleaned = Array.from(new Set(phones.map(sanitizePhone).filter(Boolean) as string[]));
  return cleaned;
}

export async function processBroadcastJob(userId: number, filename: string, buffer: Buffer, messageBody: string) {
  const contacts = parseContactsFromBuffer(buffer, filename);
  if (contacts.length === 0) throw new Error("no recipients");
  if (contacts.length > MAX_RECIPIENTS) throw new Error("recipient list too large");

  const [res]: any = await pool.query("INSERT INTO broadcast_jobs (user_id, filename, total, status) VALUES (?, ?, ?, ?)", [userId, filename, contacts.length, "processing"]);
  const jobId = res.insertId;

  const results: any[] = [];
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= contacts.length) break;
      const phone = contacts[i];
      try { await sendMessageAndLog(userId, phone, { text: messageBody }); results.push({ phone, ok: true }); }
      catch (e: any) { results.push({ phone, ok: false, error: String(e?.message || e) }); }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, contacts.length) }, () => worker());
  await Promise.all(workers);
  const sent = results.filter((r) => r.ok).length;
  const failed = results.length - sent;
  const reportDir = path.join(process.cwd(), "broadcast_reports"); if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `report_${jobId}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ total: contacts.length, sent, failed, details: results }, null, 2));
  await pool.query("UPDATE broadcast_jobs SET sent=?, failed=?, status=?, report_path=?, updated_at=NOW() WHERE id=?", [sent, failed, "done", reportPath, jobId]);
  return { jobId, total: contacts.length, sent, failed, reportPath };
}
