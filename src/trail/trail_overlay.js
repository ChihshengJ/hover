/**
 * Trail Overlay — pull handle, overlay panel, SVG tree visualization.
 */

import { normalizeTitle } from "./trail_store.js";

const SVG_NS = "http://www.w3.org/2000/svg";

// Layout constants
const NODE_W = 180;
const NODE_H = 48;
const NODE_PAD_X = 60;
const NODE_PAD_Y = 16;
const NODE_RX = 8;
const TITLE_MAX_CHARS = 22;
const DRAG_THRESHOLD = 4;

export class TrailOverlay {
  /**
   * @param {import('./trail_store.js').TrailStore} trailStore
   * @param {string|null} currentTitle — detected title of the current paper
   * @param {string|null} currentUrl
   */
  constructor(trailStore, currentTitle, currentUrl) {
    this.trailStore = trailStore;
    this.currentTitle = currentTitle;
    this.currentNormalized = normalizeTitle(currentTitle || "");
    this.currentUrl = currentUrl;

    this.isOpen = false;
    this.currentTrailIndex = 0;

    // DOM elements
    this.handle = null;
    this.backdrop = null;
    this.panel = null;
    this.titlebar = null;
    this.treeContainer = null;
    this.tooltip = null;
    this.pillsContainer = null;

    // Pan state
    this.isPanning = false;
    this.wasDragged = false;
    this.panStartX = 0;
    this.panOffsetX = 0;

    // Resolved trail lists
    this.currentTrails = []; // trails containing this paper
    this.otherTrails = []; // remaining trails for browsing
    this.allDisplayTrails = []; // combined ordered list
  }

  initialize() {
    this.#createHandle();
    this.#createOverlay();
    this.#createTooltip();
    this.#resolveTrails();
    this.#updateHandleVisibility();
    this.#bindKeys();
    this.#bindSync();
  }

  // ============================================
  // Trail Resolution
  // ============================================

  #resolveTrails() {
    const locations = this.trailStore.getTrailsForTitle(this.currentNormalized);
    const currentTrailIds = new Set(locations.map((l) => l.trailId));

    this.currentTrails = [];
    this.otherTrails = [];

    const allTrails = this.trailStore.getAllTrails();

    for (const trail of allTrails) {
      if (currentTrailIds.has(trail.id)) {
        this.currentTrails.push(trail);
      } else {
        this.otherTrails.push(trail);
      }
    }

    // Sort: starred first, then by lastAccessedAt descending
    const sortFn = (a, b) => {
      if (a.starred !== b.starred) return b.starred ? 1 : -1;
      return b.lastAccessedAt - a.lastAccessedAt;
    };
    this.currentTrails.sort(sortFn);
    this.otherTrails.sort(sortFn);

    // Build combined list: current trails first, then up to 5 others
    this.allDisplayTrails = [
      ...this.currentTrails,
      ...this.otherTrails.slice(0, 5),
    ];

    this.currentTrailIndex = Math.min(
      this.currentTrailIndex,
      Math.max(0, this.allDisplayTrails.length - 1),
    );
  }

  /**
   * Refresh the overlay after trail data changed (from any tab).
   */
  #onTrailSync() {
    this.#resolveTrails();
    this.#updateHandleVisibility();
    if (this.isOpen) {
      this.#renderCurrentTrail();
    }
  }

  // ============================================
  // DOM Creation
  // ============================================

  #createHandle() {
    this.handle = document.createElement("div");
    this.handle.className = "trail-handle";
    this.handle.innerHTML = `
      <div class="trail-handle-line"></div>
      <div class="trail-handle-circle"></div>
    `;
    this.handle.addEventListener("click", () => this.toggle());
    document.body.appendChild(this.handle);
  }

  #createOverlay() {
    this.backdrop = document.createElement("div");
    this.backdrop.className = "trail-backdrop";
    this.backdrop.addEventListener("click", () => this.close());

    this.panel = document.createElement("div");
    this.panel.className = "trail-panel";

    // Title bar
    this.titlebar = document.createElement("div");
    this.titlebar.className = "trail-titlebar";
    this.panel.appendChild(this.titlebar);

    // Body row: tree area + right sidebar
    this.bodyRow = document.createElement("div");
    this.bodyRow.className = "trail-body";
    this.panel.appendChild(this.bodyRow);

    // Tree container
    this.treeContainer = document.createElement("div");
    this.treeContainer.className = "trail-tree-container";
    this.bodyRow.appendChild(this.treeContainer);

    // Right sidebar (pills + delete)
    this.sidebar = document.createElement("div");
    this.sidebar.className = "trail-sidebar";
    this.bodyRow.appendChild(this.sidebar);

    // Pills container
    this.pillsContainer = document.createElement("div");
    this.pillsContainer.className = "trail-pills";
    this.sidebar.appendChild(this.pillsContainer);

    // Delete button
    this.deleteBtn = document.createElement("button");
    this.deleteBtn.className = "trail-delete-btn";
    this.deleteBtn.title = "Delete trail";
    this.deleteBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M2.5 4.5h11M5.5 4.5V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5M6.5 7v4M9.5 7v4M3.5 4.5l.5 8.5a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l.5-8.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
    this.sidebar.appendChild(this.deleteBtn);

    // Pan handling — no pointer capture, track drag vs click
    this.treeContainer.addEventListener("pointerdown", (e) =>
      this.#onPanStart(e),
    );
    document.addEventListener("pointermove", (e) => this.#onPanMove(e));
    document.addEventListener("pointerup", () => this.#onPanEnd());

    // Scroll wheel to switch trails
    this.treeContainer.addEventListener("wheel", (e) => {
      if (this.allDisplayTrails.length <= 1) return;
      e.preventDefault();
      if (e.deltaY > 0 && this.currentTrailIndex < this.allDisplayTrails.length - 1) {
        this.currentTrailIndex++;
        this.panOffsetX = 0;
        this.#renderCurrentTrail();
      } else if (e.deltaY < 0 && this.currentTrailIndex > 0) {
        this.currentTrailIndex--;
        this.panOffsetX = 0;
        this.#renderCurrentTrail();
      }
    }, { passive: false });

    document.body.appendChild(this.backdrop);
    document.body.appendChild(this.panel);
  }

  #createTooltip() {
    this.tooltip = document.createElement("div");
    this.tooltip.className = "trail-tooltip";
    document.body.appendChild(this.tooltip);
  }

  #bindKeys() {
    document.addEventListener("keydown", (e) => {
      if (!this.isOpen) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        this.close();
      }
    });
  }

  /**
   * Listen for cross-tab trail sync via BroadcastChannel.
   * When another tab mutates trails, the store re-reads from IndexedDB
   * and calls our onSync callback.
   */
  #bindSync() {
    this.trailStore.onSync = () => this.#onTrailSync();
  }

  #updateHandleVisibility() {
    const hasTrails = this.allDisplayTrails.length > 0;
    this.handle.classList.toggle("visible", hasTrails);
  }

  // ============================================
  // Open / Close
  // ============================================

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.isOpen) return;
    this.isOpen = true;

    // Re-resolve in case trails changed
    this.#resolveTrails();

    this.backdrop.classList.add("open");
    this.panel.classList.add("open");
    this.#renderCurrentTrail();
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.backdrop.classList.remove("open");
    this.panel.classList.remove("open");
    this.tooltip.classList.remove("visible");
  }

  // ============================================
  // Rendering
  // ============================================

  #renderCurrentTrail() {
    this.#renderPills();

    if (this.allDisplayTrails.length === 0) {
      this.#renderEmpty();
      return;
    }

    const trail = this.allDisplayTrails[this.currentTrailIndex];
    if (!trail) return;

    this.#renderTitlebar(trail);
    this.#renderTree(trail);
  }

  #renderEmpty() {
    this.titlebar.innerHTML = "";
    this.pillsContainer.innerHTML = "";
    this.treeContainer.innerHTML = `
      <div class="trail-empty">
        <div class="trail-empty-icon">&#8693;</div>
        <div>Follow a citation to start a trail</div>
      </div>
    `;
  }

  #renderTitlebar(trail) {
    const isCurrent = this.currentTrails.includes(trail);
    const label = isCurrent
      ? "current trail:"
      : trail.starred
        ? "starred trail:"
        : "recent trail:";

    this.titlebar.innerHTML = "";

    // Star button
    const starBtn = document.createElement("button");
    starBtn.className = "trail-star-btn" + (trail.starred ? " starred" : "");
    starBtn.textContent = trail.starred ? "\u2605" : "\u2606";
    starBtn.title = trail.starred ? "Unstar trail" : "Star trail";
    starBtn.addEventListener("click", async () => {
      const newStarred = !trail.starred;
      await this.trailStore.starTrail(trail.id, newStarred);
      this.#renderCurrentTrail();
    });
    this.titlebar.appendChild(starBtn);

    // Label
    const labelEl = document.createElement("span");
    labelEl.className = "trail-label";
    labelEl.textContent = label;
    this.titlebar.appendChild(labelEl);

    // Spacer
    const spacer = document.createElement("div");
    spacer.className = "trail-titlebar-spacer";
    this.titlebar.appendChild(spacer);

    // Close button
    const closeBtn = document.createElement("button");
    closeBtn.className = "trail-close-btn";
    closeBtn.textContent = "\u2715";
    closeBtn.title = "Close";
    closeBtn.addEventListener("click", () => this.close());
    this.titlebar.appendChild(closeBtn);

    // Wire the panel-level delete button for the current trail
    this.deleteBtn.onclick = async () => {
      await this.trailStore.deleteTrail(trail.id);
      this.#resolveTrails();
      this.#updateHandleVisibility();
      if (this.allDisplayTrails.length === 0) {
        this.close();
      } else {
        this.currentTrailIndex = Math.min(
          this.currentTrailIndex,
          this.allDisplayTrails.length - 1,
        );
        this.#renderCurrentTrail();
      }
    };
  }

  #renderPills() {
    this.pillsContainer.innerHTML = "";
    if (this.allDisplayTrails.length <= 1) return;

    for (let i = 0; i < this.allDisplayTrails.length; i++) {
      const trail = this.allDisplayTrails[i];
      const pill = document.createElement("div");
      pill.className = "trail-pill";
      if (i === this.currentTrailIndex) pill.classList.add("active");
      if (trail.starred) pill.classList.add("starred");
      pill.addEventListener("click", () => {
        this.currentTrailIndex = i;
        this.panOffsetX = 0;
        this.#renderCurrentTrail();
      });
      this.pillsContainer.appendChild(pill);
    }
  }

  // ============================================
  // SVG Tree Layout & Rendering
  // ============================================

  #renderTree(trail) {
    this.treeContainer.innerHTML = "";
    this.panOffsetX = 0;

    const root = trail.rootNode;
    if (!root) return;

    // Compute layout positions
    const layout = this.#layoutTree(root, 0, 0);

    // Determine SVG dimensions
    let maxX = 0;
    let maxY = 0;
    this.#walkLayout(layout, (n) => {
      maxX = Math.max(maxX, n.x + NODE_W);
      maxY = Math.max(maxY, n.y + NODE_H);
    });

    const svgW = maxX + 40;
    const svgH = maxY + 40;

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", svgW);
    svg.setAttribute("height", svgH);
    svg.setAttribute("viewBox", `0 0 ${svgW} ${svgH}`);

    const group = document.createElementNS(SVG_NS, "g");
    group.setAttribute("transform", "translate(20, 20)");
    this.svgGroup = group;

    // Render connections first (below nodes)
    this.#renderConnections(group, layout);

    // Render nodes
    this.#renderNodes(group, layout, trail);

    svg.appendChild(group);
    this.treeContainer.appendChild(svg);
  }

  /**
   * Recursive layout: returns a layout object with x, y, children.
   * @param {import('./trail_store.js').TrailNode} node
   * @param {number} depth — horizontal depth level
   * @param {number} yOffset — vertical offset for this subtree
   * @returns {{node: Object, x: number, y: number, children: Array, subtreeHeight: number}}
   */
  #layoutTree(node, depth, yOffset) {
    const x = depth * (NODE_W + NODE_PAD_X);

    if (!node.children || node.children.length === 0) {
      return {
        node,
        x,
        y: yOffset,
        children: [],
        subtreeHeight: NODE_H,
      };
    }

    const childLayouts = [];
    let currentY = yOffset;

    for (const child of node.children) {
      const childLayout = this.#layoutTree(child, depth + 1, currentY);
      childLayouts.push(childLayout);
      currentY += childLayout.subtreeHeight + NODE_PAD_Y;
    }

    const totalChildrenHeight = currentY - yOffset - NODE_PAD_Y;
    const subtreeHeight = Math.max(NODE_H, totalChildrenHeight);

    // Center this node vertically relative to its children
    const firstChildY = childLayouts[0].y;
    const lastChildY = childLayouts[childLayouts.length - 1].y;
    const y = (firstChildY + lastChildY) / 2;

    return {
      node,
      x,
      y,
      children: childLayouts,
      subtreeHeight,
    };
  }

  #walkLayout(layout, fn) {
    fn(layout);
    for (const child of layout.children) {
      this.#walkLayout(child, fn);
    }
  }

  #renderConnections(group, layout) {
    for (const child of layout.children) {
      const x1 = layout.x + NODE_W;
      const y1 = layout.y + NODE_H / 2;
      const x2 = child.x;
      const y2 = child.y + NODE_H / 2;
      const dx = (x2 - x1) * 0.5;

      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute(
        "d",
        `M ${x1},${y1} C ${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`,
      );
      path.setAttribute("class", "trail-link");
      group.appendChild(path);

      this.#renderConnections(group, child);
    }
  }

  #renderNodes(group, layout, trail) {
    const { node } = layout;
    const isCurrent =
      normalizeTitle(node.displayTitle) === this.currentNormalized;
    const isRoot = node.id === trail.rootNode.id;

    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute(
      "class",
      "trail-node" + (isCurrent ? " current" : "") + (isRoot ? " root" : ""),
    );
    g.setAttribute("transform", `translate(${layout.x}, ${layout.y})`);

    // Background rect
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("width", NODE_W);
    rect.setAttribute("height", NODE_H);
    rect.setAttribute("rx", NODE_RX);
    rect.setAttribute("ry", NODE_RX);
    g.appendChild(rect);

    // Root dot indicator
    if (isRoot) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("cx", -8);
      dot.setAttribute("cy", NODE_H / 2);
      dot.setAttribute("r", 3);
      dot.setAttribute("class", "trail-root-dot");
      g.appendChild(dot);

      // Star icon for starred trails
      if (trail.starred) {
        const star = document.createElementNS(SVG_NS, "text");
        star.setAttribute("x", -8);
        star.setAttribute("y", NODE_H / 2 - 10);
        star.setAttribute("text-anchor", "middle");
        star.setAttribute("class", "trail-star-icon");
        star.textContent = "\u2605";
        g.appendChild(star);
      }
    }

    // Title text
    const titleText = this.#truncateText(node.displayTitle, TITLE_MAX_CHARS);
    const title = document.createElementNS(SVG_NS, "text");
    title.setAttribute("x", NODE_W / 2);
    title.setAttribute("y", node.referenceText ? 20 : NODE_H / 2 + 4);
    title.setAttribute("text-anchor", "middle");
    title.setAttribute("class", "node-title");
    title.textContent = titleText;
    g.appendChild(title);

    // Subtitle (reference text) if available
    if (node.referenceText) {
      const sub = document.createElementNS(SVG_NS, "text");
      sub.setAttribute("x", NODE_W / 2);
      sub.setAttribute("y", 36);
      sub.setAttribute("text-anchor", "middle");
      sub.setAttribute("class", "node-subtitle");
      sub.textContent = this.#truncateText(node.referenceText, 28);
      g.appendChild(sub);
    }

    // Click handler — only fires if the pointer didn't drag
    if (!isCurrent && node.url) {
      g.addEventListener("click", (e) => {
        if (this.wasDragged) return;
        e.stopPropagation();
        this.#navigateToNode(node);
      });
    }

    // Hover tooltip
    const fullTitle = node.displayTitle || "";
    if (fullTitle.length > TITLE_MAX_CHARS) {
      g.addEventListener("mouseenter", (e) => {
        this.tooltip.textContent = fullTitle;
        this.tooltip.style.left = e.clientX + 12 + "px";
        this.tooltip.style.top = e.clientY + 12 + "px";
        this.tooltip.classList.add("visible");
      });
      g.addEventListener("mousemove", (e) => {
        this.tooltip.style.left = e.clientX + 12 + "px";
        this.tooltip.style.top = e.clientY + 12 + "px";
      });
      g.addEventListener("mouseleave", () => {
        this.tooltip.classList.remove("visible");
      });
    }

    group.appendChild(g);

    // Recurse children
    for (const child of layout.children) {
      this.#renderNodes(group, child, trail);
    }
  }

  /**
   * @param {string} text
   * @param {number} max
   * @returns {string}
   */
  #truncateText(text, max) {
    if (!text) return "";
    if (text.length <= max) return text;
    return text.substring(0, max - 1) + "\u2026";
  }

  // ============================================
  // Node Navigation (tab switching / fallback open)
  // ============================================

  /**
   * Navigate to a trail node's paper. Tries to activate an existing tab first,
   * falls back to opening a new tab.
   * @param {import('./trail_store.js').TrailNode} node
   */
  async #navigateToNode(node) {
    if (!node.url) return;

    // Try to find an existing viewer tab for this paper
    if (typeof chrome !== "undefined" && chrome.tabs?.query) {
      try {
        const viewerBase = chrome.runtime.getURL("index.html");
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (!tab.url || !tab.url.startsWith(viewerBase)) continue;
          try {
            const parsed = new URL(tab.url);
            const tabPaperUrl = parsed.searchParams.get("url");
            if (tabPaperUrl && tabPaperUrl === node.url) {
              await chrome.tabs.update(tab.id, { active: true });
              if (tab.windowId) {
                await chrome.windows.update(tab.windowId, { focused: true });
              }
              this.close();
              return;
            }
          } catch {
            // ignore parse errors
          }
        }
      } catch {
        // tabs API unavailable, fall through to window.open
      }
    }

    window.open(node.url, "_blank", "noopener,noreferrer");
  }

  // ============================================
  // Pan Handling
  // ============================================

  #onPanStart(e) {
    if (e.button !== 0) return;
    this.isPanning = true;
    this.wasDragged = false;
    this.panStartX = e.clientX - this.panOffsetX;
  }

  #onPanMove(e) {
    if (!this.isPanning) return;
    const dx = e.clientX - this.panStartX - this.panOffsetX;
    if (Math.abs(dx) > DRAG_THRESHOLD) {
      this.wasDragged = true;
    }
    this.panOffsetX = e.clientX - this.panStartX;
    if (this.svgGroup) {
      this.svgGroup.setAttribute(
        "transform",
        `translate(${20 + this.panOffsetX}, 20)`,
      );
    }
  }

  #onPanEnd() {
    this.isPanning = false;
  }
}
