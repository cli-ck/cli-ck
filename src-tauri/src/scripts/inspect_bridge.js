// Injected into every frame of the main window (see lib.rs's
// `initialization_script_for_all_frames`) — including the cross-origin
// `<iframe>` WorkspacePreviewPane uses to render a dev-server preview.
//
// Deliberately narrow: this is a one-directional fact-extractor, not a
// general execute-arbitrary-JS bridge. It never accepts code from the
// parent to run, and it never exposes anything back into the previewed
// page — it only listens for a click (while armed) and reports fixed,
// budget-capped facts about the clicked element. Marker string must match
// `CLI_CK_INSPECT_MARKER` in WorkspacePreviewPane.tsx.
(function () {
  // Never run in the app's own top-level UI — only inside a nested frame
  // (the preview iframe, or a frame nested inside it, which the "only the
  // element's own immediate parent hears about it" design below leaves as
  // a disclosed gap: see WorkspacePreviewPane.tsx).
  if (window.top === window.self) return;

  var MARKER = "__cli_ck_inspect__";
  var MAX_STRING = 500;
  var STYLE_PROPS = [
    "display", "position", "width", "height",
    "color", "background-color", "font-family", "font-size", "font-weight",
    "line-height", "padding", "margin", "border", "border-radius",
    "flex-direction", "justify-content", "align-items", "gap",
    "opacity", "z-index", "overflow", "text-align", "cursor", "box-shadow",
  ];

  function cap(s) {
    if (typeof s !== "string") return s;
    return s.length > MAX_STRING ? s.slice(0, MAX_STRING) + "…" : s;
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
      // targetOrigin left as "*" deliberately: the app's own runtime origin
      // varies by OS (tauri://localhost, https://tauri.localhost, ...) and
      // isn't reliably knowable from inside the previewed page. The payload
      // itself carries nothing beyond facts about the previewed page's own
      // already-visible UI.
    }, "*");
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
    }
  });
})();
