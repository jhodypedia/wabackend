import express from "express";
import http from "http";
import bodyParser from "body-parser";
import cors from "cors";
import dotenv from "dotenv";
dotenv.config();

import { WebSocketServer } from "ws";
import authRoutes from "./routes/auth";
import whatsappRoutes from "./routes/whatsapp";
import userRoutes from "./routes/user";
import adminRoutes from "./routes/admin";
import { subscribe, unsubscribe } from "./baileysManager";

const PORT_API = Number(process.env.PORT_API || 3001);
const PORT_WS = Number(process.env.PORT_WS || 3002);

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "5mb" }));
app.use(bodyParser.urlencoded({ extended: true }));

// public auth
app.use("/api", authRoutes);

// whatsapp routes
app.use("/api", whatsappRoutes);

// user
app.use("/api", userRoutes);

// admin (includes admin routes)
app.use("/api", adminRoutes);

const server = http.createServer(app);
server.listen(PORT_API, () => console.log(`REST API running at http://localhost:${PORT_API}`));

// WebSocket server (token in query)
const wss = new WebSocketServer({ port: PORT_WS });
console.log(`WebSocket server running at ws://localhost:${PORT_WS}`);

wss.on("connection", (ws, req) => {
  const url = (req.url || "");
  const params = new URLSearchParams(url.split("?")[1]);
  const token = params.get("token");
  if (!token) { ws.send(JSON.stringify({ type: "error", message: "token required" })); ws.close(); return; }
  try {
    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "secret") as any;
    const userId = Number(decoded.userId);
    const cb = (ev: any) => { try { ws.send(JSON.stringify(ev)); } catch {} };
    subscribe(userId, cb);
    ws.send(JSON.stringify({ type: "ws_connected", userId }));
    ws.on("message", (raw) => { try { const data = JSON.parse(String(raw)); if (data.action === "ping") ws.send(JSON.stringify({ type: "pong" })); } catch {} });
    ws.on("close", () => { unsubscribe(userId, cb); });
  } catch (e) {
    ws.send(JSON.stringify({ type: "error", message: "invalid token" })); ws.close(); return;
  }
});
