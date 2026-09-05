/* مخرِّب الرياض — سيرفر محلي على الوايفاي. تشغيل: node server.js */
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const S = require("./public/shared.js");
const C = S.C;

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
  if (c.pid != null) dropPlayer(c.pid);
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

/* ---------------- حالة اللعبة ---------------- */
let G = freshLobby();
let nextId = 1;

function freshLobby() {
  return {
    phase: "lobby",
    players: [],
    bodies: [],
    doneTasks: 0,
    totalTasks: 0,
    meetEnd: 0,
    result: null,
    winner: null,
    note: "",
    hostId: null,
  };
}

const byId = (id) => G.players.find((p) => p.id === id);
const usedColors = () => G.players.map((p) => p.color);

function addPlayer(name, isBot) {
  if (G.players.length >= C.MAX_PLAYERS) return null;
  const free = S.PALETTE.filter((c) => !usedColors().includes(c));
  const p = {
    id: nextId++,
    name: (name || "لاعب").slice(0, 12),
    color: free.length ? free[0] : S.PALETTE[G.players.length % S.PALETTE.length],
    isBot: !!isBot,
    x: S.SPAWN.x,
    y: S.SPAWN.y,
    alive: true,
    imp: false,
    done: 0,
    tasks: [],
    killReady: 0,
    vote: null,
    suspect: null,
    lastMove: Date.now(),
    path: [],
    goal: null,
    workUntil: 0,
    nextPath: 0,
  };
  G.players.push(p);
  if (G.hostId === null && !isBot) G.hostId = p.id;
  return p;
}

function dropPlayer(id) {
  G.players = G.players.filter((p) => p.id !== id);
  if (G.hostId === id) {
    const h = G.players.find((p) => !p.isBot);
    G.hostId = h ? h.id : null;
  }
  if (G.phase !== "lobby" && G.players.filter((p) => !p.isBot).length === 0) G = freshLobby();
  else if (G.phase !== "lobby" && G.phase !== "over") checkWin();
}

function spawnAll() {
  G.players.forEach((p, i) => {
    const a = (i / G.players.length) * Math.PI * 2;
    p.x = S.SPAWN.x + Math.cos(a) * 60;
    p.y = S.SPAWN.y + Math.sin(a) * 60;
    p.path = [];
    p.goal = null;
    p.vote = null;
    p.workUntil = 0;
    p.lastMove = Date.now();
  });
}

function startGame() {
  if (G.players.length < C.MIN_PLAYERS) return;
  const impCount = G.players.length >= 7 ? 2 : 1;
  const ids = G.players.map((p) => p.id).sort(() => Math.random() - 0.5);
  const imps = ids.slice(0, impCount);
  const shuffledSpots = () => S.SPOTS.slice().sort(() => Math.random() - 0.5);
  G.players.forEach((p) => {
    p.imp = imps.includes(p.id);
    p.alive = true;
    p.done = 0;
    p.suspect = null;
    p.tasks = shuffledSpots().slice(0, C.TASKS_PER).map((s) => s.id);
    p.killReady = Date.now() + C.FIRST_KILL;
  });
  G.bodies = [];
  G.doneTasks = 0;
  G.totalTasks = G.players.filter((p) => !p.imp).length * C.TASKS_PER;
  G.winner = null;
  G.result = null;
  G.note = "";
  G.phase = "play";
  spawnAll();
}

function checkWin() {
  const ai = G.players.filter((p) => p.alive && p.imp).length;
  const ac = G.players.filter((p) => p.alive && !p.imp).length;
  if (G.totalTasks > 0 && G.doneTasks >= G.totalTasks) G.winner = "crew";
  else if (ai === 0) G.winner = "crew";
  else if (ai >= ac) G.winner = "imp";
  if (G.winner) G.phase = "over";
}

function doKill(killer, victim) {
  victim.alive = false;
  killer.killReady = Date.now() + C.KILL_CD;
  killer.x = victim.x;
  killer.y = victim.y;
  G.bodies.push({ x: victim.x, y: victim.y, name: victim.name, color: victim.color });
  for (const w of G.players) {
    if (!w.alive || w.imp || w.id === victim.id) continue;
    if (Math.hypot(w.x - victim.x, w.y - victim.y) < 380 && S.hasLOS(w.x, w.y, victim.x, victim.y))
      w.suspect = killer.id;
  }
  checkWin();
}

function callMeeting(note) {
  if (G.phase !== "play") return;
  G.phase = "meeting";
  G.meetEnd = Date.now() + C.MEET_MS;
  G.bodies = [];
  G.note = note;
  spawnAll();
}

function resolveVotes() {
  const alive = G.players.filter((p) => p.alive);
  for (const p of alive) {
    if (!p.isBot || p.vote !== null) continue;
    if (p.suspect !== null && byId(p.suspect) && byId(p.suspect).alive && Math.random() < 0.85) {
      p.vote = p.suspect;
    } else if (p.imp) {
      const t = alive.filter((x) => !x.imp);
      p.vote = t.length ? t[(Math.random() * t.length) | 0].id : -1;
    } else {
      const t = alive.filter((x) => x.id !== p.id);
      p.vote = Math.random() < 0.3 || !t.length ? -1 : t[(Math.random() * t.length) | 0].id;
    }
  }
  const tally = {};
  alive.forEach((p) => {
    if (p.vote !== null) tally[p.vote] = (tally[p.vote] || 0) + 1;
  });
  let top = null, topN = 0, tie = false;
  for (const [k, n] of Object.entries(tally)) {
    if (n > topN) { top = Number(k); topN = n; tie = false; }
    else if (n === topN) tie = true;
  }
  if (top !== null && top >= 0 && !tie) {
    const out = byId(top);
    if (out) { out.alive = false; G.result = { name: out.name, wasImp: out.imp }; }
    else G.result = { name: null, wasImp: false };
  } else G.result = { name: null, wasImp: false };
  G.players.forEach((p) => { p.vote = null; p.suspect = null; });
  G.phase = "result";
  G.meetEnd = Date.now() + C.RESULT_MS;
  checkWin();
}

/* ---------------- ذكاء البوتات ---------------- */
function botTick(b, dt, nowMs) {
  if (!b.alive) return;
  if (b.workUntil > nowMs) return;
  if (b.workUntil && b.workUntil <= nowMs) {
    if (!b.imp) { b.done++; G.doneTasks++; checkWin(); }
    b.workUntil = 0;
    b.goal = null;
  }
  if (b.imp) {
    const prey = G.players
      .filter((p) => p.alive && !p.imp)
      .map((p) => ({ p, d: Math.hypot(p.x - b.x, p.y - b.y) }))
      .sort((a, c) => a.d - c.d)[0];
    if (prey) {
      const others = G.players.filter(
        (p) => p.alive && !p.imp && p.id !== prey.p.id &&
          Math.hypot(p.x - prey.p.x, p.y - prey.p.y) < C.ISO &&
          S.hasLOS(p.x, p.y, prey.p.x, prey.p.y)
      );
      if (prey.d < C.KILL_RANGE && nowMs > b.killReady && !others.length) {
        doKill(b, prey.p);
        b.goal = null; b.path = [];
        return;
      }
      if (nowMs > b.killReady - C.HUNT_LEAD && !others.length && prey.d < 800) {
        if (!b.goal || b.goal.kind !== "hunt" || b.goal.id !== prey.p.id) {
          b.goal = { kind: "hunt", id: prey.p.id };
          b.path = S.findPath(b.x, b.y, prey.p.x, prey.p.y);
          b.nextPath = nowMs + C.REPATH_MS;
        } else if (b.path.length < 2 && nowMs > b.nextPath) {
          b.path = S.findPath(b.x, b.y, prey.p.x, prey.p.y);
          b.nextPath = nowMs + C.REPATH_MS;
        }
      } else if (!b.goal || b.goal.kind === "hunt") {
        const s = S.SPOTS[(Math.random() * S.SPOTS.length) | 0];
        b.goal = { kind: "spot", x: s.x, y: s.y };
        b.path = S.findPath(b.x, b.y, s.x, s.y);
      }
    }
  } else {
    const body = G.bodies.find(
      (bd) => Math.hypot(bd.x - b.x, bd.y - b.y) < C.REPORT_RANGE && S.hasLOS(b.x, b.y, bd.x, bd.y)
    );
    if (body) { callMeeting(`${b.name} بلّغ عن ${body.name}`); return; }
    if (!b.goal) {
      const rem = b.tasks.slice(b.done);
      const sid = rem.length ? rem[0] : S.SPOTS[(Math.random() * S.SPOTS.length) | 0].id;
      const s = S.SPOTS.find((x) => x.id === sid);
      b.goal = { kind: "spot", x: s.x, y: s.y };
      b.path = S.findPath(b.x, b.y, s.x, s.y);
    }
  }
  if (b.path && b.path.length) {
    const [wx, wy] = b.path[0];
    const dx = wx - b.x, dy = wy - b.y, d = Math.hypot(dx, dy);
    if (d < 9) b.path.shift();
    else { b.x += (dx / d) * C.BOT_SPEED * dt; b.y += (dy / d) * C.BOT_SPEED * dt; }
  } else if (b.goal && b.goal.kind === "spot") {
    if (Math.hypot(b.goal.x - b.x, b.goal.y - b.y) < 45) b.workUntil = nowMs + C.WORK_MS;
    else {
      b.path = S.findPath(b.x, b.y, b.goal.x, b.goal.y);
      if (!b.path.length) b.goal = null;
    }
  }
}

/* ---------------- رسائل اللاعبين ---------------- */
function handle(c, m) {
  if (m.t === "join") {
    if (c.pid != null) return;
    if (G.phase !== "lobby") return send(c, { t: "err", m: "الجولة شغالة، انتظر لين تخلص" });
    const p = addPlayer(m.name, false);
    if (!p) return send(c, { t: "err", m: "الغرفة ممتلئة" });
    c.pid = p.id;
    return send(c, { t: "you", id: p.id });
  }
  const me = c.pid != null ? byId(c.pid) : null;
  if (!me) return;

  switch (m.t) {
    case "start":
      if (me.id === G.hostId && G.phase === "lobby") startGame();
      break;
    case "bots":
      if (me.id === G.hostId && G.phase === "lobby") {
        const names = ["فهد", "سلطان", "عبدالله", "ناصر", "تركي", "بدر", "مشعل"];
        const n = Math.max(1, Math.min(6, m.n | 0));
        for (let i = 0; i < n; i++) {
          const used = G.players.map((p) => p.name);
          const nm = names.find((x) => !used.includes(x)) || "بوت";
          if (!addPlayer(nm, true)) break;
        }
      }
      break;
    case "again":
      if (me.id === G.hostId && G.phase === "over") {
        G.phase = "lobby";
        G.players = G.players.filter((p) => true);
        G.bodies = [];
        G.winner = null;
        G.result = null;
      }
      break;
    case "move": {
      if (G.phase !== "play") break;
      const now = Date.now();
      const dt = Math.min(0.4, (now - me.lastMove) / 1000);
      me.lastMove = now;
      const x = +m.x, y = +m.y;
      if (!isFinite(x) || !isFinite(y)) break;
      const maxD = C.SPEED * dt * 1.8 + 6;
      const d = Math.hypot(x - me.x, y - me.y);
      if (d > maxD) break;
      if (!S.walkable(x, y, C.R)) break;
      me.x = x; me.y = y;
      break;
    }
    case "task": {
      if (G.phase !== "play" || !me.alive || me.imp) break;
      const rem = me.tasks.slice(me.done);
      if (!rem.includes(m.spot)) break;
      const s = S.SPOTS.find((x) => x.id === m.spot);
      if (!s || Math.hypot(s.x - me.x, s.y - me.y) > C.USE_RANGE + 25) break;
      me.done++;
      G.doneTasks++;
      checkWin();
      break;
    }
    case "kill": {
      if (G.phase !== "play" || !me.alive || !me.imp) break;
      if (Date.now() < me.killReady) break;
      const v = byId(m.id);
      if (!v || !v.alive || v.imp) break;
      if (Math.hypot(v.x - me.x, v.y - me.y) > C.KILL_RANGE + 15) break;
      doKill(me, v);
      break;
    }
    case "report": {
      if (G.phase !== "play" || !me.alive) break;
      const b = G.bodies.find((bd) => Math.hypot(bd.x - me.x, bd.y - me.y) < C.REPORT_RANGE + 20);
      if (b) callMeeting(`${me.name} بلّغ عن ${b.name}`);
      break;
    }
    case "emergency": {
      if (G.phase !== "play" || !me.alive) break;
      if (Math.hypot(S.EMERGENCY.x - me.x, S.EMERGENCY.y - me.y) < C.USE_RANGE + 25)
        callMeeting(`${me.name} فتح اجتماع طارئ`);
      break;
    }
    case "vote": {
      if (G.phase !== "meeting" || !me.alive) break;
      me.vote = m.id;
      const alive = G.players.filter((p) => p.alive && !p.isBot);
      if (alive.every((p) => p.vote !== null)) G.meetEnd = Math.min(G.meetEnd, Date.now() + 3000);
      break;
    }
  }
}

/* ---------------- الحلقة والبث ---------------- */
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;

  if (G.phase === "play") for (const b of G.players) if (b.isBot) botTick(b, dt, now);
  if (G.phase === "meeting" && now > G.meetEnd) resolveVotes();
  if (G.phase === "result" && now > G.meetEnd) {
    if (G.winner) G.phase = "over";
    else { G.phase = "play"; G.result = null; }
  }

  for (const c of clients) {
    if (c.pid == null) continue;
    const me = byId(c.pid);
    if (!me) { send(c, { t: "kick" }); c.pid = null; continue; }
    const vis = me.imp ? C.VIS_IMP : C.VIS_CREW;
    const showAll = !me.alive || G.phase !== "play";
    send(c, {
      t: "s",
      ph: G.phase,
      host: G.hostId === me.id,
      note: G.note,
      dt: G.doneTasks,
      tt: G.totalTasks,
      left: Math.max(0, Math.ceil((G.meetEnd - now) / 1000)),
      res: G.result,
      win: G.winner,
      imps: G.phase === "over" ? G.players.filter((p) => p.imp).map((p) => p.name) : null,
      me: {
        id: me.id, x: me.x, y: me.y, imp: me.imp, alive: me.alive,
        done: me.done, tasks: me.tasks, vote: me.vote,
        cd: Math.max(0, Math.ceil((me.killReady - now) / 1000)),
      },
      ps: G.players
        .filter((p) => p.id !== me.id)
        .filter((p) => showAll || (p.alive && Math.hypot(p.x - me.x, p.y - me.y) < vis && S.hasLOS(me.x, me.y, p.x, p.y)))
        .map((p) => ({ i: p.id, n: p.name, c: p.color, x: Math.round(p.x), y: Math.round(p.y), a: p.alive ? 1 : 0 })),
      all: G.players.map((p) => ({ i: p.id, n: p.name, c: p.color, a: p.alive ? 1 : 0, b: p.isBot ? 1 : 0 })),
      bd: G.bodies
        .filter((b) => showAll || (Math.hypot(b.x - me.x, b.y - me.y) < vis && S.hasLOS(me.x, me.y, b.x, b.y)))
        .map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), c: b.color, n: b.name })),
    });
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
