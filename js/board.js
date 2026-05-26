/* Canvas board renderer. */
(function (global) {
  "use strict";
  const { BLACK, WHITE, EMPTY } = global.GO_CONSTS;

  // Standard star points (화점).
  function starPoints(size) {
    if (size === 19) {
      const c = [3, 9, 15];
      const out = [];
      for (const y of c) for (const x of c) out.push([x, y]);
      return out;
    }
    if (size === 13) {
      return [[3,3],[9,3],[6,6],[3,9],[9,9]];
    }
    if (size === 9) {
      return [[2,2],[6,2],[4,4],[2,6],[6,6]];
    }
    return [];
  }

  const COL_LABELS = "ABCDEFGHJKLMNOPQRST"; // Skips 'I' as is tradition.

  class BoardView {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.size = opts.size || 19;
      this.onClick = opts.onClick || (() => {});
      this.onHover = opts.onHover || (() => {});
      this.hoverColor = null;     // 'B' | 'W' | null — preview ghost color
      this.hoverX = -1;
      this.hoverY = -1;
      this.lastMove = null;       // [x,y] or null
      this.board = null;          // 2D array
      this._setupEvents();
      this._setupHiDPI();
      this.compute();
    }

    _setupHiDPI() {
      const dpr = window.devicePixelRatio || 1;
      const c = this.canvas;
      const cssW = c.clientWidth || c.width;
      const cssH = c.clientHeight || c.height;
      // Maintain square aspect via CSS width set elsewhere; default 760.
      const targetCss = Math.min(cssW || 760, 760);
      c.style.width = targetCss + "px";
      c.style.height = targetCss + "px";
      c.width = Math.floor(targetCss * dpr);
      c.height = Math.floor(targetCss * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.cssSize = targetCss;
    }

    setSize(size) {
      this.size = size;
      this.compute();
    }

    compute() {
      const s = this.cssSize;
      this.padding = Math.max(24, s * 0.045);
      this.cell = (s - this.padding * 2) / (this.size - 1);
      this.origin = this.padding;
    }

    _setupEvents() {
      const c = this.canvas;
      c.addEventListener("click", (e) => {
        const { x, y } = this._eventToCoord(e);
        if (x >= 0) this.onClick(x, y);
      });
      c.addEventListener("mousemove", (e) => {
        const { x, y } = this._eventToCoord(e);
        if (x !== this.hoverX || y !== this.hoverY) {
          this.hoverX = x; this.hoverY = y;
          this.draw();
          this.onHover(x, y);
        }
      });
      c.addEventListener("mouseleave", () => {
        this.hoverX = -1; this.hoverY = -1; this.draw();
      });
      window.addEventListener("resize", () => {
        this._setupHiDPI(); this.compute(); this.draw();
      });
    }

    _eventToCoord(e) {
      const rect = this.canvas.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const x = Math.round((px - this.origin) / this.cell);
      const y = Math.round((py - this.origin) / this.cell);
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) return { x: -1, y: -1 };
      const cx = this.origin + x * this.cell;
      const cy = this.origin + y * this.cell;
      const dist = Math.hypot(px - cx, py - cy);
      if (dist > this.cell * 0.55) return { x: -1, y: -1 };
      return { x, y };
    }

    setState({ board, lastMove, hoverColor }) {
      this.board = board;
      this.lastMove = lastMove || null;
      if (hoverColor !== undefined) this.hoverColor = hoverColor;
      this.draw();
    }

    draw() {
      const ctx = this.ctx;
      const s = this.cssSize;
      const size = this.size;
      const cell = this.cell;
      const origin = this.origin;

      // Wood background with subtle gradient.
      const grad = ctx.createLinearGradient(0, 0, s, s);
      grad.addColorStop(0, "#e1b865");
      grad.addColorStop(1, "#caa04a");
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, s, s);

      // Grid lines.
      ctx.strokeStyle = "#2c1d10";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i < size; i++) {
        const p = origin + i * cell;
        ctx.moveTo(origin, p); ctx.lineTo(origin + (size-1) * cell, p);
        ctx.moveTo(p, origin); ctx.lineTo(p, origin + (size-1) * cell);
      }
      ctx.stroke();

      // Star points.
      ctx.fillStyle = "#2c1d10";
      for (const [x, y] of starPoints(size)) {
        const cx = origin + x * cell;
        const cy = origin + y * cell;
        ctx.beginPath();
        ctx.arc(cx, cy, Math.max(2.5, cell * 0.07), 0, Math.PI * 2);
        ctx.fill();
      }

      // Coordinate labels.
      ctx.fillStyle = "#5a3b1e";
      ctx.font = `${Math.max(10, cell * 0.32)}px ui-monospace, monospace`;
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      for (let i = 0; i < size; i++) {
        const p = origin + i * cell;
        const label = COL_LABELS[i];
        ctx.fillText(label, p, origin - cell * 0.55);
        ctx.fillText(label, p, origin + (size-1) * cell + cell * 0.55);
        const num = String(size - i);
        ctx.fillText(num, origin - cell * 0.55, p);
        ctx.fillText(num, origin + (size-1) * cell + cell * 0.55, p);
      }

      // Stones.
      if (this.board) {
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const v = this.board[y][x];
            if (v === EMPTY) continue;
            this._drawStone(x, y, v, 1);
          }
        }
      }

      // Last move marker.
      if (this.lastMove && this.board) {
        const [lx, ly] = this.lastMove;
        const v = this.board[ly] && this.board[ly][lx];
        if (v === BLACK || v === WHITE) {
          const cx = origin + lx * cell;
          const cy = origin + ly * cell;
          ctx.strokeStyle = v === BLACK ? "#fff" : "#111";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(cx, cy, cell * 0.22, 0, Math.PI * 2);
          ctx.stroke();
        }
      }

      // Hover ghost.
      if (this.hoverColor && this.hoverX >= 0 && this.board && this.board[this.hoverY][this.hoverX] === EMPTY) {
        this._drawStone(this.hoverX, this.hoverY, this.hoverColor, 0.4);
      }
    }

    _drawStone(x, y, color, alpha) {
      const ctx = this.ctx;
      const cx = this.origin + x * this.cell;
      const cy = this.origin + y * this.cell;
      const r = this.cell * 0.46;
      ctx.save();
      ctx.globalAlpha = alpha;

      // Shadow.
      ctx.beginPath();
      ctx.arc(cx + r*0.08, cy + r*0.12, r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.28)";
      ctx.fill();

      // Stone gradient.
      const grad = ctx.createRadialGradient(
        cx - r*0.4, cy - r*0.4, r*0.1,
        cx, cy, r
      );
      if (color === BLACK) {
        grad.addColorStop(0, "#7a7a7a");
        grad.addColorStop(0.55, "#1a1a1a");
        grad.addColorStop(1, "#000");
      } else {
        grad.addColorStop(0, "#ffffff");
        grad.addColorStop(0.7, "#dcdde1");
        grad.addColorStop(1, "#a8aab0");
      }
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = color === BLACK ? "#000" : "#5a5a5a";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      ctx.restore();
    }
  }

  global.BoardView = BoardView;
  global.COL_LABELS = COL_LABELS;
})(window);
