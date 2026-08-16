type SessionCacheRecord = {
  key: string;
  refreshedAt: number;
  userId: string;
  value: unknown;
};

const DATABASE_NAME = "echolens-session-cache";
const DATABASE_VERSION = 3;
const STORE_NAME = "session-data";
const USER_INDEX_NAME = "by-user";

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
      userId,
      value,
    } satisfies SessionCacheRecord);
    await transactionToPromise(transaction);
    await trimUserRecords(database, userId, 100);
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

async function trimUserRecords(database: IDBDatabase, userId: string, limit: number): Promise<void> {
  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  const records = await requestToPromise<SessionCacheRecord[]>(
    store.index(USER_INDEX_NAME).getAll(IDBKeyRange.only(userId)),
  );
  const stale = records
    .sort((left, right) => right.refreshedAt - left.refreshedAt)
    .slice(limit);
  for (const record of stale) store.delete(record.key);
  await transactionToPromise(transaction);
}

function cacheKey(userId: string, key: string): string {
  return `${userId}:${key}`;
}

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const store = request.result.objectStoreNames.contains(STORE_NAME)
        ? request.transaction!.objectStore(STORE_NAME)
        : request.result.createObjectStore(STORE_NAME, { keyPath: "key" });
      if (!store.indexNames.contains(USER_INDEX_NAME)) {
        store.createIndex(USER_INDEX_NAME, "userId");
      }
      if ((event as IDBVersionChangeEvent).oldVersion > 0 && (event as IDBVersionChangeEvent).oldVersion < 3) {
        store.clear();
      }
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