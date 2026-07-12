import { createHash } from "node:crypto";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";
const UA_KEY = Buffer.from([0, 1, 12]);
const CHARACTER = "Dkdpgh4ZKsQB80/Mfvw36XI1R25-WUAlEi7NLboqYTOPuzmFjJnryx9HVGcaStCe=";

export type SignedDouyinUrl = {
  url: string;
  userAgent: string;
  xBogus: string;
};

// Ported from the downloader reference project's Apache-licensed X-Bogus helper.
// Keep this module isolated: Douyin signature schemes change often.
export function signDouyinUrl(url: string, userAgent = DEFAULT_USER_AGENT): SignedDouyinUrl {
  const uaMd5Array = md5StringToArray(md5(rc4(UA_KEY, Buffer.from(userAgent, "latin1")).toString("base64")));
  const emptyMd5Array = md5StringToArray(md5(md5StringToArray("d41d8cd98f00b204e9800998ecf8427e")));
  const urlMd5Array = md5Encrypt(url);
  const timer = Math.floor(Date.now() / 1000);
  const ct = 536919696;
  const values = [
    64,
    0,
    1,
    12,
    urlMd5Array[14],
    urlMd5Array[15],
    emptyMd5Array[14],
    emptyMd5Array[15],
    uaMd5Array[14],
    uaMd5Array[15],
    (timer >> 24) & 255,
    (timer >> 16) & 255,
    (timer >> 8) & 255,
    timer & 255,
    (ct >> 24) & 255,
    (ct >> 16) & 255,
    (ct >> 8) & 255,
    ct & 255,
  ];

  const checksum = values.slice(1).reduce((current, value) => current ^ value, values[0]);
  values.push(checksum);

  const even: number[] = [];
  const odd: number[] = [];
  for (let index = 0; index < values.length; index += 2) {
    even.push(values[index]);
    if (index + 1 < values.length) {
      odd.push(values[index + 1]);
    }
  }

  const converted = encodingConversion([...even, ...odd]);
  const encrypted = rc4(Buffer.from("ÿ", "latin1"), Buffer.from(converted, "latin1")).toString("latin1");
  const garbled = String.fromCharCode(2, 255) + encrypted;
  let xBogus = "";
  for (let index = 0; index < garbled.length; index += 3) {
    xBogus += calculation(
      garbled.charCodeAt(index),
      garbled.charCodeAt(index + 1),
      garbled.charCodeAt(index + 2),
    );
  }

  return {
    url: `${url}&X-Bogus=${xBogus}`,
    userAgent,
    xBogus,
  };
}

function md5(input: string | number[] | Buffer): string {
  const data = typeof input === "string"
    ? Buffer.from(md5StringToArray(input))
    : Buffer.from(input);
  return createHash("md5").update(data).digest("hex");
}

function md5Encrypt(url: string): number[] {
  return md5StringToArray(md5(md5StringToArray(md5(url))));
}

function md5StringToArray(value: string): number[] {
  if (value.length > 32) {
    return Array.from(value, (char) => char.charCodeAt(0));
  }

  const result: number[] = [];
  for (let index = 0; index < value.length; index += 2) {
    result.push(Number.parseInt(value.slice(index, index + 2), 16));
  }
  return result;
}

function rc4(key: Buffer, data: Buffer): Buffer {
  const state = Array.from({ length: 256 }, (_, index) => index);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + state[i] + key[i % key.length]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
  }

  const output = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let index = 0; index < data.length; index += 1) {
    i = (i + 1) % 256;
    j = (j + state[i]) % 256;
    [state[i], state[j]] = [state[j], state[i]];
    output[index] = data[index] ^ state[(state[i] + state[j]) % 256];
  }
  return output;
}

function encodingConversion(values: number[]): string {
  const [
    a, b, c, e, d, t, f, r, n, o, i, underscore, x, u, s, l, v, h, p,
  ] = values;
  return String.fromCharCode(a, i, b, underscore, c, x, e, u, d, s, t, l, f, v, r, h, n, p, o);
}

function calculation(first: number, second: number, third: number): string {
  const value = ((first & 255) << 16) | ((second & 255) << 8) | (third & 255);
  return (
    CHARACTER[(value & 16515072) >> 18] +
    CHARACTER[(value & 258048) >> 12] +
    CHARACTER[(value & 4032) >> 6] +
    CHARACTER[value & 63]
  );
}
