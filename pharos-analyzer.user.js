// ==UserScript==
// @name         ファロス計測アナライザー
// @namespace    https://github.com/foxnine101-ux/pharos-analyzer
// @version      0.4.2
// @description  やっぱROのファロス燈台マッピングで、階ごと・ルートごとの所要時間を記録して分析する
// @updateURL    https://foxnine101-ux.github.io/pharos-analyzer-dist/pharos-analyzer.user.js
// @downloadURL  https://foxnine101-ux.github.io/pharos-analyzer-dist/pharos-analyzer.user.js
// @match        https://yapparo.net/social/infinity*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
/* ファロス計測アナライザー — 計算部分（画面に依存しない純粋な関数だけ）
 *
 * やること
 *  1. やっぱROのマップ画面の状態（階・マップ型・50部屋のチェック・ルート）を「写真」に撮る
 *  2. 写真を前回と見比べて「どの部屋にいつチェックが付いたか」「リセットされたか」を記録する
 *  3. 記録を「階ごとの区間（ラン）」に分けて、ルートごとの所要時間を出す
 */
(function (root) {
  'use strict';

  const ROUTE_COUNT = 12;
  const MAP_TYPES = ['four', 'five', 'six', 'seven', 'eight'];
  const MAP_LABEL = { four: 'WP4', five: 'WP5', six: 'WP6', seven: 'WP7', eight: 'WP8', other: 'その他' };

  const DEFAULT_OPTS = {
    batchMs: 700,          // この時間内に起きた変化はまとめて判定（DBは列ごとにバラバラ届くため）
    resetMinRemoved: 3,    // 一度にこの数以上チェックが外れて…
    resetMaxRemain: 2,     // …残りがこの数以下ならリセットとみなす
    bulkMinAdded: 5,       // 一度にこの数以上付いたら「全チェック」等の一括操作（時間計測しない）
    straggleMaxChecks: 3,  // リセット直後のチェックがこの数未満で…
    straggleMaxSec: 90,    // …この秒数以内に次のリセットが来たら「前の階の残り」とみなす
    markerGraceSec: 120,   // 手動の「ここから次の階」ボタンの後、この秒数以内のリセットは区切りにしない
    coverRoutes: [11, 12], // 他ルートのカバー役（自分のルートが終わったら遅れているルートの後ろから手伝う）
    lagShow: 2,            // 計測中に表示する「遅れがちなルート」の数
  };

  // ---- 座標 → 部屋番号 ----
  // マップは 19行×9列 のマス目（1始まり）。奇数行・奇数列が部屋、偶数は通路。
  // 部屋番号は (列-1)×10 + 行（左上10、左下1、右上50）
  function roomNumberFromCell(row, col) {
    if (row % 2 === 0 || col % 2 === 0) return 0; // 通路
    const c = 1 + Math.floor(col / 2);       // 1..5
    const r = 10 - Math.floor(row / 2);      // 1..10
    if (c < 1 || c > 5 || r < 1 || r > 10) return 0;
    return (c - 1) * 10 + r;
  }

  // ルート配列 [{color:'color3', rooms:[{row,col}...]}] → { 3: [部屋番号(通る順)] }
  function compactRoutes(roots) {
    const out = {};
    (roots || []).forEach((rt) => {
      const k = parseInt(String(rt && rt.color || '').replace(/\D/g, ''), 10);
      if (!k) return;
      const seq = [];
      (rt.rooms || []).forEach((cell) => {
        const n = roomNumberFromCell(cell.row, cell.col);
        if (n && !seq.includes(n)) seq.push(n);
      });
      if (seq.length) out[k] = (out[k] || []).concat(seq.filter((n) => !(out[k] || []).includes(n)));
    });
    return out;
  }

  // ---- 画面の状態を撮る ----
  function readState(v) {
    const checked = new Array(51).fill(false);
    for (let c = 1; c <= 5; c++) {
      const col = v['rooms' + c] || [];
      for (let i = 0; i < 10; i++) checked[(c - 1) * 10 + i + 1] = !!col[i];
    }
    let mapType = 'other';
    try { mapType = v.mapType || 'other'; } catch (e) { /* noop */ }
    const routes = MAP_TYPES.includes(mapType) ? compactRoutes(v[mapType + 'Roots']) : {};
    return { floor: Number(v.floor) || 0, mapType, checked, routes, joined: !!v.joined };
  }

  function countChecked(arr) { let n = 0; for (let i = 1; i <= 50; i++) if (arr[i]) n++; return n; }

  // ---- 記録係 ----
  // observe(state, now) を何度も呼ぶと、変化をまとめて events に積んでいく
  function createRecorder(opts, emit) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    let prev = null;          // 前回の状態
    let batchStart = null;    // まとめ判定の開始時刻
    let batchBase = null;     // まとめ開始前のチェック状態
    const firstSeen = {};     // 部屋 → この塊で最初に変化を見た時刻
    let routesKey = '';
    let lastResetT = -Infinity;

    function flush(now) {
      if (!batchBase) return;
      const cur = prev.checked;
      const added = [], removed = [];
      for (let i = 1; i <= 50; i++) {
        if (cur[i] && !batchBase[i]) added.push(i);
        if (!cur[i] && batchBase[i]) removed.push(i);
      }
      const after = countChecked(cur);
      const t0 = batchStart;
      const isReset = (removed.length >= o.resetMinRemoved && after <= o.resetMaxRemain) ||
        (after === 0 && removed.length >= 2) ||
        // リセット直後に付いた端数(1部屋)を消した → これもリセット
        (after === 0 && removed.length >= 1 && t0 - lastResetT <= o.straggleMaxSec * 1000);
      if (isReset) {
        lastResetT = t0;
        emit({ t: t0, k: 'R', n: removed.length, f: prev.floor });
        added.forEach((r) => emit({ t: firstSeen[r] || t0, k: 'c', r, f: prev.floor }));
      } else if (added.length >= o.bulkMinAdded) {
        emit({ t: t0, k: 'A', rs: added, f: prev.floor });
        removed.forEach((r) => emit({ t: firstSeen[r] || t0, k: 'u', r, f: prev.floor }));
      } else {
        const evs = [];
        added.forEach((r) => evs.push({ t: firstSeen[r] || t0, k: 'c', r, f: prev.floor }));
        removed.forEach((r) => evs.push({ t: firstSeen[r] || t0, k: 'u', r, f: prev.floor }));
        evs.sort((a, b) => a.t - b.t).forEach(emit);
      }
      batchBase = null; batchStart = null;
      Object.keys(firstSeen).forEach((k) => delete firstSeen[k]);
    }

    return {
      opts: o,
      start(state, now, resume) {
        prev = { floor: state.floor, mapType: state.mapType, checked: state.checked.slice() };
        routesKey = state.mapType + JSON.stringify(state.routes);
        const ev = { t: now, k: 'S', f: state.floor, m: state.mapType, routes: state.routes, pre: state.checked.reduce((a, x, i) => (x ? a.concat(i) : a), []) };
        if (resume) ev.resume = true;
        emit(ev);
      },
      observe(state, now) {
        if (!prev) { this.start(state, now); return; }
        // 階・マップ型・ルートは即記録
        if (state.floor !== prev.floor) {
          flush(now);
          emit({ t: now, k: 'f', v: state.floor, from: prev.floor });
          prev.floor = state.floor;
        }
        const rk = state.mapType + JSON.stringify(state.routes);
        if (rk !== routesKey) {
          emit({ t: now, k: 'm', v: state.mapType, routes: state.routes, f: state.floor });
          routesKey = rk; prev.mapType = state.mapType;
        }
        // チェックの変化はまとめて判定
        let changed = false;
        for (let i = 1; i <= 50; i++) {
          if (state.checked[i] !== prev.checked[i]) {
            if (!batchBase) { batchBase = prev.checked.slice(); batchStart = now; }
            if (!firstSeen[i]) firstSeen[i] = now;
            changed = true;
          }
        }
        if (changed) prev.checked = state.checked.slice();
        if (batchBase && now - batchStart >= o.batchMs) flush(now);
      },
      tick(now) { if (batchBase && now - batchStart >= o.batchMs) flush(now); },
      flush(now) { flush(now); },
      marker(now, floor) { flush(now); lastResetT = now; emit({ t: now, k: 'M', f: floor }); },
    };
  }

  // ---- 分析 ----
  function mode(list) {
    const cnt = new Map(); let best = null, bn = 0;
    list.forEach((x) => { const n = (cnt.get(x) || 0) + 1; cnt.set(x, n); if (n > bn || (n === bn && x > best)) { best = x; bn = n; } });
    return best;
  }

  function newRun(t, cause) {
    return { key: String(t), start: t, cause, checks: {}, floors: [], mapTypes: [], routes: {}, mapType: 'other',
      bulkT: null, lastT: t, endT: null, merged: [], partialStart: false, floorAtStart: null };
  }

  function splitRuns(events, opts) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    const runs = [];
    let floor = 0, mapType = 'other', routes = {};
    let run = null, lastMarkerT = -Infinity;
    const routesByType = o.routesByType || {};
    const open = (t, cause) => {
      if (run) { run.endT = t; runs.push(run); }
      run = newRun(t, cause); run.floorAtStart = floor; run.mapType = mapType; run.routes = routes;
    };
    events.forEach((e) => {
      switch (e.k) {
        case 'S':
          floor = e.f; mapType = e.m || 'other'; routes = e.routes || {};
          if (Object.keys(routes).length) routesByType[mapType] = routes;
          if (e.resume && run) { run.mapType = mapType; run.routes = routes; break; } // ページ再読み込みからの再開は同じ区間
          open(e.t, 'start');
          if (e.pre && e.pre.length > 3) run.partialStart = true; // 途中から計測開始
          break;
        case 'f': floor = e.v; break;
        case 'm': mapType = e.v; routes = e.routes || {}; if (Object.keys(routes).length) routesByType[mapType] = routes;
          if (run) { run.mapType = mapType; run.routes = routes; }
          break;
        case 'M': lastMarkerT = e.t; open(e.t, 'marker'); break;
        case 'R':
          if (e.t - lastMarkerT <= o.markerGraceSec * 1000) { // 手動区切りの直後のリセットは同じ階
            if (run) run.resetInside = (run.resetInside || 0) + 1; // 区切り後のチェックは新しい階のものとして残す
            break;
          }
          open(e.t, 'reset'); break;
        case 'c':
          if (!run) open(e.t, 'start');
          run.checks[e.r] = e.t; run.floors.push(floor); run.mapTypes.push(mapType);
          run.mapType = mapType; run.routes = routes;
          if (e.t > run.lastT) run.lastT = e.t;
          break;
        case 'u': if (run) delete run.checks[e.r]; break;
        case 'A': if (run) { run.bulkT = e.t; if (e.t > run.lastT) run.lastT = e.t; run.floors.push(floor); } break;
        default: break;
      }
    });
    if (run) runs.push(run);
    return runs;
  }

  function analyze(session, opts, overrides) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    const ov = overrides || {};
    const latestRoutes = {};
    let runs = splitRuns(session.events || [], Object.assign({}, o, { routesByType: latestRoutes }));

    // 前の階の残り（リセット後に付いた少数のチェック → すぐ次のリセット）を前のランへ戻す
    const merged = [];
    runs.forEach((r, i) => {
      const n = Object.keys(r.checks).length;
      const isLast = i === runs.length - 1;
      const span = ((r.endT || r.lastT) - r.start) / 1000;
      const forced = ov[r.key] && ov[r.key].mergePrev;
      const auto = !isLast && r.cause === 'reset' && n > 0 && n < o.straggleMaxChecks && span <= o.straggleMaxSec && !r.bulkT;
      const prev = merged[merged.length - 1];
      if (prev && (forced || (auto && !(ov[r.key] && ov[r.key].mergePrev === false)))) {
        Object.entries(r.checks).forEach(([room, t]) => { if (!prev.checks[room]) prev.checks[room] = t; });
        prev.lastT = Math.max(prev.lastT, r.lastT);
        prev.merged.push({ key: r.key, rooms: Object.keys(r.checks).map(Number), auto: !forced });
        return;
      }
      if (n === 0 && !r.bulkT) return; // 何もしていない区間は捨てる
      merged.push(r);
    });

    return merged.map((r, idx) => {
      const override = ov[r.key] || {};
      const floor = override.floor != null ? override.floor : (r.floors.length ? mode(r.floors) : r.floorAtStart);
      const mapType = override.mapType || (r.mapTypes.length ? mode(r.mapTypes) : r.mapType);
      let routes = r.routes || {};
      let routesFallback = false;
      if (!Object.keys(routes).length && latestRoutes[mapType]) { routes = latestRoutes[mapType]; routesFallback = true; }
      const checks = r.checks;
      const routeStats = [];
      Object.keys(routes).map(Number).sort((a, b) => a - b).forEach((k) => {
        const seq = routes[k];
        const times = seq.map((room) => checks[room] || null);
        const done = times.filter(Boolean);
        const st = { route: k, rooms: seq.length, done: done.length, complete: done.length === seq.length,
          firstT: done.length ? Math.min(...done) : null, lastT: done.length ? Math.max(...done) : null, seq, times };
        st.fromStart = st.lastT != null ? (st.lastT - r.start) / 1000 : null;  // 区切り→そのルート最後のチェック
        st.active = st.lastT != null ? (st.lastT - st.firstT) / 1000 : null;   // 最初→最後のチェック
        st.perRoom = st.done ? st.fromStart / st.done : null;
        routeStats.push(st);
      });
      const doneRooms = Object.keys(checks).length;
      return {
        idx, key: r.key, start: r.start, endT: r.endT, cause: r.cause, floor, mapType,
        mapLabel: MAP_LABEL[mapType] || mapType,
        duration: (r.lastT - r.start) / 1000, checks, doneRooms, bulk: !!r.bulkT,
        partialStart: r.partialStart, merged: r.merged, excluded: !!override.exclude, routeStats,
        floorEdited: override.floor != null, routesFallback,
      };
    });
  }

  // マップ型 × ルート で集計
  function aggregate(floorResults, opts) {
    const onlyComplete = !(opts && opts.includeIncomplete);
    const by = {};
    floorResults.forEach((fr) => {
      if (fr.excluded || fr.partialStart) return;
      fr.routeStats.forEach((st) => {
        if (st.fromStart == null) return;
        if (onlyComplete && !st.complete) return;
        const key = fr.mapType;
        by[key] = by[key] || {};
        const a = by[key][st.route] = by[key][st.route] || { route: st.route, mapType: key, list: [], rooms: st.rooms };
        a.list.push({ sec: st.fromStart, floor: fr.floor, start: fr.start });
      });
    });
    const out = [];
    Object.keys(by).forEach((mt) => Object.values(by[mt]).forEach((a) => {
      const xs = a.list.map((x) => x.sec).sort((p, q) => p - q);
      const avg = xs.reduce((s, x) => s + x, 0) / xs.length;
      const med = xs.length % 2 ? xs[(xs.length - 1) / 2] : (xs[xs.length / 2 - 1] + xs[xs.length / 2]) / 2;
      out.push({ mapType: mt, mapLabel: MAP_LABEL[mt] || mt, route: a.route, rooms: a.rooms, n: xs.length, avg, median: med,
        min: xs[0], max: xs[xs.length - 1], perRoom: avg / a.rooms, list: a.list });
    }));
    out.sort((p, q) => (MAP_TYPES.indexOf(p.mapType) - MAP_TYPES.indexOf(q.mapType)) || p.route - q.route);
    return out;
  }

  // マップ型ごと・部屋ごとに「区切りから何秒でチェックされたか」の平均
  function roomStats(floorResults) {
    const by = {};
    floorResults.forEach((fr) => {
      if (fr.excluded || fr.partialStart) return;
      const m = by[fr.mapType] = by[fr.mapType] || { mapType: fr.mapType, mapLabel: fr.mapLabel, floors: 0, rooms: {}, routeOf: {} };
      m.floors++;
      Object.entries(fr.checks).forEach(([room, t]) => {
        const a = m.rooms[room] = m.rooms[room] || [];
        a.push((t - fr.start) / 1000);
      });
      fr.routeStats.forEach((st) => st.seq.forEach((room) => { m.routeOf[room] = st.route; }));
    });
    Object.values(by).forEach((m) => {
      Object.keys(m.rooms).forEach((room) => {
        const xs = m.rooms[room];
        m.rooms[room] = { n: xs.length, avg: xs.reduce((p, q) => p + q, 0) / xs.length, max: Math.max(...xs) };
      });
    });
    return Object.values(by).sort((p, q) => MAP_TYPES.indexOf(p.mapType) - MAP_TYPES.indexOf(q.mapType));
  }


  // ---- 計測中の「遅れがちなルート」とカバー案 ----
  // paceOf: { ルート番号: 1部屋あたり秒数 }（過去の記録から。なければ今の階の実測 → 初期値）
  function pacesFromAggregate(agg, mapType) {
    const out = {};
    (agg || []).forEach((a) => { if (a.mapType === mapType && a.perRoom > 0) out[a.route] = a.perRoom; });
    return out;
  }

  function endsFromAggregate(agg, mapType) {
    const out = {};
    (agg || []).forEach((a) => { if (a.mapType === mapType && a.avg > 0) out[a.route] = a.avg; });
    return out;
  }

  // 末端(ルートの最後の部屋)に着くのが遅い順。見込み = max(今の進み具合からの予想, 過去の平均到達時間)
  function liveLag(state, elapsedSec, paceOf, opts, endOf) {
    const o = Object.assign({}, DEFAULT_OPTS, opts || {});
    const pace = paceOf || {};
    const cover = o.coverRoutes || [];
    const info = [];
    Object.keys(state.routes || {}).map(Number).sort((a, b) => a - b).forEach((k) => {
      const seq = state.routes[k];
      const left = seq.filter((r) => !state.checked[r]);
      info.push({ route: k, rooms: seq.length, left, done: seq.length - left.length, seq });
    });
    // 今の階の実測ペース（過去の記録が無いルートの目安）
    const doneAll = info.reduce((s, x) => s + x.done, 0);
    const livePace = doneAll >= 3 && elapsedSec > 0 ? elapsedSec / doneAll : 0;
    const fallback = livePace || 10;
    info.forEach((x) => {
      x.pace = pace[x.route] || fallback;
      const byPace = elapsedSec + x.left.length * x.pace;
      const hist = (endOf && endOf[x.route]) || 0;
      x.endAt = x.left.length ? Math.max(byPace, hist) : elapsedSec;  // 末端に着く見込み（区切りから）
      x.eta = Math.max(0, x.endAt - elapsedSec);                      // 末端まであと何秒
      x.isCover = cover.includes(x.route);
    });
    const lagging = info.filter((x) => !x.isCover && x.left.length > 0)
      .sort((a, b) => b.eta - a.eta).slice(0, o.lagShow);
    // カバー役のうち手が空いている人（自分のルートが終わった・ルートが無い）
    const covers = cover.map((k) => info.find((x) => x.route === k) || { route: k, rooms: 0, left: [], done: 0, seq: [], pace: fallback, eta: 0, isCover: true });
    const free = covers.filter((x) => x.left.length === 0);
    // いちばん遅れているルートから順に、空いているカバー役へ「後ろ半分」を渡す
    const plans = lagging.map((x, i) => {
      const helper = free[i] || null;
      const n = x.left.length;
      const take = n >= 2 ? Math.floor(n / 2) : 0;   // 本人は前から、手伝いは後ろから。真ん中で出会う
      const rooms = take ? x.left.slice(n - take).reverse() : [];
      const after = Math.max(0, Math.min(x.eta, (n - take) * x.pace));
      return { route: x.route, left: x.left, eta: x.eta, etaAfter: take && helper ? after : x.eta,
        helper: helper ? helper.route : null, rooms: helper ? rooms : [] };
    });
    return { lagging: plans, covers: covers.map((x) => ({ route: x.route, left: x.left.length, free: x.left.length === 0 })), livePace };
  }


  // ---- ルート設定・コマンド設定の保存と復元 ----
  // やっぱRO側のDB: {シート名}/{パス}/roots/{four..eight}/color1..12 = {rooms:[{row,col}]}（空は row:0,col:0 ひとつ）
  //                {シート名}/{パス}/commands/0..9 = {id,name,message,...,floors:"1,2,3"}
  const ROOT_TYPES = ['four', 'five', 'six', 'seven', 'eight'];
  const EMPTY_CELL = [{ row: 0, col: 0 }];
  const COMMAND_FIELDS = ['name', 'message', 'download', 'sheetName', 'sheetPass', 'leverGuardOn', 'leverGuardOff', 'shortcutOn', 'shortcutOff', 'foundTreasure'];

  function extractSetup(v) {
    const routes = {};
    ROOT_TYPES.forEach((t) => {
      const by = {};
      (v[t + 'Roots'] || []).forEach((rt) => {
        const cells = (rt.rooms || []).filter((c) => c && c.row > 0 && c.col > 0).map((c) => ({ row: c.row, col: c.col }));
        if (cells.length && /^color\d+$/.test(rt.color || '')) by[rt.color] = cells;
      });
      if (Object.keys(by).length) routes[t] = by;
    });
    const commands = (v.commands || []).filter((c) => c && (c.name || c.message)).map((c) => {
      const o = { id: c.id };
      COMMAND_FIELDS.forEach((k) => { o[k] = c[k]; });
      o.floors = (Array.isArray(c.floors) ? c.floors : String(c.floors || '').split(',')).map(Number).filter((n) => n > 0 && n <= 50);
      return o;
    });
    return { routes, commands };
  }

  function setupSummary(setup) {
    const r = Object.keys(setup.routes || {}).map((t) => (MAP_LABEL[t] || t) + '×' + Object.keys(setup.routes[t]).length);
    return { routes: r, commands: (setup.commands || []).length };
  }

  // 書き込み手順を作る（what: {routes, commands}）。base は "シート名/パス"（エンコード済み）
  function setupWrites(setup, base, what) {
    const w = what || { routes: true, commands: true };
    const out = [];
    if (w.routes) {
      Object.keys(setup.routes || {}).forEach((t) => {
        const body = {};
        for (let k = 1; k <= ROUTE_COUNT; k++) body['color' + k] = { rooms: (setup.routes[t]['color' + k] || EMPTY_CELL) };
        out.push({ method: 'PATCH', path: `${base}/roots/${t}`, body });
      });
    }
    if (w.commands) {
      (setup.commands || []).forEach((c) => {
        if (!(c.id >= 0 && c.id <= 9)) return;
        const body = { id: c.id };
        COMMAND_FIELDS.forEach((k) => { body[k] = c[k] == null ? (k.match(/^(download|leverGuard|shortcut|foundTreasure)/) ? false : '') : c[k]; });
        body.floors = (c.floors || []).filter((n) => n > 0 && n <= 50).join(',');
        out.push({ method: 'PUT', path: `${base}/commands/${c.id}`, body });
      });
    }
    return out;
  }

  // ---- 聖域の担当 ----
  // コマンド名「1・6：聖域50/聖域40」→ [{route:1, room:50}, {route:6, room:40}]
  const SANCT_RE = /(\d{1,2})\s*[・･,，、\/／&＆+＋\s]\s*(\d{1,2})\s*[:：\s]?\s*聖域\s*(\d{1,2})\s*[\/／・･,，、\s]\s*聖域\s*(\d{1,2})/;
  function toHalf(str) { return String(str || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)); }
  function parseSanctuaryCommand(name) {
    const m = toHalf(name).match(SANCT_RE);
    if (!m) return null;
    const a = { route: +m[1], room: +m[3] }, b = { route: +m[2], room: +m[4] };
    if (![a, b].every((x) => x.route >= 1 && x.route <= ROUTE_COUNT && x.room >= 1 && x.room <= 50)) return null;
    return [a, b];
  }
  // 画面の状態から「聖域の部屋ごとに、どのルートの誰が行くか」を作る
  //  1) 「x・y：聖域50/聖域40」形式のコマンドがあればそれを全部（コマンド番号順）
  //  2) 無ければ、今のマップのルートで50番・40番の部屋を通るルート
  //  floor を渡すと、コマンドの「階」欄にその階が入っているグループに active を付ける（階の指定が1つも無ければ全部 active）
  function sanctuaryGroups(commands, entries, routes, floor) {
    const people = {};
    (entries || []).forEach((e) => {
      const r = Number(e && e.root) || 0;
      if (!r || !e.name) return;
      (people[r] = people[r] || []).push(String(e.name));
    });
    Object.values(people).forEach((a) => a.sort((p, q) => p.localeCompare(q, 'ja')));
    const slot = (route, room) => ({ route, room, names: people[route] || [] });
    const groups = [];
    (commands || []).forEach((c, i) => {
      const pair = c && parseSanctuaryCommand(c.name);
      if (!pair) return;
      const floors = (Array.isArray(c.floors) ? c.floors : String(c.floors || '').split(',')).map(Number).filter((n) => n > 0);
      groups.push({ source: 'command', key: i, floors, label: `${pair[0].route}・${pair[1].route}`, slots: pair.map((x) => slot(x.route, x.room)).sort((a, b) => b.room - a.room) });
    });
    if (groups.length) {
      const anyFloors = groups.some((g) => g.floors.length);
      groups.forEach((g) => { g.active = !anyFloors || !floor || g.floors.includes(Number(floor)); });
      return groups;
    }
    const slots = [];
    [50, 40].forEach((room) => {
      Object.keys(routes || {}).map(Number).sort((a, b) => a - b).forEach((k) => {
        if ((routes[k] || []).includes(room)) slots.push(slot(k, room));
      });
    });
    return slots.length ? [{ source: 'map', key: 'map', label: '', floors: [], active: true, slots }] : [];
  }

  function fmtSec(s) {
    if (s == null || !isFinite(s)) return '—';
    s = Math.round(s);
    const m = Math.floor(s / 60), r = s % 60;
    return m + ':' + String(r).padStart(2, '0');
  }

  function toCsv(floorResults) {
    const head = ['階', 'マップ', '開始', '所要', 'チェック部屋数'];
    for (let k = 1; k <= ROUTE_COUNT; k++) head.push('ルート' + String(k).padStart(2, '0'));
    const rows = [head];
    floorResults.filter((f) => !f.excluded).forEach((f) => {
      const d = new Date(f.start);
      const row = [f.floor, f.mapLabel, d.toLocaleString('ja-JP'), fmtSec(f.duration), f.doneRooms];
      for (let k = 1; k <= ROUTE_COUNT; k++) {
        const st = f.routeStats.find((x) => x.route === k);
        row.push(st && st.fromStart != null ? fmtSec(st.fromStart) + (st.complete ? '' : ` (${st.done}/${st.rooms})`) : '');
      }
      rows.push(row);
    });
    return '﻿' + rows.map((r) => r.map((x) => {
      const s = String(x == null ? '' : x);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',')).join('\r\n');
  }

  const Core = { DEFAULT_OPTS, MAP_TYPES, MAP_LABEL, ROUTE_COUNT, roomNumberFromCell, compactRoutes, readState,
    countChecked, createRecorder, splitRuns, analyze, aggregate, roomStats, parseSanctuaryCommand, sanctuaryGroups, extractSetup, setupSummary, setupWrites, pacesFromAggregate, endsFromAggregate, liveLag, fmtSec, toCsv };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  root.PharosAnalyzerCore = Core;
})(typeof window !== 'undefined' ? window : globalThis);

/* ファロス計測アナライザー — 画面部分（やっぱROのマップページに小さなパネルを足す） */
(function () {
  'use strict';
  if (typeof window === 'undefined' || !document) return;
  if (window.__pharosAnalyzerLoaded) { window.__pharosAnalyzer && window.__pharosAnalyzer.show(); return; }
  window.__pharosAnalyzerLoaded = true;

  const C = window.PharosAnalyzerCore;
  const STORE_KEY = 'pharosAnalyzer.v1';
  const DEFAULT_COLORS = ['#8ab1df', '#c5d1f1', '#ff8888', '#ffcccc', '#dddd00', '#ffb74d', '#b0c48c', '#dae7bf', '#62CDA3', '#45A9B7', '#9191A1', '#CCA9E0'];

  // ---------- 保存 ----------
  function load() {
    try { const s = JSON.parse(localStorage.getItem(STORE_KEY)); if (s && s.sessions) return s; } catch (e) { /* noop */ }
    return { sessions: [], activeId: null, overrides: {}, opts: {}, ui: {}, presets: [] };
  }
  let store = load();
  store.overrides = store.overrides || {}; store.opts = store.opts || {}; store.ui = store.ui || {}; store.presets = store.presets || [];
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const run = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch (e) { toast('保存に失敗しました（容量オーバーかも）'); } };
    if (now) run(); else saveTimer = setTimeout(run, 800);
  }
  const active = () => store.sessions.find((s) => s.id === store.activeId) || null;

  // ---------- やっぱROの画面を探す ----------
  let view = null;
  function findView() {
    if (view && !view._isDestroyed) return view;
    view = null;
    const rootVm = window.$nuxt;
    if (!rootVm) return null;
    const stack = [rootVm];
    while (stack.length) {
      const vm = stack.pop();
      if (vm.$options && vm.$options.name === 'infinity' && 'rooms1' in vm) { view = vm; return vm; }
      (vm.$children || []).forEach((c) => stack.push(c));
    }
    return null;
  }
  const colors = () => { const v = findView(); try { return (v && v.colors && v.colors.length === 12) ? v.colors : DEFAULT_COLORS; } catch (e) { return DEFAULT_COLORS; } };

  // ---------- 記録 ----------
  let recorder = null, pollTimer = null;
  function emit(ev) {
    const s = active(); if (!s) return;
    s.events.push(ev);
    save();
    render();
  }
  function startPolling(resume) {
    const v = findView();
    if (!v) { toast('マップ画面が見つかりません。ページを読み込み直してください'); return false; }
    recorder = C.createRecorder(store.opts, emit);
    let started = false, lastJoined = null, lastVm = null, settleUntil = 0;
    clearInterval(pollTimer);
    const poll = () => {
      const vv = findView();
      if (!vv) return;
      try {
        const st = C.readState(vv);
        const now = Date.now();
        if (!started) {
          // 再読み込み後は、シートに参加し直してDBの内容が届くまで待つ
          // （届いた瞬間を「チェックが一斉に付いた」と誤解しないため）
          if (resume) {
            if (!st.joined) return;
            if (!settleUntil) { settleUntil = now + 3000; return; }
            if (now < settleUntil) return;
          }
          recorder.start(st, now, resume);
          started = true; settleUntil = 0; lastJoined = st.joined; lastVm = vv;
          return;
        }
        // 参加/退出や画面の作り直しでは状態が丸ごと入れ替わる → 落ち着くまで待って基準だけ取り直す
        if (st.joined !== lastJoined || vv !== lastVm) { settleUntil = now + 3000; lastJoined = st.joined; lastVm = vv; return; }
        if (settleUntil) {
          if (now < settleUntil) return;
          recorder.start(st, now, true); settleUntil = 0; return;
        }
        recorder.observe(st, now);
      } catch (e) { console.warn('[pharos-analyzer]', e); }
    };
    poll();
    pollTimer = setInterval(poll, 250);
    return true;
  }
  function startSession() {
    const v = findView();
    if (!v) { toast('マップ画面が見つかりません'); return; }
    const now = Date.now();
    const id = 's' + now.toString(36);
    let party = ''; try { party = String(v.partyName || ''); } catch (e) { /* noop */ }
    store.sessions.push({ id, name: '', party, sheetId: String(v.sheetId || ''), startedAt: now, endedAt: null, events: [] });
    store.activeId = id;
    if (!startPolling(false)) { store.activeId = null; return; }
    save(true);
    toast('計測を開始しました');
    render();
  }
  function stopSession() {
    if (recorder) recorder.flush(Date.now());
    clearInterval(pollTimer); pollTimer = null; recorder = null;
    const s = active(); if (s) s.endedAt = Date.now();
    store.activeId = null; save(true);
    toast('計測を止めました');
    render();
  }
  function marker() {
    if (!recorder) return;
    const v = findView();
    recorder.marker(Date.now(), v ? Number(v.floor) || 0 : 0);
    toast('ここから次の階として計測します');
  }

  // ---------- 画面 ----------
  const host = document.createElement('div');
  host.id = 'pharos-analyzer-host';
  host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });
  shadow.innerHTML = `<style>${CSS()}</style><div class="panel" id="panel"></div><div class="modal" id="modal" hidden></div><div class="toast" id="toast"></div>`;
  const $ = (sel) => shadow.querySelector(sel);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast'); el.textContent = msg; el.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('on'), 2400);
  }

  function liveInfo() {
    const s = active(); if (!s) return null;
    const res = C.analyze(s, store.opts, store.overrides[s.id]);
    const cur = res[res.length - 1];
    const last = s.events.filter((e) => e.k === 'R' || e.k === 'M' || (e.k === 'S' && !e.resume)).pop();
    return { elapsed: (Date.now() - s.startedAt) / 1000, floorStart: last ? last.t : s.startedAt, cur, floors: res.length };
  }

  function renderPanel() {
    const p = $('#panel');
    const v = findView();
    const s = active();
    const collapsed = !!store.ui.collapsed;
    let html = `<div class="head"><span class="title">⏱ ファロス計測</span><button class="mini" data-act="sanct" title="いまの階の聖域担当を参加者リストでハイライトする/しない">${store.ui.sanctuary === false ? '聖域OFF' : '聖域ON'}</button><button class="mini" data-act="collapse" title="たたむ">${collapsed ? '▴' : '▾'}</button></div>`;
    if (!collapsed) {
      if (!v) html += '<div class="muted">マップ画面を待っています…</div>';
      else if (s) {
        const info = liveInfo();
        const st = C.readState(v);
        html += `<div class="rec"><span class="dot"></span>計測中 <span class="mono" data-live="elapsed" data-from="${s.startedAt}">${C.fmtSec(info.elapsed)}</span></div>
          <div class="kv"><span>今の階</span><b>${st.floor || '—'}F <small>${C.MAP_LABEL[st.mapType] || ''}</small></b></div>
          <div class="kv"><span>区切りから</span><b class="mono" data-live="floor" data-from="${info.floorStart}">${C.fmtSec((Date.now() - info.floorStart) / 1000)}</b></div>
          <div class="kv"><span>チェック</span><b>${C.countChecked(st.checked)} / 50</b></div>
          ${st.joined ? '' : '<div class="warn">シートに未参加です（この画面だけの記録になります）</div>'}
          <div class="lag" id="lag">${lagHtml(st, info)}</div>
          <div class="btns">
            <button data-act="marker" title="ゲーム内で次の階に着いたら押す（任意）">⏭ ここから次の階</button>
            <button data-act="stop" class="ghost">■ 停止</button>
            <button data-act="open">📊 分析</button>
            <button data-act="bigfloor" class="ghost" title="階の数字を大きく表示">${store.ui.bigFloor === false ? '階表示 OFF' : '階表示 ON'}</button>
          </div>`;
      } else {
        html += `<div class="muted">「計測開始」を押してから普段どおりチェック・リセットするだけ。</div>
          <div class="btns"><button data-act="start" class="primary">▶ 計測開始</button><button data-act="open">📊 分析</button></div>`;
      }
    }
    p.innerHTML = html;
    p.classList.toggle('collapsed', collapsed);
  }


  // ---------- 遅れがちなルート ----------
  let paceCache = { key: '', paces: {}, ends: {} };
  function pacesFor(mapType) {
    const key = store.sessions.length + ':' + store.sessions.reduce((n, s) => n + s.events.length, 0) + ':' + mapType;
    if (paceCache.key !== key) {
      const res = [];
      store.sessions.forEach((s) => C.analyze(s, store.opts, store.overrides[s.id]).forEach((r) => res.push(r)));
      const ag = C.aggregate(res, { includeIncomplete: false });
      paceCache = { key, paces: C.pacesFromAggregate(ag, mapType), ends: C.endsFromAggregate(ag, mapType) };
    }
    return paceCache;
  }
  function lagHtml(st, info) {
    if (!Object.keys(st.routes).length) return '<div class="muted">ルートが未設定です</div>';
    const elapsed = info ? (Date.now() - info.floorStart) / 1000 : 0;
    const lag = (() => { const h = pacesFor(st.mapType); return C.liveLag(st, elapsed, h.paces, store.opts, h.ends); })();
    if (!lag.lagging.length) return '<div class="lagok">遅れているルートなし 👍</div>';
    const rows = lag.lagging.map((p) => {
      const cover = p.helper && p.rooms.length
        ? `<div class="cover">${chip(p.helper, '')} が後ろから <b>${p.rooms.join('→')}</b> <small>(${C.fmtSec(p.eta)}→${C.fmtSec(p.etaAfter)})</small></div>`
        : (p.left.length === 1 ? '' : lag.covers.some((c) => c.free) ? '' : '<div class="cover muted">カバー役は自分のルート中</div>');
      return `<div class="lagrow">${chip(p.route, '')} <span>あと<b>${p.left.length}</b>部屋</span> <span class="eta">末端まで約${C.fmtSec(p.eta)}</span><div class="rem">${p.left.join(' ')}</div>${cover}</div>`;
    }).join('');
    return `<div class="lagtitle">遅れがち</div>${rows}`;
  }
  function refreshLag() {
    const el = $('#lag'); const v = findView();
    if (!el || !v) return;
    el.innerHTML = lagHtml(C.readState(v), liveInfo());
  }

  // ---------- 階の拡大表示（本来の階の表示の上に大きく） ----------
  const big = document.createElement('div');
  big.className = 'bigfloor'; big.hidden = true;
  function findFloorEl() {
    let best = null;
    document.querySelectorAll('div.vanish-if-sp ~ div, div.vanish-if-sp div').forEach((e) => {
      if (!e.children.length && /^\s*\d+F\s*$/.test(e.textContent)) best = best || e;
    });
    if (best) return best;
    return [...document.querySelectorAll('div')].find((e) => !e.children.length && /^\s*\d+F\s*$/.test(e.textContent)) || null;
  }
  function updateBigFloor() {
    const v = findView();
    const on = v && store.ui.bigFloor !== false;
    big.hidden = !on;
    if (!on) return;
    const fl = Number(v.floor) || 0;
    big.textContent = fl + 'F';
    const el = findFloorEl();
    const r = el ? el.getBoundingClientRect() : null;
    if (r && r.width > 0 && r.bottom > 60 && r.top < window.innerHeight) {
      // 本来の階の表示の真上に大きく重ねる
      big.classList.remove('pinned');
      big.style.left = (r.left + r.width / 2) + 'px';
      big.style.top = (r.top - 4) + 'px';
    } else {
      // 画面外・スマホ幅で本来の表示が無いときは画面上部に固定
      big.classList.add('pinned');
      big.style.left = '50%'; big.style.top = '8px';
    }
  }


  // ---------- 設定（ルート・コマンド）の保存と復元 ----------
  const dbBase = () => {
    const v = findView(); if (!v) return null;
    let host = 'https://infinity-mapper-default-rtdb.asia-southeast1.firebasedatabase.app';
    try { host = v.db.app.options.databaseURL || host; } catch (e) { /* noop */ }
    return { host: host.replace(/\/$/, ''), base: encodeURIComponent(v.partyName) + '/' + encodeURIComponent(v.password) };
  };
  function savePreset() {
    const v = findView(); if (!v) { toast('マップ画面が見つかりません'); return; }
    const setup = C.extractSetup(v);
    const sum = C.setupSummary(setup);
    if (!sum.routes.length && !sum.commands) { toast('保存できる設定がありません（ルートもコマンドも空です）'); return; }
    const name = (ui.presetName || '').trim() || new Date().toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' の設定';
    store.presets.push({ id: 'p' + Date.now().toString(36), name, at: Date.now(), routes: setup.routes, commands: setup.commands });
    ui.presetName = ''; save(true); render(); toast('「' + name + '」を保存しました');
  }
  async function applyPreset(id) {
    const pr = store.presets.find((p) => p.id === id); if (!pr) return;
    const v = findView(); const b = dbBase();
    if (!v || !b || !v.joined) { toast('シートに参加してから適用してください'); return; }
    const sum = C.setupSummary(pr);
    const msg = `「${pr.name}」を今のシート（${v.partyName}）に適用します。\n\nルート: ${sum.routes.join(' / ') || 'なし'}\nコマンド: ${sum.commands}件\n\n同じマップ型のルートとコマンドは上書きされ、シートにいる全員の画面が変わります。よろしいですか？`;
    if (!window.confirm(msg)) return;
    const writes = C.setupWrites(pr, b.base, { routes: true, commands: true });
    let okN = 0;
    for (const w of writes) {
      try {
        const r = await fetch(`${b.host}/${w.path}.json`, { method: w.method, body: JSON.stringify(w.body) });
        if (!r.ok) throw new Error(r.status);
        okN++;
      } catch (e) { toast('書き込みに失敗しました（' + e.message + '）。' + okN + '/' + writes.length + '件まで反映'); return; }
    }
    toast('適用しました（' + okN + '件）');
  }
  const presetHtml = () => {
    const rows = store.presets.slice().reverse().map((p) => {
      const sum = C.setupSummary(p);
      return `<tr><td><b>${esc(p.name)}</b><br><small>${new Date(p.at).toLocaleString('ja-JP')}</small></td>
        <td>${sum.routes.map(esc).join(' ') || '<span class="muted">ルートなし</span>'}</td><td>${sum.commands}件</td>
        <td><button data-act="applypreset" data-id="${p.id}" class="primary">適用</button>
        <button data-act="exportpreset" data-id="${p.id}">書き出し</button>
        <button data-act="renamepreset" data-id="${p.id}" class="ghost">名前</button>
        <button data-act="delpreset" data-id="${p.id}" class="ghost">削除</button></td></tr>`;
    }).join('');
    return `<div class="presetbar"><input type="text" data-act="pname" placeholder="名前（例: 金曜ギルド用）" value="${esc(ui.presetName || '')}">
      <button data-act="savepreset" class="primary">今のルートとコマンドを保存</button>
      <label class="btnlike">⬆ 読み込み<input type="file" accept=".json,application/json" data-act="importpresets" hidden></label></div>
      ${rows ? `<table class="tbl"><thead><tr><th>名前</th><th>ルート</th><th>コマンド</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">まだ保存した設定がありません。ルートとコマンドを設定してから保存してね。</div>'}
      <p class="note">保存するのはこのシートの「ルート（WP4〜8の線）」と「コマンド（名前・メッセージ・階など）」。書き出したファイルにはコマンドのシートパスワードを入れません。適用すると、同じマップ型のルートとコマンドが上書きされます。</p>`;
  };

  // ---------- 分析画面 ----------
  let ui = { tab: store.ui.tab || 'floors', sel: store.ui.sel || 'latest', includeIncomplete: false, showOpts: false, confirmDel: false };
  function selectedSessions() {
    if (ui.sel === 'all') return store.sessions.slice();
    if (ui.sel === 'latest') return store.sessions.length ? [store.sessions[store.sessions.length - 1]] : [];
    return store.sessions.filter((s) => s.id === ui.sel);
  }
  function results() {
    const out = [];
    selectedSessions().forEach((s) => C.analyze(s, store.opts, store.overrides[s.id]).forEach((r) => { r.sid = s.id; out.push(r); }));
    return out;
  }
  const sessionLabel = (s) => {
    const d = new Date(s.startedAt);
    const floors = C.analyze(s, store.opts, store.overrides[s.id]).length;
    return `${s.name || d.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}${s.party ? ' / ' + s.party : ''}（${floors}区間${s.id === store.activeId ? '・計測中' : ''}）`;
  };
  const chip = (k, text, opt) => {
    const c = colors()[k - 1] || '#999';
    return `<span class="chip${opt && opt.dashed ? ' dashed' : ''}${text ? '' : ' solo'}" style="--c:${c}" ${opt && opt.title ? `title="${esc(opt.title)}"` : ''}><b>${String(k).padStart(2, '0')}</b>${text ? ' ' + text : ''}</span>`;
  };

  function renderFloors(res) {
    if (!res.length) return '<div class="empty">まだ記録がありません。計測開始してからマップでチェックしてね。</div>';
    const rows = res.map((r) => {
      const routes = r.routeStats.filter((s) => s.done > 0).map((s) => {
        const detail = s.seq.map((room, i) => `${room}: ${s.times[i] ? C.fmtSec((s.times[i] - r.start) / 1000) : '未'}`).join('\n');
        return chip(s.route, `${C.fmtSec(s.fromStart)}${s.complete ? '' : ` <small>${s.done}/${s.rooms}</small>`}`, { dashed: !s.complete, title: `ルート${s.route}（区切りからの時間）\n${detail}` });
      }).join('') || (r.mapType === 'other' ? '<span class="muted">ルート未設定のマップ</span>' : '<span class="muted">ルートのチェックなし</span>');
      const flags = [];
      if (r.cause === 'marker') flags.push('<span class="flag">手動区切り</span>');
      if (r.partialStart) flags.push('<span class="flag warnf" title="計測開始時にすでにチェックが付いていたので、平均には入れません">途中から</span>');
      if (r.bulk) flags.push('<span class="flag">一括チェックあり</span>');
      if (r.routesFallback) flags.push('<span class="flag" title="この階を回っていた時はルートが未設定だったので、あとで設定されたルートで計算しています">ルートは後から設定</span>');
      r.merged.forEach((m) => flags.push(`<span class="flag" title="リセット直後に付いた ${m.rooms.join(', ')} 番を前の階の分として数えています">端数を吸収 <button class="link" data-act="unmerge" data-sid="${r.sid}" data-key="${m.key}">戻す</button></span>`));
      const k = `data-sid="${r.sid}" data-key="${r.key}"`;
      return `<tr class="${r.excluded ? 'excluded' : ''}">
        <td><input type="checkbox" data-act="exclude" ${k} ${r.excluded ? '' : 'checked'} title="集計に入れる"></td>
        <td><input class="floor" type="number" min="0" max="50" value="${r.floor}" data-act="floor" ${k}>${r.floorEdited ? '<small>✎</small>' : ''}</td>
        <td>${esc(r.mapLabel)}</td>
        <td class="mono">${new Date(r.start).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
        <td class="mono">${C.fmtSec(r.duration)}</td>
        <td class="mono">${r.doneRooms}</td>
        <td class="routes">${routes}<div>${flags.join('')}${r.idx > 0 ? `<button class="link" data-act="mergeprev" ${k}>↑前の階とまとめる</button>` : ''}</div></td>
      </tr>`;
    }).join('');
    return `<table class="tbl"><thead><tr><th>集計</th><th>階</th><th>マップ</th><th>開始</th><th>所要</th><th>部屋</th><th>ルート（区切り→そのルート最後のチェック）</th></tr></thead><tbody>${rows}</tbody></table>
      <p class="note">時間は「リセット（または ⏭）した瞬間」から「そのルートの部屋が最後にチェックされた瞬間」まで。点線は未完了のルート。チップにマウスを乗せると部屋ごとの時間が出ます。</p>`;
  }

  function renderRoutes(res) {
    const ag = C.aggregate(res, { includeIncomplete: ui.includeIncomplete });
    if (!ag.length) return '<div class="empty">集計できるルートがまだありません（完了したルートが必要です）。</div>';
    const byType = {};
    ag.forEach((a) => { (byType[a.mapType] = byType[a.mapType] || []).push(a); });
    return Object.keys(byType).map((mt) => {
      const list = byType[mt];
      const max = Math.max(...list.map((a) => a.max));
      const avgAll = list.reduce((s, a) => s + a.avg, 0) / list.length;
      const rows = list.map((a) => {
        const diff = a.avg - avgAll;
        return `<tr>
          <td>${chip(a.route, '')}</td><td class="mono">${a.rooms}</td><td class="mono">${a.n}</td>
          <td class="mono"><b>${C.fmtSec(a.avg)}</b> <small class="${diff > 0 ? 'slow' : 'fast'}">${diff >= 0 ? '+' : '−'}${C.fmtSec(Math.abs(diff))}</small></td>
          <td class="mono">${C.fmtSec(a.median)}</td><td class="mono">${C.fmtSec(a.min)}</td><td class="mono">${C.fmtSec(a.max)}</td>
          <td class="mono">${C.fmtSec(a.perRoom)}</td>
          <td class="barcell" title="${esc(a.list.map((x) => `${x.floor}F ${C.fmtSec(x.sec)}`).join('\n'))}">
            <div class="bar"><span class="range" style="left:${a.min / max * 100}%;width:${Math.max(1, (a.max - a.min) / max * 100)}%;--c:${colors()[a.route - 1]}"></span><span class="avg" style="left:${a.avg / max * 100}%"></span></div>
          </td></tr>`;
      }).join('');
      return `<h3>${esc(C.MAP_LABEL[mt] || mt)} <small>ルート平均 ${C.fmtSec(avgAll)}</small></h3>
        <table class="tbl"><thead><tr><th>ルート</th><th>部屋数</th><th>回数</th><th>平均（全体比）</th><th>中央</th><th>最速</th><th>最遅</th><th>1部屋</th><th>ばらつき（帯=最速〜最遅、線=平均）</th></tr></thead><tbody>${rows}</tbody></table>`;
    }).join('') + '<p class="note">「全体比」が＋のルートは平均より遅い＝部屋を減らす候補、−のルートは余裕あり＝部屋を足す候補。「途中から」の区間と除外した区間は入りません。</p>';
  }

  function renderRooms(res) {
    const maps = C.roomStats(res);
    if (!maps.length) return '<div class="empty">まだ記録がありません。</div>';
    return maps.map((m) => {
      const vals = Object.values(m.rooms).map((x) => x.avg);
      const max = Math.max(1, ...vals);
      let cells = '';
      for (let row = 10; row >= 1; row--) {
        for (let col = 1; col <= 5; col++) {
          const room = (col - 1) * 10 + row;
          const st = m.rooms[room];
          const rt = m.routeOf[room];
          const heat = st ? 0.12 + 0.78 * (st.avg / max) : 0;
          const border = rt ? `border-color:${colors()[rt - 1]};` : '';
          cells += `<div class="cell${st ? '' : ' none'}" style="--h:${heat.toFixed(2)};${border}" title="${room}番${rt ? '（ルート' + rt + '）' : ''}${st ? `\n平均 ${C.fmtSec(st.avg)} / 最遅 ${C.fmtSec(st.max)} / ${st.n}回` : '\nチェック記録なし'}">
            <span class="no">${room}${rt ? `<i style="background:${colors()[rt - 1]}">${rt}</i>` : ''}</span><b>${st ? C.fmtSec(st.avg) : '—'}</b></div>`;
        }
      }
      return `<div class="roommap"><h3>${esc(m.mapLabel)} <small>${m.floors}階分の平均</small></h3><div class="grid">${cells}</div></div>`;
    }).join('') + '<p class="note">各部屋が「区切り（リセット/⏭）から何秒後にチェックされたか」の平均。色が濃いほど遅い。枠の色は担当ルート。ルート境目の濃い部屋を、近くの早く終わるルートへ渡すと全体が縮みやすいよ。</p>';
  }

  function renderLog() {
    const ss = selectedSessions();
    const evs = [];
    ss.forEach((s) => s.events.forEach((e) => evs.push(e)));
    evs.sort((a, b) => b.t - a.t);
    const name = { S: '計測開始', f: '階の移動', m: 'マップ/ルート変更', M: '⏭ 手動区切り', R: 'リセット', c: 'チェック', u: 'チェック解除', A: '一括チェック' };
    const rows = evs.slice(0, 400).map((e) => {
      let d = '';
      if (e.k === 'c' || e.k === 'u') d = `${e.r}番`;
      else if (e.k === 'f') d = `${e.from}F → ${e.v}F`;
      else if (e.k === 'm') d = C.MAP_LABEL[e.v] || e.v;
      else if (e.k === 'R') d = `${e.n}部屋が外れた`;
      else if (e.k === 'A') d = `${e.rs.length}部屋`;
      else if (e.k === 'S') d = `${e.f}F ${C.MAP_LABEL[e.m] || ''}${e.resume ? '（再開）' : ''}`;
      return `<tr class="ev-${e.k}"><td class="mono">${new Date(e.t).toLocaleTimeString('ja-JP')}</td><td>${name[e.k] || e.k}</td><td>${esc(d)}</td><td class="mono">${e.f != null ? e.f + 'F' : ''}</td></tr>`;
    }).join('');
    return rows ? `<table class="tbl"><thead><tr><th>時刻</th><th>できごと</th><th>内容</th><th>その時の階</th></tr></thead><tbody>${rows}</tbody></table>` : '<div class="empty">記録なし</div>';
  }

  function renderModal() {
    const m = $('#modal');
    if (m.hidden) return;
    const res = results();
    const opts = Object.assign({}, C.DEFAULT_OPTS, store.opts);
    const sessOpts = [`<option value="latest"${ui.sel === 'latest' ? ' selected' : ''}>いちばん新しい計測</option>`, `<option value="all"${ui.sel === 'all' ? ' selected' : ''}>すべての計測をまとめて</option>`]
      .concat(store.sessions.slice().reverse().map((s) => `<option value="${s.id}"${ui.sel === s.id ? ' selected' : ''}>${esc(sessionLabel(s))}</option>`)).join('');
    const single = selectedSessions().length === 1 ? selectedSessions()[0] : null;
    let body = '';
    if (ui.tab === 'floors') body = renderFloors(res);
    else if (ui.tab === 'rooms') body = renderRooms(res);
    else if (ui.tab === 'presets') body = presetHtml();
    else if (ui.tab === 'routes') body = `<label class="inline"><input type="checkbox" data-act="incomplete" ${ui.includeIncomplete ? 'checked' : ''}> 未完了のルートも含める</label>` + renderRoutes(res);
    else body = renderLog();
    m.innerHTML = `<div class="sheet">
      <div class="mhead">
        <b>📊 ファロス計測の分析</b>
        <select data-act="sel">${sessOpts}</select>
        <button class="mini" data-act="opts" title="判定の設定">⚙</button>
        <span class="sp"></span>
        <button class="mini" data-act="close" title="閉じる">✕</button>
      </div>
      ${ui.showOpts ? `<div class="opts">
        <label>リセット直後の端数：<input type="number" min="0" max="20" data-opt="straggleMaxChecks" value="${opts.straggleMaxChecks}">部屋未満 かつ
        <input type="number" min="0" max="600" data-opt="straggleMaxSec" value="${opts.straggleMaxSec}">秒以内に次のリセット → 前の階の分にする</label>
        <label>⏭ を押した後 <input type="number" min="0" max="600" data-opt="markerGraceSec" value="${opts.markerGraceSec}">秒以内のリセットは区切りにしない</label>
        <label>一度に <input type="number" min="2" max="50" data-opt="bulkMinAdded" value="${opts.bulkMinAdded}">部屋以上付いたら一括チェック扱い（時間に数えない）</label>
        <button class="link" data-act="resetopts">初期値に戻す</button>
      </div>` : ''}
      <div class="tabs">
        <button data-tab="floors" class="${ui.tab === 'floors' ? 'on' : ''}">階層ごと</button>
        <button data-tab="routes" class="${ui.tab === 'routes' ? 'on' : ''}">ルート平均</button>
        <button data-tab="rooms" class="${ui.tab === 'rooms' ? 'on' : ''}">部屋マップ</button>
        <button data-tab="presets" class="${ui.tab === 'presets' ? 'on' : ''}">設定の保存</button>
        <button data-tab="log" class="${ui.tab === 'log' ? 'on' : ''}">記録ログ</button>
      </div>
      <div class="mbody">${body}</div>
      <div class="mfoot">
        <button data-act="csv">⬇ CSV（階×ルート）</button>
        <button data-act="export">⬇ JSON書き出し</button>
        <label class="btnlike">⬆ JSON読み込み<input type="file" accept=".json,application/json" data-act="import" hidden></label>
        <span class="sp"></span>
        ${single ? `<button data-act="rename">名前を付ける</button>
        <button data-act="delete" class="${ui.confirmDel ? 'danger' : 'ghost'}">${ui.confirmDel ? 'もう一度押すと削除' : 'この計測を削除'}</button>` : ''}
      </div>
    </div>`;
  }

  function render() { renderPanel(); renderModal(); }

  // ---------- 操作 ----------
  function setOverride(sid, key, patch) {
    const o = store.overrides[sid] = store.overrides[sid] || {};
    const cur = Object.assign({}, o[key] || {}, patch);
    Object.keys(cur).forEach((k) => { if (cur[k] === undefined) delete cur[k]; });
    if (Object.keys(cur).length) o[key] = cur; else delete o[key];
    save(true); render();
  }
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; shadow.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => { const d = new Date(); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

  shadow.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-act],[data-tab]');
    if (!t) return;
    const act = t.dataset.act;
    if (t.dataset.tab) { ui.tab = store.ui.tab = t.dataset.tab; save(); renderModal(); return; }
    switch (act) {
      case 'sanct': store.ui.sanctuary = store.ui.sanctuary === false; save(true); renderPanel(); updateSanctuary(); break;
      case 'collapse': store.ui.collapsed = !store.ui.collapsed; save(); renderPanel(); break;
      case 'start': startSession(); break;
      case 'stop': stopSession(); break;
      case 'marker': marker(); break;
      case 'savepreset': savePreset(); break;
      case 'applypreset': applyPreset(t.dataset.id); break;
      case 'delpreset': store.presets = store.presets.filter((p) => p.id !== t.dataset.id); save(true); renderModal(); break;
      case 'renamepreset': {
        const p = store.presets.find((x) => x.id === t.dataset.id); if (!p) break;
        const n = window.prompt('名前', p.name); if (n != null && n.trim()) { p.name = n.trim(); save(true); renderModal(); }
        break;
      }
      case 'exportpreset': {
        const p = store.presets.find((x) => x.id === t.dataset.id); if (!p) break;
        const cp = JSON.parse(JSON.stringify(p));
        cp.commands.forEach((c) => { c.sheetPass = ''; });   // パスワードは書き出さない
        download(`pharos-preset-${stamp()}.json`, JSON.stringify({ app: 'pharos-analyzer', kind: 'presets', v: 1, presets: [cp] }), 'application/json');
        break;
      }
      case 'bigfloor': store.ui.bigFloor = store.ui.bigFloor === false; save(true); updateBigFloor(); renderPanel(); break;
      case 'open': $('#modal').hidden = false; ui.confirmDel = false; renderModal(); break;
      case 'close': $('#modal').hidden = true; break;
      case 'opts': ui.showOpts = !ui.showOpts; renderModal(); break;
      case 'resetopts': store.opts = {}; save(true); render(); break;
      case 'unmerge': setOverride(t.dataset.sid, t.dataset.key, { mergePrev: false }); break;
      case 'mergeprev': setOverride(t.dataset.sid, t.dataset.key, { mergePrev: true }); break;
      case 'csv': download(`pharos-routes-${stamp()}.csv`, C.toCsv(results()), 'text/csv'); break;
      case 'export': {
        const ss = selectedSessions();
        const ov = {}; ss.forEach((s) => { if (store.overrides[s.id]) ov[s.id] = store.overrides[s.id]; });
        download(`pharos-analyzer-${stamp()}.json`, JSON.stringify({ app: 'pharos-analyzer', v: 1, sessions: ss, overrides: ov }), 'application/json');
        break;
      }
      case 'rename': {
        const s = selectedSessions()[0]; if (!s) break;
        const name = window.prompt('この計測の名前（例: 10/8 金曜ギルド）', s.name || '');
        if (name != null) { s.name = name.trim(); save(true); render(); }
        break;
      }
      case 'delete': {
        if (!ui.confirmDel) { ui.confirmDel = true; renderModal(); break; }
        const s = selectedSessions()[0];
        if (s) {
          if (s.id === store.activeId) stopSession();
          store.sessions = store.sessions.filter((x) => x.id !== s.id);
          delete store.overrides[s.id];
          ui.sel = 'latest'; ui.confirmDel = false; save(true); render(); toast('削除しました');
        }
        break;
      }
      default: break;
    }
  });
  shadow.addEventListener('change', (ev) => {
    const t = ev.target;
    const act = t.dataset.act;
    if (t.dataset.opt) { const n = Number(t.value); if (isFinite(n)) { store.opts[t.dataset.opt] = n; save(true); render(); } return; }
    if (act === 'importpresets' && t.files && t.files[0]) {
      t.files[0].text().then((txt) => {
        const data = JSON.parse(txt);
        if (!data || data.app !== 'pharos-analyzer' || !Array.isArray(data.presets)) throw new Error('設定ファイルではありません');
        let added = 0;
        data.presets.forEach((p) => { if (p && p.routes && Array.isArray(p.commands) && !store.presets.some((x) => x.id === p.id)) { store.presets.push(p); added++; } });
        save(true); render(); toast(`${added}件の設定を読み込みました`);
      }).catch((e) => toast('読み込めませんでした: ' + e.message));
      return;
    }
    if (act === 'sel') { ui.sel = store.ui.sel = t.value; ui.confirmDel = false; save(); renderModal(); }
    else if (act === 'incomplete') { ui.includeIncomplete = t.checked; renderModal(); }
    else if (act === 'exclude') setOverride(t.dataset.sid, t.dataset.key, { exclude: t.checked ? undefined : true });
    else if (act === 'floor') { const n = Number(t.value); setOverride(t.dataset.sid, t.dataset.key, { floor: isFinite(n) && t.value !== '' ? n : undefined }); }
    else if (act === 'import' && t.files && t.files[0]) {
      t.files[0].text().then((txt) => {
        const data = JSON.parse(txt);
        if (!data || data.app !== 'pharos-analyzer' || !Array.isArray(data.sessions)) throw new Error('形式が違います');
        let added = 0;
        data.sessions.forEach((s) => { if (!store.sessions.some((x) => x.id === s.id)) { store.sessions.push(s); added++; } });
        Object.assign(store.overrides, data.overrides || {});
        store.sessions.sort((a, b) => a.startedAt - b.startedAt);
        save(true); render(); toast(`${added}件の計測を読み込みました`);
      }).catch((e) => toast('読み込めませんでした: ' + e.message));
    }
  });
  shadow.addEventListener('input', (ev) => { if (ev.target.dataset.act === 'pname') ui.presetName = ev.target.value; });
  // 入力欄でのキー操作がマップ側のショートカットに流れないように
  ['keydown', 'keyup', 'keypress'].forEach((type) => shadow.addEventListener(type, (e) => e.stopPropagation()));

  // ---------- 聖域担当（参加者リストの該当者をハイライト） ----------
  // 追加の枠は出さず、既存の参加者リストの行に色と「聖域50」を付ける。行には data 属性を足すだけ（Vue は触らない）
  function ensureSanctStyle() {
    if (document.getElementById('pharos-analyzer-sanct-style')) return;
    const st = document.createElement('style');
    st.id = 'pharos-analyzer-sanct-style';
    st.textContent = '[data-pharos-sanct]{background:#ffe94d!important;border-radius:8px;box-shadow:0 0 0 2px #f2b705;padding:2px 6px;margin:1px 0}'
      + '[data-pharos-sanct]::after{content:"聖域" attr(data-pharos-sanct);font-weight:800;font-size:15px;color:#1c2230;margin-left:6px;white-space:nowrap}';
    (document.head || document.documentElement).appendChild(st);
  }
  // 参加者リストの1行 = 「×ボタン・名前・ルート番号ボタン」を持つ d-flex の div
  const entryRows = () => [...document.querySelectorAll('div.d-flex.align-center.mr-1')].filter((el) => el.querySelector('.mdi-close-circle-outline'));
  const rowName = (el) => {
    const nameDiv = el.children[1];
    const t = nameDiv && nameDiv.childNodes[0] ? nameDiv.childNodes[0].textContent : '';
    return t.replace(/\s*\(自分\)\s*$/, '').trim();
  };
  function updateSanctuary() {
    const inf = findView();
    const rows = entryRows();
    const marks = new Map();   // 名前 → 担当する聖域の部屋
    if (inf && store.ui.sanctuary !== false) {
      let groups = [];
      try { groups = C.sanctuaryGroups(inf.commands, inf.entries, C.readState(inf).routes, Number(inf.floor) || 0); } catch (e) { groups = []; }
      groups.filter((g) => g.active !== false).forEach((g) => g.slots.forEach((x) => x.names.forEach((n) => {
        marks.set(n, (marks.get(n) || []).concat(x.room));
      })));
    }
    if (marks.size) ensureSanctStyle();
    rows.forEach((el) => {
      const rooms = marks.get(rowName(el));
      const v = rooms ? rooms.join('/') : null;
      if (v == null) { if (el.hasAttribute('data-pharos-sanct')) el.removeAttribute('data-pharos-sanct'); }
      else if (el.getAttribute('data-pharos-sanct') !== v) el.setAttribute('data-pharos-sanct', v);
    });
  }

  // ---------- 起動 ----------
  function boot() {
    if (!document.body) { setTimeout(boot, 200); return; }
    document.body.appendChild(host);
    shadow.appendChild(big);
    render();
    setInterval(updateBigFloor, 200);
    setInterval(() => { try { updateSanctuary(); } catch (e) { console.warn('[pharos-analyzer]', e); } }, 500);
    // 計測中にページを読み込み直した → 続きから
    const wait = setInterval(() => {
      if (!findView()) return;
      clearInterval(wait);
      if (active() && !recorder) { startPolling(true); toast('計測を再開しました'); }
      render();
    }, 500);
    // 経過時間だけ毎秒書き換える（パネル全体を作り直すとボタンの押し損じが起きるため）
    setInterval(() => {
      shadow.querySelectorAll('[data-live]').forEach((el) => { el.textContent = C.fmtSec((Date.now() - Number(el.dataset.from)) / 1000); });
      if (!!active() !== !!shadow.querySelector('.rec')) renderPanel(); else refreshLag();
    }, 1000);
  }
  window.__pharosAnalyzer = { show() { $('#modal').hidden = false; renderModal(); }, store: () => store, core: C };
  boot();

  function CSS() {
    return `
    :host{all:initial}
    *{box-sizing:border-box;font-family:"Hiragino Kaku Gothic ProN","Meiryo",system-ui,sans-serif}
    button{font:inherit;cursor:pointer;border:1px solid #c9ced8;background:#fff;color:#22262e;border-radius:6px;padding:5px 10px;font-size:12px}
    button:hover{background:#f1f4f9}
    button.primary{background:#2f6fde;border-color:#2f6fde;color:#fff}
    button.primary:hover{background:#2560c6}
    button.ghost{background:transparent}
    button.danger{background:#d64545;border-color:#d64545;color:#fff}
    button.mini{padding:2px 7px;font-size:12px;line-height:1.2}
    button.link{border:0;background:none;color:#2f6fde;padding:0 4px;font-size:11px;text-decoration:underline}
    .mono{font-variant-numeric:tabular-nums}
    .panel{position:fixed;left:12px;bottom:12px;width:250px;background:#fff;color:#22262e;border:1px solid #d5d9e2;border-radius:10px;
      box-shadow:0 6px 24px rgba(20,30,50,.18);padding:10px 12px;font-size:12px}
    .panel.collapsed{width:auto}
    .head{display:flex;align-items:center;gap:6px;margin-bottom:6px}
    .panel.collapsed .head{margin:0}
    .title{font-weight:700;flex:1}
    .muted{color:#6b7280;font-size:11.5px;line-height:1.5}
    .rec{display:flex;align-items:center;gap:6px;font-weight:700;color:#c62828;margin-bottom:4px}
    .dot{width:8px;height:8px;border-radius:50%;background:#e53935;animation:blink 1.2s infinite}
    @keyframes blink{50%{opacity:.25}}
    .kv{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed #eceff4}
    .kv span{color:#6b7280}
    .warn{margin-top:6px;background:#fff6e0;color:#8a5a00;border-radius:6px;padding:4px 6px;font-size:11px}
    .btns{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
    .toast{position:fixed;left:50%;bottom:24px;transform:translate(-50%,20px);background:#22262e;color:#fff;padding:8px 14px;border-radius:8px;
      font-size:13px;opacity:0;pointer-events:none;transition:.2s}
    .toast.on{opacity:1;transform:translate(-50%,0)}
    .modal{position:fixed;inset:0;background:rgba(15,20,30,.45);display:flex;align-items:center;justify-content:center;padding:16px}
    .modal[hidden]{display:none}
    .sheet{background:#fff;color:#22262e;width:min(1100px,100%);max-height:100%;display:flex;flex-direction:column;border-radius:12px;overflow:hidden;font-size:13px}
    .mhead{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid #e5e8ef;flex-wrap:wrap}
    .mhead select{font:inherit;font-size:12px;padding:4px;border:1px solid #c9ced8;border-radius:6px;max-width:100%}
    .sp{flex:1}
    .opts{display:flex;flex-direction:column;gap:6px;padding:8px 14px;background:#f6f8fb;border-bottom:1px solid #e5e8ef;font-size:12px}
    .opts input{width:52px;font:inherit;padding:2px 4px;margin:0 2px}
    .tabs{display:flex;gap:4px;padding:8px 14px 0}
    .tabs button{border-radius:6px 6px 0 0;border-bottom:0;background:#f1f4f9}
    .tabs button.on{background:#fff;font-weight:700;box-shadow:inset 0 2px 0 #2f6fde}
    .mbody{padding:12px 14px;overflow:auto;flex:1;border-top:1px solid #e5e8ef}
    .mfoot{display:flex;gap:6px;padding:10px 14px;border-top:1px solid #e5e8ef;flex-wrap:wrap;align-items:center}
    .btnlike{border:1px solid #c9ced8;border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}
    .tbl{border-collapse:collapse;width:100%}
    .tbl th{font-size:11px;color:#6b7280;font-weight:600;text-align:left;padding:5px 6px;border-bottom:1px solid #e5e8ef;white-space:nowrap}
    .tbl td{padding:5px 6px;border-bottom:1px solid #f0f2f6;vertical-align:top}
    .tbl tr.excluded td{opacity:.4}
    .floor{width:48px;font:inherit;padding:2px 4px}
    .routes{line-height:1.9}
    .chip{display:inline-block;margin:0 4px 2px 0;padding:0 7px 0 0;border-radius:5px;border:1.5px solid var(--c);font-size:12px;white-space:nowrap;
      font-variant-numeric:tabular-nums;background:color-mix(in srgb,var(--c) 16%,#fff)}
    .chip b{display:inline-block;background:var(--c);color:#1c2230;padding:0 5px;margin-right:2px;border-radius:3px 0 0 3px}
    .chip.solo{padding:0;border-width:0}
    .chip.solo b{border-radius:4px}
    .chip.dashed{border-style:dashed;background:#fff}
    .flag{display:inline-block;font-size:10.5px;background:#eef2f8;color:#475066;border-radius:4px;padding:0 5px;margin:0 4px 2px 0}
    .flag.warnf{background:#fff3d6;color:#8a5a00}
    .note{color:#6b7280;font-size:11.5px;margin:10px 0 0}
    .empty{color:#6b7280;padding:28px;text-align:center}
    h3{font-size:14px;margin:14px 0 6px}
    h3:first-of-type{margin-top:4px}
    h3 small{font-weight:400;color:#6b7280;margin-left:6px}
    small.slow{color:#c62828}
    small.fast{color:#2e7d32}
    .barcell{min-width:180px}
    .bar{position:relative;height:12px;background:#f1f4f9;border-radius:6px;margin-top:3px}
    .bar .range{position:absolute;top:2px;height:8px;border-radius:4px;background:var(--c)}
    .bar .avg{position:absolute;top:-1px;width:2px;height:14px;background:#22262e;margin-left:-1px}
    .roommap{display:inline-block;vertical-align:top;margin:0 18px 10px 0}
    .grid{display:grid;grid-template-columns:repeat(5,64px);gap:3px}
    .cell{height:40px;border:2px solid #d5d9e2;border-radius:6px;background:rgba(230,120,30,var(--h));padding:2px 4px;position:relative}
    .cell.none{background:#f6f7f9;color:#9aa1ad}
    .cell .no{font-size:10px;color:#4b5261;display:flex;gap:3px;align-items:center}
    .cell .no i{font-style:normal;font-size:9px;border-radius:3px;padding:0 3px;color:#1c2230}
    .cell b{display:block;font-size:12px;font-variant-numeric:tabular-nums;text-align:right}
    .lag{margin-top:6px;border-top:1px solid #eceff4;padding-top:5px}
    .lagtitle{font-size:10.5px;color:#6b7280;margin-bottom:2px}
    .lagok{font-size:11.5px;color:#2e7d32}
    .lagrow{padding:3px 0;border-bottom:1px dashed #eceff4;font-size:11.5px}
    .lagrow .eta{color:#c62828;font-variant-numeric:tabular-nums}
    .lagrow .rem{color:#6b7280;font-size:10.5px;margin:1px 0}
    .lagrow .cover{font-size:11px;background:#f1f6ff;border-radius:5px;padding:1px 4px;margin-top:2px}
    .lagrow .cover small{color:#6b7280}
    .bigfloor{position:fixed;transform:translate(-50%,-100%);background:rgba(20,30,50,.88);color:#fff;font-weight:800;font-size:56px;line-height:1;
      padding:4px 22px 8px;border-radius:12px;pointer-events:none;font-variant-numeric:tabular-nums;box-shadow:0 4px 16px rgba(0,0,0,.35);letter-spacing:1px}
    .bigfloor.pinned{transform:translate(-50%,0)}
    .bigfloor[hidden]{display:none}
    .presetbar{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
    .presetbar input[type=text]{font:inherit;font-size:12px;padding:5px 8px;border:1px solid #c9ced8;border-radius:6px;min-width:200px}
    .inline{display:inline-flex;align-items:center;gap:4px;font-size:12px;margin-bottom:4px}
    `;
  }
})();

