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
        <svg class="tool-icon" width="25" height="25" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M5 17H9C10.6569 17 12 18.3431 12 20V10C12 7.17157 12 5.75736 11.1213 4.87868C10.2426 4 8.82843 4 6 4H5C4.05719 4 3.58579 4 3.29289 4.29289C3 4.58579 3 5.05719 3 6V15C3 15.9428 3 16.4142 3.29289 16.7071C3.58579 17 4.05719 17 5 17Z" stroke="currentColor"/>
          <path d="M19 17H15C13.3431 17 12 18.3431 12 20V10C12 7.17157 12 5.75736 12.8787 4.87868C13.7574 4 15.1716 4 18 4H19C19.9428 4 20.4142 4 20.7071 4.29289C21 4.58579 21 5.05719 21 6V15C21 15.9428 21 16.4142 20.7071 16.7071C20.4142 17 19.9428 17 19 17Z" stroke="currentColor"/>
        </svg>
      </div>
    </button>
    <button class="tool-btn" data-action="split-screen" data-tip-title="Split Screen" data-tip-desc="Click to toggle split-screen reading">
      <div class="inner">
        <svg class="tool-icon" width="25" height="25" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
          <path d="M19.2928932,12 L14,12 L14,19.5 C14,19.7761424 13.7761424,20 13.5,20 C13.2238576,20 13,19.7761424 13,19.5 L13,3.5 C13,3.22385763 13.2238576,3 13.5,3 C13.7761424,3 14,3.22385763 14,3.5 L14,11 L19.2928932,11 L16.1464466,7.85355339 C15.9511845,7.65829124 15.9511845,7.34170876 16.1464466,7.14644661 C16.3417088,6.95118446 16.6582912,6.95118446 16.8535534,7.14644661 L20.8535534,11.1464466 C21.0488155,11.3417088 21.0488155,11.6582912 20.8535534,11.8535534 L16.8535534,15.8535534 C16.6582912,16.0488155 16.3417088,16.0488155 16.1464466,15.8535534 C15.9511845,15.6582912 15.9511845,15.3417088 16.1464466,15.1464466 L19.2928932,12 Z M4.70710678,11 L10,11 L10,3.5 C10,3.22385763 10.2238576,3 10.5,3 C10.7761424,3 11,3.22385763 11,3.5 L11,19.5 C11,19.7761424 10.7761424,20 10.5,20 C10.2238576,20 10,19.7761424 10,19.5 L10,12 L4.70710678,12 L7.85355339,15.1464466 C8.04881554,15.3417088 8.04881554,15.6582912 7.85355339,15.8535534 C7.65829124,16.0488155 7.34170876,16.0488155 7.14644661,15.8535534 L3.14644661,11.8535534 C2.95118446,11.6582912 2.95118446,11.3417088 3.14644661,11.1464466 L7.14644661,7.14644661 C7.34170876,6.95118446 7.65829124,6.95118446 7.85355339,7.14644661 C8.04881554,7.34170876 8.04881554,7.65829124 7.85355339,7.85355339 L4.70710678,11 Z"/>
        </svg>
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
        <svg class="tool-icon" width="20" height="20" viewBox="0 0 800 800" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M104 200V600" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M697 200V600" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M240.731 317.269L158 400" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M158.487 401.539L241.219 484.271" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M555.487 484L638.219 401.269" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M637.731 399.729L555 316.998" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
          <path d="M197 400H620" stroke="currentColor" stroke-width="33.3333" stroke-linecap="square"/>
        </svg>
      </div>
    </button>
    <button class="tool-btn" data-action="zoom-in" data-tip-title="Zoom In" data-tip-desc="Increase zoom level">
      <div class="inner">
          <svg class="tool-icon" width="24" height="24" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M8 4a.5.5 0 0 1 .5.5v3h3a.5.5 0 0 1 0 1h-3v3a.5.5 0 0 1-1 0v-3h-3a.5.5 0 0 1 0-1h3v-3A.5.5 0 0 1 8 4"/>
          </svg>
      </div>
    </button>
    <button class="tool-btn" data-action="zoom-out" data-tip-title="Zoom Out" data-tip-desc="Decrease zoom level">
      <div class="inner">
          <svg class="tool-icon" width="24" height="24" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M4 8a.5.5 0 0 1 .5-.5h7a.5.5 0 0 1 0 1h-7A.5.5 0 0 1 4 8"/>
          </svg>
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
