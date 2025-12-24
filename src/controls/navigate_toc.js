/**
 * @typedef {import('../window_manager.js').SplitWindowManager} SplitWindowManager;
 * @typedef {import('../viewpane.js').ViewerPane} ViewerPane;
 * @typedef {import('../controls/floating_toolbar.js').FloatingToolbar} FloatingToolbar;
 * 
 * @typedef {Object} NavItem
 * @property {string} title
 * @property {string} type - 'section' | 'figure' | 'table'
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
    this.isVisible = false;
    this.isBuilt = false;
    
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
    const onScroll = () => {
      if (this.isVisible) this.hide();
    };
    
    const onClick = (e) => {
      if (!this.isVisible) return;
      if (!this.popup.contains(e.target) && !this.toolbar.ball.contains(e.target)) {
        this.hide();
      }
    };
    
    const onKeydown = (e) => {
      if (this.isVisible && e.key === "Escape") {
        this.hide();
      }
    };

    // Use capture phase for scroll to catch it before it bubbles
    document.addEventListener("scroll", onScroll, true);
    document.addEventListener("click", onClick);
    document.addEventListener("keydown", onKeydown);
  }

  async #parseTree() {
    const pdfDoc = this.doc.pdfDoc;
    const outline = await pdfDoc.getOutline();
    
    if (!outline || outline.length === 0) {
      this.tree = [];
      return;
    }

    this.tree = await this.#buildOutlineTree(outline);
    const figureTableItems = await this.#extractFigureTableAnnotations();
    this.#insertFiguresIntoTree(figureTableItems);
  }

  /**
   * Recursively build navigation tree from PDF outline
   * @param {Object[]} outline
   * @returns {Promise<NavItem[]>}
   */
  async #buildOutlineTree(outline) {
    const items = [];
    
    for (const entry of outline) {
      const position = await this.#resolveDestination(entry.dest);
      
      /** @type {NavItem} */
      const item = {
        title: entry.title || "Untitled",
        type: "section",
        pageIndex: position?.pageIndex ?? 0,
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        children: [],
        expanded: false
      };
      
      if (entry.items && entry.items.length > 0) {
        item.children = await this.#buildOutlineTree(entry.items);
      }
      
      items.push(item);
    }
    
    return items;
  }

  /**
   * Resolve a PDF destination to page coordinates
   * @param {string|Array} dest
   * @returns {Promise<{pageIndex: number, left: number, top: number}|null>}
   */
  async #resolveDestination(dest) {
    if (!dest) return null;
    
    const pdfDoc = this.doc.pdfDoc;
    const namedDests = this.doc.allNamedDests;
    
    let explicitDest = dest;
    
    if (typeof dest === "string") {
      explicitDest = namedDests?.[dest];
      if (!explicitDest) {
        try {
          explicitDest = await pdfDoc.getDestination(dest);
        } catch {
          return null;
        }
      }
    }
    
    if (!Array.isArray(explicitDest)) return null;
    
    const [ref, , left, top] = explicitDest;
    
    try {
      const pageIndex = await pdfDoc.getPageIndex(ref);
      return { pageIndex, left: left ?? 0, top: top ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * Extract figure and table links from annotations
   * @returns {Promise<NavItem[]>}
   */
  async #extractFigureTableAnnotations() {
    const items = [];
    const pdfDoc = this.doc.pdfDoc;
    const namedDests = this.doc.allNamedDests;
    const numPages = pdfDoc.numPages;
    
    const figurePattern = /^(fig(ure)?|table|tab)\s*\.?\s*(\d+)/i;
    
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const annotations = await page.getAnnotations({ intent: "display" });
      const textContent = await page.getTextContent();
      
      for (const a of annotations) {
        if (a.subtype !== "Link") continue;
        if (!a.dest) continue;
        
        const linkText = this.#findAnnotationText(a, textContent, page);
        if (!linkText) continue;
        
        const match = linkText.match(figurePattern);
        if (!match) continue;
        
        const type = match[1].toLowerCase().startsWith("tab") ? "table" : "figure";
        const position = await this.#resolveDestination(a.dest);
        
        if (position) {
          items.push({
            title: linkText.trim(),
            type,
            pageIndex: position.pageIndex,
            left: position.left,
            top: position.top,
            children: [],
            expanded: false,
            sourcePageIndex: pageNum - 1
          });
        }
      }
    }
    
    return this.#deduplicateItems(items);
  }

  /**
   * Find text content near an annotation rectangle
   * @param {Object} annot
   * @param {Object} textContent
   * @param {Object} page
   * @returns {string|null}
   */
  #findAnnotationText(annot, textContent, page) {
    if (!annot.rect || !textContent?.items) return null;
    
    const [x1, y1, x2, y2] = annot.rect;
    const annotLeft = Math.min(x1, x2);
    const annotRight = Math.max(x1, x2);
    const annotBottom = Math.min(y1, y2);
    const annotTop = Math.max(y1, y2);
    
    const matchingText = [];
    
    for (const item of textContent.items) {
      if (!item.transform || !item.str) continue;
      
      const itemX = item.transform[4];
      const itemY = item.transform[5];
      const itemWidth = item.width || 0;
      const itemHeight = item.height || 10;
      
      const overlapsX = itemX < annotRight && (itemX + itemWidth) > annotLeft;
      const overlapsY = itemY < annotTop && (itemY + itemHeight) > annotBottom;
      
      if (overlapsX && overlapsY) {
        matchingText.push(item.str);
      }
    }
    
    return matchingText.join(" ") || null;
  }

  /**
   * Remove duplicate figure/table references
   * @param {NavItem[]} items
   * @returns {NavItem[]}
   */
  #deduplicateItems(items) {
    const seen = new Map();
    
    for (const item of items) {
      const key = `${item.type}-${item.pageIndex}-${Math.round(item.top)}`;
      if (!seen.has(key)) {
        seen.set(key, item);
      }
    }
    
    return Array.from(seen.values());
  }

  /**
   * Insert figure/table items into the tree under appropriate sections
   * @param {NavItem[]} figureItems
   */
  #insertFiguresIntoTree(figureItems) {
    if (figureItems.length === 0) return;
    
    // Sort by page index and top position
    figureItems.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      return b.top - a.top; // Higher top = earlier in page (PDF coordinates)
    });
    
    // For each figure, find the section it belongs to
    for (const fig of figureItems) {
      const section = this.#findContainingSection(fig.pageIndex, fig.top);
      if (section) {
        section.children.push(fig);
      } else {
        // No containing section found, add to root level
        this.tree.push(fig);
      }
    }
  }

  /**
   * Find the section that contains a given page position
   * @param {number} pageIndex
   * @param {number} top
   * @returns {NavItem|null}
   */
  #findContainingSection(pageIndex, top) {
    let bestMatch = null;
    
    const search = (items, parent = null) => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type !== "section") continue;
        
        const nextSection = items[i + 1];
        const isAfterCurrent = 
          pageIndex > item.pageIndex || 
          (pageIndex === item.pageIndex && top <= item.top);
        
        const isBeforeNext = !nextSection || 
          nextSection.type !== "section" ||
          pageIndex < nextSection.pageIndex ||
          (pageIndex === nextSection.pageIndex && top > nextSection.top);
        
        if (isAfterCurrent && isBeforeNext) {
          bestMatch = item;
          if (item.children.length > 0) {
            search(item.children, item);
          }
        }
      }
    };
    
    search(this.tree);
    return bestMatch;
  }

  // ─────────────────────────────────────────────────────────────
  // Rendering
  // ─────────────────────────────────────────────────────────────

  #renderTree() {
    this.treeContainer.innerHTML = "";
    
    if (this.tree.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nav-empty";
      empty.textContent = "No outline available";
      this.treeContainer.appendChild(empty);
      return;
    }
    
    const ul = this.#createTreeList(this.tree, 0);
    this.treeContainer.appendChild(ul);
  }

  /**
   * Create a nested list for tree items
   * @param {NavItem[]} items
   * @param {number} depth
   * @returns {HTMLUListElement}
   */
  #createTreeList(items, depth) {
    const ul = document.createElement("ul");
    ul.className = "nav-list";
    ul.dataset.depth = depth.toString();
    
    for (const item of items) {
      const li = this.#createTreeItem(item, depth);
      ul.appendChild(li);
    }
    
    return ul;
  }

  /**
   * Create a single tree item element
   * @param {NavItem} item
   * @param {number} depth
   * @returns {HTMLLIElement}
   */
  #createTreeItem(item, depth) {
    const li = document.createElement("li");
    li.className = `nav-item nav-item--${item.type}`;
    
    const hasChildren = item.children.length > 0;
    
    // Item row
    const row = document.createElement("div");
    row.className = "nav-item-row";
    
    // Expand/collapse toggle
    if (hasChildren) {
      const toggle = document.createElement("span");
      toggle.className = "nav-toggle";
      toggle.innerHTML = item.expanded ? "▼" : "▶";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        this.#toggleItem(item, li);
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement("span");
      spacer.className = "nav-toggle nav-toggle--spacer";
      row.appendChild(spacer);
    }
    
    // Icon
    const icon = document.createElement("span");
    icon.className = "nav-icon";
    icon.textContent = this.#getIcon(item.type);
    row.appendChild(icon);
    
    // Title
    const title = document.createElement("span");
    title.className = "nav-title";
    title.textContent = item.title;
    title.title = item.title;
    row.appendChild(title);
    
    // Page number indicator
    const pageNum = document.createElement("span");
    pageNum.className = "nav-page";
    pageNum.textContent = (item.pageIndex + 1).toString();
    row.appendChild(pageNum);
    
    // Click to navigate
    row.addEventListener("click", () => {
      this.#navigateTo(item);
    });
    
    li.appendChild(row);
    
    // Children container
    if (hasChildren) {
      const childList = this.#createTreeList(item.children, depth + 1);
      childList.style.display = item.expanded ? "block" : "none";
      li.appendChild(childList);
    }
    
    return li;
  }

  /**
   * Get icon for item type
   * @param {string} type
   * @returns {string}
   */
  #getIcon(type) {
    switch (type) {
      case "figure": return "🖼";
      case "table": return "📊";
      default: return "§";
    }
  }

  /**
   * Toggle expand/collapse of a tree item
   * @param {NavItem} item
   * @param {HTMLLIElement} li
   */
  #toggleItem(item, li) {
    item.expanded = !item.expanded;
    
    const toggle = li.querySelector(".nav-toggle");
    const childList = li.querySelector(":scope > .nav-list");
    
    if (toggle) {
      toggle.innerHTML = item.expanded ? "▼" : "▶";
    }
    
    if (childList) {
      childList.style.display = item.expanded ? "block" : "none";
    }
  }

  /**
   * Navigate to an item's position
   * @param {NavItem} item
   */
  async #navigateTo(item) {
    await this.pane.scrollToPoint(item.pageIndex, item.left, item.top);
    this.hide();
  }

  // ─────────────────────────────────────────────────────────────
  // Show / Hide
  // ─────────────────────────────────────────────────────────────

  async show() {
    if (this.isVisible) {
      this.hide();
      return;
    }
    
    // Build tree on first show
    if (!this.isBuilt) {
      await this.#parseTree();
      this.isBuilt = true;
    }
    
    this.#renderTree();
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
    const ballRect = this.toolbar.ball.getBoundingClientRect();
    
    // Position branch to connect from ball
    this.branch.style.left = `${ballRect.left}px`;
    this.branch.style.top = `${ballRect.top + ballRect.height / 2}px`;
    
    // Position tree container
    const branchWidth = 40;
    this.treeContainer.style.left = `${ballRect.left - branchWidth - 280}px`;
    this.treeContainer.style.top = `${ballRect.top - 100}px`;
  }

  /**
   * Refresh the tree (call after document changes)
   */
  async refresh() {
    this.isBuilt = false;
    if (this.isVisible) {
      await this.#parseTree();
      this.isBuilt = true;
      this.#renderTree();
    }
  }
}
