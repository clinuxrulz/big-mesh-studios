// IndexedDB persistence for the place editor's working draft, following the
// edit-overlay persistence's shape: the whole project is one JSON record under
// one key, so a save is a single write, and saving is debounced so a burst of
// keystrokes coalesce into one write rather than one per change.
import type { PlaceProject } from "./project";

const DB_NAME = "bms-voxelscape-places";
const STORE = "draft";
const KEY = "working";

export interface DraftPersistence {
  /** The saved project, or null when none has ever been saved. */
  load(): Promise<PlaceProject | null>;
  /** Writes `project` after the current burst of changes settles, at most once. */
  scheduleSave(project: PlaceProject): void;
  /** Writes `project` now, clearing any pending debounced write. */
  saveNow(project: PlaceProject): Promise<void>;
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

const getJson = (db: IDBDatabase): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(KEY) as IDBRequest;
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error);
  });

const putJson = (db: IDBDatabase, json: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(json, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

/** Whether a parsed value is shaped like a saved project, before it is trusted. */
const isPlaceProject = (v: unknown): v is PlaceProject => {
  if (typeof v !== "object" || v === null) {
    return false;
  }
  const r = v as Record<string, unknown>;
  return (
    typeof r.manifest === "object" &&
    r.manifest !== null &&
    typeof r.scripts === "object" &&
    r.scripts !== null &&
    !Array.isArray(r.scripts)
  );
};

/**
 * A persistence handle for one working draft. Loading reads whatever JSON was
 * previously saved, silently falling back to no draft when nothing was or the
 * record no longer parses; every subsequent mutation is captured by
 * `scheduleSave` (debounced) and `saveNow`.
 */
export const createDraftPersistence = (): DraftPersistence => {
  let dbPromise: Promise<IDBDatabase> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: PlaceProject | null = null;

  const db = (): Promise<IDBDatabase> => {
    dbPromise ??= openDb();
    return dbPromise;
  };

  const write = async (): Promise<void> => {
    if (pending === null) {
      return;
    }
    const saved = pending;
    pending = null;
    try {
      await putJson(await db(), JSON.stringify(saved));
    } catch (err) {
      console.warn("[place draft] failed to persist to IndexedDB.", err);
    }
  };

  return {
    async load() {
      try {
        const json = await getJson(await db());
        if (json === undefined) {
          return null;
        }
        const parsed: unknown = JSON.parse(json);
        return isPlaceProject(parsed) ? parsed : null;
      } catch (err) {
        console.warn("[place draft] failed to load from IndexedDB.", err);
        return null;
      }
    },
    scheduleSave(project) {
      pending = project;
      if (timer !== undefined) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        if (pending !== null) {
          void write();
        }
      }, 250);
    },
    async saveNow(project) {
      pending = project;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      await write();
    },
  };
};
