/**
 * @typedef {Object} TreeNode
 * @property {string} id
 * @property {string} title
 * @property {'section'|'figure'|'table'|'annotation'} type
 * @property {number} pageIndex
 * @property {number} left
 * @property {number} top
 * @property {TreeNode[]} children
 * @property {boolean} expanded
 * @property {string} [annotationType] - 'highlight' or 'underline'
 * @property {string} [color] - annotation color
 * @property {string} [annotationId] - reference to actual annotation
 * @property {string} [pageRange] - e.g., "pp. 3-5" for cross-page
 * @property {{color: string}[]} [annotationDots] - dots to show on section
 * @property {number} [extraAnnotationCount] - count beyond 3 dots
 */

const rightSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-chevron-right" viewBox="0 0 16 16">
    <path fill-rule="evenodd" d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708"/>
  </svg>`;
const downSvg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" class="bi bi-chevron-down" viewBox="0 0 16 16">
    <path fill-rule="evenodd" d="M1.646 4.646a.5.5 0 0 1 .708 0L8 10.293l5.646-5.647a.5.5 0 0 1 .708.708l-6 6a.5.5 0 0 1-.708 0l-6-6a.5.5 0 0 1 0-.708"/>
  </svg>`;

export class NavigationTree {
  /**
   * @param {FloatingToolbar} toolbar
   */
  constructor(toolbar) {
    this.toolbar = toolbar;
    this.wm = toolbar.wm;

    /** @type {TreeNode[]} */
    this.tree = [];

    /** @type {TreeNode[]} Flattened sections for annotation placement */
    this.flatSections = [];

    this.isVisible = false;
    this.treeBuilt = false;

    // DOM elements
    this.backdrop = null;
    this.container = null;
    this.treeWrapper = null;
    this.branchSvg = null;

    // Sizing
    this.TREE_WIDTH = 220;
    this.NODE_HEIGHT = 26;
    this.INDENT = 12;
    this.BRANCH_COLOR = "#555";
    this.BRANCH_WIDTH = 1;

    // Hover state
    this.hoverTimeout = null;
    this.collapseTimeout = null;

    // Pinned path - array of node IDs from root to pinned node
    this.pinnedPath = [];

    // Global annotation counter
    this.annotationCounter = 0;

    // Callback for when tree closes
    this.onCloseCallback = null;

    // Hide timeout for mouse leave
    this.hideTimeout = null;

    this.#createElements();
  }

  /** @returns {ViewerPane} */
  get pane() {
    return this.wm.activePane;
  }

  get doc() {
    return this.wm.document;
  }

  // ═══════════════════════════════════════════════════════════════
  // Initialization
  // ═══════════════════════════════════════════════════════════════

  async initialize() {
    if (this.treeBuilt) return;

    const pdfDoc = this.doc.pdfDoc;
    const outline = await pdfDoc.getOutline();

    const destCache = new Map();

    if (outline && outline.length > 0) {
      this.tree = await this.#buildOutlineTree(outline, destCache);
      this.flatSections = this.#flattenSections(this.tree);

      const figureTableItems =
        await this.#extractFigureTableAnnotations(destCache);
      this.#insertFiguresIntoTree(figureTableItems);
    }

    this.treeBuilt = true;
  }

  refreshAnnotations() {
    this.annotationCounter = 0;
    this.#clearAnnotationsFromTree(this.tree);

    const annotations = this.doc.getAllAnnotations();
    const sortedAnnotations = this.#sortAnnotationsByPosition(annotations);

    for (const annotation of sortedAnnotations) {
      this.annotationCounter++;
      const node = this.#createAnnotationNode(
        annotation,
        this.annotationCounter,
      );
      this.#insertAnnotationIntoTree(node);
    }

    this.#calculateAnnotationDots(this.tree);
  }

  // ═══════════════════════════════════════════════════════════════
  // DOM Creation
  // ═══════════════════════════════════════════════════════════════

  #createElements() {
    // Backdrop
    this.backdrop = document.createElement("div");
    this.backdrop.className = "nav-tree-backdrop";
    document.body.appendChild(this.backdrop);

    // Main container
    this.container = document.createElement("div");
    this.container.className = "nav-tree-container";
    document.body.appendChild(this.container);

    // Click outside to close
    this.backdrop.addEventListener("click", (e) => {
      if (e.target === this.backdrop) {
        this.hide();
      }
    });

    // Escape key to close
    this.escapeHandler = (e) => {
      if (e.key === "Escape" && this.isVisible) {
        this.hide();
      }
    };
    document.addEventListener("keydown", this.escapeHandler);
  }

  // ═══════════════════════════════════════════════════════════════
  // Tree Building
  // ═══════════════════════════════════════════════════════════════

  async #buildOutlineTree(outline, destCache) {
    const items = [];

    for (const entry of outline) {
      const position = await this.#resolveDestination(entry.dest, destCache);

      const item = {
        id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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

  #insertFiguresIntoTree(figureItems) {
    if (figureItems.length === 0 || this.flatSections.length === 0) {
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

  #findContainingSection(pageIndex, top) {
    const sections = this.flatSections;
    if (sections.length === 0) return null;

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

  // ═══════════════════════════════════════════════════════════════
  // Annotation Integration
  // ═══════════════════════════════════════════════════════════════

  #clearAnnotationsFromTree(nodes) {
    for (let i = nodes.length - 1; i >= 0; i--) {
      const node = nodes[i];
      if (node.type === "annotation") {
        nodes.splice(i, 1);
      } else {
        node.annotationDots = [];
        node.extraAnnotationCount = 0;
        if (node.children.length > 0) {
          this.#clearAnnotationsFromTree(node.children);
        }
      }
    }
  }

  #sortAnnotationsByPosition(annotations) {
    return [...annotations].sort((a, b) => {
      const aPage = a.pageRanges[0]?.pageNumber ?? 0;
      const bPage = b.pageRanges[0]?.pageNumber ?? 0;
      if (aPage !== bPage) return aPage - bPage;

      const aTop = a.pageRanges[0]?.rects[0]?.topRatio ?? 0;
      const bTop = b.pageRanges[0]?.rects[0]?.topRatio ?? 0;
      return aTop - bTop;
    });
  }

  #createAnnotationNode(annotation, counter) {
    const firstPage = annotation.pageRanges[0];
    const lastPage = annotation.pageRanges[annotation.pageRanges.length - 1];

    let pageRange = null;
    if (firstPage?.pageNumber !== lastPage?.pageNumber) {
      pageRange = `pp. ${firstPage.pageNumber}-${lastPage.pageNumber}`;
    }

    const typeName =
      annotation.type === "highlight" ? "Hightlight" : "Underline";

    const title = annotation.comment ? `Cmt: ${annotation.comment}` : `${typeName} ${counter} `;

    return {
      id: crypto.randomUUID(),
      title: title,
      type: "annotation",
      annotationType: annotation.type,
      color: annotation.color,
      annotationId: annotation.id,
      pageIndex: (firstPage?.pageNumber ?? 1) - 1,
      left: 0,
      top: firstPage?.rects[0]?.topRatio ?? 0,
      children: [],
      expanded: false,
    };
  }

  #insertAnnotationIntoTree(annotationNode) {
    const section = this.#findContainingSection(
      annotationNode.pageIndex,
      1 - annotationNode.top,
    );

    if (section) {
      section.children.push(annotationNode);
    } else if (this.tree.length > 0) {
      this.tree[this.tree.length - 1].children.push(annotationNode);
    } else {
      this.tree.push(annotationNode);
    }
  }

  #calculateAnnotationDots(nodes) {
    for (const node of nodes) {
      if (node.type === "section") {
        const annotations = this.#collectAnnotationsInSubtree(node);
        const colors = annotations.map((a) => a.color);
        const uniqueColors = [...new Set(colors)];

        node.annotationDots = uniqueColors
          .slice(0, 3)
          .map((color) => ({ color }));
        node.extraAnnotationCount = Math.max(0, annotations.length - 3);

        if (node.children.length > 0) {
          this.#calculateAnnotationDots(node.children);
        }
      }
    }
  }

  #collectAnnotationsInSubtree(node) {
    const annotations = [];

    for (const child of node.children) {
      if (child.type === "annotation") {
        annotations.push(child);
      } else if (child.children.length > 0) {
        annotations.push(...this.#collectAnnotationsInSubtree(child));
      }
    }

    return annotations;
  }

  #render() {
    this.container.innerHTML = "";

    if (this.tree.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nav-tree-empty";
      empty.textContent = "No outline available";
      this.container.appendChild(empty);
      return;
    }

    // Create wrapper for the tree content
    this.treeWrapper = document.createElement("div");
    this.treeWrapper.className = "nav-tree-wrapper";
    this.container.appendChild(this.treeWrapper);

    // Create SVG for branches
    this.branchSvg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    this.branchSvg.classList.add("nav-tree-branches");
    this.treeWrapper.appendChild(this.branchSvg);

    // Render tree nodes
    const list = document.createElement("div");
    list.className = "nav-tree-list";
    this.treeWrapper.appendChild(list);

    this.tree.forEach((node, index) => {
      const nodeEl = this.#createNodeElement(node, 0, [index]);
      list.appendChild(nodeEl);
    });

    // Draw branches after DOM is ready
    requestAnimationFrame(() => {
      this.#drawAllBranches();
    });
  }

  #createNodeElement(node, depth, path) {
    const item = document.createElement("div");
    item.className = "nav-tree-item";
    item.dataset.nodeId = node.id;
    item.dataset.depth = depth;
    item.dataset.path = JSON.stringify(path);
    item.style.maxWidth = this.treeWrapper.style.width;

    // Node row
    const row = document.createElement("div");
    row.className = `nav-tree-row nav-tree-row--${node.type}`;
    // Add INDENT to leave room for branch line at each level
    row.style.marginLeft = `${(1+depth) * this.INDENT}px`;

    // Chevron
    const hasChildren = node.children.length > 0;
    const chevron = document.createElement("span");
    chevron.className = "nav-tree-chevron";
    if (hasChildren) {
      chevron.innerHTML = node.expanded ? downSvg : rightSvg;
      chevron.addEventListener("click", (e) => {
        e.stopPropagation400
        this.#togglePin(node, item, path);
      });
    }
    row.appendChild(chevron);

    // Icon
    const icon = document.createElement("span");
    icon.className = "nav-tree-icon";
    if (node.type === "annotation") {
      icon.innerHTML = node.annotationType === "highlight" ? "■" : "▬";
      icon.style.color = this.#getAnnotationColor(node.color);
    } else {
      icon.innerHTML =
        node.type === "figure" ? "F" : node.type === "table" ? "T" : "§";
    }
    row.appendChild(icon);

    // Title
    const title = document.createElement("span");
    title.className = "nav-tree-title";
    title.textContent = node.title;
    title.title = node.title;
    row.appendChild(title);

    // Annotation dots
    if (node.annotationDots && node.annotationDots.length > 0) {
      const dotsContainer = document.createElement("span");
      dotsContainer.className = "nav-tree-dots";

      for (const dot of node.annotationDots) {
        const dotEl = document.createElement("span");
        dotEl.className = "nav-tree-dot";
        dotEl.style.backgroundColor = this.#getAnnotationColor(dot.color);
        dotsContainer.appendChild(dotEl);
      }

      if (node.extraAnnotationCount > 0) {
        const badge = document.createElement("span");
        badge.className = "nav-tree-dot-badge";
        badge.textContent = `+${node.extraAnnotationCount}`;
        dotsContainer.appendChild(badge);
      }

      row.appendChild(dotsContainer);
    }

    item.appendChild(row);

    // Children container
    if (hasChildren) {
      const childrenContainer = document.createElement("div");
      childrenContainer.className = "nav-tree-children";
      if (!node.expanded) {
        childrenContainer.style.display = "none";
      } else {
        node.children.forEach((child, idx) => {
          const childPath = [...path, idx];
          const childEl = this.#createNodeElement(child, depth + 1, childPath);
          childrenContainer.appendChild(childEl);
        });
      }
      item.appendChild(childrenContainer);
    }

    // Events
    this.#attachNodeEvents(row, item, node, path);

    return item;
  }

  #attachNodeEvents(row, wrapper, node, path) {
    const hasChildren = node.children.length > 0;

    // Hover to expand (and collapse siblings)
    row.addEventListener("mouseenter", () => {
      if (this.hoverTimeout) clearTimeout(this.hoverTimeout);

      row.classList.add("hovered");

      if (hasChildren && !node.expanded) {
        this.hoverTimeout = setTimeout(() => {
          // Collapse siblings at the same level before expanding
          this.#collapseSiblings(wrapper, node);
          this.#expandNode(node, wrapper, path);
        }, 200);
      } else if (!hasChildren) {
        // Leaf node - collapse any expanded siblings
        this.hoverTimeout = setTimeout(() => {
          this.#collapseSiblings(wrapper, node);
        }, 200);
      }
    });

    row.addEventListener("mouseleave", () => {
      row.classList.remove("hovered");

      if (this.hoverTimeout) {
        clearTimeout(this.hoverTimeout);
        this.hoverTimeout = null;
      }
    });

    // Click to navigate
    row.querySelector(".nav-tree-title").addEventListener("click", () => {
      this.#navigateTo(node);
    });
  }

  #collapseSiblings(wrapper, currentNode) {
    // Find the parent container (either nav-tree-list for root or nav-tree-children for nested)
    const parentContainer = wrapper.parentElement;
    if (!parentContainer) return;

    // Get all sibling items at this level
    const siblings = parentContainer.querySelectorAll(
      ":scope > .nav-tree-item",
    );

    siblings.forEach((siblingEl) => {
      if (siblingEl === wrapper) return; // Skip current node

      const siblingId = siblingEl.dataset.nodeId;
      const siblingNode = this.#findNodeById(siblingId, this.tree);

      if (
        siblingNode &&
        siblingNode.expanded &&
        !this.#isInPinnedPath(siblingId)
      ) {
        this.#collapseNode(siblingNode, siblingEl);
      }
    });
  }

  #expandNode(node, wrapper, path) {
    if (node.expanded) return;

    node.expanded = true;
    wrapper.classList.add("expanded");

    const chevron = wrapper.querySelector(
      ":scope > .nav-tree-row > .nav-tree-chevron",
    );
    if (chevron) chevron.innerHTML = downSvg;

    const childrenContainer = wrapper.querySelector(
      ":scope > .nav-tree-children",
    );
    if (!childrenContainer) return;

    // Render children
    childrenContainer.innerHTML = "";
    childrenContainer.style.display = "";

    node.children.forEach((child, idx) => {
      const childPath = [...path, idx];
      const childEl = this.#createNodeElement(
        child,
        parseInt(wrapper.dataset.depth) + 1,
        childPath,
      );
      childrenContainer.appendChild(childEl);
    });

    // Redraw branches
    requestAnimationFrame(() => {
      this.#drawAllBranches();
    });
  }

  #collapseNode(node, wrapper) {
    if (!node.expanded) return;

    // First recursively collapse children
    this.#collapseAllChildren(node);

    node.expanded = false;
    wrapper.classList.remove("expanded");

    const chevron = wrapper.querySelector(
      ":scope > .nav-tree-row > .nav-tree-chevron",
    );
    if (chevron) chevron.innerHTML = rightSvg;

    const childrenContainer = wrapper.querySelector(
      ":scope > .nav-tree-children",
    );
    if (childrenContainer) {
      childrenContainer.style.display = "none";
      childrenContainer.innerHTML = "";
    }

    // Redraw branches
    requestAnimationFrame(() => {
      this.#drawAllBranches();
    });
  }

  #collapseAllChildren(node) {
    for (const child of node.children) {
      if (child.expanded) {
        child.expanded = false;
        this.#collapseAllChildren(child);
      }
    }
  }

  #togglePin(node, wrapper, path) {
    const isCurrentlyPinned = this.#isInPinnedPath(node.id);

    if (isCurrentlyPinned) {
      // Unpin - clear entire path
      this.pinnedPath = [];

      // Collapse this node
      this.#collapseNode(node, wrapper);
    } else {
      // Pin - set path from root to this node
      this.pinnedPath = this.#getPathToNode(node.id);

      // Ensure node is expanded
      if (!node.expanded) {
        this.#expandNode(node, wrapper, path);
      }
    }

    this.#updatePinnedStyles();
  }

  #isInPinnedPath(nodeId) {
    return this.pinnedPath.includes(nodeId);
  }

  #getPathToNode(targetId, nodes = this.tree, currentPath = []) {
    for (const node of nodes) {
      const newPath = [...currentPath, node.id];

      if (node.id === targetId) {
        return newPath;
      }

      if (node.children.length > 0) {
        const found = this.#getPathToNode(targetId, node.children, newPath);
        if (found) return found;
      }
    }

    return null;
  }

  #updatePinnedStyles() {
    const allItems = this.container.querySelectorAll(".nav-tree-item");
    allItems.forEach((item) => {
      const nodeId = item.dataset.nodeId;
      item.classList.toggle("pinned", this.pinnedPath.includes(nodeId));
    });
  }

  #navigateTo(node) {
    if (node.type === "annotation" && node.annotationId) {
      this.pane.annotationManager?.selectAnnotation?.(node.annotationId);
      const top = window.innerHeight * (1-node.top);
      this.pane.scrollToPoint(node.pageIndex, 0, top);
    } else {
      this.pane.scrollToPoint(node.pageIndex, node.left, node.top);
    }
 
    if (this.pinnedPath.length === 0) {
      this.hide();
    }
  }

  #getAnnotationColor(colorName) {
    const colors = {
      yellow: "#f59e0b",
      red: "#ef4444",
      blue: "#3b82f6",
      green: "#22c55e",
    };
    return colors[colorName] || colors.yellow;
  }

  #drawAllBranches() {
    if (!this.branchSvg || !this.treeWrapper) return;

    // Clear existing
    this.branchSvg.innerHTML = "";

    // Use double RAF to ensure layout is complete
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const wrapperRect = this.treeWrapper.getBoundingClientRect();

        // Size SVG to match wrapper
        this.branchSvg.style.width = `${wrapperRect.width}px`;
        this.branchSvg.style.height = `${wrapperRect.height}px`;
        this.branchSvg.setAttribute(
          "viewBox",
          `0 0 ${wrapperRect.width} ${wrapperRect.height}`,
        );

        // Draw first level branches (root items)
        const rootList = this.treeWrapper.querySelector(".nav-tree-list");
        if (rootList) {
          const rootItems = rootList.querySelectorAll(
            ":scope > .nav-tree-item",
          );
          if (rootItems.length > 0) {
            this.#drawBranchesForItems(rootItems, 0, wrapperRect);
          }
        }

        // Draw branches for all expanded items' children
        const expandedItems = this.treeWrapper.querySelectorAll(
          ".nav-tree-item.expanded",
        );
        expandedItems.forEach((parentItem) => {
          const childrenContainer = parentItem.querySelector(
            ":scope > .nav-tree-children",
          );
          if (!childrenContainer) return;

          const childItems = childrenContainer.querySelectorAll(
            ":scope > .nav-tree-item",
          );
          if (childItems.length === 0) return;

          const parentDepth = parseInt(parentItem.dataset.depth) || 0;
          this.#drawBranchesForItems(childItems, parentDepth + 1, wrapperRect);
        });
      });
    });
  }

  #drawBranchesForItems(items, depth, wrapperRect) {
    if (items.length === 0) return;

    const lineX = depth * this.INDENT + 6;

    // Get first and last rows
    const firstRow = items[0].querySelector(":scope > .nav-tree-row");
    const lastRow = items[items.length - 1].querySelector(
      ":scope > .nav-tree-row",
    );

    if (!firstRow || !lastRow) return;

    const firstRect = firstRow.getBoundingClientRect();
    const lastRect = lastRow.getBoundingClientRect();

    const startY = firstRect.top - wrapperRect.top + firstRect.height / 2;
    const endY = lastRect.top - wrapperRect.top + lastRect.height / 2;

    // Draw vertical line connecting all items
    if (items.length > 1 || depth > 0) {
      const vertical = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      vertical.setAttribute("class", "nav-tree-branch");
      vertical.setAttribute("x1", lineX);
      vertical.setAttribute("y1", startY);
      vertical.setAttribute("x2", lineX);
      vertical.setAttribute("y2", endY);
      this.branchSvg.appendChild(vertical);
    }

    // Draw horizontal branch to each item
    items.forEach((item) => {
      const row = item.querySelector(":scope > .nav-tree-row");
      if (!row) return;

      const rowRect = row.getBoundingClientRect();
      const rowY = rowRect.top - wrapperRect.top + rowRect.height / 2;

      const horizontal = document.createElementNS(
        "http://www.w3.org/2000/svg",
        "line",
      );
      horizontal.setAttribute("class", "nav-tree-branch");
      horizontal.setAttribute("x1", lineX);
      horizontal.setAttribute("y1", rowY);
      horizontal.setAttribute("x2", lineX + this.INDENT - 4);
      horizontal.setAttribute("y2", rowY);
      this.branchSvg.appendChild(horizontal);
    });
  }

  #findNodeById(id, nodes) {
    for (const node of nodes) {
      if (node.id === id) return node;
      if (node.children.length > 0) {
        const found = this.#findNodeById(id, node.children);
        if (found) return found;
      }
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // Show / Hide
  // ═══════════════════════════════════════════════════════════════

  async show(ballRightX, onClose = null) {
    if (this.isVisible) return;

    this.onCloseCallback = onClose;

    if (!this.treeBuilt) {
      await this.initialize();
    }

    this.refreshAnnotations();

    // Store ball position for centering
    this.ballRightX = ballRightX;
    this.ballCenterY =
      this.toolbar.ball.getBoundingClientRect().top +
      this.toolbar.ball.getBoundingClientRect().height / 2;

    // Position container - right half of window, starting from ball
    const viewportWidth = window.innerWidth;
    this.container.style.left = `${ballRightX + 15}px`;
    this.container.style.right = "20px";
    this.container.style.width = "auto";

    // Show backdrop - covers right half from ball position
    this.backdrop.style.left = `${ballRightX - 300}px`;
    this.backdrop.style.right = "0";
    this.backdrop.style.width = "auto";
    this.backdrop.classList.add("visible");

    // Show container
    this.container.classList.add("visible");

    // Render after a brief delay
    setTimeout(() => {
      this.#render();
      this.#centerOnBall();
    }, 100);

    this.isVisible = true;
  }

  #centerOnBall() {
    // Calculate the center point of the tree content
    const wrapper = this.container.querySelector(".nav-tree-wrapper");
    if (!wrapper) return;

    const wrapperRect = wrapper.getBoundingClientRect();
    const wrapperHeight = wrapperRect.height;
    const viewportHeight = window.innerHeight;

    // Target: center of tree aligns with ball center
    const targetTop = this.ballCenterY - wrapperHeight / 2;

    // Clamp to viewport bounds with padding
    const padding = 30;
    const clampedTop = Math.max(
      padding,
      Math.min(targetTop, viewportHeight - wrapperHeight - padding),
    );

    wrapper.style.top = `${clampedTop}px`;
    this.container.style.height = `${viewportHeight}px`;
  }

  hide() {
    if (!this.isVisible) return;

    // Clear any pending timeouts
    if (this.hideTimeout) {
      clearTimeout(this.hideTimeout);
      this.hideTimeout = null;
    }
    if (this.hoverTimeout) {
      clearTimeout(this.hoverTimeout);
      this.hoverTimeout = null;
    }
    if (this.collapseTimeout) {
      clearTimeout(this.collapseTimeout);
      this.collapseTimeout = null;
    }

    // Reset states
    this.#resetTreeState(this.tree);
    this.pinnedPath = [];

    this.backdrop.classList.remove("visible");
    this.container.classList.remove("visible");

    setTimeout(() => {
      this.container.innerHTML = "";
    }, 300);

    this.isVisible = false;

    if (this.onCloseCallback) {
      this.onCloseCallback();
      this.onCloseCallback = null;
    }
  }

  #resetTreeState(nodes) {
    for (const node of nodes) {
      node.expanded = false;
      if (node.children.length > 0) {
        this.#resetTreeState(node.children);
      }
    }
  }

  destroy() {
    // Clear timeouts
    if (this.hideTimeout) clearTimeout(this.hideTimeout);
    if (this.hoverTimeout) clearTimeout(this.hoverTimeout);
    if (this.collapseTimeout) clearTimeout(this.collapseTimeout);

    // Remove escape handler
    if (this.escapeHandler) {
      document.removeEventListener("keydown", this.escapeHandler);
    }

    this.backdrop?.remove();
    this.container?.remove();
    this.tree = [];
    this.flatSections = [];
    this.treeBuilt = false;
    this.pinnedPath = [];
  }
}
