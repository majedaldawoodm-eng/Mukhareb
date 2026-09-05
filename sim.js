/* محاكاة معايرة: جولات بوتات ضد بوتات بساعة افتراضية، أسرع من الوقت الحقيقي بمراحل.
   تشغيل: node sim.js                  (٤٠ جولة لكل إعداد من ٤ إلى ٨ لاعبين)
          ROUNDS=400 node sim.js
          PLAYERS=6 ROUNDS=40 node sim.js
   يطبع لكل إعداد نسبة فوز الشباب ومتوسط مدة الجولة، ثم الإجمالي. */
"use strict";
const S = require("./public/shared.js");
const C = S.C;
const { createGame } = require("./game.js");

const ROUNDS = +process.env.ROUNDS || 40;
const SETUPS = process.env.PLAYERS ? process.env.PLAYERS.split(",").map(Number) : [4, 5, 6, 7, 8];
const MAX_ROUND_MS = 15 * 60 * 1000; // حد أمان: جولة أطول من هذا تُحسب متجمّدة
const NAMES = ["فهد", "سلطان", "عبدالله", "ناصر", "تركي", "بدر", "مشعل", "سعد", "راكان", "نايف"];

function simulate(players, rounds) {
  let clock = 0;
  const game = createGame({ now: () => clock });
  for (let i = 0; i < players; i++) game.addPlayer(NAMES[i], true);
  const out = { crew: 0, imp: 0, stuck: 0, dur: [], tasksAtEnd: [], byTasks: 0, byVote: 0, byKills: 0 };

  for (let r = 0; r < rounds; r++) {
    // startGame يحتاج المرحلة لوبي فقط، وما فيه بشر فما نحتاج مضيفًا
    game.state.phase = "lobby";
    if (!game.startGame()) throw new Error("ما بدأت الجولة: عدد اللاعبين " + players);
    const t0 = clock;
    const dt = C.TICK / 1000;
    let stuck = false;
    while (game.state.phase !== "over") {
      clock += C.TICK;
      game.tick(clock, dt);
      if (clock - t0 > MAX_ROUND_MS) { stuck = true; break; }
    }
    const G = game.state;
    if (stuck) { out.stuck++; continue; }
    out[G.winner]++;
    out.dur.push((clock - t0) / 1000);
    out.tasksAtEnd.push(`${G.doneTasks}/${G.totalTasks}`);
    if (G.winner === "crew") {
      if (G.doneTasks >= G.totalTasks) out.byTasks++; else out.byVote++;
    } else out.byKills++;
    // فاصل بين الجولات كما في اللعب الحقيقي
    game.again();
  }
  return out;
}

const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

console.log(`محاكاة ${ROUNDS} جولة لكل إعداد، بوتات فقط، بساعة افتراضية\n`);
console.log("اللاعبون | فوز الشباب | بالمهام | بالتصويت | فوز المخرِّب | متجمّدة | متوسط الجولة | تجاوز العدّاد");
console.log("---|---|---|---|---|---|---|---");
let allCrew = 0, allImp = 0, allStuck = 0, allDur = [], allOver = 0, allN = 0;
for (const n of SETUPS) {
  const t = Date.now();
  const o = simulate(n, ROUNDS);
  const played = o.crew + o.imp;
  const over = o.tasksAtEnd.filter((s) => { const [a, b] = s.split("/").map(Number); return a > b; }).length;
  console.log(
    `${n} | ${pct(o.crew, played)}٪ (${o.crew}/${played}) | ${o.byTasks} | ${o.byVote} | ${pct(o.imp, played)}٪ | ${o.stuck} | ${avg(o.dur).toFixed(0)} ث | ${over}` +
      (process.env.VERBOSE ? `  [${((Date.now() - t) / 1000).toFixed(1)}s حقيقية]` : "")
  );
  allCrew += o.crew; allImp += o.imp; allStuck += o.stuck; allDur = allDur.concat(o.dur); allOver += over; allN += played;
}
console.log(`\nالإجمالي: الشباب يفوزون ${pct(allCrew, allN)}٪ (${allCrew}/${allN})، متوسط الجولة ${avg(allDur).toFixed(0)} ث (${(avg(allDur) / 60).toFixed(2)} دقيقة)، متجمّدة ${allStuck}، جولات تجاوز فيها العدّاد المطلوب ${allOver}`);
