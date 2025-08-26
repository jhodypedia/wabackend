import express from "express";
import { authMiddleware } from "../middlewares/auth";
import { adminOnly } from "../middlewares/role";
import { pool } from "../config/db";
import bcrypt from "bcrypt";
import { createOrGetSocket, disconnectSession, deleteAuthFolder } from "../baileysManager";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";

const router = express.Router();
router.use("/admin", authMiddleware, adminOnly);

router.get("/admin/users", async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const per = Math.min(Number(req.query.per || 50), 200);
  const offset = (page - 1) * per;
  try {
    const [rows]: any = await pool.query("SELECT id, username, email, phone, role, license_code, is_verified, created_at, updated_at FROM users ORDER BY id DESC LIMIT ? OFFSET ?", [per, offset]);
    const [[countRow]]: any = await pool.query("SELECT COUNT(*) as total FROM users");
    return res.json({ ok: true, users: rows, total: countRow.total, page, per });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

router.post("/admin/users", async (req, res) => {
  const { username, email, phone, password, role } = req.body;
  if (!username || !email || !password) return res.status(400).json({ ok: false, error: "missing" });
  try {
    const hashed = await bcrypt.hash(password, 12);
    const [ins]: any = await pool.query("INSERT INTO users (username, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)", [username, email, phone || null, hashed, role === "admin" ? "admin" : "user"]);
    return res.json({ ok: true, id: ins.insertId });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.put("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  const { username, email, phone, role } = req.body;
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    await pool.query("UPDATE users SET username=COALESCE(?, username), email=COALESCE(?, email), phone=COALESCE(?, phone), role=COALESCE(?, role) WHERE id = ?", [username, email, phone, role, id]);
    return res.json({ ok: true });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.delete("/admin/users/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    await pool.query("DELETE FROM users WHERE id = ?", [id]);
    const waAuthRoot = process.env.WA_AUTH_ROOT || "./sessions";
    const dir = path.join(process.cwd(), waAuthRoot, String(id));
    if (fs.existsSync(dir)) {
      await deleteAuthFolder(waAuthRoot, id);
    }
    return res.json({ ok: true });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/admin/users/:id/reset-password", async (req, res) => {
  const id = Number(req.params.id);
  const { newPassword } = req.body;
  if (!id || !newPassword) return res.status(400).json({ ok: false, error: "id & newPassword required" });
  try {
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.query("UPDATE users SET password_hash = ? WHERE id = ?", [hash, id]);
    return res.json({ ok: true });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/admin/license/generate", async (req, res) => {
  const { count } = req.body;
  const n = Math.min(Math.max(Number(count || 1), 1), 1000);
  const codes: string[] = [];
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (let i = 0; i < n; i++) {
      const code = `LIC-${uuidv4().slice(0, 8).toUpperCase()}`;
      await conn.query("INSERT INTO license_codes (code) VALUES (?)", [code]);
      codes.push(code);
    }
    await conn.commit();
    return res.json({ ok: true, codes });
  } catch (e:any) {
    await conn.rollback();
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  } finally { conn.release(); }
});

router.get("/admin/license", async (req, res) => {
  try {
    const [rows]: any = await pool.query("SELECT id, code, is_used, created_at FROM license_codes ORDER BY id DESC LIMIT 1000");
    return res.json({ ok: true, license: rows });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/admin/sessions/pair", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
  try { await createOrGetSocket(Number(userId), process.env.WA_AUTH_ROOT || "./sessions"); return res.json({ ok: true, message: "pairing started" }); }
  catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/admin/sessions/disconnect", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ ok: false, error: "userId required" });
  try {
    const ok = await disconnectSession(Number(userId));
    return res.json({ ok, message: ok ? "disconnected" : "no session" });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get("/admin/sessions", async (req, res) => {
  try {
    const [rows]: any = await pool.query("SELECT s.*, u.username FROM sessions_meta s JOIN users u ON u.id = s.user_id ORDER BY s.created_at DESC");
    return res.json({ ok: true, sessions: rows });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get("/admin/broadcasts", async (req, res) => {
  const page = Math.max(Number(req.query.page || 1), 1);
  const per = Math.min(Number(req.query.per || 50), 200);
  const offset = (page - 1) * per;
  try {
    const [rows]: any = await pool.query("SELECT * FROM broadcast_jobs ORDER BY created_at DESC LIMIT ? OFFSET ?", [per, offset]);
    const [[countRow]]: any = await pool.query("SELECT COUNT(*) as total FROM broadcast_jobs");
    return res.json({ ok: true, broadcasts: rows, total: countRow.total, page, per });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.get("/admin/broadcasts/:id/report", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "id required" });
  try {
    const [rows]: any = await pool.query("SELECT report_path FROM broadcast_jobs WHERE id = ? LIMIT 1", [id]);
    if ((rows as any[]).length === 0) return res.status(404).json({ ok: false, error: "not found" });
    const rpt = rows[0].report_path;
    if (!rpt || !fs.existsSync(rpt)) return res.status(404).json({ ok: false, error: "report not available" });
    return res.download(rpt);
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
