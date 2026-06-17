const DB_NAME = "ai-glasses-media";
const STORE_NAME = "media-items";
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("kind", "kind");
      }
    };
  });
}

async function withStore(mode, fn) {
  const db = await openDb();
  return await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let settled = false;

    tx.oncomplete = () => {
      db.close();
      if (!settled) {
        resolve(undefined);
      }
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error);
    };
    tx.onabort = () => {
      db.close();
      reject(tx.error || new Error("IndexedDB transaction aborted"));
    };

    Promise.resolve(fn(store, tx))
      .then((value) => {
        settled = true;
        resolve(value);
      })
      .catch((error) => {
        reject(error);
      });
  });
}

export async function saveMediaItem(item) {
  const record = {
    ...item,
    updatedAt: Date.now()
  };
  await withStore("readwrite", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.put(record);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(record);
    });
  });
  return record;
}

export async function listMediaItems() {
  return await withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const items = (request.result || []).sort((a, b) => b.createdAt - a.createdAt);
        resolve(items);
      };
    });
  });
}

export async function getMediaItem(id) {
  return await withStore("readonly", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result || null);
    });
  });
}

export async function deleteMediaItem(id) {
  await withStore("readwrite", (store) => {
    return new Promise((resolve, reject) => {
      const request = store.delete(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  });
}
