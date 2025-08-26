export function sanitizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let s = String(raw).trim();
  s = s.replace(/[^\d+]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  if (s.startsWith("0")) s = "62" + s.slice(1);
  if (!/^\d{6,15}$/.test(s)) return null;
  return s;
}
