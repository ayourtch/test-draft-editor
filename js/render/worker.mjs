// Browser entry for the render engine: a module Web Worker (no bundler, no Node APIs).
// Spec: docs/steps/0009a-rfc-render.md. The UI starts it with
//   new Worker(new URL("./render/worker.mjs", import.meta.url), { type: "module" })
//
// Messages in:
//   {type: "init", indexURL, lockFileURL, offline?}  once, first; URLs of the vendored Pyodide
//                                                     package directory and of the wheel lock
//   {id, xml, text, html, date?, refs?, filename?}    one per render (refs?: href -> reference XML,
//                                                     filename?: the working file name)
// Messages out:
//   {type: "ready", engine_id, offline}  or  {type: "ready", error}
//   {id, engine_id, rc, txt?, html?, log}  or  {id, error}   (rc != 0: xml2rfc failed)
// Requests are answered one at a time, in the order received.
//
// The offline guard allows only the origin of the Pyodide files (see xml2rfc-engine.mjs).

import { createEngine } from "./xml2rfc-engine.mjs";

let engine = null;
let queue = Promise.resolve();

self.onmessage = (event) => {
  queue = queue.then(() => handle(event.data));
};

async function handle(message) {
  if (message.type === "init") {
    try {
      engine = await createEngine({
        indexURL: message.indexURL,
        lockFileURL: message.lockFileURL,
        offline: message.offline ?? true,
      });
      self.postMessage({ type: "ready", engine_id: engine.id, offline: engine.offline });
    } catch (err) {
      self.postMessage({ type: "ready", error: String(err?.message ?? err) });
    }
    return;
  }

  const { id } = message;
  try {
    if (!engine) throw new Error("the engine is not initialised: send an init message first");
    const result = await engine.render(message.xml, {
      text: message.text === true,
      html: message.html === true,
      date: message.date ?? null,
      refs: message.refs ?? null,
      filename: message.filename ?? null,
    });
    self.postMessage({ id, engine_id: engine.id, ...result });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
}
