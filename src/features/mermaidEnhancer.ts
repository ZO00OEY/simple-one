import { setIcon } from "obsidian";
import type SimplePlugin from "../main";

type MermaidMode = "fit" | "canvas";

const FRAME_CLASS = "simple-mermaid-frame";
const MIN_CANVAS_SCALE = 0.35;
const MAX_CANVAS_SCALE = 4;

export function registerMermaidEnhancer(plugin: SimplePlugin): () => void {
  const pendingMermaids = new Set<HTMLElement>();
  let overlay: HTMLElement | null = null;
  let overlayCleanup: (() => void) | null = null;
  let queued = false;

  const closeOverlay = () => {
    overlayCleanup?.();
    overlayCleanup = null;
    overlay?.remove();
    overlay = null;
  };

  const openOverlay = (mermaid: HTMLElement) => {
    closeOverlay();
    const doc = mermaid.ownerDocument;
    overlay = doc.body.createDiv({ cls: "simple-mermaid-overlay" });
    const header = overlay.createDiv({ cls: "simple-mermaid-overlay-header" });
    header.createSpan({ text: "流程图全屏查看" });
    const closeButton = header.createEl("button", {
      cls: "clickable-icon simple-mermaid-icon-button",
      attr: { type: "button", "aria-label": "关闭全屏查看" },
    });
    setIcon(closeButton, "x");

    const stage = overlay.createDiv({ cls: "simple-mermaid-overlay-stage" });
    const clone = mermaid.cloneNode(true) as HTMLElement;
    clone.removeAttribute("data-processed");
    clone.addClass("simple-mermaid-overlay-diagram");
    stage.appendChild(clone);

    const close = () => {
      doc.removeEventListener("keydown", onKeyDown);
      closeOverlay();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    closeButton.addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay || event.target === stage) close();
    });
    doc.addEventListener("keydown", onKeyDown);
    overlayCleanup = () => doc.removeEventListener("keydown", onKeyDown);
  };

  const setMode = (frame: HTMLElement, mode: MermaidMode) => {
    frame.dataset.mode = mode;
    frame.querySelectorAll<HTMLButtonElement>("[data-mermaid-mode]").forEach((button) => {
      const active = button.dataset.mermaidMode === mode;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
  };

  const enhance = (mermaid: HTMLElement) => {
    if (!plugin.settings.enableMermaidEnhancer) return;
    if (mermaid.closest(`.${FRAME_CLASS}, .simple-mermaid-overlay`)) return;
    if (!mermaid.querySelector("svg")) return;
    if (!mermaid.closest(".markdown-reading-view, .markdown-preview-view, .markdown-rendered, .markdown-source-view.is-live-preview")) return;

    const frame = mermaid.ownerDocument.createElement("div");
    frame.addClass(FRAME_CLASS);
    frame.dataset.mode = "fit";
    const viewport = frame.createDiv({ cls: "simple-mermaid-viewport" });
    const canvas = viewport.createDiv({ cls: "simple-mermaid-canvas" });
    let scale = 1;
    let offsetX = 0;
    let offsetY = 0;
    let dragStart: { x: number; y: number; offsetX: number; offsetY: number } | null = null;

    const applyCanvasTransform = () => {
      canvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`;
    };
    const resetCanvas = () => {
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      dragStart = null;
      viewport.removeClass("is-dragging");
      applyCanvasTransform();
    };

    const toolbar = frame.createDiv({ cls: "simple-mermaid-toolbar" });
    const addButton = (label: string, icon: string, action: () => void, mode?: MermaidMode) => {
      const button = toolbar.createEl("button", {
        cls: "clickable-icon simple-mermaid-icon-button",
        attr: { type: "button", "aria-label": label, title: label },
      });
      if (mode) button.dataset.mermaidMode = mode;
      setIcon(button, icon);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        action();
      });
      return button;
    };

    addButton("适应面板宽度", "move-horizontal", () => {
      resetCanvas();
      setMode(frame, "fit");
    }, "fit");
    addButton("画布模式：滚轮缩放，拖动空白处", "hand", () => setMode(frame, "canvas"), "canvas");
    addButton("全屏查看流程图", "maximize", () => openOverlay(mermaid));

    mermaid.parentNode?.insertBefore(frame, mermaid);
    canvas.appendChild(mermaid);
    setMode(frame, "fit");

    viewport.addEventListener("wheel", (event) => {
      if (frame.dataset.mode !== "canvas") return;
      event.preventDefault();
      event.stopPropagation();

      const rect = viewport.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0015);
      const nextScale = Math.min(MAX_CANVAS_SCALE, Math.max(MIN_CANVAS_SCALE, scale * factor));
      if (nextScale === scale) return;

      const ratio = nextScale / scale;
      offsetX = pointerX - (pointerX - offsetX) * ratio;
      offsetY = pointerY - (pointerY - offsetY) * ratio;
      scale = nextScale;
      applyCanvasTransform();
    }, { passive: false });

    viewport.addEventListener("pointerdown", (event) => {
      if (frame.dataset.mode !== "canvas" || event.button !== 0) return;
      const target = event.target as Element | null;
      if (target?.closest(".node, .edgePaths path, .edgeLabels, .cluster, text, foreignObject, a")) return;

      event.preventDefault();
      viewport.setPointerCapture(event.pointerId);
      viewport.addClass("is-dragging");
      dragStart = { x: event.clientX, y: event.clientY, offsetX, offsetY };
    });
    viewport.addEventListener("pointermove", (event) => {
      if (!dragStart) return;
      offsetX = dragStart.offsetX + event.clientX - dragStart.x;
      offsetY = dragStart.offsetY + event.clientY - dragStart.y;
      applyCanvasTransform();
    });
    const endDrag = (event: PointerEvent) => {
      if (!dragStart) return;
      dragStart = null;
      viewport.removeClass("is-dragging");
      if (viewport.hasPointerCapture(event.pointerId)) viewport.releasePointerCapture(event.pointerId);
    };
    viewport.addEventListener("pointerup", endDrag);
    viewport.addEventListener("pointercancel", endDrag);
  };

  const collectMermaids = (root: ParentNode) => {
    if (root instanceof HTMLElement) {
      if (root.matches(".mermaid")) pendingMermaids.add(root);
      const owner = root.closest<HTMLElement>(".mermaid");
      if (owner) pendingMermaids.add(owner);
    }
    root.querySelectorAll<HTMLElement>(".mermaid").forEach((mermaid) => pendingMermaids.add(mermaid));
  };

  const scheduleEnhance = (root?: ParentNode) => {
    if (root) collectMermaids(root);
    if (queued) return;
    queued = true;
    window.requestAnimationFrame(() => {
      queued = false;
      pendingMermaids.forEach(enhance);
      pendingMermaids.clear();
    });
  };

  plugin.registerMarkdownPostProcessor((el) => {
    window.setTimeout(() => scheduleEnhance(el), 0);
  });

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement) collectMermaids(node);
      });
    }
    if (pendingMermaids.size > 0) scheduleEnhance();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  plugin.app.workspace.onLayoutReady(() => scheduleEnhance(document.body));

  const refresh = () => {
    if (plugin.settings.enableMermaidEnhancer) {
      scheduleEnhance(document.body);
      return;
    }

    closeOverlay();
    document.querySelectorAll<HTMLElement>(`.${FRAME_CLASS}`).forEach((frame) => {
      const mermaid = frame.querySelector<HTMLElement>(".mermaid");
      if (mermaid) frame.parentNode?.insertBefore(mermaid, frame);
      frame.remove();
    });
  };

  plugin.register(() => {
    observer.disconnect();
    pendingMermaids.clear();
    closeOverlay();
  });

  return refresh;
}
