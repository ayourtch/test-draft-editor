// xml2rfc in Pyodide: the render engine shared by the Node CLI (node-cli.mjs) and the browser
// module worker (worker.mjs). Spec: docs/steps/0009a-rfc-render.md; SPEC §6.
//
// One module for both environments: no Node-only import at top level, no fs, no Buffer. The
// caller names Pyodide's package directory (`indexURL`) and the wheel lock (`lockFileURL`): as
// URLs in a browser (absolute, or relative to the page or worker), and as absolute paths in Node,
// whose Pyodide build takes paths. Everything is read from those places; nothing else is fetched.
//
// Offline (`offline`, the default): as in smoke.mjs, fetch and Python's requests and sockets
// refuse every host except the origin of the Pyodide files. Each refusal is logged.
//
// Date: an empty <date/> takes xml2rfc's date from the clock, and `--date` does not change it
// (step 0004c). With `date`, xml2rfc sees that day as today, as the smoke suite does.

const WORK_DIR = "/work";
const INPUT_DIR = `${WORK_DIR}/in`;
// The working file name when the caller has none: xml2rfc names its output after the input file.
const DEFAULT_INPUT = "input.xml";
const OUTPUT_DIR = `${WORK_DIR}/out`;
const CACHE_DIR = `${WORK_DIR}/cache`;
// The bibxml locations xml2rfc's CachingResolver fetches references from when offline: its
// `network_locs`, with its `NET_SUBDIRS` (the series directories under the network location).
const NETWORK_LOC = "https://bib.ietf.org/public/rfc/";
const NET_SUBDIRS = [
  "bibxml",
  "bibxml-misc",
  "bibxml-ids",
  "bibxml-w3c",
  "bibxml-3gpp",
  "bibxml-ieee",
  "bibxml-rfcsubseries",
];

// Python: the network guard of smoke.mjs. REFUSED collects what the guard refused.
// The refusal nests like requests/urllib3's: xml2rfc's retry loop logs `exc.args[0].args[0]`, so a
// flat `ConnectionError("offline: …")` would raise `AttributeError` instead of failing cleanly.
const PY_GUARD = `
import requests, socket
REFUSED = []
def _refuse_request(self, method, url, *args, **kwargs):
    REFUSED.append(str(url))
    raise requests.exceptions.ConnectionError(
        requests.exceptions.ConnectionError("offline: " + str(url) + " refused"))
def _refuse_connect(self, address):
    host = address[0] if isinstance(address, tuple) else str(address)
    REFUSED.append(host)
    raise OSError("offline: " + host + " refused")
requests.Session.request = _refuse_request
socket.socket.connect = _refuse_connect
`;

// Python: the xml2rfc entry point (as smoke.mjs runs it) and the refusal drain.
const PY_XML2RFC = `
import datetime
import json
import sys
import traceback

import xml2rfc.run


def run_xml2rfc(request_json):
    """Runs xml2rfc on {"argv": [...], "pinned": "YYYY-MM-DD" | null}; a pinned date is the day
    that xml2rfc sees as today."""
    request = json.loads(request_json)
    argv = request["argv"]
    pinned = request["pinned"]
    real_date = datetime.date
    if pinned is not None:
        class PinnedDate(real_date):
            @classmethod
            def today(cls):
                return cls(*map(int, pinned.split("-")))
        datetime.date = PinnedDate
    saved_argv = sys.argv
    sys.argv = argv
    try:
        xml2rfc.run.main()
        return 0
    except SystemExit as exit_:
        if exit_.code is None:
            return 0
        if isinstance(exit_.code, int):
            return exit_.code
        print(exit_.code, file=sys.stderr)
        return 1
    except Exception:
        traceback.print_exc()
        return 1
    finally:
        datetime.date = real_date
        sys.argv = saved_argv


def drain_refused():
    """The targets the Python-side guard refused since the last call, as a JSON list."""
    refused = globals().get("REFUSED", [])
    out = json.dumps(list(refused))
    refused.clear()
    return out


INPUT_DIR = "/work/in"
CACHE_DIR = "/work/cache"


def prepopulate_cache(entries_json):
    """Writes the render's reference cache entries ([{"url": ..., "xml": ...}]) into the cache
    dir xml2rfc's CachingResolver reads (<cache>/<basename>, with the xml:base attribute set to
    the full URL), so the run that follows resolves the references from the cache instead of the
    network. An entry with a local path (a relative href) is also written beside the input,
    where lxml's XInclude resolves the relative href: xml2rfc refuses local file access unless
    --allow-local-file-access is passed, and then reads the file next to the source."""
    import base64
    import hashlib
    import os
    from urllib.parse import urlsplit

    import lxml.etree

    entries = json.loads(entries_json)
    written = []
    for entry in entries:
        url = entry["url"]
        scheme, netloc, path, query, fragment = urlsplit(url)
        root, ext = os.path.splitext(path)
        hash = "-" + base64.urlsafe_b64encode(hashlib.sha1(query.encode()).digest()).decode() if query else ""
        basename = os.path.basename(root + hash + ext)
        xml = lxml.etree.fromstring(entry["xml"].encode("utf-8"))
        xml.set("{http://www.w3.org/XML/1998/namespace}base", url)
        text = lxml.etree.tostring(xml, encoding="utf-8").decode("utf-8")
        with open(os.path.join(CACHE_DIR, basename), "w", encoding="utf-8") as cache_file:
            cache_file.write(text)
        written.append(basename)
        local = entry.get("local")
        if local:
            local_path = os.path.join(INPUT_DIR, local)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "w", encoding="utf-8") as local_file:
                local_file.write(text)
    return json.dumps(written)
`;

let engines = 0;

const LOAD_ATTEMPTS = 3;

/**
 * Loads xml2rfc and its packages: one at a time, dependencies first. In the browser some
 * downloads fail with "Failed to fetch" (step 0009), so the load is retried; a failed download
 * is only logged by loadPackage, so success is checked by importing the packages.
 * @param {object} py the Pyodide instance
 * @param {string} lockHref
 * @param {string[]} log receives the load messages
 */
async function loadPackages(py, lockHref, log) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      for (const name of await loadOrder(lockHref, "xml2rfc")) await py.loadPackage(name);
      py.runPython("import requests, xml2rfc");
      return;
    } catch (err) {
      const reason = String(err?.message ?? err).trim().split("\n").pop();
      if (attempt === LOAD_ATTEMPTS) {
        throw new Error(`xml2rfc did not load (${reason}):\n${log.join("\n")}`);
      }
      log.push(`xml2rfc load attempt ${attempt} failed (${reason}); retrying`);
      await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
    }
  }
}

/**
 * The packages `root` needs, dependencies first, as names of the lock's `packages`.
 * @param {string} lockHref the lock file's URL or path
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function loadOrder(lockHref, root) {
  // In a browser the lock is fetched; in Node it is a file (no Node import at top level).
  const text = globalThis.location
    ? await (await fetch(lockHref)).text()
    : await (await import("node:fs/promises")).readFile(lockHref, "utf8");
  const { packages } = JSON.parse(text);
  const order = [];
  const seen = new Set();
  const visit = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const dependency of packages[name].depends) visit(dependency);
    order.push(name);
  };
  visit(root);
  return order;
}

/**
 * Refuses every fetch except local files and the Pyodide origin; refusals go to `log`.
 * @param {Set<string>} allowed origins that may be fetched
 * @param {string} base the URL that relative fetches resolve against
 * @param {string[]} log
 */
function installFetchGuard(allowed, base, log) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(String(input?.url ?? input), base);
    if (url.protocol === "file:" || allowed.has(url.origin)) {
      return realFetch(input, init);
    }
    log.push(`offline: refused ${url.href}`);
    return Promise.reject(new TypeError(`offline: ${url.href} refused`));
  };
}

/**
 * The full bibxml URL xml2rfc's CachingResolver fetches for an include `href`: the href itself
 * when it is absolute, or the first network location's `bibxml` directory plus the href's file
 * name (the resolver's cache lookup keys on the file name).
 * @param {string} href an include href, absolute or relative
 * @returns {string} the bibxml URL to prepopulate the cache with
 */
function includeUrl(href) {
  const path = href.endsWith(".xml") ? href : `${href}.xml`;
  return /^https?:\/\//.test(href)
    ? href
    : new URL(`${NET_SUBDIRS[0]}/${path}`, NETWORK_LOC).href;
}

/**
 * The reference cache entries a render asks for: the `<?rfc include="…"?>` hrefs and
 * `xi:include` elements of the source, each as the full bibxml URL xml2rfc's CachingResolver
 * fetches, with the reference XML the caller supplied. The offline render writes these into the
 * cache dir before running xml2rfc, so that the run resolves the references from the local cache.
 * A relative href also gets its `local` path: the file lxml's XInclude reads beside the source.
 * @param {string} xml the source being rendered
 * @param {Record<string, string>} refs href -> the reference XML to cache for it
 * @returns {{url: string, local: string | null, xml: string}[]} the entries to prepopulate, in
 *   first-seen order
 */
function referenceEntries(xml, refs) {
  const entries = [];
  const seen = new Set();
  const include = /<\?rfc[^>]*?include=["']([^"']+)["'][^>]*>|<xi:include[^>]*?href=["']([^"']+)["'][^>]*>/g;
  let match;
  while ((match = include.exec(xml)) !== null) {
    const href = match[1] ?? match[2];
    const url = includeUrl(href);
    if (seen.has(url)) continue;
    seen.add(url);
    const content = refs?.[url] ?? refs?.[href];
    if (content) {
      entries.push({
        url,
        // A relative href is read from beside the source; an absolute one from the cache.
        local: /^https?:\/\//.test(href) ? null : href,
        xml: content,
      });
    }
  }
  return entries;
}

/**
 * The working file name the tools see: the document's name (`filename`), or `input.xml` when the
 * caller has none. Only the base name is kept (a path would put the file outside `/work/in`), and a
 * name without an extension gets `.xml`, as xml2rfc names its output after the input file.
 * @param {string|null} filename the document's name, or null
 * @returns {string} the working file name
 */
function workingFileName(filename) {
  const base = String(filename ?? "").replace(/^.*[\\/]/, "").trim();
  if (!base || base === "." || base === "..") return DEFAULT_INPUT;
  return base.includes(".") ? base : `${base}.xml`;
}

/**
 * Loads Pyodide and xml2rfc once. Call once per realm (a Node process, or a worker).
 *
 * @param {{ indexURL: string, lockFileURL: string, offline?: boolean }} options
 * @returns {Promise<{
 *   id: number,
 *   render(xml: string, opts?: { text?: boolean, html?: boolean, date?: string | null, refs?: object, filename?: string | null }):
 *     Promise<{ rc: number, txt?: string, html?: string, log: string }>
 * }>} `id` counts the engines this realm has loaded. `rc` is xml2rfc's exit code; `txt` and
 *   `html` are present only when requested and `rc` is 0. `refs`, when the render runs offline,
 *   maps a `<?rfc include="…"?>` href to the reference XML to prepopulate the cache with.
 *   `filename` is the working file name the tools see, or null for the engine's default.
 */
export async function createEngine({ indexURL, lockFileURL, offline = true }) {
  // In a browser the URLs are made absolute against the page or worker; in Node they stay paths.
  const absolute = (url) =>
    globalThis.location ? new URL(url, globalThis.location.href).href : url;
  const indexHref = absolute(indexURL.endsWith("/") ? indexURL : `${indexURL}/`);
  const lockHref = absolute(lockFileURL);
  const packageBaseUrl = lockHref.slice(0, lockHref.lastIndexOf("/") + 1);

  const log = [];
  const base = globalThis.location?.href ?? "file:///";
  const allowed = new Set(
    [indexHref, lockHref]
      .map((url) => new URL(url, base))
      .filter((url) => url.protocol === "http:" || url.protocol === "https:")
      .map((url) => url.origin),
  );

  const { loadPyodide } = await import(`${indexHref}pyodide.mjs`);
  const py = await loadPyodide({
    indexURL: indexHref,
    lockFileURL: lockHref,
    packageBaseUrl,
    stdout: (line) => log.push(line),
    stderr: (line) => log.push(line),
  });
  // loadPyodide and loadPackage fetch only the files of indexURL and the lock (the origins
  // `allowed`). The guard goes in after them: with a fetch wrapper in place while Pyodide
  // downloads its wheels, Chromium fails the downloads with "Failed to fetch" (step 0009).
  await loadPackages(py, lockHref, log);
  if (offline) {
    installFetchGuard(allowed, base, log);
    py.runPython(PY_GUARD);
  }
  py.runPython(PY_XML2RFC);
  py.FS.mkdirTree(`${WORK_DIR}/in`);
  py.FS.mkdirTree(OUTPUT_DIR);
  py.FS.mkdirTree(CACHE_DIR);
  const runXml2rfc = py.globals.get("run_xml2rfc");
  const drainRefused = py.globals.get("drain_refused");
  const prepopulateCache = py.globals.get("prepopulate_cache");

  engines += 1;
  return {
    id: engines,
    /// Whether the render resolves references from its cache instead of the network.
    offline,

    async render(
      xml,
      { text = false, html = false, date = null, refs = null, filename = null } = {},
    ) {
      if (typeof xml !== "string") throw new TypeError("render: xml must be a string");
      if (!text && !html) throw new Error("render: ask for text, html or both");
      if (date !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`render: date must be YYYY-MM-DD, got ${date}`);
      }
      log.length = 0;
      // The source goes to xml2rfc as written, under the document's working file name: the tools
      // name their output after it, and a name that matches the document keeps them from
      // reporting a filename mismatch. The offline run resolves its includes from the local
      // cache, which is populated below from the reference XML the caller supplied.
      const name = workingFileName(filename);
      const input = `${INPUT_DIR}/${name}`;
      py.FS.writeFile(input, xml);
      if (offline) {
        // The offline run resolves references from the local cache: before running xml2rfc,
        // write the source's `<?rfc include="…"?>` and `xi:include` entries into the cache dir,
        // which the argv below names as `--cache`, from the reference XML the caller supplied.
        // Relative `xi:include` entries also land beside the source, where lxml reads them.
        const entries = referenceEntries(xml, refs);
        for (const entry of entries) {
          log.push(`offline: caching ${entry.url}${entry.local ? ` (local ${entry.local})` : ""}`);
        }
        if (entries.length === 0) {
          log.push("offline: no reference includes to cache");
        } else {
          prepopulateCache(JSON.stringify(entries));
        }
      }
      const argv = [
        "xml2rfc",
        "--no-network",
        // Relative `xi:include` hrefs are read from beside the source: the prepopulated local
        // files, not the cache. Without this flag xml2rfc refuses them as local file access.
        "--allow-local-file-access",
        "--cache",
        CACHE_DIR,
        ...(text ? ["--text"] : []),
        ...(html ? ["--html"] : []),
        "--path",
        OUTPUT_DIR,
        input,
      ];
      // The date goes in the JSON: a JS null passed as an argument reaches Python as JsNull.
      const rc = runXml2rfc(JSON.stringify({ argv, pinned: date }));
      for (const target of JSON.parse(drainRefused())) {
        log.push(`offline: refused ${target}`);
      }
      const result = { rc, log: log.join("\n") };
      if (rc !== 0) return result;
      // xml2rfc names its outputs after the input file: <name>.txt, <name>.html.
      const base = name.replace(/\.[^/.]*$/, "");
      if (text) result.txt = py.FS.readFile(`${OUTPUT_DIR}/${base}.txt`, { encoding: "utf8" });
      if (html) result.html = py.FS.readFile(`${OUTPUT_DIR}/${base}.html`, { encoding: "utf8" });
      return result;
    },
  };
}
