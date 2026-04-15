/**
 * Pure DOM builder for the floating toolbar structure.
 *
 * Creates:
 *   - the wrapper (positioned on the right edge of the viewport),
 *   - the floating ball with its page-number display,
 *   - the top and bottom button halves,
 *   - the goo SVG filter that gives the ball/buttons their metaball look.
 *
 * Returns the handles controllers need. No listeners are attached here —
 * wiring lives in the facade.
 *
 * @returns {{
 *   wrapper: HTMLDivElement,
 *   gooContainer: HTMLDivElement,
 *   ball: HTMLDivElement,
 *   toolbarTop: HTMLDivElement,
 *   toolbarBottom: HTMLDivElement,
 * }}
 */
export function buildToolbarDom() {
  const wrapper = document.createElement("div");
  wrapper.className = "floating-toolbar-wrapper";

  const gooContainer = document.createElement("div");
  gooContainer.className = "goo-container";

  const ball = document.createElement("div");
  ball.className = "floating-ball";
  ball.innerHTML = `
    <div class="page-display">
      <span class="page-current">1</span>
      <span class="page-divider">-</span>
      <span class="page-total">?</span>
    </div>
  `;

  gooContainer.appendChild(ball);

  const toolbarTop = document.createElement("div");
  toolbarTop.className = "floating-toolbar floating-toolbar-top";
  toolbarTop.innerHTML = `
    <button class="tool-btn" data-action="horizontal-spread" data-tip-title="Spread Mode" data-tip-desc="Click to cycle: single → even → odd spread">
      <div class="inner">
        <img src="/assets/book.svg" width="25" />
      </div>
    </button>
    <button class="tool-btn" data-action="split-screen" data-tip-title="Split Screen" data-tip-desc="Click to toggle split-screen reading">
      <div class="inner">
        <img src="/assets/split.svg" width="25" />
      </div>
    </button>
    <button class="tool-btn" data-action="rotate" data-tip-title="Rotate" data-tip-desc="Click to rotate 90°, double-click to reset">
      <div class="inner">
        <svg class="rotate-icon" xmlns="http://www.w3.org/2000/svg" width="24" fill="currentColor" class="bi bi-arrow-clockwise" viewBox="0 0 16 16">
          <path fill-rule="evenodd" d="M8 3a5 5 0 1 0 4.546 2.914.5.5 0 0 1 .908-.417A6 6 0 1 1 8 2z"/>
          <path d="M8 4.466V.534a.25.25 0 0 1 .41-.192l2.36 1.966c.12.1.12.284 0 .384L8.41 4.658A.25.25 0 0 1 8 4.466"/>
        </svg>
      </div>
    </button>
  `;

  const toolbarBottom = document.createElement("div");
  toolbarBottom.className = "floating-toolbar floating-toolbar-bottom";
  toolbarBottom.innerHTML = `
    <button class="tool-btn" data-action="fit-width" data-tip-title="Fit to View" data-tip-desc="Click to toggle fit width / fit height">
      <div class="inner">
        <img src="/assets/fit_width.svg" width="20" />
      </div>
    </button>
    <button class="tool-btn" data-action="zoom-in" data-tip-title="Zoom In" data-tip-desc="Increase zoom level">
      <div class="inner">
          <img src="/assets/plus.svg" width="24" />
      </div>
    </button>
    <button class="tool-btn" data-action="zoom-out" data-tip-title="Zoom Out" data-tip-desc="Decrease zoom level">
      <div class="inner">
          <img src="/assets/minus.svg" width="24" />
      </div>
    </button>
  `;

  wrapper.appendChild(toolbarTop);
  wrapper.appendChild(gooContainer);
  wrapper.appendChild(toolbarBottom);

  document.body.appendChild(wrapper);
  wrapper.dataset.state = "collapsed";

  appendGooFilter();

  return { wrapper, gooContainer, ball, toolbarTop, toolbarBottom };
}

function appendGooFilter() {
  const svgFilter = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "svg",
  );
  svgFilter.style.position = "absolute";
  svgFilter.style.width = "0";
  svgFilter.style.height = "0";
  svgFilter.innerHTML = `
    <defs>
      <filter id="goo" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="12" result="blur" />
        <feColorMatrix in="blur" mode="matrix"
          values="1 0 0 0 0
                  0 1 0 0 0
                  0 0 1 0 0
                  0 0 0 25 -10" result="goo" />
        <feGaussianBlur in="goo" stdDeviation="8" result="softGlow"/>
        <feComposite in="goo" in2="softGlow" operator="over"/>
      </filter>
    </defs>
  `;
  document.body.appendChild(svgFilter);
}
