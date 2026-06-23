import crypto from "crypto";

const KEY = process.env["ENCRYPTION_KEY"] || "tradeupdate-default-key-32chars!!";
const ALGORITHM = "aes-256-cbc";
const KEY_BUFFER = Buffer.from(KEY.padEnd(32).slice(0, 32));

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY_BUFFER, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

export function decrypt(encrypted: string): string {
  const [ivHex, data] = encrypted.split(":");
  if (!ivHex || !data) throw new Error("Invalid encrypted data");
  const iv = Buffer.from(ivHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY_BUFFER, iv);
  let decrypted = decipher.update(data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}
