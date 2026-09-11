// IndexedDB persistence for the `EditLayer` overlay. The whole overlay is
// stored as one JSON record (edits are sparse, so a single object stays small
// for realistic build sizes and avoids the overhead of a per-voxel key).
// Saving is debounced so burst edits (rapid digging) coalesce into one write.
import type { EditLayer } from "./edit-layer";

const DB_NAME = "bms-voxelscape";
const STORE = "edits";

export interface EditPersistence {
  load(): Promise<EditLayer>;
  scheduleSave(): void;
  saveNow(): Promise<void>;
}

const openDb = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const getJson = (db: IDBDatabase, key: string): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key) as IDBRequest;
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error);
  });

const putJson = (db: IDBDatabase, key: string, json: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(json, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

/**
 * Creates a persistence handle bound to `layer`, keyed by `scope` — a place's
 * `at://` address, a demo's synthetic id, or `null` for the default world —
 * so different worlds' overlays don't collide in the one browser database.
 * Loading reads whatever JSON was previously saved under that key and
 * replaces the layer's contents; every subsequent mutation is captured by
 * `scheduleSave` (debounced) and `saveNow`.
 */
export const createEditPersistence = (
  layer: EditLayer,
  scope: string | null,
): EditPersistence => {
  const key = `overlay:${scope ?? "default"}`;
  let dbPromise: Promise<IDBDatabase> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const db = (): Promise<IDBDatabase> => {
    dbPromise ??= openDb();
    return dbPromise;
  };

  const write = async (): Promise<void> => {
    dirty = false;
    try {
      const entries = layer.snapshot();
      await putJson(await db(), key, JSON.stringify(entries));
    } catch (err) {
      console.warn("[edits] failed to persist overlay to IndexedDB.", err);
    }
  };

  return {
    async load(): Promise<EditLayer> {
      try {
        const json = await getJson(await db(), key);
        if (json !== undefined) {
          const entries = JSON.parse(json) as Array<{
            w: [number, number, number];
            edit: { id: number; updatedAt: number };
          }>;
          for (const { w, edit } of entries) {
            layer.set(w, edit.id, edit.updatedAt);
          }
        }
      } catch (err) {
        console.warn("[edits] failed to load overlay from IndexedDB.", err);
      }
      return layer;
    },
    scheduleSave(): void {
      dirty = true;
      if (timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (dirty) {
          void write();
        }
      }, 250);
    },
    async saveNow(): Promise<void> {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await write();
    },
  };
};
