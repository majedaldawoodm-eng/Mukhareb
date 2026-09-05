/* مخرِّب الرياض — سيرفر محلي على الوايفاي. تشغيل: node server.js
   هذا الملف للاتصال فقط: ملفات ثابتة، ويب سوكِت من الصفر، الانضمام وإعادة الاتصال، والبث.
   قواعد اللعبة والبوتات كلها في game.js. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const S = require("./public/shared.js");
const C = S.C;
const { createGame } = require("./game.js");

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8" };

/* ---------------- ملفات ---------------- */
const server = http.createServer((req, res) => {
  let p = req.url.split("?")[0];
  if (p === "/") p = "/index.html";
  const file = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ""));
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("ما لقيت الملف");
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
    res.end(data);
  });
});

/* ---------------- ويب سوكِت من الصفر ---------------- */
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set();

server.on("upgrade", (req, socket) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) return socket.destroy();
  const accept = crypto.createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      "Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
  );
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), pid: null, alive: true };
  clients.add(c);

  socket.on("data", (chunk) => {
    c.buf = Buffer.concat([c.buf, chunk]);
    for (;;) {
      const f = decodeFrame(c.buf);
      if (!f) break;
      c.buf = f.rest;
      if (f.op === 8) {
        closeClient(c);
        return;
      }
      if (f.op === 9) {
        socket.write(encodeFrame(f.payload, 10));
        continue;
      }
      if (f.op === 1) {
        let msg = null;
        try {
          msg = JSON.parse(f.payload.toString("utf8"));
        } catch {}
        if (msg) handle(c, msg);
      }
    }
  });
  socket.on("error", () => closeClient(c));
  socket.on("close", () => closeClient(c));
});

function closeClient(c) {
  if (!c.alive) return;
  c.alive = false;
  clients.delete(c);
  try { c.socket.destroy(); } catch {}
  if (c.pid != null) {
    // ما نطرده فورًا: نحتفظ بمقعده ودوره ومهامه مدة RECONNECT_MS لعل اتصاله يرجع
    const p = game.byId(c.pid);
    if (p && p.conn === c) { p.conn = null; p.offlineSince = Date.now(); }
    c.pid = null;
  }
}

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b0 = buf[0], b1 = buf[1];
  const op = b0 & 0x0f;
  const masked = (b1 & 0x80) === 0x80;
  let len = b1 & 0x7f;
  let off = 2;
  if (len === 126) {
    if (buf.length < 4) return null;
    len = buf.readUInt16BE(2);
    off = 4;
  } else if (len === 127) {
    if (buf.length < 10) return null;
    len = Number(buf.readBigUInt64BE(2));
    off = 10;
  }
  let mask = null;
  if (masked) {
    if (buf.length < off + 4) return null;
    mask = buf.slice(off, off + 4);
    off += 4;
  }
  if (buf.length < off + len) return null;
  const payload = Buffer.from(buf.slice(off, off + len));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return { op, payload, rest: buf.slice(off + len) };
}

function encodeFrame(payload, op = 1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  const n = data.length;
  let head;
  if (n < 126) {
    head = Buffer.alloc(2);
    head[1] = n;
  } else if (n < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(n, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(n), 2);
  }
  head[0] = 0x80 | op;
  return Buffer.concat([head, data]);
}

function send(c, obj) {
  if (!c.alive) return;
  try { c.socket.write(encodeFrame(JSON.stringify(obj))); } catch { closeClient(c); }
}

/* ---------------- اللعبة ---------------- */
const game = createGame({
  now: Date.now,
  onKick: (p) => { const c = p.conn; p.conn = null; c.pid = null; send(c, { t: "kick" }); },
});

/* ---------------- رسائل اللاعبين ---------------- */
function handle(c, m) {
  const G = game.state;
  if (m.t === "join") {
    if (c.pid != null) return;
    // رجوع لاعب منقطع بنفس السر: يرجع لنفس المقعد والدور والمهام في أي مرحلة
    if (typeof m.token === "string" && m.token) {
      const p = game.findByToken(m.token);
      if (p) {
        if (p.conn && p.conn !== c) { p.conn.pid = null; closeClient(p.conn); } // تبويب ثاني يأخذ المقعد
        p.conn = c; p.offlineSince = 0; p.lastMove = Date.now();
        c.pid = p.id;
        return send(c, { t: "you", id: p.id, token: p.token, back: true });
      }
      if (G.phase !== "lobby") return send(c, { t: "err", m: "انتهت مهلة الرجوع، انتظر لين تخلص الجولة" });
    }
    if (G.phase !== "lobby") return send(c, { t: "err", m: "الجولة شغالة، انتظر لين تخلص" });
    const p = game.addPlayer(m.name, false);
    if (!p) return send(c, { t: "err", m: "الغرفة ممتلئة" });
    p.conn = c;
    c.pid = p.id;
    return send(c, { t: "you", id: p.id, token: p.token });
  }
  const me = c.pid != null ? game.byId(c.pid) : null;
  if (!me) return;
  game.handle(me, m);
}

/* ---------------- الحلقة والبث ---------------- */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;

  game.tick(now, dt);

  for (const c of clients) {
    if (c.pid == null) continue;
    const me = game.byId(c.pid);
    if (!me) { send(c, { t: "kick" }); c.pid = null; continue; }
    send(c, game.snapshotFor(me, now));
  }
}, C.TICK);

/* ---------------- التشغيل ---------------- */
function lanIP() {
  for (const list of Object.values(os.networkInterfaces()))
    for (const i of list || []) if (i.family === "IPv4" && !i.internal) return i.address;
  return "127.0.0.1";
}
server.listen(PORT, "0.0.0.0", () => {
  const ip = lanIP();
  console.log("\n  مخرِّب الرياض شغّال\n");
  console.log("  افتح من جوالك على نفس الوايفاي:");
  console.log("  \x1b[33mhttp://" + ip + ":" + PORT + "\x1b[0m\n");
  console.log("  ومن هذا الجهاز: http://localhost:" + PORT + "\n");
});
