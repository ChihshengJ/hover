/**
 * @typedef {Object} TreeNode
 * @property {string} id
 * @property {string} title
 * @property {'section'|'figure'|'table'|'annotation'} type
 * @property {number} pageIndex - 0-based page index
 * @property {number} left - X position in PDF coordinates
 * @property {number} top - Y position in PDF coordinates (origin bottom-left, higher = higher on page)
 * @property {number} columnIndex - Column index: -1 for full-width, 0 for col1, 1 for col2, etc.
 * @property {TreeNode[]} children
 * @property {boolean} expanded
 * @property {string} [annotationType] - 'highlight' or 'underline'
 * @property {string} [color] - annotation coloroutline_builder
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

    /** @type {TreeNode[]} Flattened sections for annotation placement (sorted by reading order) */
    this.flatSections = [];

    /** @type {Array<{width: number, height: number}>} Cached page dimensions */
    this.pageDimensions = [];

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

  async initialize() {
    if (this.treeBuilt) return;
    
    // Cache page dimensions for coordinate conversion
    await this.#cachePageDimensions();
    
    const docOutline = this.doc.outline;

    if (docOutline && docOutline.length > 0) {
      this.tree = this.#convertOutlineToTreeNodes(docOutline);
      this.flatSections = this.#flattenSections(this.tree);

      const destCache = this.#buildDestCacheFromOutline(docOutline);
      const figureTableItems = await this.#extractFigureTableAnnotations(destCache);
      this.#insertFiguresIntoTree(figureTableItems);
    }
    this.treeBuilt = true;
  }
  
  /**
   * Cache page dimensions from the document model
   */
  async #cachePageDimensions() {
    // Use cached dimensions from PDFDocumentModel if available
    if (this.doc.pageDimensions && this.doc.pageDimensions.length > 0) {
      this.pageDimensions = this.doc.pageDimensions;
      return;
    }
    
    // Fallback: compute dimensions ourselves
    const pdfDoc = this.doc.pdfDoc;
    if (!pdfDoc) return;
    
    this.pageDimensions = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      this.pageDimensions.push({
        width: viewport.width,
        height: viewport.height,
      });
    }
  }
  
  /**
   * Get page height for a given page index
   * @param {number} pageIndex - 0-based page index
   * @returns {number} Page height in PDF units (default 792 for letter size)
   */
  #getPageHeight(pageIndex) {
    return this.pageDimensions[pageIndex]?.height ?? 792;
  }
  
  /**
   * Get page width for a given page index
   * @param {number} pageIndex - 0-based page index
   * @returns {number} Page width in PDF units (default 612 for letter size)
   */
  #getPageWidth(pageIndex) {
    return this.pageDimensions[pageIndex]?.width ?? 612;
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

  // DOM Creation

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

  // Tree Building
  
  /**
   * Transform doc.outline nodes to TreeNode format
   * Preserves columnIndex from outline_builder for column-aware placement
   * @param {Array} outlineItems - Items from doc.outline
   * @returns {TreeNode[]}
   */
  #convertOutlineToTreeNodes(outlineItems) {
    return outlineItems.map(item => ({
      id: item.id,
      title: item.title,
      type: 'section',
      pageIndex: item.pageIndex,
      left: item.left,
      top: item.top,  // PDF coordinates (origin bottom-left)
      columnIndex: item.columnIndex ?? -1,  // Preserve column info, default to full-width
      children: item.children.length > 0 
        ? this.#convertOutlineToTreeNodes(item.children) 
        : [],
      expanded: false,
    }));
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

  /**
   * Build a destination cache from pre-resolved outline items
   * This avoids re-resolving destinations we've already computed
   * @param {Array} outlineItems
   * @returns {Map}
   */
  #buildDestCacheFromOutline(outlineItems) {
    const cache = new Map();
    
    const addToCache = (items) => {
      for (const item of items) {
        // We can't recover the original dest key, but the cache will still
        // be useful for any new destinations encountered during figure extraction
        if (item.children.length > 0) {
          addToCache(item.children);
        }
      }
    };
    
    addToCache(outlineItems);
    return cache;
  }

  /**
   * Flatten section nodes and sort by reading order
   * Reading order: page → column → vertical position (higher Y = earlier in PDF coords)
   * @param {TreeNode[]} items
   * @param {TreeNode[]} result
   * @returns {TreeNode[]}
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
    
    // Sort by reading order: page → column → Y (descending for PDF coords)
    result.sort((a, b) => {
      // Different pages: earlier page first
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      
      const colA = a.columnIndex ?? -1;
      const colB = b.columnIndex ?? -1;
      
      // Handle full-width vs column items on same page
      if (colA === -1 && colB === -1) {
        // Both full-width: higher Y (top of page in PDF coords) comes first
        return b.top - a.top;
      }
      
      if (colA === -1) {
        // a is full-width, b is in a column
        // Full-width comes before column content if it's above (higher Y)
        // Use a slight bias toward full-width being "earlier" when close
        return b.top > a.top ? 1 : -1;
      }
      
      if (colB === -1) {
        // b is full-width, a is in a column
        return a.top > b.top ? -1 : 1;
      }
      
      // Both in columns: lower column index first (left column before right)
      if (colA !== colB) return colA - colB;
      
      // Same column: higher Y (top of page) comes first in reading order
      return b.top - a.top;
    });
    
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

        // Estimate column from left position
        const columnIndex = this.#estimateColumnFromLeft(position.left, position.pageIndex);

        items.push({
          id: crypto.randomUUID(),
          title: linkText.trim(),
          type,
          pageIndex: position.pageIndex,
          left: position.left,
          top: position.top,
          columnIndex: columnIndex,
          children: [],
          expanded: false,
        });
      }

      page.cleanup();
    }

    // Sort by reading order: page → column → Y
    items.sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      
      const colA = a.columnIndex ?? -1;
      const colB = b.columnIndex ?? -1;
      
      if (colA !== colB && colA !== -1 && colB !== -1) {
        return colA - colB;  // Earlier column first
      }
      
      return b.top - a.top;  // Higher Y (top of page) first
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
      // Use the columnIndex already computed during extraction
      const section = this.#findContainingSection(fig.pageIndex, fig.top, fig.columnIndex);
      if (section) {
        section.children.push(fig);
      } else {
        this.tree.push(fig);
      }
    }
  }

  /**
   * Find the section that contains the given position using column-aware reading order
   * 
   * Reading order in multi-column documents:
   * - Page N before Page N+1
   * - Column 0 (left) before Column 1 (right) on same page
   * - Higher Y (top) before lower Y within same column
   * - Full-width content (-1) ordered by Y position relative to column content
   * 
   * @param {number} pageIndex - 0-based page index
   * @param {number} pdfY - Y position in PDF coordinates (higher = higher on page)
   * @param {number} columnIndex - Column index: -1 for full-width, 0+ for columns
   * @returns {TreeNode|null} The section that precedes this position in reading order
   */
  #findContainingSection(pageIndex, pdfY, columnIndex = -1) {
    const sections = this.flatSections;
    if (sections.length === 0) return null;

    let bestMatch = null;

    // Linear scan through sorted sections to find the last section
    // that comes "before" the target position in reading order
    for (const section of sections) {
      if (this.#isSectionBefore(section, pageIndex, pdfY, columnIndex)) {
        bestMatch = section;
      } else {
        // Sections are sorted in reading order, so once we pass the target, stop
        break;
      }
    }

    return bestMatch;
  }

  /**
   * Determine if a section comes before a given position in reading order
   * 
   * @param {TreeNode} section - The section to check
   * @param {number} targetPageIndex - Target page index
   * @param {number} targetPdfY - Target Y in PDF coordinates
   * @param {number} targetColumn - Target column index (-1 for full-width)
   * @returns {boolean} True if section comes before the target in reading order
   */
  #isSectionBefore(section, targetPageIndex, targetPdfY, targetColumn) {
    // Different page - simple comparison
    if (section.pageIndex < targetPageIndex) return true;
    if (section.pageIndex > targetPageIndex) return false;

    // Same page - need column-aware comparison
    const sectionCol = section.columnIndex ?? -1;
    
    // Both full-width: compare Y (higher Y = earlier in reading order for PDF coords)
    if (sectionCol === -1 && targetColumn === -1) {
      return section.top >= targetPdfY;
    }
    
    // Section is full-width, target is in a column
    if (sectionCol === -1) {
      // Full-width section is "before" if it's above the target position
      // (or at same level - full-width typically precedes column content)
      return section.top >= targetPdfY;
    }
    
    // Target is full-width, section is in a column
    if (targetColumn === -1) {
      // Section in column is "before" full-width target only if section is above
      return section.top > targetPdfY;
    }

    // Both in columns
    if (sectionCol < targetColumn) return true;  // Earlier column = before
    if (sectionCol > targetColumn) return false; // Later column = after

    // Same column: section is before if it has higher or equal Y (higher = earlier in PDF coords)
    return section.top >= targetPdfY;
  }
  
  /**
   * Estimate which column a position belongs to based on X coordinate
   * 
   * @param {number} leftX - X position in PDF coordinates
   * @param {number} pageIndex - 0-based page index
   * @returns {number} Column index: -1 for ambiguous/full-width, 0 for left, 1 for right
   */
  #estimateColumnFromLeft(leftX, pageIndex) {
    const pageWidth = this.#getPageWidth(pageIndex);
    const leftRatio = leftX / pageWidth;
    
    // Heuristic thresholds for two-column layout
    // Left margin to ~45% = column 0
    // ~55% to right margin = column 1
    // Middle zone (45-55%) = ambiguous, treat as full-width
    if (leftRatio < 0.45) return 0;
    if (leftRatio > 0.55) return 1;
    return -1;  // Ambiguous, treat as full-width
  }
  
  /**
   * Estimate column from a ratio (0-1) left position
   * 
   * @param {number} leftRatio - Left position as ratio (0 = left edge, 1 = right edge)
   * @returns {number} Column index: -1 for ambiguous/full-width, 0 for left, 1 for right
   */
  #estimateColumnFromLeftRatio(leftRatio) {
    if (leftRatio < 0.495) return 0;
    if (leftRatio > 0.505) return 1;
    return -1;
  }

  // Annotation Integration

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

  /**
   * Sort annotations by reading order: page → column → vertical position
   * @param {Array} annotations
   * @returns {Array} Sorted annotations
   */
  #sortAnnotationsByPosition(annotations) {
    return [...annotations].sort((a, b) => {
      const aPage = a.pageRanges[0]?.pageNumber ?? 1;
      const bPage = b.pageRanges[0]?.pageNumber ?? 1;
      if (aPage !== bPage) return aPage - bPage;

      // Get positions
      const aLeftRatio = a.pageRanges[0]?.rects[0]?.leftRatio ?? 0;
      const bLeftRatio = b.pageRanges[0]?.rects[0]?.leftRatio ?? 0;
      const aTopRatio = a.pageRanges[0]?.rects[0]?.topRatio ?? 0;
      const bTopRatio = b.pageRanges[0]?.rects[0]?.topRatio ?? 0;
      
      // Estimate columns
      const aCol = this.#estimateColumnFromLeftRatio(aLeftRatio);
      const bCol = this.#estimateColumnFromLeftRatio(bLeftRatio);
      
      // Sort by column first (left column before right)
      if (aCol !== bCol && aCol !== -1 && bCol !== -1) {
        return aCol - bCol;
      }
      
      // Then by vertical position (smaller topRatio = higher on page = earlier)
      return aTopRatio - bTopRatio;
    });
  }

  /**
   * Create a TreeNode for an annotation
   * Converts annotation's ratio-based coordinates to PDF coordinates for proper placement
   * 
   * @param {Object} annotation - The annotation object
   * @param {number} counter - Annotation counter for display
   * @returns {TreeNode}
   */
  #createAnnotationNode(annotation, counter) {
    const firstPage = annotation.pageRanges[0];
    const lastPage = annotation.pageRanges[annotation.pageRanges.length - 1];
    const pageIndex = (firstPage?.pageNumber ?? 1) - 1;

    let pageRange = null;
    if (firstPage?.pageNumber !== lastPage?.pageNumber) {
      pageRange = `pp. ${firstPage.pageNumber}-${lastPage.pageNumber}`;
    }

    const typeName =
      annotation.type === "highlight" ? "Highlight" : "Underline";

    const title = annotation.comment ? `Cmt: ${annotation.comment}` : `${typeName} ${counter}`;

    // Convert topRatio to PDF Y coordinate
    // topRatio: 0 = top of page, 1 = bottom of page
    // PDF Y: 0 = bottom of page, pageHeight = top of page
    const topRatio = firstPage?.rects[0]?.topRatio ?? 0;
    const pageHeight = this.#getPageHeight(pageIndex);
    const pdfY = pageHeight * (1 - topRatio);  // Convert to PDF coords
    
    // Estimate column from left position
    const leftRatio = firstPage?.rects[0]?.leftRatio ?? 0;
    const columnIndex = this.#estimateColumnFromLeftRatio(leftRatio);
    
    // Store original topRatio for navigation (used in #navigateTo)
    const originalTopRatio = topRatio;

    return {
      id: crypto.randomUUID(),
      title: title,
      type: "annotation",
      annotationType: annotation.type,
      color: annotation.color,
      annotationId: annotation.id,
      pageIndex: pageIndex,
      left: leftRatio * this.#getPageWidth(pageIndex),  // Convert to PDF X coordinate
      top: pdfY,  // Now in PDF coordinates
      columnIndex: columnIndex,  // Column-aware placement
      originalTopRatio: originalTopRatio,  // Keep for navigation
      children: [],
      expanded: false,
      pageRange: pageRange,
    };
  }

  /**
   * Insert an annotation node into the appropriate section of the tree
   * Uses column-aware placement to correctly handle multi-column documents
   * 
   * @param {TreeNode} annotationNode - The annotation node to insert
   */
  #insertAnnotationIntoTree(annotationNode) {
    const section = this.#findContainingSection(
      annotationNode.pageIndex,
      annotationNode.top,  // Now in PDF coordinates
      annotationNode.columnIndex
    );

    if (section) {
      section.children.push(annotationNode);
    } else if (this.tree.length > 0) {
      // Fallback: add to last section
      this.tree[this.tree.length - 1].children.push(annotationNode);
    } else {
      // No sections at all: add to root
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
      icon.innerHTML = node.annotationType === "highlight" ? "◼" : "-";
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
      // Use PDF coordinates for scrolling (node.top is now in PDF coords)
      this.pane.scrollToPoint(node.pageIndex, node.left, node.top);
    } else {
      // Sections and figures already use PDF coordinates
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

  // Show / Hide

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
    this.pageDimensions = [];
    this.treeBuilt = false;
    this.pinnedPath = [];
  }
}
