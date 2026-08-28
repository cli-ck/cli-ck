// Injected into every frame of the main window (see lib.rs's
// `initialization_script_for_all_frames`) — including the cross-origin
// `<iframe>` WorkspacePreviewPane uses to render a dev-server preview.
//
// Two capabilities, one shared message channel (all messages carry
// `source: MARKER`, matching `CLI_CK_BRIDGE_MARKER` in
// WorkspacePreviewPane.tsx):
//   - click-to-inspect ("start"/"stop"/"result"): arms a click listener,
//     reports fixed facts about whatever the user clicks.
//   - browser_execute ("run"/"run_result"): runs an agent-supplied script
//     against a small primitive set (click/fill/wait/read a locator) inside
//     this page's own context, since the app can't reach in from outside a
//     cross-origin iframe.
//
// The pure resolver/primitive functions below have no `window`/`document`
// dependency beyond standard DOM APIs, so they're also unit-tested directly
// (see tests/preview_bridge.test.ts) via the CJS export hook further down —
// that hook is unreachable when this file is actually injected by Tauri
// (no `module` global exists there), so it costs nothing at runtime.

function cap(s, maxLen) {
  var max = maxLen || 500;
  if (typeof s !== "string") return s;
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function cssSelector(el) {
  if (el.id) return "#" + el.id;
  var parts = [];
  var node = el;
  for (var depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    var part = node.tagName.toLowerCase();
    var cls = typeof node.className === "string"
      ? node.className.trim().split(/\s+/).filter(Boolean).slice(0, 2)
      : [];
    if (cls.length) part += "." + cls.join(".");
    var parent = node.parentElement;
    if (parent) {
      var siblings = Array.prototype.filter.call(
        parent.children,
        function (c) { return c.tagName === node.tagName; },
      );
      if (siblings.length > 1) {
        part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
      }
    }
    parts.unshift(part);
    node = parent;
  }
  return cap(parts.join(" > "));
}

function computedStyleFacts(el) {
  var STYLE_PROPS = [
    "display", "position", "width", "height",
    "color", "background-color", "font-family", "font-size", "font-weight",
    "line-height", "padding", "margin", "border", "border-radius",
    "flex-direction", "justify-content", "align-items", "gap",
    "opacity", "z-index", "overflow", "text-align", "cursor", "box-shadow",
  ];
  var cs = window.getComputedStyle(el);
  var out = {};
  for (var i = 0; i < STYLE_PROPS.length; i++) {
    out[STYLE_PROPS[i]] = cap(cs.getPropertyValue(STYLE_PROPS[i]));
  }
  return out;
}

function ariaFacts(el) {
  var out = {};
  for (var i = 0; i < el.attributes.length; i++) {
    var attr = el.attributes[i];
    if (attr.name === "role" || attr.name.indexOf("aria-") === 0) {
      out[attr.name] = cap(attr.value);
    }
  }
  return out;
}

// Best-effort React DevTools-style fiber walk to find the JSX call site
// that rendered this element — degrades to null for non-React apps,
// production builds (no _debugSource), or anything else unexpected.
function reactSourcePointer(el) {
  var key = null;
  for (var k in el) {
    if (k.indexOf("__reactFiber$") === 0 || k.indexOf("__reactInternalInstance$") === 0) {
      key = k;
      break;
    }
  }
  if (!key) return null;
  var fiber = el[key];
  for (var hops = 0; fiber && hops < 12; hops++, fiber = fiber.return) {
    var src = fiber._debugSource;
    if (src && src.fileName) {
      return { fileName: cap(src.fileName), lineNumber: src.lineNumber || null };
    }
  }
  return null;
}

// --- Locator mini-language: css:/xpath:/text:/role:name[...]/testid: ---
// Deliberately just these five prefixes — no href:/alt:/placeholder:/
// label:/ref=N backend-node IDs until real usage shows they're needed.

function parseLocator(locator) {
  var m = /^(css|xpath|text|role|testid):([\s\S]*)$/.exec(locator);
  if (!m) return { kind: "css", value: locator }; // bare value = css shorthand
  return { kind: m[1], value: m[2] };
}

var IMPLICIT_ROLES = {
  button: "button", a: "link", img: "img",
  h1: "heading", h2: "heading", h3: "heading", h4: "heading",
  h5: "heading", h6: "heading", textarea: "textbox", select: "combobox",
};

function elementRole(el) {
  var explicit = el.getAttribute && el.getAttribute("role");
  if (explicit) return explicit;
  var tag = el.tagName.toLowerCase();
  if (tag === "input") {
    var type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "submit" || type === "button") return "button";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    return "textbox";
  }
  return IMPLICIT_ROLES[tag] || null;
}

function accessibleName(el) {
  var aria = el.getAttribute && el.getAttribute("aria-label");
  if (aria) return aria.trim();
  if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
    return (el.value || el.getAttribute("placeholder") || "").trim();
  }
  return (el.textContent || "").trim();
}

function parseRoleLocator(value) {
  var m = /^([a-zA-Z-]+)\[([\s\S]*)\]$/.exec(value);
  if (m) return { role: m[1], name: m[2] };
  return { role: value, name: null };
}

// Resolves one locator string against `root` (defaults to `document`).
// Returns the matched element, or `null`. `text:`/`role:` pick the most
// specific (fewest-descendant) match rather than the first DOM-order match,
// so a locator naming a leaf label doesn't accidentally grab an ancestor
// wrapper that also happens to contain that text.
function resolveLocator(locator, root) {
  var doc = root || document;
  var parsed = parseLocator(locator);
  if (parsed.kind === "css") {
    return doc.querySelector(parsed.value);
  }
  if (parsed.kind === "testid") {
    // Compare the attribute value directly rather than interpolating it
    // into a CSS attribute selector — escaping an arbitrary string for CSS
    // selector syntax is its own hazard (e.g. embedded quotes), and this
    // sidesteps it entirely.
    var candidates = doc.querySelectorAll("[data-testid]");
    for (var t = 0; t < candidates.length; t++) {
      if (candidates[t].getAttribute("data-testid") === parsed.value) return candidates[t];
    }
    return null;
  }
  if (parsed.kind === "xpath") {
    var xdoc = doc.nodeType === 9 ? doc : doc.ownerDocument || document;
    var result = xdoc.evaluate(
      parsed.value, doc, null,
      XPathResult.FIRST_ORDERED_NODE_TYPE, null,
    );
    return result.singleNodeValue;
  }
  if (parsed.kind === "text") {
    var target = parsed.value.trim();
    var all = doc.querySelectorAll("*");
    var best = null;
    var bestDepth = Infinity;
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var text = (el.textContent || "").trim();
      if (!text) continue;
      if (text === target || text.indexOf(target) !== -1) {
        var depth = el.querySelectorAll("*").length;
        if (depth < bestDepth) { best = el; bestDepth = depth; }
      }
    }
    return best;
  }
  if (parsed.kind === "role") {
    var rn = parseRoleLocator(parsed.value);
    var all2 = doc.querySelectorAll("*");
    var best2 = null;
    var bestDepth2 = Infinity;
    for (var j = 0; j < all2.length; j++) {
      var el2 = all2[j];
      if (elementRole(el2) !== rn.role) continue;
      if (rn.name && accessibleName(el2).indexOf(rn.name) === -1) continue;
      var depth2 = el2.querySelectorAll("*").length;
      if (depth2 < bestDepth2) { best2 = el2; bestDepth2 = depth2; }
    }
    return best2;
  }
  return null;
}

// --- browser_execute primitives: click/fill/wait/read a locator ---

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function waitForLocator(locator, timeoutMs) {
  var deadline = Date.now() + (timeoutMs || 5000);
  function attempt() {
    var el = resolveLocator(locator);
    if (el) return el;
    if (Date.now() >= deadline) return null;
    return sleep(50).then(attempt);
  }
  return Promise.resolve().then(attempt);
}

function clickPrimitive(locator) {
  return waitForLocator(locator, 5000).then(function (el) {
    if (!el) throw new Error("no element matched locator: " + locator);
    if (el.scrollIntoView) el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  });
}

function nativeValueSetter(el) {
  var proto = el.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  var desc = Object.getOwnPropertyDescriptor(proto, "value");
  return desc && desc.set;
}

// Sets `.value` via the native setter (not the instance property) so a
// controlled React input's own onChange actually fires — React overrides
// the instance-level setter, so a plain `el.value = x` is invisible to it.
function fillPrimitive(locator, value) {
  return waitForLocator(locator, 5000).then(function (el) {
    if (!el) throw new Error("no element matched locator: " + locator);
    var setter = nativeValueSetter(el);
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value; // best-effort for anything else with a .value
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
}

function waitPrimitive(locatorOrMs) {
  if (typeof locatorOrMs === "number") return sleep(locatorOrMs).then(function () { return true; });
  return waitForLocator(locatorOrMs, 5000).then(function (el) { return !!el; });
}

function readPrimitive(locator) {
  var el = resolveLocator(locator);
  if (!el) return null;
  return {
    text: cap((el.textContent || "").trim()),
    value: "value" in el ? String(el.value) : null,
    checked: "checked" in el ? !!el.checked : null,
  };
}

// Runs an agent-supplied script as the body of an async function, with
// click/fill/wait/read bound as locals — one script per call, not one tool
// call per action (the load-bearing idea from the research this is based
// on: compiling a whole multi-step interaction into one round trip).
function runScript(js) {
  var fn = new Function(
    "click", "fill", "wait", "read",
    "return (async () => {\n" + js + "\n})();",
  );
  return fn(clickPrimitive, fillPrimitive, waitPrimitive, readPrimitive);
}

function safeSerialize(value, maxLen) {
  if (value === undefined) return null;
  try {
    var json = JSON.stringify(value);
    if (json === undefined) return cap(String(value), maxLen);
    return json.length > (maxLen || 2000) ? cap(json, maxLen) : JSON.parse(json);
  } catch (e) {
    return cap(String(value), maxLen);
  }
}

// --- Compact snapshot instead of a screenshot ---
// One line per interactive/labeled element; skips non-semantic wrapper
// divs. No algorithm to port from — ego-lite's format is closed-source, so
// this is a fresh, deliberately minimal design. Hard byte-budgeted, same
// discipline as orca-comparison-plan.md §3.1's Design Mode capture.
var SNAPSHOT_MAX_CHARS = 8000;
var SNAPSHOT_MAX_ELEMENTS = 300;
var INTERACTIVE_TAGS = { a: 1, button: 1, input: 1, textarea: 1, select: 1 };

function buildSnapshot(root) {
  var doc = root || (typeof document !== "undefined" ? document.body : null);
  var lines = [];
  var refIndex = 0;

  function walk(el) {
    if (!el || lines.length >= SNAPSHOT_MAX_ELEMENTS) return;
    var tag = el.tagName ? el.tagName.toLowerCase() : null;
    if (tag) {
      var role = elementRole(el);
      var interactive = INTERACTIVE_TAGS[tag] || role === "button" || role === "link";
      var name = accessibleName(el);
      if (interactive || (role && name)) {
        refIndex++;
        var label = "ref=" + refIndex + " role=" + (role || tag);
        if (name) label += ' name="' + cap(name, 80).replace(/"/g, "'") + '"';
        lines.push(label);
      }
    }
    var children = el.children || [];
    for (var i = 0; i < children.length && lines.length < SNAPSHOT_MAX_ELEMENTS; i++) {
      walk(children[i]);
    }
  }
  walk(doc);

  var out = lines.join("\n");
  return out.length > SNAPSHOT_MAX_CHARS
    ? out.slice(0, SNAPSHOT_MAX_CHARS) + "\n…[truncated]"
    : out;
}

// Node/vitest access to the pure functions above — never reached when this
// file is injected into a real webview frame (no `module` global there).
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    resolveLocator: resolveLocator,
    parseLocator: parseLocator,
    elementRole: elementRole,
    accessibleName: accessibleName,
    parseRoleLocator: parseRoleLocator,
    buildSnapshot: buildSnapshot,
    readPrimitive: readPrimitive,
    cssSelector: cssSelector,
    clickPrimitive: clickPrimitive,
    fillPrimitive: fillPrimitive,
    waitPrimitive: waitPrimitive,
    runScript: runScript,
  };
} else {
  (function () {
    // Never run in the app's own top-level UI — only inside a nested frame
    // (the preview iframe, or a frame nested inside it — see
    // WorkspacePreviewPane.tsx for the "only the immediate parent hears
    // about it" disclosed gap that follows from this).
    if (window.top === window.self) return;

    var MARKER = "__cli_ck_bridge__";
    var active = false;

    function onClick(e) {
      if (!active) return;
      e.preventDefault();
      e.stopPropagation();
      var el = e.target;
      var rect = el.getBoundingClientRect();
      active = false;
      document.removeEventListener("click", onClick, true);
      if (document.body) document.body.style.cursor = "";
      window.parent.postMessage({
        source: MARKER,
        type: "result",
        selector: cssSelector(el),
        tag: el.tagName.toLowerCase(),
        text: cap((el.textContent || "").trim().slice(0, 200)),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        style: computedStyleFacts(el),
        aria: ariaFacts(el),
        source_pointer: reactSourcePointer(el),
        // targetOrigin left as "*" deliberately: the app's own runtime
        // origin varies by OS (tauri://localhost, https://tauri.localhost,
        // ...) and isn't reliably knowable from inside the previewed page.
      }, "*");
    }

    function handleRun(data) {
      var requestId = data.requestId;
      function respond(payload) {
        payload.source = MARKER;
        payload.type = "run_result";
        payload.requestId = requestId;
        window.parent.postMessage(payload, "*");
      }
      Promise.resolve()
        .then(function () { return runScript(data.js || ""); })
        .then(function (result) {
          respond({
            ok: true,
            result: safeSerialize(result),
            snapshot: data.includeSnapshot ? buildSnapshot() : null,
          });
        })
        .catch(function (err) {
          respond({
            ok: false,
            error: cap(String((err && err.message) || err)),
            snapshot: data.includeSnapshot ? buildSnapshot() : null,
          });
        });
    }

    window.addEventListener("message", function (event) {
      if (event.source !== window.parent) return;
      var data = event.data;
      if (!data || data.source !== MARKER) return;
      if (data.type === "start") {
        active = true;
        if (document.body) document.body.style.cursor = "crosshair";
        document.addEventListener("click", onClick, true);
      } else if (data.type === "stop") {
        active = false;
        document.removeEventListener("click", onClick, true);
        if (document.body) document.body.style.cursor = "";
      } else if (data.type === "run") {
        handleRun(data);
      }
    });
  })();
}
