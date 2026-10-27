import assert from "node:assert/strict";
import vm from "node:vm";
import { build } from "esbuild";
import { JSDOM } from "jsdom";

const { window } = new JSDOM('<main><div class="mermaid"><svg><g class="node"><text>节点</text></g></svg></div></main>');
const result = await build({ entryPoints: ["src/shared/mermaidViewer.ts"], bundle: true, write: false, format: "cjs", platform: "browser" });
const context = vm.createContext({ module: { exports: {} } });
vm.runInContext(result.outputFiles[0].text, context);
const { enhanceMermaid } = context.module.exports;
const diagram = window.document.querySelector(".mermaid");
const dispose = enhanceMermaid(diagram);
assert.equal(typeof dispose, "function");
assert.equal(enhanceMermaid(diagram), null, "repeated enhancement must not nest frames");
const frame = diagram.closest(".simple-mermaid-frame");
const viewport = frame.querySelector(".simple-mermaid-viewport");
const canvas = frame.querySelector(".simple-mermaid-canvas");
const [fit, pan, minus, plus, fullscreen] = frame.querySelectorAll("button");
let captured;
viewport.setPointerCapture = id => { captured = id; };
viewport.hasPointerCapture = id => captured === id;
viewport.releasePointerCapture = () => { captured = undefined; };
const wheel = deltaY => {
  const event = new window.WheelEvent("wheel", { deltaY, clientX: 100, clientY: 50, bubbles: true, cancelable: true });
  viewport.dispatchEvent(event);
  return event;
};
const pointer = (target, type, x, y, id = 1) => {
  const event = new window.MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerId", { value: id });
  target.dispatchEvent(event);
};
assert.equal(wheel(-100).defaultPrevented, false, "fit mode preserves page scrolling");
pan.click(); assert.equal(pan.getAttribute("aria-pressed"), "true");
assert.equal(wheel(-100).defaultPrevented, true);
assert.match(canvas.style.transform, /translate\(-[\d.]+px, -[\d.]+px\) scale\(1\./, "zoom anchors at the mouse position");
wheel(-100000); assert.match(canvas.style.transform, /scale\(4\)/);
wheel(100000); assert.match(canvas.style.transform, /scale\(0.35\)/);
fit.click(); assert.equal(canvas.style.transform, "translate(0px, 0px) scale(1)");
plus.click(); assert.equal(frame.dataset.mode, "canvas");
minus.click(); assert.match(canvas.style.transform, /scale\(1\)/);
pointer(diagram.querySelector("text"), "pointerdown", 0, 0);
assert.equal(captured, undefined, "diagram nodes keep their own interaction");
pointer(viewport, "pointerdown", 10, 20);
pointer(viewport, "pointermove", 110, 120, 2);
assert.equal(canvas.style.transform, "translate(0px, 0px) scale(1)", "other pointers cannot move the canvas");
pointer(viewport, "pointermove", 30, 50);
assert.equal(canvas.style.transform, "translate(20px, 30px) scale(1)");
pointer(viewport, "lostpointercapture", 30, 50);
assert.equal(viewport.classList.contains("is-dragging"), false);
pointer(viewport, "pointermove", 60, 80);
assert.equal(canvas.style.transform, "translate(20px, 30px) scale(1)");
fullscreen.click(); assert(frame.classList.contains("is-fullscreen"));
assert.equal(frame.parentElement, window.document.body, "fullscreen escapes clipped editor containers");
assert.equal(fullscreen.getAttribute("aria-expanded"), "true");
frame.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
assert.equal(frame.classList.contains("is-fullscreen"), false);
assert.equal(fullscreen.getAttribute("aria-expanded"), "false");
assert.equal(frame.parentElement.tagName, "MAIN", "exit restores the original location");
fullscreen.click();
dispose(); assert.equal(diagram.parentElement.tagName, "MAIN");
assert.equal(window.document.querySelector(".simple-mermaid-frame"), null);
assert.equal(diagram.style.transform, "", "cleanup does not leave canvas transforms on the SVG host");
console.log("Mermaid viewer: fit, anchored zoom, limits, drag, cancellation, fullscreen and cleanup passed.");

// Plugin lifecycle: queued work must not recreate UI after unload or note removal.
window.Node.prototype.instanceOf = function(type) { return this instanceof type; };
const pluginBundle = await build({ entryPoints: ["src/features/mermaidEnhancer.ts"], bundle: true, write: false, format: "cjs", external: ["obsidian"] });
const frames = [], cleanup = [];
let observe;
const pluginContext = vm.createContext({ module: { exports: {} }, document: window.document, HTMLElement: window.HTMLElement,
  window: { requestAnimationFrame: callback => frames.push(callback), setTimeout: callback => callback() },
  MutationObserver: class { constructor(callback) { observe = callback; } observe() {} disconnect() {} },
  require: () => ({ setIcon: (button, name) => { button.dataset.icon = name; } }),
});
vm.runInContext(pluginBundle.outputFiles[0].text, pluginContext);
diagram.parentElement.className = "markdown-rendered";
const plugin = { settings: { enableMermaidEnhancer: true },
  app: { workspace: { onLayoutReady: callback => callback() } },
  registerMarkdownPostProcessor() {}, register: callback => cleanup.push(callback) };
const refresh = pluginContext.module.exports.registerMermaidEnhancer(plugin);
const flush = () => { while (frames.length) frames.shift()(); };
flush(); assert(diagram.closest(".simple-mermaid-frame"));
diagram.closest(".simple-mermaid-frame").querySelector('button[aria-label="全屏"]').click();
const source = window.document.querySelector("main"); source.remove();
observe([{ addedNodes: [], removedNodes: [source] }]); flush();
assert.equal(window.document.querySelector(".simple-mermaid-frame"), null, "note removal cleans up fullscreen UI");
window.document.body.append(source);
refresh(); flush(); assert(diagram.closest(".simple-mermaid-frame"));
plugin.settings.enableMermaidEnhancer = false; refresh();
assert.equal(diagram.closest(".simple-mermaid-frame"), null);
plugin.settings.enableMermaidEnhancer = true; refresh();
cleanup.forEach(callback => callback()); flush();
assert.equal(diagram.closest(".simple-mermaid-frame"), null, "queued callbacks cannot recreate UI after unload");
console.log("Mermaid plugin lifecycle: note removal, disabling and pending unload callbacks passed.");
