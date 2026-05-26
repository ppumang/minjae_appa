/* P2P networking via PeerJS. Messages exchanged as JSON.
   Message types:
     - { type: 'hello', name }
     - { type: 'start', size, komi, handicap, hostName, guestName }
     - { type: 'move', x, y }
     - { type: 'pass' }
     - { type: 'resign', color }
     - { type: 'undo-request' }
     - { type: 'undo-accept' } / { type: 'undo-reject' }
     - { type: 'chat', text }
     - { type: 'sync', game }     // full game serialization
*/
(function (global) {
  "use strict";

  const ROOM_PREFIX = "tygem-baduk-";

  class Net {
    constructor(handlers) {
      this.peer = null;
      this.conn = null;
      this.role = null;  // 'host' | 'guest'
      this.roomCode = null;
      this.handlers = handlers; // { onOpen, onClose, onMessage, onError, onStatus }
    }

    _genCode() {
      const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
      let s = "";
      for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
      return "BADUK-" + s;
    }

    _status(msg, cls) {
      if (this.handlers.onStatus) this.handlers.onStatus(msg, cls);
    }

    host() {
      this.role = "host";
      const code = this._genCode();
      this.roomCode = code;
      const peerId = ROOM_PREFIX + code;
      this._status("PeerJS 서버 연결 중…");
      this.peer = new Peer(peerId, { debug: 1 });
      this.peer.on("open", (id) => {
        this._status("방 생성됨. 친구의 접속을 기다리는 중…", "ok");
      });
      this.peer.on("connection", (conn) => {
        this._setConn(conn);
      });
      this.peer.on("error", (err) => {
        // ID taken? regenerate.
        if (err && err.type === "unavailable-id") {
          this._status("방 코드 충돌. 새로 생성 중…");
          this.peer.destroy();
          setTimeout(() => this.host(), 200);
          return;
        }
        this._status("오류: " + (err && err.message || err), "error");
        if (this.handlers.onError) this.handlers.onError(err);
      });
      return code;
    }

    join(code) {
      this.role = "guest";
      this.roomCode = code;
      const peerId = ROOM_PREFIX + code;
      this._status("PeerJS 서버 연결 중…");
      this.peer = new Peer(undefined, { debug: 1 });
      this.peer.on("open", () => {
        this._status("방에 접속 중…");
        const conn = this.peer.connect(peerId, { reliable: true });
        this._setConn(conn);
      });
      this.peer.on("error", (err) => {
        this._status("오류: " + (err && err.message || err), "error");
        if (this.handlers.onError) this.handlers.onError(err);
      });
    }

    _setConn(conn) {
      this.conn = conn;
      conn.on("open", () => {
        this._status("연결 성공!", "ok");
        if (this.handlers.onOpen) this.handlers.onOpen();
      });
      conn.on("data", (data) => {
        if (this.handlers.onMessage) this.handlers.onMessage(data);
      });
      conn.on("close", () => {
        this._status("연결이 끊어졌습니다.", "error");
        if (this.handlers.onClose) this.handlers.onClose();
      });
      conn.on("error", (err) => {
        this._status("오류: " + (err && err.message || err), "error");
        if (this.handlers.onError) this.handlers.onError(err);
      });
    }

    send(msg) {
      if (this.conn && this.conn.open) this.conn.send(msg);
    }

    close() {
      if (this.conn) try { this.conn.close(); } catch (_) {}
      if (this.peer) try { this.peer.destroy(); } catch (_) {}
      this.peer = null; this.conn = null;
    }

    isConnected() {
      return this.conn && this.conn.open;
    }
  }

  global.Net = Net;
})(window);
