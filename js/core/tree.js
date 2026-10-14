// The work folder: a tree of directories and files, kept either in a real
// folder on disk (where the browser lets a page work in one) or, with the same
// structure, by the browser itself.
//
// A place in the tree is a path: an array of names, [] being the work folder.
// Both stores have the same functions:
//   list(path)            [{ name, kind: "dir" | "file" }], sorted by name
//   read(path)            Uint8Array, or null if there is no such file
//   write(path, data)     data: Uint8Array or string; directories are made as needed
//   mkdir(path)
//   remove(path)          a file, or a directory with all that is in it
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const tree = (WB.tree = {});

  const bytesOf = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : data);

  // ------------------------------------------------------- a folder on disk

  function diskStore(root) {
    // the handle of a directory; null if it is not there (and not to be made)
    async function dir(path, create = false) {
      let handle = root;
      for (const name of path) {
        try {
          handle = await handle.getDirectoryHandle(name, { create });
        } catch (error) {
          if (error.name === "NotFoundError" || error.name === "TypeMismatchError") return null;
          throw error;
        }
      }
      return handle;
    }
    return {
      kind: "disk",
      label: root.name,
      async list(path) {
        const handle = await dir(path);
        const out = [];
        if (handle) for await (const [name, entry] of handle.entries()) out.push({ name, kind: entry.kind === "directory" ? "dir" : "file" });
        return out.sort((a, b) => a.name.localeCompare(b.name));
      },
      async read(path) {
        const handle = await dir(path.slice(0, -1));
        if (!handle) return null;
        try {
          const file = await (await handle.getFileHandle(path[path.length - 1])).getFile();
          return new Uint8Array(await file.arrayBuffer());
        } catch (error) {
          if (error.name === "NotFoundError" || error.name === "TypeMismatchError") return null;
          throw error;
        }
      },
      async write(path, data) {
        const handle = await dir(path.slice(0, -1), true);
        const writable = await (await handle.getFileHandle(path[path.length - 1], { create: true })).createWritable();
        await writable.write(bytesOf(data));
        await writable.close();
      },
      async mkdir(path) {
        await dir(path, true);
      },
      async remove(path) {
        const handle = await dir(path.slice(0, -1));
        if (!handle) return;
        try {
          await handle.removeEntry(path[path.length - 1], { recursive: true });
        } catch (error) {
          if (error.name !== "NotFoundError") throw error;
        }
      },
    };
  }

  // ---------------------------------------------------- kept by the browser

  const DB = "web_blot_tree";
  let opening = null;
  function openOnce() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB, 1);
      request.onupgradeneeded = () => {
        // nodes: "a/b/c" -> { kind: "dir" } | { kind: "file", data: ArrayBuffer }
        request.result.createObjectStore("nodes");
        request.result.createObjectStore("settings"); // the folder on disk that was chosen
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("The browser's storage could not be opened."));
    });
  }

  // The browser can refuse to open its storage for a moment, for instance
  // while the page before is still closing it: try again a few times before
  // taking it that it stores nothing. A failure is not kept, so a later call
  // tries anew.
  function database() {
    if (!opening) {
      opening = (async () => {
        for (let attempt = 1; ; attempt++) {
          try {
            return await openOnce();
          } catch (error) {
            if (attempt >= 4 || error instanceof TypeError || error.name === "SecurityError") throw error;
            await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
          }
        }
      })();
      opening.catch(() => (opening = null));
    }
    return opening;
  }
  const result = (request) =>
    new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  const finished = (tx) =>
    new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("The browser did not store the file."));
    });
  const key = (path) => path.join("/");
  // everything below a directory
  const below = (path) => (path.length ? IDBKeyRange.bound(`${key(path)}/`, `${key(path)}/￿`) : undefined);

  function browserStore() {
    return {
      kind: "browser",
      label: "this browser",
      async list(path) {
        const db = await database();
        const store = db.transaction("nodes").objectStore("nodes");
        const [keys, values] = await Promise.all([result(store.getAllKeys(below(path))), result(store.getAll(below(path)))]);
        const prefix = path.length ? key(path).length + 1 : 0;
        return keys
          .map((k, i) => ({ name: k.slice(prefix), kind: values[i].kind }))
          .filter((entry) => !entry.name.includes("/"))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async read(path) {
        const db = await database();
        const node = await result(db.transaction("nodes").objectStore("nodes").get(key(path)));
        return node && node.kind === "file" ? new Uint8Array(node.data) : null;
      },
      async write(path, data) {
        const db = await database();
        const tx = db.transaction("nodes", "readwrite");
        const done = finished(tx);
        for (let i = 1; i < path.length; i++) tx.objectStore("nodes").put({ kind: "dir" }, key(path.slice(0, i)));
        const bytes = bytesOf(data);
        tx.objectStore("nodes").put({ kind: "file", data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, key(path));
        await done;
      },
      async mkdir(path) {
        const db = await database();
        const tx = db.transaction("nodes", "readwrite");
        const done = finished(tx);
        for (let i = 1; i <= path.length; i++) tx.objectStore("nodes").put({ kind: "dir" }, key(path.slice(0, i)));
        await done;
      },
      async remove(path) {
        const db = await database();
        const tx = db.transaction("nodes", "readwrite");
        const done = finished(tx);
        tx.objectStore("nodes").delete(key(path));
        tx.objectStore("nodes").delete(below(path));
        await done;
      },
    };
  }

  // a store that holds nothing and keeps nothing: where the browser stores nothing at all
  function noStore() {
    const files = new Map();
    return {
      kind: "none",
      label: "nowhere",
      async list(path) {
        const prefix = path.length ? `${key(path)}/` : "";
        const seen = new Map();
        for (const k of files.keys()) {
          if (!k.startsWith(prefix)) continue;
          const rest = k.slice(prefix.length).split("/");
          seen.set(rest[0], rest.length > 1 ? "dir" : files.get(k) === null ? "dir" : "file");
        }
        return [...seen].map(([name, kind]) => ({ name, kind })).sort((a, b) => a.name.localeCompare(b.name));
      },
      async read(path) { return files.get(key(path)) || null; },
      async write(path, data) { files.set(key(path), bytesOf(data)); },
      async mkdir(path) { if (!files.has(key(path))) files.set(key(path), null); },
      async remove(path) { for (const k of [...files.keys()]) if (k === key(path) || k.startsWith(`${key(path)}/`)) files.delete(k); },
    };
  }

  // ------------------------------------------------------------ the one in use

  tree.store = noStore();
  // a folder on disk that was chosen before and needs the user's OK again
  tree.waiting = null;
  // can this browser work in a folder on disk at all?
  tree.canPick = () => typeof window.showDirectoryPicker === "function";

  const setting = async (name, value) => {
    const db = await database();
    if (value === undefined) return result(db.transaction("settings").objectStore("settings").get(name));
    const tx = db.transaction("settings", "readwrite");
    const done = finished(tx);
    if (value === null) tx.objectStore("settings").delete(name);
    else tx.objectStore("settings").put(value, name);
    return done;
  };

  // Decide where the tree is kept: the folder on disk chosen last time if the
  // browser still lets the page into it, otherwise the browser's own store.
  tree.start = async function () {
    tree.waiting = null;
    try {
      await database();
    } catch (error) {
      tree.store = noStore();
      return tree.store;
    }
    tree.store = browserStore();
    try {
      const handle = await setting("folder");
      if (handle && handle.queryPermission) {
        if ((await handle.queryPermission({ mode: "readwrite" })) === "granted") tree.store = diskStore(handle);
        else tree.waiting = handle;
      }
    } catch (error) {
      // the folder is gone, or the browser forgot it: the browser's store it is
    }
    return tree.store;
  };

  // Let the user choose the folder on disk to work in. Needs a click.
  tree.pick = async function () {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "web_blot" });
    await setting("folder", handle);
    tree.waiting = null;
    tree.store = diskStore(handle);
    return tree.store;
  };

  // Ask for the folder that is waiting to be let in again. Needs a click.
  tree.reconnect = async function () {
    if (!tree.waiting) return tree.store;
    if ((await tree.waiting.requestPermission({ mode: "readwrite" })) !== "granted") return null;
    tree.store = diskStore(tree.waiting);
    tree.waiting = null;
    return tree.store;
  };

  // Go back to the tree the browser keeps.
  tree.useBrowser = async function () {
    await setting("folder", null);
    tree.waiting = null;
    tree.store = browserStore();
    return tree.store;
  };

  tree.browserStore = browserStore;
  tree.diskStore = diskStore;

  // ---------------------------------------------------------------- helpers

  tree.readText = async (path) => {
    const bytes = await tree.store.read(path);
    return bytes ? new TextDecoder().decode(bytes) : null;
  };

  // Copy a directory with all that is in it, within a store or from one to another.
  tree.copy = async function (from, to, source = tree.store, target = tree.store) {
    await target.mkdir(to);
    for (const entry of await source.list(from)) {
      if (entry.kind === "dir") await tree.copy([...from, entry.name], [...to, entry.name], source, target);
      else await target.write([...to, entry.name], await source.read([...from, entry.name]));
    }
  };

  tree.rename = async function (from, to) {
    await tree.copy(from, to);
    await tree.store.remove(from);
  };

  // A name that can be a file or directory name everywhere.
  tree.safeName = (name) =>
    (name || "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 100) || "untitled";

  // `name`, or `name 2`, `name 3`, ... if `taken` (a Set of lower-case names) has it
  tree.freeName = function (name, taken) {
    const safe = tree.safeName(name);
    if (!taken.has(safe.toLowerCase())) return safe;
    let n = 2;
    while (taken.has(`${safe} ${n}`.toLowerCase())) n++;
    return `${safe} ${n}`;
  };

  // every file below a directory: [[path, Uint8Array]]
  tree.files = async function (path, store = tree.store) {
    const out = [];
    for (const entry of await store.list(path)) {
      if (entry.kind === "dir") out.push(...(await tree.files([...path, entry.name], store)));
      else out.push([[...path, entry.name], await store.read([...path, entry.name])]);
    }
    return out;
  };
})();
