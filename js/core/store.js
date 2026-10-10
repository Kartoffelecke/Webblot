// Projects kept in the browser (IndexedDB), several of them.
//
// A project is stored in three parts, so that the list can be shown without
// reading any image and a change of settings does not rewrite the images:
//   projects  { id, name, created, modified, blots: [names] }
//   docs      id -> the project document, images as keys (see ui/project.js)
//   images    "<project id>/<image key>" -> { w, h, dtype, buffer }
(function () {
  "use strict";
  const WB = (window.WB = window.WB || {});
  const store = (WB.store = {});

  const NAME = "web_blot";
  const STORES = ["projects", "docs", "images"];

  let opening = null;

  function open() {
    if (!opening) {
      opening = new Promise((resolve, reject) => {
        const request = indexedDB.open(NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("projects", { keyPath: "id" });
          db.createObjectStore("docs");
          db.createObjectStore("images");
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("The browser's storage could not be opened."));
        request.onblocked = () => reject(new Error("The browser's storage is in use by an older page."));
      });
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
      tx.onabort = () => reject(tx.error || new Error("The browser did not store the project."));
    });

  // all images of one project
  const imagesOf = (id) => IDBKeyRange.bound(`${id}/`, `${id}/￿`);

  // false in a private window, with storage blocked, or in a browser without it
  store.available = async function () {
    try {
      await open();
      return true;
    } catch (error) {
      return false;
    }
  };

  // [{ id, name, created, modified, blots }], the last changed first
  store.list = async function () {
    const db = await open();
    const all = await result(db.transaction("projects").objectStore("projects").getAll());
    return all.sort((a, b) => b.modified - a.modified);
  };

  // { meta, doc, images: { key: { w, h, dtype, buffer } } }, or null
  store.load = async function (id) {
    const db = await open();
    const tx = db.transaction(STORES);
    const range = imagesOf(id);
    const [meta, doc, keys, values] = await Promise.all([
      result(tx.objectStore("projects").get(id)),
      result(tx.objectStore("docs").get(id)),
      result(tx.objectStore("images").getAllKeys(range)),
      result(tx.objectStore("images").getAll(range)),
    ]);
    if (!meta || !doc) return null;
    const images = {};
    keys.forEach((key, i) => (images[key.slice(id.length + 1)] = values[i]));
    return { meta, doc, images };
  };

  // Write a project. `images` maps image keys to functions giving the stored
  // form { w, h, dtype, buffer }; only images that are not stored yet are asked
  // for, and stored images the project no longer has are removed.
  //
  // `expected` is the `modified` this page last saw of the project (null: it
  // has never been stored). If the stored project has another one, somebody
  // else wrote it since: nothing is written and the error has `conflict` set.
  // Returns the new `modified`.
  store.save = async function (meta, doc, images, expected) {
    const db = await open();
    const tx = db.transaction(STORES, "readwrite");
    const done = finished(tx);
    const projects = tx.objectStore("projects");
    const current = await result(projects.get(meta.id));
    if (current && current.modified !== expected) {
      tx.abort();
      await done.catch(() => {});
      throw Object.assign(new Error("The project was changed in another tab."), { conflict: true });
    }
    const modified = Math.max(Date.now(), current ? current.modified + 1 : 0);
    const imageStore = tx.objectStore("images");
    const prefix = `${meta.id}/`;
    const stored = new Set(await result(imageStore.getAllKeys(imagesOf(meta.id))));
    for (const [key, make] of Object.entries(images)) {
      if (!stored.delete(prefix + key)) imageStore.put(make(), prefix + key);
    }
    for (const key of stored) imageStore.delete(key);
    projects.put({ ...meta, modified });
    tx.objectStore("docs").put(doc, meta.id);
    await done;
    return modified;
  };

  // Write a project as it is given, `modified` included (copies and imports).
  store.put = async function (meta, doc, images) {
    const db = await open();
    const tx = db.transaction(STORES, "readwrite");
    const done = finished(tx);
    const imageStore = tx.objectStore("images");
    imageStore.delete(imagesOf(meta.id));
    for (const [key, image] of Object.entries(images)) imageStore.put(image, `${meta.id}/${key}`);
    tx.objectStore("projects").put(meta);
    tx.objectStore("docs").put(doc, meta.id);
    await done;
  };

  store.remove = async function (id) {
    const db = await open();
    const tx = db.transaction(STORES, "readwrite");
    const done = finished(tx);
    tx.objectStore("projects").delete(id);
    tx.objectStore("docs").delete(id);
    tx.objectStore("images").delete(imagesOf(id));
    await done;
  };

  // { usage, quota } in bytes, or null if the browser does not tell
  store.estimate = async function () {
    try {
      return await navigator.storage.estimate();
    } catch (error) {
      return null;
    }
  };

  // Ask the browser not to clear the storage on its own when space runs low.
  store.persist = function () {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    } catch (error) {
      // not available here
    }
  };
})();
