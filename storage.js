// Keeps recent readings in this browser's IndexedDB, so a reload doesn't lose the trend.
// Storage can be blocked or evicted; the page then works for the current visit only.

const DB_NAME = "hs30a";
const STORE = "records";
const RETENTION_MS = 24 * 60 * 60 * 1000;

function request(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

function openDb() {
  const opening = indexedDB.open(DB_NAME, 1);
  opening.onupgradeneeded = () => {
    opening.result.createObjectStore(STORE, { keyPath: "ts" });
  };
  return request(opening);
}

export class RecordStore {
  #db = null;

  /** Opens the store, drops expired readings and returns the rest, oldest first. */
  async load(now = Date.now()) {
    try {
      this.#db = await openDb();
      const store = this.#db.transaction(STORE, "readwrite").objectStore(STORE);
      store.delete(IDBKeyRange.upperBound(now - RETENTION_MS));
      return await request(store.getAll());
    } catch (error) {
      console.warn("Readings will not be saved in this browser", error);
      this.#db = null;
      return [];
    }
  }

  add(record) {
    if (!this.#db) return;
    try {
      this.#db.transaction(STORE, "readwrite").objectStore(STORE).put(record);
    } catch (error) {
      console.warn("Could not save a reading", error);
    }
  }
}
