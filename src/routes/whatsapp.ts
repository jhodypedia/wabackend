import express from "express";
import { authMiddleware } from "../middlewares/auth";
import { createOrGetSocket, getSocket, isConnected, sendMessageAndLog, sendMediaFromFile, sendStickerFromImage, sendButtons, sendList, sendPresence, sendReaction, createGroup, addGroupParticipants, removeGroupParticipants, promoteGroupAdmin, demoteGroupAdmin } from "../baileysManager";
import { pool } from "../config/db";
import { sanitizePhone } from "../utils/phone";
import { genOtpCode, nowSeconds } from "../utils/otp";
import multer from "multer";
import { parseContactsFromBuffer, processBroadcastJob } from "../broadcast";
import path from "path";
import fs from "fs";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const router = express.Router();

router.use("/protected", authMiddleware);

router.post("/protected/pair", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  try {
    await createOrGetSocket(userId, process.env.WA_AUTH_ROOT || "./sessions");
    await pool.query("INSERT INTO sessions_meta (user_id, auth_folder, connected) VALUES (?, ?, 0) ON DUPLICATE KEY UPDATE auth_folder=VALUES(auth_folder)", [userId, `${process.env.WA_AUTH_ROOT || "./sessions"}/${userId}`]);
    return res.json({ ok: true, message: "pairing started" });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

router.get("/protected/status", async (req, res) => {
  const user = (req as any).user;
  return res.json({ ok: true, connected: isConnected(Number(user.userId)) });
});

router.post("/protected/send-message", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to, text, quoted } = req.body;
  if (!to || !text) return res.status(400).json({ ok: false, error: "to & text required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  try { const r = await sendMessageAndLog(userId, sanitized, { text }, quoted); return res.json({ ok: true, result: r }); }
  catch (e: any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/send-media", upload.single("file"), async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to, caption } = req.body; const file = req.file;
  if (!to || !file) return res.status(400).json({ ok: false, error: "to & file required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  const tmpDir = path.join(process.cwd(), "tmp_uploads"); if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filepath = path.join(tmpDir, `${Date.now()}_${file.originalname}`);
  fs.writeFileSync(filepath, file.buffer);
  try {
    const r = await sendMediaFromFile(userId, filepath, sanitized, caption || "");
    fs.unlinkSync(filepath);
    return res.json({ ok: true, result: r });
  } catch (e:any) { try{ fs.unlinkSync(filepath) }catch{} return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/send-sticker", upload.single("file"), async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to } = req.body; const file = req.file;
  if (!to || !file) return res.status(400).json({ ok: false, error: "to & image required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  const tmpDir = path.join(process.cwd(), "tmp_uploads"); if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const filepath = path.join(tmpDir, `${Date.now()}_${file.originalname}`);
  fs.writeFileSync(filepath, file.buffer);
  try { const r = await sendStickerFromImage(userId, sanitized, filepath); fs.unlinkSync(filepath); return res.json({ ok: true, result: r }); }
  catch (e:any){ try{ fs.unlinkSync(filepath) }catch{} return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/send-buttons", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to, text, buttons, footer } = req.body;
  if (!to || !text || !Array.isArray(buttons)) return res.status(400).json({ ok: false, error: "to, text, buttons required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  try { const r = await sendButtons(userId, sanitized, text, buttons, footer); return res.json({ ok: true, result: r }); }
  catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/send-list", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to, text, buttonText, sections } = req.body;
  if (!to || !text || !buttonText || !Array.isArray(sections)) return res.status(400).json({ ok: false, error: "to,text,buttonText,sections required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  try { const r = await sendList(userId, sanitized, text, buttonText, sections); return res.json({ ok: true, result: r }); }
  catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/presence", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { to, type } = req.body;
  if (!to || !type) return res.status(400).json({ ok: false, error: "to,type required" });
  const sanitized = sanitizePhone(to); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  try { await sendPresence(userId, sanitized, type); return res.json({ ok: true }); } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/react", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { remoteJid, key, emoji } = req.body;
  if (!remoteJid || !key || !emoji) return res.status(400).json({ ok: false, error: "remoteJid,key,emoji required" });
  try { const r = await sendReaction(userId, remoteJid, key, emoji); return res.json({ ok: true, result: r }); } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/group/create", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const { subject, participants } = req.body;
  if (!subject || !Array.isArray(participants)) return res.status(400).json({ ok: false, error: "subject & participants required" });
  try { const r = await createGroup(userId, subject, participants); return res.json({ ok: true, result: r }); } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/group/add", async (req,res) => {
  const user=(req as any).user; const userId=Number(user.userId); const { groupId, participants }=req.body;
  if(!groupId||!Array.isArray(participants)) return res.status(400).json({ok:false,error:'missing'});
  try{ const r=await addGroupParticipants(userId,groupId,participants); return res.json({ok:true,result:r}); }catch(e:any){return res.status(500).json({ok:false,error:String(e.message||e)})}
});
router.post("/protected/group/remove", async (req,res)=>{ const user=(req as any).user; const userId=Number(user.userId); const { groupId, participants }=req.body; if(!groupId||!Array.isArray(participants)) return res.status(400).json({ok:false,error:'missing'}); try{ const r=await removeGroupParticipants(userId,groupId,participants); return res.json({ok:true,result:r}); }catch(e:any){return res.status(500).json({ok:false,error:String(e.message||e)})} });
router.post("/protected/group/promote", async (req,res)=>{ const user=(req as any).user; const userId=Number(user.userId); const { groupId, participants }=req.body; if(!groupId||!Array.isArray(participants)) return res.status(400).json({ok:false,error:'missing'}); try{ const r=await promoteGroupAdmin(userId,groupId,participants); return res.json({ok:true,result:r}); }catch(e:any){return res.status(500).json({ok:false,error:String(e.message||e)})} });
router.post("/protected/group/demote", async (req,res)=>{ const user=(req as any).user; const userId=Number(user.userId); const { groupId, participants }=req.body; if(!groupId||!Array.isArray(participants)) return res.status(400).json({ok:false,error:'missing'}); try{ const r=await demoteGroupAdmin(userId,groupId,participants); return res.json({ok:true,result:r}); }catch(e:any){return res.status(500).json({ok:false,error:String(e.message||e)})} });

router.post("/protected/send-otp", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId); const { phone } = req.body;
  if (!phone) return res.status(400).json({ ok: false, error: "phone required" });
  const sanitized = sanitizePhone(phone); if (!sanitized) return res.status(400).json({ ok: false, error: "invalid phone" });
  const sock = getSocket(userId);
  if (!sock || !isConnected(userId)) return res.status(400).json({ ok: false, error: "whatsapp not connected" });
  const code = genOtpCode(6); const ttl = Number(process.env.OTP_TTL_SECONDS || 300);
  try {
    await pool.query("INSERT INTO otps (user_id, phone, code, expires_at) VALUES (?, ?, ?, ?)", [userId, `${sanitized}@s.whatsapp.net`, code, nowSeconds() + ttl]);
    await sock.sendMessage(`${sanitized}@s.whatsapp.net`, { text: `Kode OTP Anda: ${code}\nBerlaku ${ttl} detik.` });
    return res.json({ ok: true, message: "OTP sent" });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/verify-otp", async (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ ok: false, error: "phone & code required" });
  try {
    const [rows]: any = await pool.query("SELECT id, user_id, expires_at, consumed FROM otps WHERE phone = ? AND code = ? LIMIT 1", [phone, code]);
    if ((rows as any[]).length === 0) return res.status(400).json({ ok: false, error: "invalid code" });
    const otp: any = rows[0];
    if (otp.consumed) return res.status(400).json({ ok: false, error: "code already used" });
    if (otp.expires_at < nowSeconds()) return res.status(400).json({ ok: false, error: "code expired" });
    await pool.query("UPDATE otps SET consumed=1 WHERE id=?", [otp.id]);
    return res.json({ ok: true, message: "verified", userId: otp.user_id });
  } catch (e:any) { return res.status(500).json({ ok: false, error: String(e.message || e) }); }
});

router.post("/protected/broadcast", upload.single("file"), async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const messageBody = String(req.body.message || "");
  if (!messageBody) return res.status(400).json({ ok: false, error: "message required" });
  const file = req.file; if (!file) return res.status(400).json({ ok: false, error: "file required" });
  try {
    const contacts = parseContactsFromBuffer(file.buffer, file.originalname);
    if (contacts.length === 0) return res.status(400).json({ ok: false, error: "no valid recipients" });
    (async () => { try { await processBroadcastJob(userId, file.originalname, file.buffer, messageBody); } catch (err) { console.error("broadcast job error", err); } })();
    return res.json({ ok: true, message: "broadcast started", recipients: contacts.length });
  } catch (e:any) { return res.status(400).json({ ok: false, error: String(e.message || e) }); }
});

export default router;
