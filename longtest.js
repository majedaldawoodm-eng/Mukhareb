/* اختبار طويل: عملاء ويب سوكِت حقيقيون يلعبون عدة جولات متتالية ضد السيرفر.
   تشغيل: node longtest.js            (يشغّل السيرفر بنفسه على منفذ حر)
          ROUNDS=10 HUMANS=4 BOTS=3 node longtest.js
          URL=ws://192.168.1.15:3000 node longtest.js   (يتصل بسيرفر شغّال)
   لا يحتاج أي مكتبة، يستخدم WebSocket المدمج في Node 22 أو أحدث. */
"use strict";
const { spawn } = require("child_process");
const path = require("path");
const S = require("./public/shared.js");
const C = S.C;

if (typeof WebSocket !== "function") {
  console.error("هذا السكربت يحتاج Node 22 أو أحدث (WebSocket مدمج). نسختك: " + process.version);
  process.exit(1);
}

const ROUNDS = +process.env.ROUNDS || 10;
const HUMANS = Math.max(1, +process.env.HUMANS || 4);
const BOTS = Math.max(0, +process.env.BOTS || 3);
const ROUND_TIMEOUT_MS = +process.env.ROUND_TIMEOUT_MS || 6 * 60 * 1000;
const STALL_MS = +process.env.STALL_MS || 90 * 1000; // بدون أي تغيّر في المرحلة أو المهام أو الأحياء
const VERBOSE = !!process.env.VERBOSE;

const NAMES = ["ماجد", "خالد", "سعود", "فيصل", "عبدالعزيز", "محمد", "يوسف", "ريان", "عمر", "زياد"];
const now = () => Date.now();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const vlog = (...a) => VERBOSE && log(...a);

/* ---------------- مسار يراعي نصف قطر اللاعب ----------------
   S.findPath يرجّع خلايا تلامس الجدران (البوتات ما تتحقق من الجدران فما يفرق معها)،
   لكن لاعب حقيقي نصف قطره C.R ما يقدر يوقف على ٢٣٪ من تلك الخلايا. هنا BFS على
   الخلايا اللي يقدر جسم بنصف قطر C.R يوقف عليها فعليًا. */
const RCELL = new Uint8Array(S.GW * S.GH);
for (let cy = 0; cy < S.GH; cy++)
  for (let cx = 0; cx < S.GW; cx++)
    RCELL[cy * S.GW + cx] = S.walkable(cx * S.CELL + S.CELL / 2, cy * S.CELL + S.CELL / 2, C.R) ? 1 : 0;
const rOk = (cx, cy) => cx >= 0 && cy >= 0 && cx < S.GW && cy < S.GH && RCELL[cy * S.GW + cx] === 1;
function nearestR(x, y) {
  const cx0 = Math.floor(x / S.CELL), cy0 = Math.floor(y / S.CELL);
  for (let r = 0; r < 6; r++)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === r && rOk(cx0 + dx, cy0 + dy)) return [cx0 + dx, cy0 + dy];
  return null;
}
function pathR(sx, sy, tx, ty) {
  const s = nearestR(sx, sy), g = nearestR(tx, ty);
  if (!s || !g) return [];
  const W = S.GW, start = s[1] * W + s[0], goal = g[1] * W + g[0];
  const prev = new Int32Array(W * S.GH).fill(-1), seen = new Uint8Array(W * S.GH);
  const q = [start]; seen[start] = 1;
  for (let h = 0; h < q.length; h++) {
    const cur = q[h];
    if (cur === goal) break;
    const cx = cur % W, cy = (cur - cx) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (!rOk(nx, ny)) continue;
      const ni = ny * W + nx;
      if (seen[ni]) continue;
      seen[ni] = 1; prev[ni] = cur; q.push(ni);
    }
  }
  if (!seen[goal]) return [];
  const out = [];
  for (let cur = goal; cur !== -1 && cur !== start; cur = prev[cur]) {
    const cx = cur % W;
    out.push([cx * S.CELL + S.CELL / 2, ((cur - cx) / W) * S.CELL + S.CELL / 2]);
  }
  out.push([s[0] * S.CELL + S.CELL / 2, s[1] * S.CELL + S.CELL / 2]);
  return out.reverse();
}

/* ---------------- تشغيل السيرفر ---------------- */
let child = null;
function startServer() {
  return new Promise((resolve, reject) => {
    const port = 20000 + ((Math.random() * 20000) | 0);
    child = spawn(process.execPath, [path.join(__dirname, "server.js")], {
      env: { ...process.env, PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("localhost:" + port)) resolve("ws://127.0.0.1:" + port);
    });
    child.stderr.on("data", (d) => log("[server stderr]", String(d).trim()));
    child.on("exit", (code, sig) => {
      log(`[server] خرج code=${code} signal=${sig}`);
      if (!done) fail("السيرفر مات أثناء الاختبار");
    });
    setTimeout(() => reject(new Error("السيرفر ما اشتغل خلال 5 ثواني\n" + out)), 5000);
  });
}

/* ---------------- عميل ---------------- */
class Client {
  constructor(url, name) {
    this.name = name;
    this.url = url;
    this.id = null;
    this.st = null;
    this.x = S.SPAWN.x;
    this.y = S.SPAWN.y;
    this.path = [];
    this.target = null;
    this.lastMove = now();
    this.suspect = null;
    this.voted = false;
    this.taskBusy = 0;
    this.msgs = 0;
    this.errors = [];
    this.closed = false;
    this.stallX = this.x;
    this.stallY = this.y;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = (e) => { this.errors.push("ws error"); reject(new Error("فشل الاتصال: " + this.name)); };
      ws.onclose = () => { this.closed = true; vlog(`[${this.name}] انقطع الاتصال`); };
      ws.onmessage = (e) => {
        this.msgs++;
        let m;
        try { m = JSON.parse(e.data); } catch { this.errors.push("bad json"); return; }
        if (m.t === "you") this.id = m.id;
        else if (m.t === "err") { this.errors.push(m.m); vlog(`[${this.name}] err: ${m.m}`); }
        else if (m.t === "kick") { this.errors.push("kick"); log(`[${this.name}] انطرد`); }
        else if (m.t === "s") this.onState(m);
      };
    });
  }
  send(o) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  join() { this.send({ t: "join", name: this.name }); }
  onState(m) {
    const prev = this.st;
    this.st = m;
    // السيرفر هو المرجع: لو فرق كبير (بداية جولة، اجتماع) خذ موقعه
    if (!prev || prev.ph !== m.ph || Math.hypot(this.x - m.me.x, this.y - m.me.y) > 70) {
      this.x = m.me.x; this.y = m.me.y; this.path = []; this.target = null; this.lastMove = now();
    }
    if (prev && prev.ph !== m.ph) { this.voted = false; }
    if (m.ph === "play" && prev && prev.ph !== "play") this.suspect = null;
  }
  /* منطق لاعب بسيط يشبه البوتات لكن من جهة العميل */
  tick() {
    const m = this.st;
    if (!m || m.ph !== "play") return;
    const me = m.me, t = now();
    const dt = Math.min(0.2, (t - this.lastMove) / 1000);
    this.lastMove = t;
    if (!me.alive) return;

    // بلّغ عن جثة
    const body = (m.bd || []).find((b) => Math.hypot(b.x - this.x, b.y - this.y) < C.REPORT_RANGE);
    if (body && Math.random() < 0.7) { this.send({ t: "report" }); return; }

    if (me.imp) {
      const victim = (m.ps || []).find((p) => p.a && Math.hypot(p.x - this.x, p.y - this.y) < C.KILL_RANGE);
      if (victim && !me.cd) { this.send({ t: "kill", id: victim.i }); return; }
      const prey = (m.ps || []).filter((p) => p.a).sort((a, b) =>
        Math.hypot(a.x - this.x, a.y - this.y) - Math.hypot(b.x - this.x, b.y - this.y))[0];
      if (prey && me.cd <= 3) {
        if (!this.target || this.target.kind !== "hunt" || this.target.id !== prey.i || this.path.length < 2) {
          this.target = { kind: "hunt", id: prey.i };
          this.path = pathR(this.x, this.y, prey.x, prey.y);
        }
      } else if (!this.target || this.target.kind === "hunt" || !this.path.length) {
        const s = S.SPOTS[(Math.random() * S.SPOTS.length) | 0];
        this.target = { kind: "spot", x: s.x, y: s.y };
        this.path = pathR(this.x, this.y, s.x, s.y);
      }
    } else {
      const rem = me.tasks.slice(me.done);
      const near = S.SPOTS.find((s) => rem.includes(s.id) && Math.hypot(s.x - this.x, s.y - this.y) < C.USE_RANGE);
      if (near) {
        // محاكاة وقت اللعبة المصغّرة
        if (!this.taskBusy) this.taskBusy = t + 3000 + Math.random() * 3000;
        else if (t >= this.taskBusy) { this.send({ t: "task", spot: near.id }); this.taskBusy = 0; this.target = null; this.path = []; }
        return;
      }
      if (!this.target || !this.path.length) {
        const sid = rem.length ? rem[0] : S.SPOTS[(Math.random() * S.SPOTS.length) | 0].id;
        const s = S.SPOTS.find((x) => x.id === sid);
        this.target = { kind: "spot", x: s.x, y: s.y };
        this.path = pathR(this.x, this.y, s.x, s.y);
        if (!this.path.length) this.target = null;
      }
    }
    // امشِ خطوة على المسار وأرسلها للسيرفر ليتحقق
    if (this.path.length) {
      const [wx, wy] = this.path[0];
      const dx = wx - this.x, dy = wy - this.y, d = Math.hypot(dx, dy);
      if (d < 8) this.path.shift();
      else {
        const step = Math.min(d, C.SPEED * dt);
        const nx = this.x + (dx / d) * step, ny = this.y + (dy / d) * step;
        if (S.walkable(nx, ny, C.R)) { this.x = nx; this.y = ny; }
        else this.path.shift();
      }
      this.send({ t: "move", x: Math.round(this.x), y: Math.round(this.y) });
    }
  }
  voteTick() {
    const m = this.st;
    if (!m || m.ph !== "meeting" || !m.me.alive || this.voted) return;
    if (m.left > 18) return; // فكّر شوي قبل التصويت
    const alive = (m.all || []).filter((p) => p.a && p.i !== this.id);
    let v = -1;
    if (m.me.imp) { v = alive.length ? alive[(Math.random() * alive.length) | 0].i : -1; }
    else if (Math.random() < 0.6 && alive.length) v = alive[(Math.random() * alive.length) | 0].i;
    this.send({ t: "vote", id: v });
    this.voted = true;
  }
  close() { try { this.ws.close(); } catch {} }
}

/* ---------------- التشغيل ---------------- */
let done = false;
const clients = [];
function fail(msg) {
  if (done) return;
  done = true;
  log("✗ فشل:", msg);
  dumpState();
  cleanup();
  process.exit(1);
}
function dumpState() {
  const h = clients[0];
  if (!h || !h.st) { log("  (لا توجد حالة من السيرفر بعد)"); return; }
  const m = h.st;
  log(`  المرحلة=${m.ph} host=${m.host} مهام=${m.dt}/${m.tt} left=${m.left} win=${m.win}`);
  log("  اللاعبون:", (m.all || []).map((p) => `${p.n}${p.b ? "(بوت)" : ""}${p.a ? "" : "†"}`).join(", "));
  for (const c of clients)
    log(`  ${c.name}: id=${c.id} ph=${c.st && c.st.ph} alive=${c.st && c.st.me.alive} imp=${c.st && c.st.me.imp} ` +
        `pos=(${Math.round(c.x)},${Math.round(c.y)}) srv=(${c.st ? Math.round(c.st.me.x) : "?"},${c.st ? Math.round(c.st.me.y) : "?"}) msgs=${c.msgs} closed=${c.closed} errors=${c.errors.length ? c.errors.join("|") : "-"}`);
}
function cleanup() {
  for (const c of clients) c.close();
  if (child) child.kill();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, timeoutMs, what) {
  const t0 = now();
  while (!pred()) {
    if (now() - t0 > timeoutMs) throw new Error("انتهى الوقت وأنا أنتظر: " + what);
    await sleep(50);
  }
}

async function main() {
  const url = process.env.URL || (await startServer());
  log(`السيرفر: ${url}  |  ${HUMANS} لاعب حقيقي + ${BOTS} بوت  |  ${ROUNDS} جولة`);

  for (let i = 0; i < HUMANS; i++) clients.push(new Client(url, NAMES[i] || "لاعب" + i));
  for (const c of clients) await c.connect();
  for (const c of clients) c.join();
  await waitFor(() => clients.every((c) => c.id !== null), 3000, "استلام المعرّفات");
  const host = clients[0];
  await waitFor(() => host.st && host.st.host, 3000, "تعيين المضيف");
  if (BOTS) host.send({ t: "bots", n: BOTS });
  await waitFor(() => host.st.all.length === HUMANS + BOTS, 3000, "إضافة البوتات");
  log("اللوبي:", host.st.all.map((p) => p.n + (p.b ? "(بوت)" : "")).join(", "));

  // حلقة تحكّم العملاء: حركة كل 50ms وتصويت
  const loop = setInterval(() => { for (const c of clients) { c.tick(); c.voteTick(); } }, 50);

  const results = [];
  for (let r = 1; r <= ROUNDS; r++) {
    // ابدأ الجولة
    await waitFor(() => host.st.ph === "lobby", 5000, `اللوبي قبل الجولة ${r}`);
    host.send({ t: "start" });
    await waitFor(() => host.st.ph === "play", 3000, `بداية الجولة ${r}`);
    const t0 = now();
    const roles = clients.map((c) => `${c.name}=${c.st.me.imp ? "مخرِّب" : "شاب"}`).join(" ");
    log(`▶ جولة ${r} بدأت. ${roles}. مهام مطلوبة ${host.st.tt}`);

    // انتظر النهاية مع كاشف تجمّد
    let lastSig = "", lastChange = now(), meetings = 0, lastPh = "play";
    while (host.st.ph !== "over") {
      await sleep(100);
      const m = host.st;
      if (m.ph === "meeting" && lastPh !== "meeting") meetings++;
      lastPh = m.ph;
      const sig = `${m.ph}|${m.dt}|${m.all.filter((p) => p.a).length}|${m.left}`;
      if (sig !== lastSig) { lastSig = sig; lastChange = now(); }
      if (now() - lastChange > STALL_MS) {
        const moving = clients.filter((c) => c.st.me.alive && Math.hypot(c.st.me.x - c.stallX, c.st.me.y - c.stallY) > 40).length;
        const aliveH = clients.filter((c) => c.st.me.alive).length;
        return fail(`الجولة ${r} متجمّدة ${STALL_MS / 1000} ثانية بدون تغيّر في المرحلة/المهام/الأحياء. ` +
          `اللاعبون الأحياء اللي تحرّكوا (حسب السيرفر) خلال الفترة: ${moving}/${aliveH}. ` +
          (moving === 0 && aliveH ? "→ التجمّد من جهة العملاء (ما يرسلون حركة مقبولة)." : "→ العملاء يتحرّكون والجولة ما تنتهي: راجع منطق الفوز/البوتات في السيرفر."));
      }
      if (sig !== lastSig) for (const c of clients) { c.stallX = c.st.me.x; c.stallY = c.st.me.y; }
      if (now() - t0 > ROUND_TIMEOUT_MS) return fail(`الجولة ${r} تجاوزت ${ROUND_TIMEOUT_MS / 1000} ثانية`);
      if (clients.some((c) => c.closed)) return fail(`عميل انقطع أثناء الجولة ${r}`);
    }
    const m = host.st;
    const dur = ((now() - t0) / 1000).toFixed(1);
    const alive = m.all.filter((p) => p.a).length;
    results.push({ r, win: m.win, dur: +dur, tasks: `${m.dt}/${m.tt}`, meetings, alive });
    log(`■ جولة ${r}: الفائز ${m.win === "crew" ? "الشباب" : "المخرِّب"} | ${dur} ث | مهام ${m.dt}/${m.tt} | اجتماعات ${meetings} | أحياء ${alive}/${m.all.length} | المخرِّب ${(m.imps || []).join("، ")}`);

    // جولة ثانية
    await sleep(500);
    host.send({ t: "again" });
    await waitFor(() => host.st.ph === "lobby", 3000, `الرجوع للوبي بعد الجولة ${r}`);
  }
  clearInterval(loop);
  done = true;

  console.log("\nالملخص:");
  console.table(results);
  const crew = results.filter((x) => x.win === "crew").length;
  const avg = results.reduce((a, x) => a + x.dur, 0) / results.length;
  console.log(`الشباب فازوا ${crew}/${results.length} (${Math.round((crew / results.length) * 100)}٪)، متوسط الجولة ${avg.toFixed(0)} ث`);
  const errs = clients.flatMap((c) => c.errors.map((e) => `${c.name}: ${e}`));
  console.log(errs.length ? "أخطاء العملاء: " + errs.join(" | ") : "ما فيه أخطاء من العملاء ولا انقطاع.");
  cleanup();
  process.exit(0);
}

module.exports = { Client, pathR, startServer, waitFor, sleep, stopServer: () => { done = true; if (child) child.kill(); } };

if (require.main === module) {
  process.on("unhandledRejection", (e) => fail("unhandledRejection: " + (e && e.stack || e)));
  process.on("uncaughtException", (e) => fail("uncaughtException: " + (e && e.stack || e)));
  main().catch((e) => fail(e.stack || String(e)));
}
