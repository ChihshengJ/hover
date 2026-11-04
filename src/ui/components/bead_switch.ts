/**
 * The bead switch: Hover's line-and-dot toggle made physical. The line is a
 * groove cut into the surface, the dot a glass bead riding in it; switched
 * on, the bead lights up and lights the groove. Styles: styles/bead_switch.css.
 *
 * It's a checkbox underneath, so put it in a <label> with its text and the
 * whole row flips it, keyboard included.
 */

export interface BeadSwitch {
  el: HTMLSpanElement;
  input: HTMLInputElement;
}

export function createBeadSwitch(): BeadSwitch {
  const el = document.createElement("span");
  el.className = "bead-switch";
  el.innerHTML = `
    <input type="checkbox" class="bead-switch-input">
    <span class="bead-switch-groove"></span>
    <span class="bead-switch-bead"></span>
  `;
  return {
    el,
    input: el.querySelector(".bead-switch-input") as HTMLInputElement,
  };
}
