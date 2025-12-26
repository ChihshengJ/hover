/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('../controls/floating_toolbar.js').FloatingToolbar} FloatingToolbar;
 *
 * @typedef {Object} NavItem
 * @property {string} title
 * @property {'section'|'figure'|'table'} type
 * @property {number} pageIndex
 * @property {number} left
 * @property {number} top
 * @property {NavItem[]} children
 * @property {boolean} expanded
 */

export class NavigationPopup {
  /**
   * @param {FloatingToolbar} toolbar
   */
  constructor(toolbar) {
    this.toolbar = toolbar;
    this.wm = toolbar.wm;

    /** @type {NavItem[]} */
    this.tree = [];

    /** @type {NavItem[]} Flattened sections for binary search */
    this.flatSections = [];

    this.isVisible = false;
    this.treeBuilt = false;
    this.domBuilt = false;

    this.popup = null;
    this.branch = null;
    this.treeContainer = null;

    this.#createPopup();
    this.#setupDismissListeners();
  }

  /** @returns {ViewerPane} */
  get pane() {
    return this.wm.activePane;
  }

  get doc() {
    return this.wm.document;
  }

  /**
   * Build the navigation tree. Call this once when document loads.
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.treeBuilt) return;

    const pdfDoc = this.doc.pdfDoc;
    const outline = await pdfDoc.getOutline();

    if (!outline || outline.length === 0) {
      this.tree = [];
      this.flatSections = [];
      this.treeBuilt = true;
      return;
    }

    const destCache = new Map();

    this.tree = await this.#buildOutlineTree(outline, destCache);

    this.flatSections = this.#flattenSections(this.tree);

    const figureTableItems =
      await this.#extractFigureTableAnnotations(destCache);
    this.#insertFiguresIntoTree(figureTableItems);

    this.treeBuilt = true;
  }

  #createPopup() {
    this.popup = document.createElement("div");
    this.popup.className = "nav-popup";

    this.branch = document.createElement("div");
    this.branch.className = "nav-branch";

    this.treeContainer = document.createElement("div");
    this.treeContainer.className = "nav-tree";

    this.popup.appendChild(this.branch);
    this.popup.appendChild(this.treeContainer);
    document.body.appendChild(this.popup);
  }

  #setupDismissListeners() {
    const dismiss = () => {
      if (this.isVisible) this.hide();
    };

    document.addEventListener("click", (e) => {
      if (!this.isVisible) return;
      if (
        !this.popup.contains(e.target) &&
        !this.toolbar.ball.contains(e.target)
      ) {
        this.hide();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (this.isVisible && e.key === "Escape") this.hide();
    });
  }

  /**
   * Recursively build navigation tree from PDF outline
   * @param {Object[]} outline
   * @param {Map} destCache
   * @returns {Promise<NavItem[]>}
   */
  async #buildOutlineTree(outline, destCache) {
    const items = [];

    for (const entry of outline) {
      const position = await this.#resolveDestination(entry.dest, destCache);

      /** @type {NavItem} */
      const item = {
        title: entry.title || "Untitled",
        type: "section",
        pageIndex: position?.pageIndex ?? 0,
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        children: [],
        expanded: false,
      };

      if (entry.items?.length > 0) {
        item.children = await this.#buildOutlineTree(entry.items, destCache);
      }

      items.push(item);
    }

    return items;
  }

  /**
   * Resolve a PDF destination to page coordinates (cached)
   * @param {string|Array} dest
   * @param {Map} cache
   * @returns {Promise<{pageIndex: number, left: number, top: number}|null>}
   */
  async #resolveDestination(dest, cache) {
    if (!dest) return null;

    const cacheKey = typeof dest === "string" ? dest : JSON.stringify(dest);
    if (cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const pdfDoc = this.doc.pdfDoc;
    const namedDests = this.doc.allNamedDests;

    let explicitDest = dest;

    if (typeof dest === "string") {
      explicitDest = namedDests?.[dest];
      if (!explicitDest) {
        try {
          explicitDest = await pdfDoc.getDestination(dest);
        } catch {
          cache.set(cacheKey, null);
          return null;
        }
      }
    }

    if (!Array.isArray(explicitDest)) {
      cache.set(cacheKey, null);
      return null;
    }

    const [ref, , left, top] = explicitDest;

    try {
      const pageIndex = await pdfDoc.getPageIndex(ref);
      const result = { pageIndex, left: left ?? 0, top: top ?? 0 };
      cache.set(cacheKey, result);
      return result;
    } catch {
      cache.set(cacheKey, null);
      return null;
    }
  }

  /**
   * Flatten sections into sorted array for binary search
   * @param {NavItem[]} items
   * @param {NavItem[]} result
   * @returns {NavItem[]}
   */
  #flattenSections(items, result = []) {
    for (const item of items) {
      if (item.type === "section") {
        result.push(item);
        if (item.children.length > 0) {
          this.#flattenSections(item.children, result);
        }
      }
    }
    return result;
  }

  /**
   * Extract figure and table links from annotations
   * @param {Map} destCache
   * @returns {Promise<NavItem[]>}
   */
  async #extractFigureTableAnnotations(destCache) {
    const items = [];
    const pdfDoc = this.doc.pdfDoc;
    const numPages = pdfDoc.numPages;
    const figurePattern = /^(fig(ure)?|table|tab)\.?\s*(\d+)/i;

    const seen = new Set();

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const [annotations, textContent] = await Promise.all([
        page.getAnnotations({ intent: "display" }),
        page.getTextContent(),
      ]);

      const textIndex = this.#buildTextSpatialIndex(textContent);

      for (const annot of annotations) {
        if (annot.subtype !== "Link" || !annot.dest) continue;

        const linkText = this.#findAnnotationText(annot, textIndex);
        if (!linkText) continue;

        const match = linkText.match(figurePattern);
        if (!match) continue;

        const position = await this.#resolveDestination(annot.dest, destCache);
        if (!position) continue;

        const key = `${position.pageIndex}:${Math.round(position.top)}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const type = match[1].toLowerCase().startsWith("tab")
          ? "table"
          : "figure";

        items.push({
          title: linkText.trim(),
          type,
          pageIndex: position.pageIndex,
          left: position.left,
          top: position.top,
          children: [],
          expanded: false,
        });
      }

      page.cleanup();
    }

    items.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      return b.top - a.top;
    });

    return items;
  }

  /**
   * Build spatial index for text items
   * @param {Object} textContent
   * @returns {Object[]}
   */
  #buildTextSpatialIndex(textContent) {
    if (!textContent?.items) return [];

    return textContent.items
      .filter((item) => item.str && item.transform)
      .map((item) => ({
        str: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width || 0,
        height: item.height || 10,
      }));
  }

  /**
   * Find text content overlapping an annotation
   * @param {Object} annot
   * @param {Object[]} textIndex
   * @returns {string|null}
   */
  #findAnnotationText(annot, textIndex) {
    if (!annot.rect || textIndex.length === 0) return null;

    const [x1, y1, x2, y2] = annot.rect;
    const left = Math.min(x1, x2);
    const right = Math.max(x1, x2);
    const bottom = Math.min(y1, y2);
    const top = Math.max(y1, y2);

    const matches = [];

    for (const item of textIndex) {
      const itemRight = item.x + item.width;
      const itemTop = item.y + item.height;

      if (
        item.x < right &&
        itemRight > left &&
        item.y < top &&
        itemTop > bottom
      ) {
        matches.push(item.str);
      }
    }

    return matches.length > 0 ? matches.join(" ") : null;
  }

  /**
   * Insert figure/table items into appropriate sections
   * @param {NavItem[]} figureItems
   */
  #insertFiguresIntoTree(figureItems) {
    if (figureItems.length === 0 || this.flatSections.length === 0) {
      // No sections, add figures to root
      this.tree.push(...figureItems);
      return;
    }

    for (const fig of figureItems) {
      const section = this.#findContainingSection(fig.pageIndex, fig.top);
      if (section) {
        section.children.push(fig);
      } else {
        this.tree.push(fig);
      }
    }
  }

  /**
   * Binary search to find containing section
   * @param {number} pageIndex
   * @param {number} top
   * @returns {NavItem|null}
   */
  #findContainingSection(pageIndex, top) {
    const sections = this.flatSections;
    if (sections.length === 0) return null;

    // Binary search for the last section that starts before this position
    let lo = 0;
    let hi = sections.length - 1;
    let result = -1;

    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const section = sections[mid];

      const sectionBefore =
        section.pageIndex < pageIndex ||
        (section.pageIndex === pageIndex && section.top >= top);

      if (sectionBefore) {
        result = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    return result >= 0 ? sections[result] : null;
  }

  // ─────────────────────────────────────────────────────────────
  // DOM Rendering (cached)
  // ─────────────────────────────────────────────────────────────

  #buildDOM() {
    if (this.domBuilt) return;

    this.treeContainer.innerHTML = "";

    if (this.tree.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nav-empty";
      empty.textContent = "No outline available";
      this.treeContainer.appendChild(empty);
    } else {
      const ul = this.#createTreeList(this.tree, 0);
      this.treeContainer.appendChild(ul);
    }

    this.domBuilt = true;
  }

  /**
   * Create nested list for tree items
   * @param {NavItem[]} items
   * @param {number} depth
   * @returns {HTMLUListElement}
   */
  #createTreeList(items, depth) {
    const ul = document.createElement("ul");
    ul.className = "nav-list";
    ul.dataset.depth = String(depth);

    for (const item of items) {
      ul.appendChild(this.#createTreeItem(item, depth));
    }

    return ul;
  }

  /**
   * Create single tree item element
   * @param {NavItem} item
   * @param {number} depth
   * @returns {HTMLLIElement}
   */
  #createTreeItem(item, depth) {
    const li = document.createElement("li");
    li.className = `nav-item nav-item--${item.type}`;

    const hasChildren = item.children.length > 0;

    const row = document.createElement("div");
    row.className = "nav-item-row";

    // Toggle
    const toggle = document.createElement("span");
    toggle.className = hasChildren
      ? "nav-toggle"
      : "nav-toggle nav-toggle--spacer";
    if (hasChildren) {
      toggle.textContent = item.expanded ? "-" : "+";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        item.expanded = !item.expanded;
        toggle.textContent = item.expanded ? "-" : "+";
        childList.style.display = item.expanded ? "block" : "none";
      });
    }
    row.appendChild(toggle);

    // Icon
    const icon = document.createElement("span");
    icon.className = "nav-icon";
    icon.textContent =
      item.type === "figure" ? "F" : item.type === "table" ? "T" : "§";
    row.appendChild(icon);

    // Title
    const title = document.createElement("span");
    title.className = "nav-title";
    title.textContent = item.title;
    title.title = item.title;
    row.appendChild(title);

    // Page number
    const pageNum = document.createElement("span");
    pageNum.className = "nav-page";
    pageNum.textContent = String(item.pageIndex + 1);
    row.appendChild(pageNum);

    // Navigation click
    row.addEventListener("click", () => this.#navigateTo(item));

    li.appendChild(row);

    // Children
    let childList = null;
    if (hasChildren) {
      childList = this.#createTreeList(item.children, depth + 1);
      childList.style.display = item.expanded ? "block" : "none";
      li.appendChild(childList);
    }

    return li;
  }

  /**
   * Navigate to item position
   * @param {NavItem} item
   */
  async #navigateTo(item) {
    this.hide();
    await this.pane.scrollToPoint(item.pageIndex, item.left, item.top);
  }

  // ─────────────────────────────────────────────────────────────
  // Show / Hide
  // ─────────────────────────────────────────────────────────────

  async show() {
    if (this.isVisible) {
      this.hide();
      return;
    }

    // Ensure tree is built (should already be from document load)
    if (!this.treeBuilt) {
      await this.initialize();
    }

    // Build DOM once
    this.#buildDOM();

    this.#positionPopup();
    this.popup.classList.add("nav-popup--visible");
    this.isVisible = true;
  }

  hide() {
    if (!this.isVisible) return;
    this.popup.classList.remove("nav-popup--visible");
    this.isVisible = false;
  }

  toggle() {
    if (this.isVisible) {
      this.hide();
    } else {
      this.show();
    }
  }

  #positionPopup() {
    const ballRect = this.toolbar.wrapper.getBoundingClientRect();

    this.branch.style.left = `${ballRect.left}px`;
    this.branch.style.top = `${ballRect.top + ballRect.height / 2}px`;

    const branchWidth = 40;
    this.treeContainer.style.left = `${ballRect.left - branchWidth - 280}px`;
    this.treeContainer.style.top = `${ballRect.top - 100}px`;
  }

  /**
   * Clean up resources
   */
  destroy() {
    this.popup.remove();
    this.tree = [];
    this.flatSections = [];
    this.treeBuilt = false;
    this.domBuilt = false;
  }
}
