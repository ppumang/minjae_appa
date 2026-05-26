/* Go (Baduk) rules engine.
   Public API:
     const g = new GoGame({ size: 19, komi: 6.5, handicap: 0 });
     g.play(x, y)         -> { ok:true } or { ok:false, reason }
     g.pass()             -> { ok:true, ended:boolean }
     g.resign(color)
     g.undo()
     g.gotoMove(n)
     g.currentColor       // 'B' or 'W'
     g.board[y][x]        // 'B' | 'W' | '.'
     g.captures            // { B: n, W: n }   captures made BY that color
     g.history            // array of move records
     g.score()            // { black, white, blackTerritory, whiteTerritory, ... }
*/
(function (global) {
  "use strict";

  const EMPTY = ".";
  const BLACK = "B";
  const WHITE = "W";

  function opposite(c) { return c === BLACK ? WHITE : BLACK; }

  function makeBoard(size) {
    const b = new Array(size);
    for (let y = 0; y < size; y++) {
      b[y] = new Array(size).fill(EMPTY);
    }
    return b;
  }

  function cloneBoard(b) {
    return b.map(row => row.slice());
  }

  function boardKey(b) {
    return b.map(r => r.join("")).join("/");
  }

  // Handicap stone positions for common board sizes (Japanese-style fixed).
  function handicapPoints(size, n) {
    let pts;
    if (size === 19) {
      pts = {
        2: [[15,3],[3,15]],
        3: [[15,3],[3,15],[15,15]],
        4: [[3,3],[15,3],[3,15],[15,15]],
        5: [[3,3],[15,3],[3,15],[15,15],[9,9]],
        6: [[3,3],[15,3],[3,15],[15,15],[3,9],[15,9]],
        7: [[3,3],[15,3],[3,15],[15,15],[3,9],[15,9],[9,9]],
        8: [[3,3],[15,3],[3,15],[15,15],[3,9],[15,9],[9,3],[9,15]],
        9: [[3,3],[15,3],[3,15],[15,15],[3,9],[15,9],[9,3],[9,15],[9,9]],
      };
    } else if (size === 13) {
      pts = {
        2: [[9,3],[3,9]],
        3: [[9,3],[3,9],[9,9]],
        4: [[3,3],[9,3],[3,9],[9,9]],
        5: [[3,3],[9,3],[3,9],[9,9],[6,6]],
        6: [[3,3],[9,3],[3,9],[9,9],[3,6],[9,6]],
        7: [[3,3],[9,3],[3,9],[9,9],[3,6],[9,6],[6,6]],
        8: [[3,3],[9,3],[3,9],[9,9],[3,6],[9,6],[6,3],[6,9]],
        9: [[3,3],[9,3],[3,9],[9,9],[3,6],[9,6],[6,3],[6,9],[6,6]],
      };
    } else if (size === 9) {
      pts = {
        2: [[6,2],[2,6]],
        3: [[6,2],[2,6],[6,6]],
        4: [[2,2],[6,2],[2,6],[6,6]],
        5: [[2,2],[6,2],[2,6],[6,6],[4,4]],
      };
    } else {
      pts = {};
    }
    return pts[n] || [];
  }

  // Find the group of stones connected to (x,y) and its liberties.
  function getGroup(board, x, y) {
    const size = board.length;
    const color = board[y][x];
    if (color === EMPTY) return null;
    const visited = new Set();
    const stones = [];
    const liberties = new Set();
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop();
      const k = cy * size + cx;
      if (visited.has(k)) continue;
      visited.add(k);
      stones.push([cx, cy]);
      const neigh = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
      for (const [nx, ny] of neigh) {
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const v = board[ny][nx];
        if (v === EMPTY) {
          liberties.add(ny * size + nx);
        } else if (v === color) {
          if (!visited.has(ny * size + nx)) stack.push([nx, ny]);
        }
      }
    }
    return { color, stones, liberties };
  }

  class GoGame {
    constructor(opts = {}) {
      this.size = opts.size || 19;
      this.komi = (opts.komi !== undefined) ? opts.komi : 6.5;
      this.handicap = opts.handicap || 0;
      this.board = makeBoard(this.size);
      this.captures = { B: 0, W: 0 }; // captures made BY each color
      this.history = []; // each: { color, x, y, pass, captured:[[x,y]...], boardBefore, prevKoKey, prevConsec }
      this.currentColor = BLACK;
      this.consecutivePasses = 0;
      this.ended = false;
      this.endReason = null; // 'pass-pass', 'resign-B', 'resign-W'
      this.koKey = null;     // positional ko: forbidden previous position key
      this.positionHistory = new Set([boardKey(this.board)]);

      if (this.handicap >= 2) {
        const pts = handicapPoints(this.size, this.handicap);
        for (const [x, y] of pts) this.board[y][x] = BLACK;
        this.currentColor = WHITE; // after handicap, white plays first
        this.positionHistory = new Set([boardKey(this.board)]);
      }
    }

    inBounds(x, y) {
      return x >= 0 && y >= 0 && x < this.size && y < this.size;
    }

    // Returns: { ok, reason, captured }
    play(x, y) {
      if (this.ended) return { ok: false, reason: "대국이 종료되었습니다." };
      if (!this.inBounds(x, y)) return { ok: false, reason: "판 밖입니다." };
      if (this.board[y][x] !== EMPTY) return { ok: false, reason: "이미 돌이 있습니다." };

      const color = this.currentColor;
      const opp = opposite(color);
      const trial = cloneBoard(this.board);
      trial[y][x] = color;

      // Find adjacent opponent groups; capture those with no liberties.
      const captured = [];
      const neigh = [[x+1,y],[x-1,y],[x,y+1],[x,y-1]];
      const seenGroups = new Set();
      for (const [nx, ny] of neigh) {
        if (!this.inBounds(nx, ny)) continue;
        if (trial[ny][nx] !== opp) continue;
        const groupKey = ny * this.size + nx;
        if (seenGroups.has(groupKey)) continue;
        const g = getGroup(trial, nx, ny);
        for (const [sx, sy] of g.stones) seenGroups.add(sy * this.size + sx);
        if (g.liberties.size === 0) {
          for (const [sx, sy] of g.stones) {
            trial[sy][sx] = EMPTY;
            captured.push([sx, sy]);
          }
        }
      }

      // Suicide check: own group must have liberties after captures.
      const own = getGroup(trial, x, y);
      if (own.liberties.size === 0) {
        return { ok: false, reason: "자살수는 둘 수 없습니다." };
      }

      // Positional superko: must not recreate a previous position.
      const newKey = boardKey(trial);
      if (this.positionHistory.has(newKey)) {
        return { ok: false, reason: "패(같은 모양 반복)에 해당하는 수입니다." };
      }

      // Apply move.
      const rec = {
        color, x, y, pass: false,
        captured,
        prevConsec: this.consecutivePasses,
        prevKoKey: this.koKey,
        prevBoardKey: boardKey(this.board),
      };
      this.board = trial;
      this.positionHistory.add(newKey);
      this.captures[color] += captured.length;
      this.history.push(rec);
      this.consecutivePasses = 0;
      this.koKey = newKey;
      this.currentColor = opp;
      return { ok: true, captured };
    }

    pass() {
      if (this.ended) return { ok: false, reason: "대국이 종료되었습니다." };
      const rec = {
        color: this.currentColor, x: -1, y: -1, pass: true,
        captured: [],
        prevConsec: this.consecutivePasses,
        prevKoKey: this.koKey,
        prevBoardKey: boardKey(this.board),
      };
      this.history.push(rec);
      this.consecutivePasses += 1;
      this.currentColor = opposite(this.currentColor);
      let ended = false;
      if (this.consecutivePasses >= 2) {
        this.ended = true;
        this.endReason = "pass-pass";
        ended = true;
      }
      return { ok: true, ended };
    }

    resign(color) {
      if (this.ended) return { ok: false };
      this.ended = true;
      this.endReason = "resign-" + color;
      return { ok: true };
    }

    canUndo() {
      return this.history.length > 0 && !this.ended;
    }

    undo() {
      if (!this.history.length) return false;
      // Replay from scratch for simplicity & correctness with ko/superko set.
      const newHistory = this.history.slice(0, -1);
      this._resetTo(newHistory);
      return true;
    }

    _resetTo(history) {
      const size = this.size;
      const handicap = this.handicap;
      const komi = this.komi;
      this.board = makeBoard(size);
      this.captures = { B: 0, W: 0 };
      this.currentColor = BLACK;
      this.consecutivePasses = 0;
      this.ended = false;
      this.endReason = null;
      this.koKey = null;
      this.positionHistory = new Set([boardKey(this.board)]);
      if (handicap >= 2) {
        const pts = handicapPoints(size, handicap);
        for (const [x, y] of pts) this.board[y][x] = BLACK;
        this.currentColor = WHITE;
        this.positionHistory = new Set([boardKey(this.board)]);
      }
      const savedHistory = history;
      this.history = [];
      for (const m of savedHistory) {
        if (m.pass) this.pass();
        else this.play(m.x, m.y);
      }
    }

    // Replay up to move index n (1-based count of moves to keep). 0 = empty (or handicap-start).
    gotoMove(n) {
      const target = Math.max(0, Math.min(n, this.history.length));
      const slice = this.history.slice(0, target);
      this._resetTo(slice);
    }

    // Chinese-style area scoring (counts stones + empty points surrounded by one color only).
    score() {
      const size = this.size;
      const visited = new Set();
      let blackArea = 0, whiteArea = 0;
      let blackTerr = 0, whiteTerr = 0;
      let blackStones = 0, whiteStones = 0;
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const v = this.board[y][x];
          if (v === BLACK) blackStones++;
          else if (v === WHITE) whiteStones++;
        }
      }
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          if (this.board[y][x] !== EMPTY) continue;
          const k = y * size + x;
          if (visited.has(k)) continue;
          // Flood fill empty region; track bordering colors.
          const region = [];
          const borderColors = new Set();
          const stack = [[x, y]];
          while (stack.length) {
            const [cx, cy] = stack.pop();
            const ck = cy * size + cx;
            if (visited.has(ck)) continue;
            visited.add(ck);
            region.push([cx, cy]);
            const neigh = [[cx+1,cy],[cx-1,cy],[cx,cy+1],[cx,cy-1]];
            for (const [nx, ny] of neigh) {
              if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
              const v = this.board[ny][nx];
              if (v === EMPTY) {
                if (!visited.has(ny * size + nx)) stack.push([nx, ny]);
              } else {
                borderColors.add(v);
              }
            }
          }
          if (borderColors.size === 1) {
            if (borderColors.has(BLACK)) blackTerr += region.length;
            else whiteTerr += region.length;
          }
        }
      }
      blackArea = blackStones + blackTerr;
      whiteArea = whiteStones + whiteTerr;
      const blackScore = blackArea;
      const whiteScore = whiteArea + this.komi;
      return {
        blackStones, whiteStones,
        blackTerritory: blackTerr,
        whiteTerritory: whiteTerr,
        blackArea, whiteArea,
        komi: this.komi,
        blackScore, whiteScore,
        diff: blackScore - whiteScore,
        winner: blackScore > whiteScore ? BLACK : (whiteScore > blackScore ? WHITE : null),
      };
    }

    // Serialize for syncing over network.
    serialize() {
      return {
        size: this.size, komi: this.komi, handicap: this.handicap,
        history: this.history.map(m => ({ color: m.color, x: m.x, y: m.y, pass: m.pass })),
        ended: this.ended, endReason: this.endReason,
      };
    }
    static fromSerialized(data) {
      const g = new GoGame({ size: data.size, komi: data.komi, handicap: data.handicap });
      for (const m of data.history) {
        if (m.pass) g.pass();
        else g.play(m.x, m.y);
      }
      if (data.ended && data.endReason && data.endReason.startsWith("resign-")) {
        g.ended = true; g.endReason = data.endReason;
      }
      return g;
    }
  }

  global.GoGame = GoGame;
  global.GO_CONSTS = { EMPTY, BLACK, WHITE };
})(window);
