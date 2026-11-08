// Browser entry for the Nits panel (step 0026): a module Web Worker that runs the vendored idnits3
// bundle in browser mode. Spec: docs/steps/0026-nits-panel.md.
//
// Messages in:
//   {type: "init", bundleURL}            once, first: the bundle's URL (from the Rust side's
//                                        build-time vendor paths, never written here)
//   {id, xml, filename, mode, offline}   one per run; mode: "normal" | "forgive-checklist" | "submission"
//   {type: "lookup-answer", lookup, status, contentType, body}  or  {…, lookup, error}: the page's
//                                        answer to a lookup of an offline run (see below)
// Messages out:
//   {type: "ready"}  or  {type: "ready", error}
//   {id, findings: [{severity, code, desc, ref?, line?, column?, path?}]}  or  {id, error}
//   {type: "lookup", lookup, path, body}: an offline run's lookup, asked of the page
//   severity: "error" | "warning" | "comment"
// Runs are answered one at a time, in the order received. A lookup's answer is handled as it
// arrives, not in that queue: the run that waits for it is the one at the head of the queue.
//
// Browser mode. idnits3 posts its lookups to /idnits3/api/* of the page's own origin only when it
// finds `window.document` (remote/common.mjs:6; the bundle's `X2`). A module worker has no window,
// so without the shim below it would call www.rfc-editor.org and datatracker.ietf.org itself, which
// would leave the machine. The check is made when the bundle module is evaluated, so the shim must
// be set before the dynamic import in `init`. browser-check nits fails on any request that does not
// stay on this origin, which is how a bundle that checks something else would show up.
if (typeof self.window === "undefined") {
  self.window = { document: {} };
}

let idnits = null;
let queue = Promise.resolve();
// The lookups of an offline run that wait for the page's answer, by number.
const lookups = new Map();
let nextLookup = 0;

self.onmessage = (event) => {
  if (event.data?.type === "lookup-answer") {
    answerLookup(event.data);
    return;
  }
  queue = queue.then(() => handle(event.data));
};

async function handle(message) {
  if (message.type === "init") {
    try {
      idnits = await import(message.bundleURL);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "ready", error: String(err?.message ?? err) });
    }
    return;
  }

  const { id } = message;
  try {
    if (!idnits) throw new Error("idnits3 is not loaded: send an init message first");
    const findings = await withoutNetwork(message.offline === true, () =>
      idnits.checkNits(new TextEncoder().encode(message.xml), message.filename, {
        mode: modeOf(message.mode),
        offline: message.offline === true,
      }),
    );
    self.postMessage({ id, findings: findings.map(toFinding) });
  } catch (err) {
    self.postMessage({ id, error: String(err?.message ?? err) });
  }
}

// An offline run (a static site, steps 0008d-1 and 0008d-2A) makes no request of its own. idnits3's
// `offline` option leaves its lookups in place (`/idnits3/api/*`, for each RFC a reference names), and
// the page answers them from its bundled RFC index: each one is asked of the page, and answered by its
// `lookup-answer`. Any other request is refused before anything is sent, as a server that is down
// refuses it: the bundle carries on with what it can answer and the local findings (browser-check
// static checks that it finishes, and that every request stays on the site).
const LOOKUP_PATH = "/idnits3/api/";

async function withoutNetwork(offline, run) {
  if (!offline) return run();
  const realFetch = self.fetch;
  self.fetch = (input, init) => {
    const url = new URL(String(input), self.location.href);
    if (url.pathname.startsWith(LOOKUP_PATH)) return relayLookup(url, init);
    return Promise.reject(new TypeError("offline: no requests in this run"));
  };
  try {
    return await run();
  } finally {
    self.fetch = realFetch;
  }
}

// Asks the page for one lookup and resolves with a Response of the answer, as fetch would.
function relayLookup(url, init) {
  const lookup = ++nextLookup;
  const body = typeof init?.body === "string" ? init.body : "";
  return new Promise((resolve, reject) => {
    lookups.set(lookup, { resolve, reject });
    self.postMessage({ type: "lookup", lookup, path: url.pathname, body });
  });
}

function answerLookup(message) {
  const waiting = lookups.get(message.lookup);
  if (!waiting) return;
  lookups.delete(message.lookup);
  if (message.error !== undefined) {
    waiting.reject(new TypeError(message.error));
  } else {
    waiting.resolve(
      new Response(message.body, {
        status: message.status,
        headers: { "Content-Type": message.contentType },
      }),
    );
  }
}

function modeOf(name) {
  switch (name) {
    case "normal":
      return idnits.MODES.NORMAL;
    case "forgive-checklist":
      return idnits.MODES.FORGIVE_CHECKLIST;
    case "submission":
      return idnits.MODES.SUBMISSION;
    default:
      throw new Error(`unknown mode "${name}"`);
  }
}

// The bundle is minified, so a finding's class name says nothing: test the exported classes. The
// warning and comment classes extend the error class, hence the order.
function severityOf(finding) {
  if (finding instanceof idnits.ValidationComment) return "comment";
  if (finding instanceof idnits.ValidationWarning) return "warning";
  return "error";
}

function toFinding(finding) {
  const out = { severity: severityOf(finding), code: finding.name, desc: finding.message };
  if (finding.refUrl) out.ref = finding.refUrl;
  const at = finding.lines?.[0];
  if (at) {
    out.line = at.line;
    out.column = at.pos;
  }
  if (finding.path) out.path = finding.path;
  return out;
}
