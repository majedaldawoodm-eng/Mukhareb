/* اختبار سيناريوهات الميزات بعملاء ويب سوكِت حقيقيين: قطع الكهرب، وغيرها لاحقًا.
   تشغيل: node featuretest.js
   كل تحقق يطبع ✓ أو ✗، وينتهي بكود 1 لو فشل أي تحقق. */
"use strict";
const S = require("./public/shared.js");
const C = S.C;
const { Client, pathR, startServer, stopServer, waitFor, sleep } = require("./longtest.js");

let fails = 0;
function check(ok, what) { console.log((ok ? "  ✓ " : "  ✗ ") + what); if (!ok) fails++; }
const now = () => Date.now();

/* يمشي العميل خطوة خطوة بمسار صحيح لين يقرب من نقطة، السيرفر يتحقق من كل خطوة */
async function walkTo(c, x, y, within, timeoutMs = 40000) {
  const t0 = now();
  c.path = pathR(c.x, c.y, x, y);
  let last = now();
  while (Math.hypot(c.x - x, c.y - y) > within) {
    if (now() - t0 > timeoutMs) throw new Error(`${c.name} ما وصل (${x},${y}) خلال المهلة`);
    await sleep(50);
    const t = now(), dt = Math.min(0.2, (t - last) / 1000); last = t;
    if (!c.path.length) c.path = pathR(c.x, c.y, x, y);
    // المسار ينتهي عند أقرب مركز خلية للهدف، فقد يقصر عنه بأقل من خلية
    if (c.path.length <= 1 && Math.hypot(c.x - x, c.y - y) < within + S.CELL) break;
    if (!c.path.length) break;
    const [wx, wy] = c.path[0];
    const dx = wx - c.x, dy = wy - c.y, d = Math.hypot(dx, dy);
    if (d < 8) { c.path.shift(); continue; }
    const step = Math.min(d, C.SPEED * dt);
    const nx = c.x + (dx / d) * step, ny = c.y + (dy / d) * step;
    if (S.walkable(nx, ny, C.R)) { c.x = nx; c.y = ny; } else c.path.shift();
    c.send({ t: "move", x: Math.round(c.x), y: Math.round(c.y) });
  }
}

/* حركة قصيرة بخط مستقيم (بدون مسار) لتثبيت الاتجاه */
async function nudge(c, dx, dy) {
  const d = Math.hypot(dx, dy), steps = Math.ceil(d / 6);
  for (let i = 0; i < steps; i++) {
    await sleep(50);
    const nx = c.x + (dx / steps), ny = c.y + (dy / steps);
    if (!S.walkable(nx, ny, C.R)) break;
    c.x = nx; c.y = ny;
    c.send({ t: "move", x: Math.round(c.x), y: Math.round(c.y) });
  }
}

async function setup(url, n) {
  const cs = [];
  for (let i = 0; i < n; i++) cs.push(new Client(url, "لاعب" + (i + 1)));
  for (const c of cs) await c.connect();
  for (const c of cs) c.join();
  await waitFor(() => cs.every((c) => c.id !== null && c.st), 3000, "الانضمام");
  return cs;
}

async function testSabotage(url) {
  console.log("\n▶ قطع الكهرب");
  const cs = await setup(url, 3);
  const host = cs[0];
  await waitFor(() => host.st.host, 2000, "المضيف");
  host.send({ t: "start" });
  await waitFor(() => cs.every((c) => c.st.ph === "play"), 3000, "بداية الجولة");
  // العملاء ما يتحرّكون تلقائيًا هنا (ما شغّلنا tick)، فنتحكم بكل خطوة
  const imp = cs.find((c) => c.st.me.imp);
  const crew = cs.filter((c) => !c.st.me.imp);
  check(imp && crew.length === 2, "جولة بثلاثة: مخرِّب واحد وشابّين");
  check(imp.st.me.scd > 0 && imp.st.me.scd <= C.SAB_FIRST / 1000, `كولداون التخريب يبدأ من ${imp.st.me.scd} ث`);
  check(crew[0].st.me.scd === 0, "الشباب ما عندهم كولداون تخريب");

  // تخريب قبل الجهوز → مرفوض
  imp.send({ t: "sab" });
  await sleep(300);
  check(host.st.sab === 0, "التخريب قبل جهوز الكولداون مرفوض");
  check(crew[0].st.me.vis === C.VIS_CREW && imp.st.me.vis === C.VIS_IMP, "الرؤية عادية قبل التخريب");

  // شاب يمشي لأقرب مهمة له
  const c0 = crew[0];
  const spot = S.SPOTS.find((s) => s.id === c0.st.me.tasks[0]);
  await walkTo(c0, spot.x, spot.y, C.USE_RANGE - 10);
  await sleep(200);
  const srvD = Math.hypot(c0.st.me.x - spot.x, c0.st.me.y - spot.y);
  check(srvD < C.USE_RANGE, `الشاب وصل المهمة ${spot.name} (بُعده حسب السيرفر ${srvD.toFixed(0)})`);

  // جهوز الكولداون ثم التخريب
  await waitFor(() => imp.st.me.scd === 0, C.SAB_FIRST + 2000, "جهوز كولداون التخريب");
  const killCdBefore = imp.st.me.cd;
  imp.send({ t: "sab" });
  await waitFor(() => host.st.sab > 0, 1000, "بداية الظلمة");
  check(host.st.sab <= C.SAB_MS / 1000 && host.st.sab >= C.SAB_MS / 1000 - 1, `الظلمة بدأت بـ ${host.st.sab} ث`);
  check(imp.st.me.scd >= (C.SAB_MS + C.SAB_CD) / 1000 - 1, `كولداون التخريب صار ${imp.st.me.scd} ث (مدة + كولداون)`);
  check(Math.abs(imp.st.me.cd - killCdBefore) <= 1, "كولداون الطيحة ما تأثّر بالتخريب");
  await sleep(200);
  check(c0.st.me.vis === C.SAB_VIS_CREW, `رؤية الشاب ضاقت إلى ${c0.st.me.vis}`);
  check(imp.st.me.vis === C.SAB_VIS_IMP, `رؤية المخرِّب ضاقت إلى ${imp.st.me.vis}`);

  // تخريب ثاني أثناء الظلمة → مرفوض (الوقت ما يمتد)
  const left1 = host.st.sab;
  imp.send({ t: "sab" });
  await sleep(300);
  check(host.st.sab <= left1, "التخريب أثناء الظلمة ما يمدّها");

  // المهمة وقت الظلمة مرفوضة
  const dtBefore = host.st.dt;
  c0.send({ t: "task", spot: spot.id });
  await sleep(300);
  check(host.st.dt === dtBefore && c0.st.me.done === 0, "إنهاء المهمة وقت الظلمة مرفوض من السيرفر");

  // بعد انتهاء الظلمة كل شي يرجع
  await waitFor(() => host.st.sab === 0, C.SAB_MS + 2000, "نهاية الظلمة");
  await sleep(200);
  check(c0.st.me.vis === C.VIS_CREW && imp.st.me.vis === C.VIS_IMP, "الرؤية رجعت طبيعية");
  c0.send({ t: "task", spot: spot.id });
  await sleep(300);
  check(host.st.dt === dtBefore + 1 && c0.st.me.done === 1, "نفس المهمة تنجز بعد رجوع الكهرب");
  check(imp.st.me.scd > 0 && imp.st.me.scd <= C.SAB_CD / 1000 + 1, `كولداون التخريب الباقي ${imp.st.me.scd} ث`);

  // الاجتماع يرجّع الكهرب
  await waitFor(() => imp.st.me.scd === 0, C.SAB_CD + 2000, "جهوز التخريب مرة ثانية");
  imp.send({ t: "sab" });
  await waitFor(() => host.st.sab > 0, 1000, "ظلمة ثانية");
  const c1 = crew[1];
  await walkTo(c1, S.EMERGENCY.x, S.EMERGENCY.y, C.USE_RANGE - 10);
  c1.send({ t: "emergency" });
  await waitFor(() => host.st.ph === "meeting", 1500, "الاجتماع الطارئ");
  check(host.st.sab === 0, "الاجتماع يرجّع الكهرب");

  for (const c of cs) c.close();
}

async function testCone(url) {
  console.log("\n▶ مخروط الرؤية");
  // دالة المخروط نفسها
  check(S.inCone(0, 0, 0, 200, 0, 300, 110), "نقطة أمامك داخل المدى: مرئية");
  check(!S.inCone(0, 0, 0, -200, 0, 300, 110), "نقطة وراك خارج الدائرة الصغيرة: غير مرئية");
  check(S.inCone(0, 0, 0, -100, 0, 300, 110), "نقطة وراك داخل الدائرة الصغيرة: مرئية");
  check(!S.inCone(0, 0, 0, 350, 0, 300, 110), "نقطة أمامك خارج المدى: غير مرئية");
  check(S.inCone(0, 0, Math.PI, -200, 0, 300, 110) && !S.inCone(0, 0, Math.PI, 200, 0, 300, 110), "الاتجاه يقلب المخروط");
  check(S.inCone(0, 0, -Math.PI, 0, -200, 300, 110) === S.inCone(0, 0, Math.PI, 0, -200, 300, 110), "زاوية ±π تعطي نفس النتيجة");

  const cs = await setup(url, 3);
  const host = cs[0];
  await waitFor(() => host.st.host, 2000, "المضيف");
  host.send({ t: "start" });
  await waitFor(() => cs.every((c) => c.st.ph === "play"), 3000, "بداية الجولة");
  const a = cs[0], b = cs[1], c = cs[2];
  // a يمشي لفوق حتى يبعد عن b أكثر من الدائرة الصغيرة وأقل من مدى الرؤية، ووجهه لفوق
  await walkTo(a, S.SPAWN.x, S.SPAWN.y - 170, 8);
  await nudge(a, 0, -12); // آخر خطوة لفوق بالضبط عشان يثبت الاتجاه
  await sleep(250);
  const d = Math.hypot(a.st.me.x - b.st.me.x, a.st.me.y - b.st.me.y);
  check(d > C.VIS_NEAR && d < C.VIS_CREW, `المسافة بين a و b ${d.toFixed(0)} (بين ${C.VIS_NEAR} و ${C.VIS_CREW})`);
  check(Math.abs(a.st.me.face + Math.PI / 2) < 0.3, `وجه a لفوق (face=${a.st.me.face})`);
  const seesB = () => (a.st.ps || []).some((p) => p.i === b.id);
  check(!seesB(), "a ما يشوف b اللي وراه");
  // b يشوف a لأنه واقف يواجه وسط الميدان؟ لا نضمنه، لكن لو مشى صوبه لازم يشوفه
  await nudge(b, 0, -15);
  await sleep(250);
  check((b.st.ps || []).some((p) => p.i === a.id), "b مشى صوب a فصار يشوفه");
  // a يرجع خطوة لتحت فيقلب وجهه ويشوف b
  await nudge(a, 0, 15);
  await sleep(250);
  check(Math.abs(a.st.me.face - Math.PI / 2) < 0.3, `وجه a صار لتحت (face=${a.st.me.face})`);
  check(seesB(), "a التفت لتحت فشاف b");
  // الجثث والمهام ما تتأثر بالمخروط من ناحية الرسم؛ اللاعب القريب جدًا يُرى من كل الجهات
  void c;
  for (const x of cs) x.close();
}

async function testReconnect(url) {
  console.log("\n▶ إعادة الاتصال");
  const cs = await setup(url, 3);
  const host = cs[0];
  check(cs.every((c) => typeof c.token === "string" && c.token.length >= 16), "كل لاعب استلم سرًا للرجوع");
  await waitFor(() => host.st.host, 2000, "المضيف");
  host.send({ t: "start" });
  await waitFor(() => cs.every((c) => c.st.ph === "play"), 3000, "بداية الجولة");
  const gone = cs[2];
  const before = { id: gone.id, imp: gone.st.me.imp, tasks: gone.st.me.tasks.slice(), token: gone.token };
  // يمشي شوي عشان يكون له موقع غير نقطة البداية
  await walkTo(gone, S.SPAWN.x, S.SPAWN.y - 120, 10);
  await sleep(150);
  const pos = { x: gone.st.me.x, y: gone.st.me.y };

  // انقطاع
  gone.close();
  await waitFor(() => host.st.all.find((p) => p.i === before.id)?.o === 1, 2000, "علامة منقطع");
  check(host.st.ph === "play", "الجولة استمرت بعد الانقطاع");
  check(host.st.all.length === 3, "مقعده محفوظ (ما زال في القائمة)");
  check(host.st.all.find((p) => p.i === before.id).o === 1, "معلَّم عند الباقين إنه منقطع");

  // سر خاطئ أثناء الجولة → رفض
  const bogus = new Client(url, "دخيل");
  await bogus.connect();
  bogus.join("ffffffffffffffffffffffff");
  await sleep(300);
  check(bogus.id === null && bogus.errors.length === 1, `سر خاطئ أثناء الجولة مرفوض: ${bogus.errors[0]}`);
  bogus.close();

  // رجوع خلال المهلة بنفس السر
  await sleep(1500);
  const back = new Client(url, "لاعب3");
  await back.connect();
  back.join(before.token);
  await waitFor(() => back.id !== null && back.st, 2000, "الرجوع");
  check(back.back === true, "السيرفر قال إنها عودة (back)");
  check(back.id === before.id, `نفس المعرّف ${back.id}`);
  check(back.st.me.imp === before.imp, "نفس الدور");
  check(JSON.stringify(back.st.me.tasks) === JSON.stringify(before.tasks), "نفس المهام");
  check(Math.hypot(back.st.me.x - pos.x, back.st.me.y - pos.y) < 1, "نفس الموقع");
  check(back.st.ph === "play" && host.st.all.find((p) => p.i === before.id).o === 0, "رجع للجولة وانشالت علامة منقطع");
  // يقدر يتحرك بعد الرجوع
  await nudge(back, 0, -12);
  await sleep(150);
  check(back.st.me.y < pos.y - 8, "حركته مقبولة بعد الرجوع");

  // تبويب ثاني بنفس السر يأخذ المقعد والقديم ينسكر
  const twin = new Client(url, "لاعب3");
  await twin.connect();
  twin.join(before.token);
  await waitFor(() => twin.id !== null, 2000, "التبويب الثاني");
  await sleep(300);
  check(twin.id === before.id && back.closed, "التبويب الجديد أخذ المقعد والقديم انسكر");

  // انقطاع بدون رجوع → يُطرد بعد المهلة، والجولة تنتهي لأن الباقي واحد ضد واحد
  twin.close();
  await sleep(C.RECONNECT_MS - 2000);
  check(host.st.all.length === 3, "قبل انتهاء المهلة ما زال محفوظًا");
  await waitFor(() => host.st.all.length === 2, 4000, "الطرد بعد المهلة");
  check(host.st.all.length === 2, "بعد المهلة انطرد فعليًا");
  await sleep(200);
  check(host.st.ph === "over", `والجولة انتهت (${host.st.ph}) لأن العدد ما يكفي`);
  for (const c of cs) c.close();
}

/* ONLY=reconnect node featuretest.js يشغّل قسمًا واحدًا */
const TESTS = { sabotage: testSabotage, cone: testCone, reconnect: testReconnect };
(async () => {
  const url = await startServer();
  try {
    const names = process.env.ONLY ? process.env.ONLY.split(",") : Object.keys(TESTS);
    for (let i = 0; i < names.length; i++) {
      // كل الأقسام على نفس السيرفر: لما ينقطع كل اللاعبين ويُطردون بعد المهلة يرجع للوبي
      if (i) await sleep(C.RECONNECT_MS + 1500);
      await TESTS[names[i]](url);
    }
  } catch (e) {
    console.log("  ✗ استثناء:", e.message);
    fails++;
  }
  stopServer();
  console.log(fails ? `\n${fails} تحقق فشل` : "\nكل التحققات نجحت");
  process.exit(fails ? 1 : 0);
})();
