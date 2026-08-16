import { createHash, randomInt } from "node:crypto";

const SALT = "cus";
const UA_KEY = Buffer.from([0, 1, 14]);
const ALPHABETS = [
  "Dkdpgh2ZmsQB80/MfvV36XI1R45-WUAlEixNLwoqYTOPuzKFjJnry79HbGcaStCe",
  "ckdp1h4ZKsUB80/Mfvw36XIgR25+WQAlEi7NLboqYTOPuzmFjJnryx9HVGDaStCe",
] as const;
const INITIAL_STATE = [
  121,243,55,234,103,36,47,228,30,231,106,6,115,95,78,101,250,207,198,50,
  139,227,220,105,97,143,34,28,194,215,18,100,159,160,43,8,169,217,180,120,
  247,45,90,11,27,197,46,3,84,72,5,68,62,56,221,75,144,79,73,161,
  178,81,64,187,134,117,186,118,16,241,130,71,89,147,122,129,65,40,88,150,
  110,219,199,255,181,254,48,4,195,248,208,32,116,167,69,201,17,124,125,104,
  96,83,80,127,236,108,154,126,204,15,20,135,112,158,13,1,188,164,210,237,
  222,98,212,77,253,42,170,202,26,22,29,182,251,10,173,152,58,138,54,141,
  185,33,157,31,252,132,233,235,102,196,191,223,240,148,39,123,92,82,128,109,
  57,24,38,113,209,245,2,119,153,229,189,214,230,174,232,63,52,205,86,140,
  66,175,111,171,246,133,238,193,99,60,74,91,225,51,76,37,145,211,166,151,
  213,206,0,200,244,176,218,44,184,172,49,216,93,168,53,21,183,41,67,85,
  224,155,226,242,87,177,146,70,190,12,162,19,137,114,25,165,163,192,23,59,
  9,94,179,107,35,7,142,131,239,203,149,136,61,249,14,156,
] as const;
const SORT_INDEX = [
  18,20,52,26,30,34,58,38,40,53,42,21,27,54,55,31,35,57,39,41,43,22,28,
  32,60,36,23,29,33,37,44,45,59,46,47,48,49,50,24,25,65,66,70,71,
] as const;
const XOR_INDEX = [
  18,20,26,30,34,38,40,42,21,27,31,35,39,41,43,22,28,32,36,23,29,33,37,
  44,45,46,47,48,49,50,24,25,52,53,54,55,57,58,59,60,65,66,70,71,
] as const;

export type ABogusSignedUrl = {
  url: string;
  userAgent: string;
};

// Ported from F2's Apache-2.0 a_bogus implementation. Keep the algorithm isolated;
// upstream changes must not leak into the request client or metadata parser.
export function signABogusUrl(
  url: string,
  userAgent: string,
  body = "",
  now = Date.now(),
): ABogusSignedUrl {
  const parsed = new URL(url);
  const params = parsed.searchParams.toString();
  const fingerprint = generateFingerprint();
  const queryHash = doubleSm3(params);
  const bodyHash = doubleSm3(body);
  const uaHash = sm3(customBase64(rc4(UA_KEY, Buffer.from(userAgent, "utf8")), 1));
  const values: Record<number, number> = {
    8: 3,
    18: 44,
    20: byte(now, 3), 21: byte(now, 2), 22: byte(now, 1), 23: byte(now, 0),
    24: Math.floor(now / 2 ** 32), 25: Math.floor(now / 2 ** 40),
    26: 0, 27: 0, 28: 0, 29: 0,
    30: 0, 31: 1, 32: 0, 33: 0,
    34: 0, 35: 0, 36: 0, 37: 14,
    38: queryHash[21], 39: queryHash[22],
    40: bodyHash[21], 41: bodyHash[22],
    42: uaHash[23], 43: uaHash[24],
    44: byte(now, 3), 45: byte(now, 2), 46: byte(now, 1), 47: byte(now, 0),
    48: 3, 49: Math.floor(now / 2 ** 32), 50: Math.floor(now / 2 ** 40),
    51: 0, 52: 0, 53: 0, 54: 0, 55: 0,
    56: 6383, 57: 6383 & 255, 58: (6383 >>> 8) & 255, 59: 0, 60: 0,
    64: fingerprint.length, 65: fingerprint.length,
    66: 0, 69: 0, 70: 0, 71: 0,
  };
  const payload = SORT_INDEX.map((index) => values[index] ?? 0);
  payload.push(...Buffer.from(fingerprint, "ascii"));
  payload.push(XOR_INDEX.reduce((result, index) => result ^ (values[index] ?? 0), 0));

  const encoded = encodeABogus(Buffer.concat([
    randomObfuscationBytes(),
    transform(Buffer.from(payload)),
  ]));
  parsed.searchParams.set("a_bogus", encoded);
  return { url: parsed.toString(), userAgent };
}

function doubleSm3(value: string): Buffer {
  return sm3(sm3(Buffer.from(value + SALT, "utf8")));
}

function sm3(value: string | Buffer): Buffer {
  return createHash("sm3").update(value).digest();
}

function byte(value: number, index: number): number {
  return Math.floor(value / 2 ** (index * 8)) & 255;
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < state.length; i += 1) {
    j = (j + state[i] + key[i % key.length]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
  }
  const result = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let offset = 0; offset < data.length; offset += 1) {
    i = (i + 1) & 255;
    j = (j + state[i]) & 255;
    [state[i], state[j]] = [state[j], state[i]];
    result[offset] = data[offset] ^ state[(state[i] + state[j]) & 255];
  }
  return result;
}

function customBase64(data: Buffer, alphabetIndex: number): string {
  const standard = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const alphabet = ALPHABETS[alphabetIndex];
  return data.toString("base64").replace(/[A-Za-z0-9+/]/g, (char) => alphabet[standard.indexOf(char)]);
}

function encodeABogus(data: Buffer): string {
  const alphabet = ALPHABETS[0];
  let result = "";
  for (let offset = 0; offset < data.length; offset += 3) {
    const remaining = data.length - offset;
    const value = (data[offset] << 16) | ((data[offset + 1] ?? 0) << 8) | (data[offset + 2] ?? 0);
    result += alphabet[(value >>> 18) & 63] + alphabet[(value >>> 12) & 63];
    if (remaining > 1) result += alphabet[(value >>> 6) & 63];
    if (remaining > 2) result += alphabet[value & 63];
  }
  return result + "=".repeat((4 - result.length % 4) % 4);
}

function transform(data: Buffer): Buffer {
  const state: number[] = [...INITIAL_STATE];
  const result = Buffer.alloc(data.length);
  let indexB = state[1];
  let initial = 0;
  let valueE = 0;
  for (let index = 0; index < data.length; index += 1) {
    let sum: number;
    if (index === 0) {
      initial = state[indexB];
      sum = indexB + initial;
      state[1] = initial;
      state[indexB] = indexB;
    } else {
      sum = initial + valueE;
    }
    sum %= state.length;
    result[index] = data[index] ^ state[sum];
    valueE = state[(index + 2) % state.length];
    sum = (indexB + valueE) % state.length;
    initial = state[sum];
    state[sum] = state[(index + 2) % state.length];
    state[(index + 2) % state.length] = initial;
    indexB = sum;
  }
  return result;
}

function randomObfuscationBytes(): Buffer {
  const result: number[] = [];
  for (let index = 0; index < 3; index += 1) {
    const random = randomInt(10_000);
    result.push(
      ((random & 255) & 170) | 1,
      ((random & 255) & 85) | 2,
      (((random >>> 8) & 170) | 5),
      (((random >>> 8) & 85) | 40),
    );
  }
  return Buffer.from(result);
}

function generateFingerprint(): string {
  const innerWidth = randomInt(1024, 1921);
  const innerHeight = randomInt(768, 1081);
  const outerWidth = innerWidth + randomInt(24, 33);
  const outerHeight = innerHeight + randomInt(75, 91);
  return [
    innerWidth, innerHeight, outerWidth, outerHeight, 0, randomInt(2) ? 30 : 0, 0, 0,
    randomInt(1024, 1921), randomInt(768, 1081), randomInt(1280, 1921), randomInt(800, 1081),
    innerWidth, innerHeight, 24, 24, "Win32",
  ].join("|");
}