import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
dotenv.config();
export interface AuthRequest extends Request { user?: any; }

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const auth = req.headers["authorization"] as string | undefined;
  if (!auth) return res.status(401).json({ ok: false, error: "no token" });
  const parts = auth.split(" ");
  if (parts.length !== 2) return res.status(401).json({ ok: false, error: "invalid auth header" });
  const token = parts[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret") as any;
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "invalid token" });
  }
}
