import { Response, NextFunction } from "express";
import { AuthRequest } from "./auth";
export function adminOnly(req: AuthRequest, res: Response, next: NextFunction) {
  const u = req.user;
  if (!u || u.role !== "admin") return res.status(403).json({ ok: false, error: "admin required" });
  next();
}
