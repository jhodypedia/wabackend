import express from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { pool } from "../config/db";
import dotenv from "dotenv";
import { genOtpCode, nowSeconds } from "../utils/otp";
import { sanitizePhone } from "../utils/phone";
dotenv.config();

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "secret";

router.post("/register", async (req, res) => {
  const { username, email, phone, password, license_code } = req.body;
  if (!username || !email || !password || !license_code) return res.status(400).json({ ok: false, error: "missing" });
  const conn = await pool.getConnection();
  try {
    const [licRows]: any = await conn.query("SELECT id, is_used FROM license_codes WHERE code = ? LIMIT 1", [license_code]);
    if ((licRows as any[]).length === 0) return res.status(400).json({ ok: false, error: "invalid license code" });
    const lic = licRows[0]; if (lic.is_used) return res.status(400).json({ ok: false, error: "license already used" });
    const [uRows]: any = await conn.query("SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1", [username, email]);
    if ((uRows as any[]).length > 0) return res.status(400).json({ ok: false, error: "username or email exists" });
    const hash = await bcrypt.hash(password, 12);
    const sanitized = sanitizePhone(phone);
    const [ins]: any = await conn.query("INSERT INTO users (username, email, phone, password_hash, role, license_code) VALUES (?, ?, ?, ?, ?, ?)", [username, email, sanitized, hash, "user", license_code]);
    await conn.query("UPDATE license_codes SET is_used=1 WHERE id = ?", [lic.id]);
    const token = jwt.sign({ userId: ins.insertId, username }, JWT_SECRET, { expiresIn: "12h" });
    return res.json({ ok: true, token, user: { id: ins.insertId, username, email, phone: sanitized } });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); } finally { conn.release(); }
});

router.post("/login", async (req, res) => {
  const { usernameOrEmail, password } = req.body;
  if (!usernameOrEmail || !password) return res.status(400).json({ ok: false, error: "missing" });
  const conn = await pool.getConnection();
  try {
    const [rows]: any = await conn.query("SELECT id, username, email, phone, password_hash, role FROM users WHERE username = ? OR email = ? LIMIT 1", [usernameOrEmail, usernameOrEmail]);
    if ((rows as any[]).length === 0) return res.status(400).json({ ok: false, error: "invalid credentials" });
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(400).json({ ok: false, error: "invalid credentials" });
    const token = jwt.sign({ userId: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "12h" });
    const requiresOtp = user.role !== "admin";
    return res.json({ ok: true, token, user: { id: user.id, username: user.username, email: user.email, phone: user.phone, role: user.role }, requiresOtp });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); } finally { conn.release(); }
});

export default router;
