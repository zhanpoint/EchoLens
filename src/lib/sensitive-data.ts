import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

export type EncryptedValue = {
  ciphertext: string;
  iv: string;
  tag: string;
  version: 1;
};

export function encryptSensitiveValue(value: string, context: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, readEncryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);

  return {
    ciphertext: ciphertext.toString("base64url"),
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    version: 1,
  };
}

export function decryptSensitiveValue(value: EncryptedValue, context: string): string {
  const decipher = createDecipheriv(ALGORITHM, readEncryptionKey(), Buffer.from(value.iv, "base64url"));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(value.tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

export function isEncryptedValue(value: unknown): value is EncryptedValue {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<EncryptedValue>;
  return candidate.version === 1
    && typeof candidate.ciphertext === "string"
    && typeof candidate.iv === "string"
    && typeof candidate.tag === "string";
}

function readEncryptionKey(): Buffer {
  const secret = process.env.DATA_ENCRYPTION_KEY;
  if (secret && secret.length >= 32) {
    return createHash("sha256").update(secret).digest();
  }
  throw new Error("DATA_ENCRYPTION_KEY must be at least 32 characters.");
}
