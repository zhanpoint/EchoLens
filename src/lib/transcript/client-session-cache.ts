type SessionCacheRecord = {
  key: string;
  refreshedAt: number;
  value: unknown;
};

const DATABASE_NAME = "echolens-session-cache";
const DATABASE_VERSION = 2;
const STORE_NAME = "session-data";

export async function readClientSessionCache<T>(
  userId: string,
  key: string,
  maxAgeMs?: number,
): Promise<T | null> {
  const database = await openDatabase();
  try {
    const record = await requestToPromise<SessionCacheRecord | undefined>(
      database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(cacheKey(userId, key)),
    );
    if (!record || (maxAgeMs !== undefined && Date.now() - record.refreshedAt > maxAgeMs)) return null;
    return record.value as T;
  } finally {
    database.close();
  }
}

export async function writeClientSessionCache<T>(
  userId: string,
  key: string,
  value: T,
): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put({
      key: cacheKey(userId, key),
      refreshedAt: Date.now(),
      value,
    } satisfies SessionCacheRecord);
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

export async function deleteClientSessionCache(userId: string, key: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(cacheKey(userId, key));
    await transactionToPromise(transaction);
  } finally {
    database.close();
  }
}

function cacheKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains(STORE_NAME)
        ? request.transaction?.objectStore(STORE_NAME)
        : request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      store?.clear();
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("会话缓存打开失败。"));
  });
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("会话缓存读取失败。"));
  });
}

function transactionToPromise(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("会话缓存写入失败。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("会话缓存写入中止。"));
  });
}