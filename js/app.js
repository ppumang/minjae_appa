/* Main application glue: ties UI, game engine, board view, and networking. */
(function () {
  "use strict";

  const { BLACK, WHITE, EMPTY } = window.GO_CONSTS;

  // -------- App state --------
  const state = {
    mode: "local",          // 'local' | 'online'
    role: null,             // 'host' (black) | 'guest' (white) in online
    game: null,             // GoGame
    board: null,            // BoardView
    names: { B: "친구1", W: "친구2" },
    timers: {
      main: { B: 20 * 60, W: 20 * 60 }, // seconds
      byoyomi: 30,
      inByoyomi: { B: false, W: false },
      byoLeft: { B: 30, W: 30 },
    },
    timerInterval: null,
    viewMove: null,         // null = follow live; integer = viewing past
    pendingUndo: false,
    net: null,
  };

  // -------- DOM helpers --------
  const $ = (id) => document.getElementById(id);

  // -------- Init --------
  function init() {
    state.board = new BoardView($("board"), {
      size: 19,
      onClick: handleBoardClick,
    });
    newGame({ size: 19, komi: 6.5, handicap: 0 });
    bindUI();
  }

  function bindUI() {
    $("btn-new").onclick = () => showModal("modal-new");
    $("btn-online").onclick = () => showModal("modal-online");
    $("btn-help").onclick = () => showModal("modal-help");

    $("new-cancel").onclick = () => hideModal("modal-new");
    $("new-start").onclick = onNewStart;

    $("online-cancel").onclick = () => hideModal("modal-online");
    $("host-create").onclick = onHostCreate;
    $("join-connect").onclick = onJoinConnect;
    document.querySelectorAll(".tab").forEach(tab => {
      tab.onclick = () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("tab-active"));
        tab.classList.add("tab-active");
        const which = tab.getAttribute("data-tab");
        $("tab-host").hidden = which !== "host";
        $("tab-join").hidden = which !== "join";
      };
    });

    $("help-close").onclick = () => hideModal("modal-help");

    $("btn-pass").onclick = onPass;
    $("btn-undo").onclick = onUndo;
    $("btn-resign").onclick = onResign;
    $("btn-count").onclick = showCount;

    $("btn-first").onclick = () => navigateMove(0);
    $("btn-prev").onclick  = () => navigateMove(currentViewMove() - 1);
    $("btn-next").onclick  = () => navigateMove(currentViewMove() + 1);
    $("btn-last").onclick  = () => navigateMove(state.game.history.length);

    $("chat-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = $("chat-input");
      const text = input.value.trim();
      if (!text) return;
      const who = (state.mode === "online")
        ? (state.role === "host" ? state.names.B : state.names.W)
        : "나";
      addChat(who, text, false);
      if (state.net && state.net.isConnected()) {
        state.net.send({ type: "chat", text });
      }
      input.value = "";
    });

    $("overlay-close").onclick = () => $("board-overlay").hidden = true;
  }

  function showModal(id) { $(id).hidden = false; }
  function hideModal(id) { $(id).hidden = true; }

  // -------- New game --------
  function onNewStart() {
    const size = parseInt(document.querySelector('input[name="size"]:checked').value, 10);
    const komi = parseFloat($("komi").value) || 0;
    const handicap = parseInt($("handicap").value, 10) || 0;
    const mainMin = parseInt($("time-main").value, 10) || 0;
    const byo = parseInt($("byoyomi").value, 10) || 0;
    const nameB = $("name-b").value || "흑";
    const nameW = $("name-w").value || "백";
    state.names = { B: nameB, W: nameW };
    state.mode = "local";
    state.role = null;
    state.timers.main = { B: mainMin * 60, W: mainMin * 60 };
    state.timers.byoyomi = byo;
    state.timers.inByoyomi = { B: false, W: false };
    state.timers.byoLeft = { B: byo, W: byo };
    newGame({ size, komi, handicap });
    hideModal("modal-new");
    if (state.net) { state.net.close(); state.net = null; }
    $("connection-panel").hidden = true;
  }

  function newGame(opts) {
    state.game = new GoGame(opts);
    state.viewMove = null;
    state.pendingUndo = false;
    state.board.setSize(opts.size);
    refreshAll();
    startTimer();
    addChat("시스템", `${opts.size}路 대국 시작 (덤 ${opts.komi}${opts.handicap ? `, 치석 ${opts.handicap}점` : ''})`, true);
  }

  // -------- Online --------
  function onHostCreate() {
    const name = $("host-name").value || "나";
    const size = parseInt(document.querySelector('input[name="osize"]:checked').value, 10);
    state.mode = "online";
    state.role = "host";
    state.names = { B: name, W: "상대" };
    state.timers.main = { B: 20 * 60, W: 20 * 60 };
    state.timers.byoyomi = 30;
    state.timers.byoLeft = { B: 30, W: 30 };

    if (state.net) state.net.close();
    state.net = new Net({
      onOpen: () => {
        // Send hello + start.
        state.net.send({ type: "hello", name });
        state.net.send({
          type: "start", size, komi: 6.5, handicap: 0, hostName: name,
        });
        newGame({ size, komi: 6.5, handicap: 0 });
        hideModal("modal-online");
        $("connection-panel").hidden = false;
        $("room-info").textContent = `방 코드: ${state.net.roomCode}`;
        addChat("시스템", "친구와 연결되었습니다.", true);
      },
      onClose: () => addChat("시스템", "연결이 끊어졌습니다.", true),
      onMessage: handleNetMessage,
      onStatus: (msg, cls) => {
        const el = $("host-code"); el.textContent = msg;
      },
    });
    const code = state.net.host();
    $("host-code").hidden = false;
    $("host-code").textContent = `방 코드: ${code}  (복사해서 친구에게 전달)`;
  }

  function onJoinConnect() {
    const name = $("join-name").value || "나";
    let code = $("join-code").value.trim().toUpperCase();
    if (!code.startsWith("BADUK-")) code = "BADUK-" + code;
    state.mode = "online";
    state.role = "guest";
    state.names = { B: "상대", W: name };

    if (state.net) state.net.close();
    state.net = new Net({
      onOpen: () => {
        state.net.send({ type: "hello", name });
        $("join-status").textContent = "연결됨. 호스트의 대국 시작을 기다리는 중…";
        $("join-status").className = "room-status ok";
      },
      onClose: () => addChat("시스템", "연결이 끊어졌습니다.", true),
      onMessage: handleNetMessage,
      onStatus: (msg, cls) => {
        $("join-status").textContent = msg;
        $("join-status").className = "room-status " + (cls || "");
      },
    });
    state.net.join(code);
  }

  function handleNetMessage(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "hello":
        if (state.role === "host") state.names.W = msg.name || "친구";
        else state.names.B = msg.name || "친구";
        refreshAll();
        break;
      case "start":
        state.names.B = msg.hostName || state.names.B;
        newGame({ size: msg.size, komi: msg.komi, handicap: msg.handicap });
        hideModal("modal-online");
        $("connection-panel").hidden = false;
        $("room-info").textContent = `방 코드: ${state.net.roomCode}`;
        addChat("시스템", "대국이 시작되었습니다.", true);
        break;
      case "move": {
        const r = state.game.play(msg.x, msg.y);
        if (r.ok) afterMove();
        break;
      }
      case "pass": {
        const r = state.game.pass();
        addChat("시스템", `${stateColorName(opposite(state.game.currentColor))} 패스`, true);
        if (r.ended) onGameEnd();
        afterMove();
        break;
      }
      case "resign": {
        state.game.resign(msg.color);
        addChat("시스템", `${stateColorName(msg.color)} 기권`, true);
        onGameEnd();
        refreshAll();
        break;
      }
      case "undo-request":
        if (confirm("상대가 무르기를 요청했습니다. 수락할까요?")) {
          state.net.send({ type: "undo-accept" });
          state.game.undo();
          afterMove();
        } else {
          state.net.send({ type: "undo-reject" });
        }
        break;
      case "undo-accept":
        state.game.undo();
        afterMove();
        addChat("시스템", "무르기가 수락되었습니다.", true);
        break;
      case "undo-reject":
        addChat("시스템", "무르기가 거절되었습니다.", true);
        break;
      case "chat":
        addChat(state.role === "host" ? state.names.W : state.names.B, msg.text, false);
        break;
    }
  }

  function opposite(c) { return c === BLACK ? WHITE : BLACK; }
  function stateColorName(c) { return c === BLACK ? "흑" : "백"; }

  // -------- Move handling --------
  function handleBoardClick(x, y) {
    if (state.viewMove !== null && state.viewMove !== state.game.history.length) {
      // Resume live view first.
      state.viewMove = null;
      refreshAll();
      return;
    }
    if (state.game.ended) return;

    if (state.mode === "online") {
      const myColor = state.role === "host" ? BLACK : WHITE;
      if (state.game.currentColor !== myColor) return;
    }

    const result = state.game.play(x, y);
    if (!result.ok) {
      flashStatus(result.reason);
      return;
    }
    if (state.mode === "online" && state.net) {
      state.net.send({ type: "move", x, y });
    }
    afterMove();
  }

  function onPass() {
    if (state.game.ended) return;
    if (state.mode === "online") {
      const myColor = state.role === "host" ? BLACK : WHITE;
      if (state.game.currentColor !== myColor) { flashStatus("상대 차례입니다."); return; }
    }
    const passingColor = state.game.currentColor;
    const r = state.game.pass();
    addChat("시스템", `${stateColorName(passingColor)} 패스`, true);
    if (state.mode === "online" && state.net) state.net.send({ type: "pass" });
    if (r.ended) onGameEnd();
    afterMove();
  }

  function onUndo() {
    if (!state.game.canUndo()) return;
    if (state.mode === "online") {
      // Need opponent's permission.
      if (state.pendingUndo) return;
      state.pendingUndo = true;
      state.net.send({ type: "undo-request" });
      addChat("시스템", "무르기를 요청했습니다…", true);
      setTimeout(() => state.pendingUndo = false, 5000);
      return;
    }
    state.game.undo();
    afterMove();
  }

  function onResign() {
    if (state.game.ended) return;
    const me = state.mode === "online"
      ? (state.role === "host" ? BLACK : WHITE)
      : state.game.currentColor;
    if (!confirm(`정말 기권하시겠습니까? (${stateColorName(me)} 기권)`)) return;
    state.game.resign(me);
    if (state.mode === "online" && state.net) state.net.send({ type: "resign", color: me });
    addChat("시스템", `${stateColorName(me)} 기권`, true);
    onGameEnd();
    refreshAll();
  }

  function afterMove() {
    state.viewMove = null; // jump to current
    refreshAll();
    if (state.game.ended) onGameEnd();
  }

  function onGameEnd() {
    stopTimer();
    let title, body;
    if (state.game.endReason === "pass-pass") {
      const s = state.game.score();
      title = "대국 종료";
      const winnerName = s.winner === BLACK ? state.names.B : (s.winner === WHITE ? state.names.W : "—");
      const winnerColor = s.winner === BLACK ? "흑" : (s.winner === WHITE ? "백" : null);
      const diff = Math.abs(s.diff);
      body = `
        <div style="text-align:left; line-height:1.8;">
          <div style="font-size:18px; margin-bottom:8px; color: var(--accent);">
            ${winnerColor ? `${winnerColor} ${winnerName} 승 (${diff} 집)` : '무승부'}
          </div>
          <div>흑(${state.names.B}): 영역 ${s.blackArea} (돌 ${s.blackStones} + 집 ${s.blackTerritory}) = <b>${s.blackScore}</b></div>
          <div>백(${state.names.W}): 영역 ${s.whiteArea} (돌 ${s.whiteStones} + 집 ${s.whiteTerritory}) + 덤 ${s.komi} = <b>${s.whiteScore}</b></div>
          <div style="margin-top:6px; color: var(--text-dim); font-size:12px;">※ 중국식 영역 계산. 사석 표시는 지원하지 않으므로 죽은 돌은 메워주세요.</div>
        </div>`;
    } else if (state.game.endReason && state.game.endReason.startsWith("resign-")) {
      const loser = state.game.endReason.split("-")[1];
      const winnerColor = loser === BLACK ? WHITE : BLACK;
      const winnerName = winnerColor === BLACK ? state.names.B : state.names.W;
      title = "대국 종료";
      body = `<div style="font-size:18px; color: var(--accent);">${stateColorName(winnerColor)} ${winnerName} 불계승</div>`;
    } else {
      title = "대국 종료"; body = "";
    }
    $("overlay-title").textContent = title;
    $("overlay-body").innerHTML = body;
    $("board-overlay").hidden = false;
  }

  function showCount() {
    const s = state.game.score();
    const body = `
      <div style="text-align:left; line-height:1.8;">
        <div>흑 ${state.names.B} — 영역 <b>${s.blackArea}</b> (돌 ${s.blackStones} + 집 ${s.blackTerritory})</div>
        <div>백 ${state.names.W} — 영역 <b>${s.whiteArea}</b> + 덤 ${s.komi} = <b>${s.whiteScore}</b></div>
        <div style="margin-top:6px;">현재 추정: ${
          s.blackScore > s.whiteScore
            ? `<b style="color:var(--accent)">흑 ${(s.blackScore - s.whiteScore)}집 우세</b>`
            : (s.whiteScore > s.blackScore
              ? `<b style="color:var(--accent)">백 ${(s.whiteScore - s.blackScore)}집 우세</b>`
              : `<b>호각</b>`)
        }</div>
        <div style="margin-top:6px; color: var(--text-dim); font-size:12px;">※ 중국식 자동계산. 죽은 돌은 우선 제거하고 다시 확인하세요.</div>
      </div>`;
    $("overlay-title").textContent = "집계산 (잠정)";
    $("overlay-body").innerHTML = body;
    $("board-overlay").hidden = false;
  }

  // -------- View navigation --------
  function currentViewMove() {
    return state.viewMove !== null ? state.viewMove : state.game.history.length;
  }
  function navigateMove(n) {
    const max = state.game.history.length;
    const target = Math.max(0, Math.min(n, max));
    if (target === max) {
      state.viewMove = null;
      refreshAll();
      return;
    }
    state.viewMove = target;
    // Build a temporary game to render at that point.
    refreshAll();
  }

  // -------- Render / refresh --------
  function refreshAll() {
    const g = state.game;
    // Determine board to render.
    let boardArr, lastMove;
    if (state.viewMove !== null && state.viewMove !== g.history.length) {
      const tmp = new GoGame({ size: g.size, komi: g.komi, handicap: g.handicap });
      for (let i = 0; i < state.viewMove; i++) {
        const m = g.history[i];
        if (m.pass) tmp.pass(); else tmp.play(m.x, m.y);
      }
      boardArr = tmp.board;
      const lm = state.viewMove > 0 ? g.history[state.viewMove - 1] : null;
      lastMove = (lm && !lm.pass) ? [lm.x, lm.y] : null;
    } else {
      boardArr = g.board;
      const lm = g.history.length ? g.history[g.history.length - 1] : null;
      lastMove = (lm && !lm.pass) ? [lm.x, lm.y] : null;
    }

    const myTurn = (() => {
      if (state.mode !== "online") return true;
      const myColor = state.role === "host" ? BLACK : WHITE;
      return g.currentColor === myColor && !g.ended;
    })();

    state.board.setState({
      board: boardArr,
      lastMove,
      hoverColor: !g.ended && myTurn ? g.currentColor : null,
    });

    // Turn indicator.
    $("turn-stone").className = "turn-stone " + (g.currentColor === BLACK ? "black" : "white");
    $("turn-text").textContent = g.ended ? "대국 종료" : (g.currentColor === BLACK ? "흑돌 차례" : "백돌 차례");
    $("move-number").textContent = g.history.length;
    $("komi-display").textContent = g.komi;

    // Captures.
    $("captures-black").textContent = g.captures[BLACK];
    $("captures-white").textContent = g.captures[WHITE];

    // Names.
    $("name-black").textContent = "흑 · " + state.names.B;
    $("name-white").textContent = "백 · " + state.names.W;

    // Active player highlight.
    $("panel-black").classList.toggle("active", g.currentColor === BLACK && !g.ended);
    $("panel-white").classList.toggle("active", g.currentColor === WHITE && !g.ended);

    // Action buttons enabled state.
    $("btn-pass").disabled = g.ended || (state.mode === "online" && !myTurn);
    $("btn-undo").disabled = g.ended || !g.canUndo() || (state.mode === "online" && state.pendingUndo);
    $("btn-resign").disabled = g.ended;

    renderMovesList();
  }

  function renderMovesList() {
    const g = state.game;
    const list = $("moves-list");
    list.innerHTML = "";
    const moves = g.history;
    const pairs = Math.ceil(moves.length / 2);
    const viewN = currentViewMove();
    for (let i = 0; i < pairs; i++) {
      const row = document.createElement("div");
      row.className = "move-row";
      const num = document.createElement("span");
      num.className = "move-num";
      num.textContent = (i + 1) + ".";
      row.appendChild(num);
      for (let j = 0; j < 2; j++) {
        const idx = i * 2 + j;
        const cell = document.createElement("span");
        cell.className = "move-cell";
        if (idx < moves.length) {
          const m = moves[idx];
          cell.classList.add(m.color === BLACK ? "black" : "white");
          cell.textContent = m.pass ? "패스" : coordLabel(m.x, m.y, g.size);
          cell.onclick = () => navigateMove(idx + 1);
          if (idx + 1 === viewN) cell.classList.add("current"), row.classList.add("current");
        } else {
          cell.textContent = "";
        }
        row.appendChild(cell);
      }
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  function coordLabel(x, y, size) {
    return window.COL_LABELS[x] + (size - y);
  }

  function flashStatus(msg) {
    addChat("시스템", msg, true);
  }

  function addChat(who, text, isSystem) {
    const log = $("chat-log");
    const div = document.createElement("div");
    div.className = "chat-msg";
    if (isSystem) {
      div.innerHTML = `<span class="sys">[${escapeHtml(text)}]</span>`;
    } else {
      div.innerHTML = `<span class="who">${escapeHtml(who)}:</span> ${escapeHtml(text)}`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[c]));
  }

  // -------- Timers --------
  function startTimer() {
    stopTimer();
    if (state.timers.main.B <= 0 && state.timers.byoyomi <= 0) {
      $("timer-black").textContent = "--:--";
      $("timer-white").textContent = "--:--";
      return;
    }
    updateTimerDisplay();
    state.timerInterval = setInterval(() => {
      if (state.game.ended) { stopTimer(); return; }
      const c = state.game.currentColor;
      if (state.timers.main[c] > 0) {
        state.timers.main[c] -= 1;
      } else {
        // Enter / continue byo-yomi.
        if (!state.timers.inByoyomi[c]) {
          state.timers.inByoyomi[c] = true;
          state.timers.byoLeft[c] = state.timers.byoyomi;
        }
        if (state.timers.byoyomi > 0) {
          state.timers.byoLeft[c] -= 1;
          if (state.timers.byoLeft[c] <= 0) {
            // Time loss.
            state.game.resign(c);
            addChat("시스템", `${stateColorName(c)} 시간패`, true);
            onGameEnd();
            refreshAll();
            stopTimer();
            return;
          }
        }
      }
      updateTimerDisplay();
    }, 1000);
  }
  function stopTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  function updateTimerDisplay() {
    for (const c of [BLACK, WHITE]) {
      const el = $(c === BLACK ? "timer-black" : "timer-white");
      if (state.timers.inByoyomi[c]) {
        el.textContent = `초읽기 ${state.timers.byoLeft[c]}`;
        el.classList.toggle("low", state.timers.byoLeft[c] <= 10);
      } else {
        const t = Math.max(0, state.timers.main[c]);
        const m = Math.floor(t / 60), s = t % 60;
        el.textContent = `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
        el.classList.toggle("low", t <= 30 && t > 0);
      }
    }
  }

  // -------- Boot --------
  window.addEventListener("DOMContentLoaded", init);
})();
