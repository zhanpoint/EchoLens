export type DouyinClientListKind = "favorites" | "following" | "bilibili-favorites-v5";

type DouyinClientListRecord = {
  data: unknown;
  key: string;
  refreshedAt: number;
};

export type DouyinClientSnapshot<T> = {
  data: T;
  refreshedAt: number;
};

const DATABASE_NAME = "echolens-client-cache";
const DATABASE_VERSION = 1;
const STORE_NAME = "douyin-lists";

export async function readDouyinClientSnapshot<T>(
  userId: string,
  kind: DouyinClientListKind,
  parse: (value: unknown) => T | null,
): Promise<DouyinClientSnapshot<T> | null> {
  const database = await openDatabase();
  try {
    const record = await requestToPromise<DouyinClientListRecord | undefined>(
      database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(cacheKey(userId, kind)),
    );
    if (!record) {
      return null;
    }
    const data = parse(record.data);
    if (data === null) {
      return null;
    }
    return {
      data,
      refreshedAt: Number.isFinite(record.refreshedAt) ? record.refreshedAt : 0,
    };
  } finally {
    database.close();
  }
}

export async function writeDouyinClientSnapshot<T>(
  userId: string,
  kind: DouyinClientListKind,
  data: T,
  refreshedAt = Date.now(),
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      data,
      key: cacheKey(userId, kind),
      refreshedAt,
    } satisfies DouyinClientListRecord);
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

function cacheKey(userId: string, kind: DouyinClientListKind): string {
  return `${userId}:${kind}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") {
    return Promise.reject(new Error("当前浏览器不支持本地列表缓存。"));
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地列表缓存打开失败。"));
    request.onblocked = () => reject(new Error("本地列表缓存正在被其他页面占用，请关闭其他页面后重试。"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("本地列表缓存读取失败。"));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("本地列表缓存写入失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("本地列表缓存写入已中止。"));
  });
}
