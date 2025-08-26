import express from "express";
import { authMiddleware } from "../middlewares/auth";
import { pool } from "../config/db";

const router = express.Router();
router.use("/protected", authMiddleware);

router.get("/protected/stats", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  try {
    const [sentRows]: any = await pool.query("SELECT COUNT(*) AS total_sent FROM messages WHERE user_id=? AND status='sent'", [userId]);
    const [failedRows]: any = await pool.query("SELECT COUNT(*) AS total_failed FROM messages WHERE user_id=? AND status='failed'", [userId]);
    const [chartRows]: any = await pool.query(
      `SELECT DATE(created_at) as day, COUNT(*) as total
       FROM messages
       WHERE user_id = ? AND created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 30 DAY)
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at)`,
      [userId]
    );
    return res.json({ ok: true, totals: { sent: sentRows[0].total_sent, failed: failedRows[0].total_failed }, chart: chartRows });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

router.get("/protected/messages", async (req, res) => {
  const user = (req as any).user; const userId = Number(user.userId);
  const page = Math.max(Number(req.query.page || 1), 1); const per = Math.min(Number(req.query.per || 50), 200);
  try {
    const [rows]: any = await pool.query("SELECT * FROM messages WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?", [userId, per, (page - 1) * per]);
    return res.json({ ok: true, messages: rows });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e) }); }
});

export default router;
