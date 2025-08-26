export function genOtpCode(len = 6) {
  let s = "";
  for (let i = 0; i < len; i++) s += Math.floor(Math.random() * 10).toString();
  return s;
}
export function nowSeconds() { return Math.floor(Date.now() / 1000); }
