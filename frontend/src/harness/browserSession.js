// Serialize the first Cookie exchange across tabs on HTTPS and local HTTP.
let ready;

async function initialize() {
  const response = await fetch('/api/harness/session', {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error('Unable to initialize the browser session.');
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('satgpt-browser-session', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('lock');
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

async function withIndexedDbLock(callback) {
  const db = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('lock', 'readwrite');
      const store = transaction.objectStore('lock');
      let operation;
      let settled = false;
      // The transaction owns the lock across tabs. Keep a request outstanding
      // while the server response sets the Cookie, then release the lock.
      function keepAlive() {
        store.get('session').onsuccess = () => {
          if (!operation) {
            operation = callback().then(
              () => { settled = true; },
              error => { settled = true; reject(error); },
            );
          }
          if (!settled) keepAlive();
        };
      }
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Browser session locking failed.'));
      keepAlive();
    });
  } finally {
    db.close();
  }
}

export function ensureBrowserSession() {
  if (!ready) {
    ready = (navigator.locks
      ? navigator.locks.request('satgpt-browser-session', initialize)
      : withIndexedDbLock(initialize)).catch(error => {
      ready = null;
      throw error;
    });
  }
  return ready;
}

