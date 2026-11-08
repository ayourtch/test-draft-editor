import { readFileSync } from "node:fs";
import { loadPyodide } from "/Users/ayourtch/cisco-rust/ietf-draft-editor/vendor/pyodide/314.0.7/package/pyodide.mjs";

const py = await loadPyodide({
  indexURL: "/Users/ayourtch/cisco-rust/ietf-draft-editor/vendor/pyodide/314.0.7/package/",
  lockFileURL: "/Users/ayourtch/cisco-rust/ietf-draft-editor/vendor/python/lock.json",
  packageBaseUrl: "/Users/ayourtch/cisco-rust/ietf-draft-editor/vendor/python/",
});
for (const name of await (async () => {
  const lock = JSON.parse(await (await import("node:fs/promises")).readFile("/Users/ayourtch/cisco-rust/ietf-draft-editor/vendor/python/lock.json", "utf8"));
  const order = [];
  const seen = new Set();
  const visit = (n) => {
    if (seen.has(n)) return;
    seen.add(n);
    for (const d of lock.packages[n].depends) visit(d);
    order.push(n);
  };
  visit("xml2rfc");
  return order;
})()) {
  await py.loadPackage(name);
}
py.runPython(`
import os, time
def p(label, path):
    print(label, path, "exists:", os.path.exists(path))
p("expanduser-root:", os.path.expanduser("~"))
p("expanduser-cache:", os.path.expanduser("~/.cache"))
p("/root/.cache:", "/root/.cache")
p("/root/.cache/xml2rfc:", "/root/.cache/xml2rfc")
p("/work:", "/work")
import pyodide
print("pyodide FS:", list(pyodide.fs) if hasattr(pyodide, "fs") else "n/a")
import os
for root, dirs, files in os.walk("/"):
    dirs[:] = [d for d in dirs if d not in ("proc", "sys", "dev", "tmp")]
    for f in files:
        if "xml2rfc" in f or "cache" in f:
            print("FSFILE:", root + "/" + f)
`);
