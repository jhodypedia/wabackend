import makeWASocket, {
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  WASocket,
  proto,
  DisconnectReason
} from "@whiskeysockets/baileys";
import pino from "pino";
import path from "path";
import fs from "fs";
import qrcode from "qrcode";
import { pool } from "./config/db";
import { saveIncomingMedia } from "./utils/media";
import sharp from "sharp";
import { rm } from "fs/promises";

const logger = pino({ level: "info", base: undefined });

type ClientCB = (ev: any) => void;

/**
 * sockets:
 *  - maps userId -> { sock, connected, reconnecting, retryCount }
 *  - we keep reconnect state to avoid double-reconnect attempts
 */
const sockets: Map<number, { sock?: WASocket; connected: boolean; reconnecting: boolean; retryCount: number }> = new Map();
const callbacks: Map<number, Set<ClientCB>> = new Map();

function ensureAuthDir(root: string, userId: number) {
  const dir = path.join(process.cwd(), root, String(userId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * calculate backoff delay in ms (exponential with cap)
 */
function backoffDelay(retryCount: number) {
  const base = 2000; // 2s
  const max = 60 * 1000; // 1 min
  const jitter = Math.floor(Math.random() * 1000);
  const delay = Math.min(base * Math.pow(2, retryCount), max) + jitter;
  return delay;
}

/**
 * Push event to any WS subscribers for a user
 */
function pushToUser(userId: number, payload: any) {
  const set = callbacks.get(userId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb(payload);
    } catch (e) {
      // ignore subscriber errors
    }
  }
}

/**
 * Create the Baileys socket for a user.
 * This function is idempotent: if socket exists and connected, returns it.
 * It sets up `connection.update` handling including auto-reconnect with backoff.
 */
export async function createOrGetSocket(userId: number, waAuthRoot: string) {
  // if we already have an entry that is connected, return sock
  const entry = sockets.get(userId);
  if (entry && entry.sock && entry.connected) {
    return entry.sock;
  }

  // if we already have an entry and it's reconnecting, return existing sock (may be undefined)
  if (entry && entry.reconnecting) {
    return entry.sock;
  }

  // ensure we have a socket state object
  sockets.set(userId, { sock: entry?.sock, connected: false, reconnecting: false, retryCount: entry?.retryCount ?? 0 });

  // call internal creator
  return await createSocketInternal(userId, waAuthRoot);
}

async function createSocketInternal(userId: number, waAuthRoot: string) {
  const authFolder = ensureAuthDir(waAuthRoot, userId);

  // mark reconnecting to prevent race
  const meta = sockets.get(userId)!;
  meta.reconnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    // keep a fresh version
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
      version,
      printQRInTerminal: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      browser: ["WebPanel", "Chrome", "1.0.0"],
      // optional: keepAliveIntervalMs: 20_000
    });

    // assign sock to map immediately (so other calls can reference it)
    meta.sock = sock;
    meta.reconnecting = false;
    meta.retryCount = 0; // reset retry count on fresh create attempt

    // persist credentials
    sock.ev.on("creds.update", saveCreds);

    // handle connection updates
    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          // send QR as data url (frontend can display)
          try {
            const dataUrl = await qrcode.toDataURL(qr);
            pushToUser(userId, { type: "qr", qr, qrDataUrl: dataUrl });
          } catch {
            pushToUser(userId, { type: "qr", qr });
          }
        }

        if (connection === "open") {
          // connected successfully
          meta.connected = true;
          meta.reconnecting = false;
          meta.retryCount = 0;
          // save session meta to DB
          try {
            await pool.query(
              "INSERT INTO sessions_meta (user_id, auth_folder, connected, last_seen) VALUES (?, ?, 1, NOW()) ON DUPLICATE KEY UPDATE connected=1, last_seen=NOW(), auth_folder=VALUES(auth_folder)",
              [userId, authFolder]
            );
          } catch (e) {
            logger.warn({ err: e }, "failed to update sessions_meta");
          }
          pushToUser(userId, { type: "status", status: "connected" });
          logger.info({ userId }, "connection open");
        } else if (connection === "close") {
          meta.connected = false;
          pushToUser(userId, { type: "status", status: "disconnected", lastDisconnect });
          logger.warn({ userId, lastDisconnect }, "connection closed");

          // Inspect lastDisconnect for reason
          const reason = (lastDisconnect && (lastDisconnect.error as any)) || null;
          // If reason indicates logged out -> don't attempt auto reconnect. Must re-scan QR.
          const isLoggedOut = reason && typeof reason === "object" && (reason?.output?.statusCode === DisconnectReason?.loggedOut || reason?.statusCode === DisconnectReason?.loggedOut);

          if (isLoggedOut) {
            logger.info({ userId }, "session logged out. clearing auth? (admin may delete auth folder manually)");
            // mark session disconnected in DB
            try { await pool.query("UPDATE sessions_meta SET connected=0 WHERE user_id = ?", [userId]); } catch {}
            // leave reconnection to admin action: do not auto-reconnect
            meta.reconnecting = false;
            return;
          }

          // Otherwise: transient disconnect -> attempt reconnect with backoff
          meta.reconnecting = true;
          meta.retryCount = (meta.retryCount || 0) + 1;
          const delay = backoffDelay(meta.retryCount);
          logger.info({ userId, retryCount: meta.retryCount, delay }, "scheduling reconnect");

          setTimeout(async () => {
            try {
              // avoid duplicate creation if another reconnection already succeeded
              const cur = sockets.get(userId);
              if (cur && cur.connected) {
                logger.info({ userId }, "already reconnected by parallel flow, skip recon");
                cur.reconnecting = false;
                return;
              }
              // clean up previous socket listeners before creating a new one
              try {
                if (meta.sock) {
                  meta.sock.ev.removeAllListeners();
                  try { await meta.sock.logout(); } catch {}
                }
              } catch (e) { /* ignore */ }

              await createSocketInternal(userId, waAuthRoot);
            } catch (e) {
              logger.error({ e, userId }, "reconnect attempt failed");
              meta.reconnecting = false;
            }
          }, delay);
        }
      } catch (e) {
        logger.error({ e, userId }, "error in connection.update handler");
      }
    });

    // messages handler: forward to subscribers & save media when needed
    sock.ev.on("messages.upsert", async (m) => {
      try {
        pushToUser(userId, { type: "messages.upsert", payload: m });
        const msg = m.messages?.[0];
        if (!msg || msg.key.fromMe) return;
        if (msg.message?.imageMessage || msg.message?.videoMessage || msg.message?.documentMessage || msg.message?.audioMessage) {
          try {
            const media = await saveIncomingMedia(msg.message as proto.IMessage, msg.key.id || String(Date.now()));
            if (media) pushToUser(userId, { type: "media.saved", media, key: msg.key });
          } catch (err) {
            logger.warn({ err }, "failed saving incoming media");
          }
        }
      } catch (err) {
        logger.error({ err }, "messages.upsert handler error");
      }
    });

    // store the socket in map
    sockets.set(userId, { sock, connected: false, reconnecting: false, retryCount: 0 });

    return sock;
  } catch (err) {
    logger.error({ err, userId }, "failed to create socket");
    // schedule retry on creation failure (e.g., network or filesystem)
    const cur = sockets.get(userId);
    cur!.reconnecting = true;
    cur!.retryCount = (cur!.retryCount || 0) + 1;
    const delay = backoffDelay(cur!.retryCount);
    setTimeout(() => {
      // attempt again
      createSocketInternal(userId, waAuthRoot).catch((e) => logger.error({ e, userId }, "retry createSocketInternal failed"));
    }, delay);
    throw err;
  } finally {
    // meta.reconnecting will be updated inside flows
  }
}

/** Return socket instance (if exists) */
export function getSocket(userId: number) {
  return sockets.get(userId)?.sock;
}

/** Return whether connected */
export function isConnected(userId: number) {
  return sockets.get(userId)?.connected === true;
}

/** Subscribe / unsubscribe for WS events */
export function subscribe(userId: number, cb: ClientCB) {
  let set = callbacks.get(userId);
  if (!set) { set = new Set(); callbacks.set(userId, set); }
  set.add(cb);
}
export function unsubscribe(userId: number, cb: ClientCB) {
  const set = callbacks.get(userId);
  if (!set) return;
  set.delete(cb);
  if (set.size === 0) callbacks.delete(userId);
}

/** sendMessageAndLog (unchanged behavior: insert into DB, attempt send, update status) */
export async function sendMessageAndLog(userId: number, toPhone: string, content: any, quoted?: any) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  const sock = entry.sock!;
  const jid = toPhone.includes("@") ? toPhone : `${toPhone}@s.whatsapp.net`;

  const conn = await pool.getConnection();
  let messageId = 0;
  try {
    const [res]: any = await conn.query("INSERT INTO messages (user_id, to_phone, jid, body, status) VALUES (?, ?, ?, ?, ?)", [userId, toPhone, jid, typeof content.text === "string" ? content.text : JSON.stringify(content), "sending"]);
    messageId = res.insertId;
  } finally {
    conn.release();
  }

  try {
    const sendOpts: any = {};
    if (quoted) sendOpts.quoted = quoted;
    const result = await sock.sendMessage(jid, content, sendOpts);
    const extId = (result?.key?.id) || null;
    await pool.query("UPDATE messages SET status=?, external_id=?, updated_at=NOW() WHERE id=?", ["sent", extId, messageId]);
    pushToUser(userId, { type: "message.update", messageId, status: "sent", to: jid, external_id: extId });
    return { ok: true, messageId, extId };
  } catch (e: any) {
    const errText = String(e?.message || e);
    await pool.query("UPDATE messages SET status=?, error_text=?, updated_at=NOW() WHERE id=?", ["failed", errText, messageId]);
    pushToUser(userId, { type: "message.update", messageId, status: "failed", error: errText });
    throw e;
  }
}

/** send media helpers (image/video/document/audio) */
export async function sendMediaFromFile(userId: number, filePath: string, toPhone: string, caption = "") {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  const sock = entry.sock!;
  const jid = toPhone.includes("@") ? toPhone : `${toPhone}@s.whatsapp.net`;
  const fileName = path.basename(filePath);
  const ext = path.extname(fileName).toLowerCase();
  let content: any = {};
  if ([".jpg", ".jpeg", ".png", ".gif"].includes(ext)) content = { image: { url: filePath, caption } };
  else if ([".mp4", ".mov"].includes(ext)) content = { video: { url: filePath, caption } };
  else if ([".mp3", ".ogg", ".m4a"].includes(ext)) content = { audio: { url: filePath } };
  else content = { document: { url: filePath, fileName } };
  return await sendMessageAndLog(userId, toPhone, content);
}

/** sticker via sharp */
export async function sendStickerFromImage(userId: number, toPhone: string, imagePath: string) {
  const out = imagePath.replace(/\.[^/.]+$/, "") + ".webp";
  await sharp(imagePath).webp({ quality: 90 }).toFile(out);
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  const sock = entry.sock!;
  const jid = toPhone.includes("@") ? toPhone : `${toPhone}@s.whatsapp.net`;
  return await sock.sendMessage(jid, { sticker: { url: out } });
}

/** buttons & list wrappers (use sendMessageAndLog to track) */
export async function sendButtons(userId: number, toPhone: string, text: string, buttons: any[], footer?: string) {
  return await sendMessageAndLog(userId, toPhone, { text, buttons, footer: footer || "Bot" });
}
export async function sendList(userId: number, toPhone: string, text: string, buttonText: string, sections: any[]) {
  return await sendMessageAndLog(userId, toPhone, { text, buttonText, sections });
}

/** reaction/presence/group helpers (call underlying sock directly) */
export async function sendReaction(userId: number, remoteJid: string, key: any, emoji: string) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.sendMessage(remoteJid, { react: { text: emoji, key } });
}
export async function sendPresence(userId: number, toPhone: string, type: "composing" | "recording" | "available" | "unavailable") {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  const jid = toPhone.includes("@") ? toPhone : `${toPhone}@s.whatsapp.net`;
  return await entry.sock!.sendPresenceUpdate(type, jid);
}
export async function createGroup(userId: number, subject: string, participants: string[]) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.groupCreate(subject, participants);
}
export async function addGroupParticipants(userId: number, groupId: string, participants: string[]) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.groupAdd(groupId, participants);
}
export async function removeGroupParticipants(userId: number, groupId: string, participants: string[]) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.groupRemove(groupId, participants);
}
export async function promoteGroupAdmin(userId: number, groupId: string, participants: string[]) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.groupMakeAdmin(groupId, participants);
}
export async function demoteGroupAdmin(userId: number, groupId: string, participants: string[]) {
  const entry = sockets.get(userId);
  if (!entry || !entry.sock || !entry.connected) throw new Error("not connected");
  return await entry.sock!.groupDemoteAdmin(groupId, participants);
}

/** Disconnect session gracefully (close socket) */
export async function disconnectSession(userId: number) {
  const entry = sockets.get(userId);
  if (!entry) return false;
  try {
    if (entry.sock) {
      try { await entry.sock.logout(); } catch (e) { /* ignore */ }
      try { entry.sock.ev.removeAllListeners(); } catch (e) { /* ignore */ }
    }
    sockets.delete(userId);
    await pool.query("UPDATE sessions_meta SET connected=0 WHERE user_id = ?", [userId]);
    return true;
  } catch (e) {
    logger.error({ e }, "disconnectSession error");
    return false;
  }
}

/** Delete auth folder from disk (permanently remove session files) */
export async function deleteAuthFolder(waAuthRoot: string, userId: number) {
  const dir = path.join(process.cwd(), waAuthRoot, String(userId));
  if (!fs.existsSync(dir)) return false;
  await disconnectSession(userId);
  try {
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch (e) {
    logger.error({ e, dir }, "deleteAuthFolder error");
    return false;
  }
}
