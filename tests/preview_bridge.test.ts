// @vitest-environment happy-dom

// Imports the actual script injected into the preview iframe (see
// src-tauri/src/lib.rs's `initialization_script_for_all_frames` and the
// file's own header comment) — not a reimplementation. Its CJS export hook
// only fires here (a `module` global exists under vitest/Node); the real
// injected copy never reaches that branch since Tauri's webview has no
// `module` global.
import bridge from "../src-tauri/src/scripts/preview_bridge.js";
import { afterEach, describe, expect, it, vi } from "vitest";

function setHtml(html: string) {
  document.body.innerHTML = html;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveLocator", () => {
  it("resolves css: (and bare strings as css shorthand)", () => {
    setHtml('<button id="go">Go</button>');
    expect(bridge.resolveLocator("css:#go")?.id).toBe("go");
    expect(bridge.resolveLocator("#go")?.id).toBe("go");
  });

  it("resolves testid: via data-testid, safely quoting the value", () => {
    setHtml('<div data-testid=\'weird"value\'>x</div>');
    const el = bridge.resolveLocator('testid:weird"value');
    expect(el?.getAttribute("data-testid")).toBe('weird"value');
  });

  it("resolves text: to the most specific (fewest-descendant) match", () => {
    setHtml(
      '<div id="wrapper"><span id="label">Submit</span></div>',
    );
    const el = bridge.resolveLocator("text:Submit");
    expect(el?.id).toBe("label");
  });

  it("resolves role:name[...] by implicit role and accessible name", () => {
    setHtml(
      '<button>Cancel</button><button>Submit</button>',
    );
    const el = bridge.resolveLocator("role:button[Submit]");
    expect(el?.textContent).toBe("Submit");
  });

  it("resolves role: with no [name] to the first element with that role", () => {
    setHtml("<a href=\"/x\">Link</a>");
    const el = bridge.resolveLocator("role:link");
    expect(el?.tagName).toBe("A");
  });

  it("returns null when nothing matches", () => {
    setHtml("<div></div>");
    expect(bridge.resolveLocator("css:.nope")).toBeNull();
    expect(bridge.resolveLocator("text:nope")).toBeNull();
    expect(bridge.resolveLocator("role:button[nope]")).toBeNull();
  });
});

describe("elementRole", () => {
  it("infers common implicit roles from tag/type", () => {
    setHtml(
      '<input id="a" type="submit"><input id="b" type="checkbox"><input id="c">',
    );
    expect(bridge.elementRole(document.getElementById("a") as HTMLElement)).toBe(
      "button",
    );
    expect(bridge.elementRole(document.getElementById("b") as HTMLElement)).toBe(
      "checkbox",
    );
    expect(bridge.elementRole(document.getElementById("c") as HTMLElement)).toBe(
      "textbox",
    );
  });

  it("prefers an explicit role attribute over the implicit one", () => {
    setHtml('<div role="button">x</div>');
    expect(bridge.elementRole(document.querySelector("div") as HTMLElement)).toBe("button");
  });
});

describe("accessibleName", () => {
  it("prefers aria-label over text content", () => {
    setHtml('<button aria-label="Close dialog">×</button>');
    expect(bridge.accessibleName(document.querySelector("button") as HTMLElement)).toBe(
      "Close dialog",
    );
  });

  it("falls back to value/placeholder for inputs", () => {
    setHtml('<input placeholder="Email">');
    expect(bridge.accessibleName(document.querySelector("input") as HTMLElement)).toBe(
      "Email",
    );
  });
});

describe("buildSnapshot", () => {
  it("lists interactive/labeled elements, skipping plain wrapper divs", () => {
    setHtml(
      '<div><div class="wrapper"><button>Save</button><span>plain text</span></div></div>',
    );
    const snapshot = bridge.buildSnapshot(document.body);
    expect(snapshot).toContain('role=button name="Save"');
    expect(snapshot).not.toContain("wrapper");
  });

  it("caps output length rather than growing unbounded", () => {
    const many = Array.from(
      { length: 500 },
      (_, i) => `<button>Button ${i}</button>`,
    ).join("");
    setHtml(many);
    const snapshot = bridge.buildSnapshot(document.body);
    expect(snapshot.length).toBeLessThanOrEqual(8000 + "\n…[truncated]".length);
  });
});

describe("readPrimitive", () => {
  it("reads text/value/checked for a resolved element", () => {
    setHtml('<input id="cb" type="checkbox" checked>');
    const result = bridge.readPrimitive("css:#cb");
    expect(result?.checked).toBe(true);
  });

  it("returns null when the locator matches nothing", () => {
    setHtml("<div></div>");
    expect(bridge.readPrimitive("css:.nope")).toBeNull();
  });
});

describe("clickPrimitive / waitPrimitive", () => {
  it("clicks the resolved element", async () => {
    setHtml('<button id="go">Go</button>');
    let clicked = false;
    const go = document.getElementById("go") as HTMLElement;
    go.addEventListener("click", () => {
      clicked = true;
    });
    await bridge.clickPrimitive("css:#go");
    expect(clicked).toBe(true);
  });

  it("rejects when the locator never resolves (default 5s wait, faked)", async () => {
    vi.useFakeTimers();
    setHtml("<div></div>");
    const pending = bridge.clickPrimitive("css:.nope");
    const assertion = expect(pending).rejects.toThrow(/no element matched/);
    await vi.advanceTimersByTimeAsync(5100);
    await assertion;
  });

  it("waitPrimitive(ms) resolves true after the delay, waitPrimitive(locator) resolves once present", async () => {
    setHtml("<div></div>");
    await expect(bridge.waitPrimitive(1)).resolves.toBe(true);
    setTimeout(() => setHtml('<span id="late">x</span>'), 10);
    await expect(bridge.waitPrimitive("css:#late")).resolves.toBe(true);
  });
});

describe("fillPrimitive", () => {
  it("sets .value via the native setter and dispatches input/change", async () => {
    setHtml('<input id="email">');
    const el = document.getElementById("email") as HTMLInputElement;
    const events: string[] = [];
    el.addEventListener("input", () => events.push("input"));
    el.addEventListener("change", () => events.push("change"));
    await bridge.fillPrimitive("css:#email", "a@b.com");
    expect(el.value).toBe("a@b.com");
    expect(events).toEqual(["input", "change"]);
  });
});

describe("runScript", () => {
  it("runs the given js as an async function body with click/fill/wait/read bound", async () => {
    setHtml('<input id="name"><button id="ok">OK</button>');
    const result = await bridge.runScript(
      "await fill('css:#name', 'hi'); await click('css:#ok'); return read('css:#name');",
    );
    expect(result?.value).toBe("hi");
  });

  it("propagates a thrown error", async () => {
    await expect(bridge.runScript("throw new Error('boom')")).rejects.toThrow(
      "boom",
    );
  });
});
