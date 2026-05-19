// IndexedDB ラッパ: 直近の FileSystemFileHandle を 1 件だけ保存・取得・削除する。
// localStorage に格納できない FSA ハンドルを永続化するためのストア。
//
// オリジナルでは saveHandle / loadHandle / deleteHandle がほぼ同形のボイラープレートを
// 三度繰り返していたため、withStore() で共通化した。

import { IDB_DB_NAME, IDB_STORE, IDB_HANDLE_KEY } from './constants.js';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB 非対応')); return; }
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * DB を開き、指定モードでオブジェクトストアを得て `op(store)` を実行し、
 * トランザクション完了まで待ってから DB を閉じる。
 *
 * - 取得系: `op` 内で `request = store.get(key)` した場合、`request.result` を
 *   トランザクション完了後に返したいので request 自体を return する。
 *   withStore はそれを検出して `request.result || null` で解決する。
 * - 更新系: `op` は何も返さなくてよい（または undefined）。トランザクション
 *   完了時に undefined で解決する。
 */
function withStore(mode, op) {
  return new Promise((resolve, reject) => {
    idbOpen().then(db => {
      const tx = db.transaction(IDB_STORE, mode);
      const store = tx.objectStore(IDB_STORE);
      let req;
      try { req = op(store); } catch (e) { try { db.close(); } catch (_) {} reject(e); return; }
      tx.onerror = () => { try { db.close(); } catch (_) {} reject(tx.error); };
      tx.onabort = () => { try { db.close(); } catch (_) {} reject(tx.error); };
      tx.oncomplete = () => {
        try { db.close(); } catch (_) {}
        // 取得系のみ req に結果が乗る
        if (req && typeof req === 'object' && 'result' in req) resolve(req.result || null);
        else resolve();
      };
    }).catch(reject);
  });
}

export async function saveHandleToIdb(handle) {
  try {
    await withStore('readwrite', store => { store.put(handle, IDB_HANDLE_KEY); });
  } catch (_) { /* 非対応 / クォータ等は握りつぶす */ }
}

export async function loadHandleFromIdb() {
  try {
    return await withStore('readonly', store => store.get(IDB_HANDLE_KEY));
  } catch (_) { return null; }
}

export async function deleteHandleFromIdb() {
  try {
    await withStore('readwrite', store => { store.delete(IDB_HANDLE_KEY); });
  } catch (_) { /* noop */ }
}
