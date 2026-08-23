/**
 * GlassRenderer — minimal raw-WebGL2 wrapper for the liquid-glass pass.
 *
 * One program, one quad, no libraries. The context is created with
 * premultiplied alpha and low-power preference; antialiasing is done in
 * the shader (fwidth), not by the context. Survives context loss by
 * rebuilding GL state and asking the owner to re-render.
 */

import { VERT_SRC, FRAG_SRC } from "./glass_shaders.js";

export class GlassRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {() => void} onNeedsRender Called after a restored context so the
   *   owner can push a fresh frame.
   */
  constructor(canvas, onNeedsRender) {
    this.canvas = canvas;
    this.onNeedsRender = onNeedsRender;
    this.gl = null;
    this.program = null;
    this.uniforms = {};
    this.lost = false;

    this._onLost = (e) => {
      e.preventDefault();
      this.lost = true;
    };
    this._onRestored = () => {
      this.lost = false;
      this.#setupGL();
      this.onNeedsRender();
    };
    canvas.addEventListener("webglcontextlost", this._onLost);
    canvas.addEventListener("webglcontextrestored", this._onRestored);
  }

  /** @returns {boolean} false when WebGL2 is unavailable. */
  init() {
    this.gl = this.canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    });
    if (!this.gl) return false;
    this.#setupGL();
    return true;
  }

  #setupGL() {
    const gl = this.gl;

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Glass shader compile failed: ${info}`);
      }
      return s;
    };

    const vs = compile(gl.VERTEX_SHADER, VERT_SRC);
    const fs = compile(gl.FRAGMENT_SHADER, FRAG_SRC);
    this.program = gl.createProgram();
    gl.attachShader(this.program, vs);
    gl.attachShader(this.program, fs);
    gl.linkProgram(this.program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
      throw new Error(`Glass program link failed: ${gl.getProgramInfoLog(this.program)}`);
    }

    for (const name of [
      "u_size",
      "u_dpr",
      "u_ball",
      "u_blob",
      "u_k",
      "u_tintA",
      "u_tintB",
      "u_grad",
      "u_night",
      "u_glow",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(this.program, name);
    }

    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    // Premultiplied-alpha over.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(0, 0, 0, 0);
  }

  /**
   * @param {number} cssW
   * @param {number} cssH
   * @param {number} dpr
   */
  resize(cssW, cssH, dpr) {
    this.cssW = cssW;
    this.cssH = cssH;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    if (this.gl) {
      this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  /**
   * Draw one frame.
   * @param {ReturnType<import('./goo_state.js').GooState['sample']>} s
   * @param {{tintA: number[], tintB: number[], grad: number[], night: number}} style
   * @param {ReturnType<import('./glow_state.js').GlowState['sample']>} [glow]
   */
  render(s, style, glow) {
    const gl = this.gl;
    if (!gl || this.lost) return;

    gl.useProgram(this.program);
    const u = this.uniforms;
    gl.uniform2f(u.u_size, this.cssW, this.cssH);
    gl.uniform1f(u.u_dpr, this.dpr);
    gl.uniform3f(u.u_ball, s.ballX, s.ballY, s.ballR);
    gl.uniform3f(u.u_blob, s.blobX, s.blobY, s.blobR);
    gl.uniform1f(u.u_k, s.k);
    gl.uniform3fv(u.u_tintA, style.tintA);
    gl.uniform3fv(u.u_tintB, style.tintB);
    gl.uniform2fv(u.u_grad, style.grad);
    gl.uniform1f(u.u_night, style.night);
    if (glow) {
      gl.uniform3f(u.u_glow, glow.x, glow.y, glow.intensity);
    } else {
      gl.uniform3f(u.u_glow, s.ballX, s.ballY, 0);
    }

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy() {
    this.canvas.removeEventListener("webglcontextlost", this._onLost);
    this.canvas.removeEventListener("webglcontextrestored", this._onRestored);
    if (this.gl) {
      this.gl.getExtension("WEBGL_lose_context")?.loseContext();
      this.gl = null;
    }
  }
}
