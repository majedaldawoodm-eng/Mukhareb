/* خريطة الرياض المشتركة بين السيرفر والمتصفح */
(function (exp) {
  const WORLD = { w: 2400, h: 1800 };
  const CELL = 20;
  const GW = Math.ceil(WORLD.w / CELL);
  const GH = Math.ceil(WORLD.h / CELL);

  /* الطرق الرئيسية = الممرات */
  const ROADS = [
    { name: "طريق الملك فهد", x: 1040, y: 120, w: 120, h: 1560, v: true },
    { name: "الدائري الشرقي", x: 1880, y: 120, w: 120, h: 1560, v: true },
    { name: "طريق الملك خالد", x: 240, y: 120, w: 120, h: 1560, v: true },
    { name: "الدائري الشمالي", x: 220, y: 480, w: 1900, h: 120 },
    { name: "طريق الملك عبدالله", x: 220, y: 1040, w: 1900, h: 120 },
    { name: "الدائري الجنوبي", x: 220, y: 1560, w: 1900, h: 120 },
  ];

  /* الأحياء = الغرف */
  const DISTRICTS = [
    { name: "الدرعية", x: 100, y: 140, w: 500, h: 360 },
    { name: "حطين", x: 660, y: 140, w: 400, h: 360 },
    { name: "الملقا", x: 1200, y: 140, w: 380, h: 360 },
    { name: "الصحافة", x: 1640, y: 140, w: 400, h: 360 },
    { name: "السفارات", x: 100, y: 580, w: 480, h: 480 },
    { name: "العليا", x: 640, y: 580, w: 420, h: 480 },
    { name: "الروضة", x: 1200, y: 580, w: 380, h: 480 },
    { name: "قرطبة", x: 1640, y: 580, w: 400, h: 480 },
    { name: "العريجا", x: 100, y: 1140, w: 440, h: 480 },
    { name: "البطحاء", x: 620, y: 1140, w: 440, h: 480 },
    { name: "الملز", x: 1200, y: 1140, w: 380, h: 480 },
    { name: "النسيم", x: 1640, y: 1140, w: 400, h: 480 },
  ];

  const AREAS = DISTRICTS.map((d) => ({ ...d, room: true })).concat(
    ROADS.map((r) => ({ ...r, road: true }))
  );

  /* وادي حنيفة، زينة فقط */
  const WADI = [
    [60, 200],
    [150, 520],
    [120, 900],
    [180, 1300],
    [300, 1700],
    [220, 1740],
    [90, 1320],
    [60, 900],
    [90, 520],
    [10, 220],
  ];

  const GRID = (function () {
    const g = new Uint8Array(GW * GH);
    for (let cy = 0; cy < GH; cy++)
      for (let cx = 0; cx < GW; cx++) {
        const px = cx * CELL + CELL / 2;
        const py = cy * CELL + CELL / 2;
        for (const a of AREAS)
          if (px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) {
            g[cy * GW + cx] = 1;
            break;
          }
      }
    return g;
  })();

  const cellOf = (x, y) => [Math.floor(x / CELL), Math.floor(y / CELL)];
  const walkCell = (cx, cy) => cx >= 0 && cy >= 0 && cx < GW && cy < GH && GRID[cy * GW + cx] === 1;

  function walkable(x, y, r) {
    return (
      walkCell(...cellOf(x - r, y - r)) &&
      walkCell(...cellOf(x + r, y - r)) &&
      walkCell(...cellOf(x - r, y + r)) &&
      walkCell(...cellOf(x + r, y + r))
    );
  }

  function hasLOS(ax, ay, bx, by) {
    const d = Math.hypot(bx - ax, by - ay);
    const steps = Math.ceil(d / (CELL * 0.6));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (!walkCell(...cellOf(ax + (bx - ax) * t, ay + (by - ay) * t))) return false;
    }
    return true;
  }

  function placeName(x, y) {
    for (const a of AREAS)
      if (x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h) return a.name;
    return "الطريق";
  }

  const NB = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ];
  function findPath(sx, sy, tx, ty) {
    const [scx, scy] = cellOf(sx, sy);
    let [tcx, tcy] = cellOf(tx, ty);
    if (!walkCell(scx, scy)) return [];
    if (!walkCell(tcx, tcy)) {
      let best = null,
        bd = 1e9;
      for (let cy = 0; cy < GH; cy++)
        for (let cx = 0; cx < GW; cx++) {
          if (!walkCell(cx, cy)) continue;
          const d = (cx - tcx) ** 2 + (cy - tcy) ** 2;
          if (d < bd) {
            bd = d;
            best = [cx, cy];
          }
        }
      if (!best) return [];
      tcx = best[0];
      tcy = best[1];
    }
    const start = scy * GW + scx;
    const goal = tcy * GW + tcx;
    const prev = new Int32Array(GW * GH).fill(-1);
    const seen = new Uint8Array(GW * GH);
    const q = [start];
    seen[start] = 1;
    let head = 0;
    while (head < q.length) {
      const cur = q[head++];
      if (cur === goal) break;
      const cx = cur % GW;
      const cy = (cur - cx) / GW;
      for (const [dx, dy] of NB) {
        const nx = cx + dx,
          ny = cy + dy;
        if (!walkCell(nx, ny)) continue;
        const ni = ny * GW + nx;
        if (seen[ni]) continue;
        seen[ni] = 1;
        prev[ni] = cur;
        q.push(ni);
      }
    }
    if (!seen[goal]) return [];
    const out = [];
    let cur = goal;
    while (cur !== -1 && cur !== start) {
      const cx = cur % GW;
      out.push([cx * CELL + CELL / 2, ((cur - cx) / GW) * CELL + CELL / 2]);
      cur = prev[cur];
    }
    return out.reverse();
  }

  /* المهام على الخريطة */
  const SPOTS = [
    { id: "kingdom", name: "برج المملكة", label: "صبّ القهوة", game: "tea", x: 770, y: 720 },
    { id: "faisal", name: "الفيصلية", label: "طلب من المطعم", game: "order", x: 950, y: 940 },
    { id: "blvd", name: "البوليفارد", label: "ترتيب الطلبات", game: "cups", x: 860, y: 320 },
    { id: "turaif", name: "الطريف", label: "إشعال الفحم", game: "coal", x: 350, y: 320 },
    { id: "masmak", name: "قصر المصمك", label: "ترتيب الطلبات", game: "cups", x: 840, y: 1380 },
    { id: "sahafa", name: "كوفي الصحافة", label: "صبّ القهوة", game: "tea", x: 1840, y: 320 },
    { id: "malqa", name: "مطعم الملقا", label: "طلب من المطعم", game: "order", x: 1390, y: 320 },
    { id: "qurtubah", name: "محطة قرطبة", label: "تعبئة بنزين", game: "tea", x: 1840, y: 820 },
    { id: "malaz", name: "سوق الملز", label: "ترتيب الطلبات", game: "cups", x: 1390, y: 1380 },
    { id: "safarat", name: "حديقة السفارات", label: "إشعال الفحم", game: "coal", x: 340, y: 820 },
    { id: "naseem", name: "مطعم النسيم", label: "طلب من المطعم", game: "order", x: 1840, y: 1380 },
    { id: "uraija", name: "محطة العريجا", label: "تعبئة بنزين", game: "tea", x: 320, y: 1380 },
    { id: "rawdah", name: "كوفي الروضة", label: "صبّ القهوة", game: "tea", x: 1390, y: 820 },
  ];

  const EMERGENCY = { x: 850, y: 620, name: "ميدان العليا" };
  const SPAWN = { x: 850, y: 800 };

  const C = {
    R: 15,
    SPEED: 190,
    BOT_SPEED: 150,
    VIS_CREW: 300,
    VIS_IMP: 420,
    KILL_RANGE: 68,
    KILL_CD: 26000,
    HUNT_LEAD: 3000,
    ISO: 300,
    FIRST_KILL: 14000,
    USE_RANGE: 62,
    REPORT_RANGE: 100,
    TASKS_PER: 5,
    WORK_MS: 6000,
    MEET_MS: 26000,
    RESULT_MS: 5000,
    REPATH_MS: 500,
    TICK: 50,
    MAX_PLAYERS: 10,
    MIN_PLAYERS: 3,
  };

  const PALETTE = [
    "#E8B33C", "#C4482E", "#5B8FD9", "#7FA05A",
    "#C77DBB", "#4FB8A8", "#E07B39", "#9B8CE0",
    "#D9D2C4", "#8A6A4A",
  ];

  exp.WORLD = WORLD;
  exp.CELL = CELL;
  exp.GW = GW;
  exp.GH = GH;
  exp.GRID = GRID;
  exp.AREAS = AREAS;
  exp.ROADS = ROADS;
  exp.DISTRICTS = DISTRICTS;
  exp.WADI = WADI;
  exp.SPOTS = SPOTS;
  exp.EMERGENCY = EMERGENCY;
  exp.SPAWN = SPAWN;
  exp.C = C;
  exp.PALETTE = PALETTE;
  exp.walkable = walkable;
  exp.walkCell = walkCell;
  exp.hasLOS = hasLOS;
  exp.findPath = findPath;
  exp.placeName = placeName;
})(typeof module !== "undefined" && module.exports ? module.exports : (window.SHARED = {}));
