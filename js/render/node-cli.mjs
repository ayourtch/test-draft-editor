// Node backend for NodeRenderer (crates/rfc-render). Spec: docs/steps/0009a-rfc-render.md.
// Line-delimited JSON over stdin/stdout, one answer per request, in order:
//   request:  {"id":1,"xml":"…","text":true,"html":true,"date":"YYYY-MM-DD" | null,"refs":{href: xml},"filename":"…" | null}
//   answer:   {"id":1,"engine_id":1,"rc":0,"txt":"…","html":"…","log":"…"}
//             (rc != 0: xml2rfc failed; no txt or html)
//   error:    {"id":1,"engine_id":1,"error":"…"}  (the request could not be served)
// The engine is loaded once per process and serves every request.
//
// Usage: node node-cli.mjs [--vendor <vendor dir>]   (default: the repository's vendor/)

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createEngine } from "./xml2rfc-engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const vendor = argValue("--vendor") ?? join(here, "..", "..", "vendor");

// The engine loads in the background; a failure is reported with each request.
const engineReady = createEngine(enginePaths(vendor));
engineReady.catch(() => {});

let queue = Promise.resolve();
createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  queue = queue.then(() => answer(line));
});

async function answer(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return reply({ id: null, error: `bad request: ${err.message}` });
  }
  const id = request.id ?? null;
  let engine;
  try {
    engine = await engineReady;
  } catch (err) {
    return reply({ id, error: `the engine did not load: ${err.message}` });
  }
  try {
    if (typeof request.xml !== "string") throw new TypeError("request has no xml string");
    const result = await engine.render(request.xml, {
      text: request.text === true,
      html: request.html === true,
      date: request.date ?? null,
      refs: request.refs ?? null,
      filename: request.filename ?? null,
    });
    reply({ id, engine_id: engine.id, ...result });
  } catch (err) {
    reply({ id, engine_id: engine.id, error: String(err?.message ?? err) });
  }
}

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function argValue(name) {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Pyodide's package directory and the wheel lock, from the vendor tree (SPEC §6a). */
function enginePaths(vendor) {
  const version = pyodideVersion(vendor);
  return {
    indexURL: join(vendor, "pyodide", version, "package") + "/",
    lockFileURL: join(vendor, "python", "lock.json"),
    offline: true,
  };
}

/** The pinned Pyodide version: `version` in the [component.pyodide] table of manifest.toml. */
function pyodideVersion(vendor) {
  const manifestPath = join(vendor, "manifest.toml");
  const manifest = readFileSync(manifestPath, "utf8");
  const table = manifest.split(/^\[/m).find((part) => part.startsWith("component.pyodide]"));
  const version = table?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`no [component.pyodide] version in ${manifestPath}`);
  return version;
}
