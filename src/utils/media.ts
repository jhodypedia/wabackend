import { downloadContentFromMessage, proto } from "@whiskeysockets/baileys";
import { createWriteStream, existsSync, mkdirSync, createReadStream } from "fs";
import path from "path";
import mime from "mime";

const MEDIA_DIR = process.env.MEDIA_DIR || "media";
if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });

export async function saveIncomingMedia(message: proto.IMessage, idHint = Date.now().toString()) {
  const msgType = Object.keys(message)[0] as keyof proto.IMessage;
  const m: any = (message as any)[msgType];
  if (!m || !m.mimetype) return null;

  let streamType: "image" | "video" | "audio" | "document" | null = null;
  if (message.imageMessage) streamType = "image";
  else if (message.videoMessage) streamType = "video";
  else if (message.audioMessage) streamType = "audio";
  else if (message.documentMessage) streamType = "document";

  if (!streamType) return null;

  const ext = mime.getExtension(m.mimetype) || (streamType === "audio" ? "ogg" : "bin");
  const filename = `${idHint}.${ext}`;
  const filepath = path.join(MEDIA_DIR, filename);

  const stream = await downloadContentFromMessage(m, streamType);
  const write = createWriteStream(filepath);
  for await (const chunk of stream) write.write(chunk);
  write.end();

  return { filepath, mimetype: m.mimetype, type: streamType };
}

export function createReadStreamForFile(filepath: string) {
  if (!existsSync(filepath)) throw new Error("file-not-found");
  return createReadStream(filepath);
}
