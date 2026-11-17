// Token Radar dashboard: renders window.RADAR (written by main.ts) with no network.
//
// Views, for screenshots and sharing: ?view=detail&slug=<slug> opens one
// protocol's detail panel; ?view=filter&category=<name> or &watchlist=1
// pre-sets the board filter; ?compare=<slug>,<slug> opens the side-by-side
// comparison. Everything else is driven by the controls.

(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) {
    document.getElementById('rows').innerHTML = '<tr><td colspan="7">No data: run main.ts first; it writes data.js beside this page.</td></tr>';
    return;
  }

  var rows = R.rows;
  var bySlug = {};
  rows.forEach(function (r) { bySlug[r.slug] = r; });

  /** Whole dollars, short: 2757585593 -> $2.76B. */
  function shortUsd(n) {
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return '$' + n;
  }
  /** Whole dollars with commas: 275758559 -> $275,758,559. */
  function fullUsd(n) {
    return '$' + String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /** The 7-day change as +5.6% / -8.3% / n/a. */
  function changeText(v) {
    if (v === null || v === undefined) return 'n/a';
    return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
  }
  /** Age in days as 1.4y / 8mo / 12d. */
  function ageText(d) {
    if (d >= 365) return (d / 365).toFixed(1) + 'y';
    if (d >= 30) return Math.round(d / 30) + 'mo';
    return d + 'd';
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ---- header stats -------------------------------------------------------
  var m = R.meta;
  document.getElementById('meta').innerHTML =
    '<span class="chip">snapshot <b>' + esc(m.as_of) + '</b></span>' +
    '<span class="chip">protocols <b>' + m.protocols_total + '</b></span>' +
    '<span class="chip">pre-token <b>' + m.pretoken_total + '</b></span>' +
    '<span class="chip">ranked <b>' + m.board_rows + '</b></span>' +
    '<span class="chip">watchlist <b>' + m.watchlist_total + '</b></span>';
  document.getElementById('asof').textContent = m.as_of;

  // ---- controls -----------------------------------------------------------
  var cats = [];
  var chains = [];
  rows.forEach(function (r) {
    if (r.category && cats.indexOf(r.category) < 0) cats.push(r.category);
    r.chains.forEach(function (c) { if (chains.indexOf(c) < 0) chains.push(c); });
  });
  cats.sort();
  chains.sort();
  var catSel = document.getElementById('cat');
  cats.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    catSel.appendChild(o);
  });
  var chainSel = document.getElementById('chain');
  chains.forEach(function (c) {
    var o = document.createElement('option');
    o.value = c; o.textContent = c;
    chainSel.appendChild(o);
  });

  var state = { q: '', cat: '', chain: '', wl: false, sort: 'implied', dir: -1, selected: null, compare: [] };

  // ---- calibration table ----------------------------------------------------
  (function renderCalibration() {
    var c = R.calibration;
    var big = c.multiples.filter(function (m) { return m.eligible >= 2; });
    var small = c.multiples.filter(function (m) { return m.eligible < 2; });
    var html = big.map(function (m) {
      return '<tr><td class="name"><b>' + esc(m.category) + '</b></td><td class="num">' + m.eligible + '</td><td class="num">' + m.live_n + '</td><td class="num">' + (m.live_median === null ? '—' : '×' + m.live_median.toFixed(2)) + '</td><td class="num"><b>×' + m.multiple.toFixed(2) + '</b></td></tr>';
    }).join('');
    if (small.length) {
      html += '<tr><td class="name"><b>' + small.length + ' smaller categories</b><span>one ranked protocol each — too thin to calibrate, so they take the global median</span></td><td class="num">' + small.length + '</td><td class="num">—</td><td class="num">—</td><td class="num"><b>×' + c.global_median.toFixed(2) + '</b></td></tr>';
    }
    document.getElementById('calibration-rows').innerHTML = html;
  })();

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = rows.filter(function (r) {
      if (state.wl && !r.watchlist) return false;
      if (state.cat && r.category !== state.cat) return false;
      if (state.chain && r.chains.indexOf(state.chain) < 0) return false;
      if (q && r.name.toLowerCase().indexOf(q) < 0 && r.slug.indexOf(q) < 0) return false;
      return true;
    });
    var key = state.sort;
    var dir = state.dir;
    list.sort(function (a, b) {
      var av = key === 'tvl' ? a.tvl_usd : key === 'growth' ? (a.change_7d === null ? -1e9 : a.change_7d) : key === 'age' ? a.age_days : a.implied_value_usd;
      var bv = key === 'tvl' ? b.tvl_usd : key === 'growth' ? (b.change_7d === null ? -1e9 : b.change_7d) : key === 'age' ? b.age_days : b.implied_value_usd;
      return (av < bv ? 1 : av > bv ? -1 : a.slug < b.slug ? -1 : 1) * (dir < 0 ? 1 : -1);
    });
    // Rank order is the model's claim; re-sorting by another key shows that
    // column's order, and the rank column keeps the model's own rank.
    return list;
  }

  function renderBoard() {
    var list = filtered();
    var tb = document.getElementById('rows');
    tb.innerHTML = list.map(function (r) {
      var chg = r.change_7d === null ? '<span>n/a</span>' : '<span class="' + (r.change_7d >= 0 ? 'up' : 'down') + '">' + changeText(r.change_7d) + '</span>';
      var first = r.farm_steps[0] ? esc(r.farm_steps[0].action) : '';
      var f = r.factors;
      var factorLine = '×' + f.multiple.toFixed(2) + ' · g' + f.growth.toFixed(2) + ' · a' + f.age.toFixed(2) + ' · c' + f.chains.toFixed(2);
      var checked = state.compare.indexOf(r.slug) >= 0 ? ' checked' : '';
      return '<tr data-slug="' + esc(r.slug) + '"' + (state.selected === r.slug ? ' class="sel"' : '') + '>' +
        '<td class="num"><label class="cmp"><input type="checkbox" data-cmp="' + esc(r.slug) + '"' + checked + ' aria-label="Compare ' + esc(r.name) + '">' + r.rank + '</label></td>' +
        '<td class="name"><b>' + esc(r.name) + (r.watchlist ? '<span class="badge">WATCHLIST</span>' : '') + '</b><span>' + esc(r.slug) + ' · ' + esc(r.category || 'uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ')) + (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</span></td>' +
        '<td class="num">' + shortUsd(r.tvl_usd) + '</td>' +
        '<td class="num">' + chg + '</td>' +
        '<td class="num">' + ageText(r.age_days) + '</td>' +
        '<td class="num">' + shortUsd(r.implied_value_usd) + '<span class="factors-line">' + factorLine + '</span></td>' +
        '<td style="white-space:normal;min-width:280px">' + first + '</td></tr>';
    }).join('');
    document.getElementById('count').textContent = list.length + ' of ' + rows.length + ' protocols';
    document.getElementById('board-title').textContent = 'The board' + (state.sort === 'implied' ? ' — ranked by implied value' : ' — sorted by ' + state.sort);
  }

  // ---- compare --------------------------------------------------------------
  function renderCompare() {
    var el = document.getElementById('compare');
    var pair = state.compare.map(function (s) { return bySlug[s]; }).filter(Boolean);
    if (pair.length !== 2) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    var a = pair[0], b = pair[1];
    document.getElementById('compare-sub').textContent = a.name + ' vs ' + b.name;
    function card(r, other) {
      var f = r.factors;
      var gap = r.implied_value_usd - other.implied_value_usd;
      return '<div class="cmp-card"><h3>#' + r.rank + ' ' + esc(r.name) + (r.watchlist ? ' <span class="badge">WATCHLIST</span>' : '') + '</h3>' +
        '<p class="cmp-implied">' + fullUsd(r.implied_value_usd) + '<small>' + (gap >= 0 ? '+' : '−') + shortUsd(Math.abs(gap)).slice(1) + ' vs the other</small></p>' +
        '<dl class="cmp-facts">' +
        '<div><dt>TVL</dt><dd>' + fullUsd(r.tvl_usd) + '</dd></div>' +
        '<div><dt>Multiple</dt><dd>×' + f.multiple.toFixed(2) + ' <small>' + esc(r.category || 'uncategorised') + '</small></dd></div>' +
        '<div><dt>7-day growth</dt><dd>' + changeText(r.change_7d) + ' <small>×' + f.growth.toFixed(2) + '</small></dd></div>' +
        '<div><dt>Age</dt><dd>' + ageText(r.age_days) + ' <small>×' + f.age.toFixed(2) + '</small></dd></div>' +
        '<div><dt>Chains</dt><dd>' + r.chains.length + ' <small>×' + f.chains.toFixed(2) + '</small></dd></div>' +
        '</dl>' +
        '<p class="cmp-first"><b>Farm first:</b> ' + esc(r.farm_steps[0] ? r.farm_steps[0].action : '') + '</p></div>';
    }
    document.getElementById('compare-grid').innerHTML = card(a, b) + card(b, a);
  }
  document.getElementById('compare-clear').addEventListener('click', function () {
    state.compare = [];
    renderBoard();
    renderCompare();
  });

  // ---- detail -------------------------------------------------------------
  function renderDetail() {
    var el = document.getElementById('detail');
    var r = state.selected ? bySlug[state.selected] : null;
    if (!r) {
      el.innerHTML = '<p class="placeholder">Select a protocol below to see its full model breakdown and farm plan.</p>';
      return;
    }
    var f = r.factors;
    var base = r.tvl_usd * f.multiple;
    el.innerHTML =
      '<h2>' + esc(r.name) + ' <span class="sub">' + esc(r.slug) + ' · rank #' + r.rank + (r.watchlist ? ' · watchlist' : '') + ' · ' + esc(r.category || 'uncategorised') + ' · ' + esc(r.chains.join(', ')) + '</span></h2>' +
      '<dl class="math">' +
      '<div><dt>TVL</dt><dd>' + fullUsd(r.tvl_usd) + '<small>base × ' + f.multiple.toFixed(2) + ' = ' + shortUsd(base) + '</small></dd></div>' +
      '<div><dt>Multiple ×' + f.multiple.toFixed(2) + '</dt><dd>' + esc(r.category || 'uncategorised') + '<small>median live mcap / TVL in this category, shrunk to the global 0.17</small></dd></div>' +
      '<div><dt>Growth ×' + f.growth.toFixed(3) + '</dt><dd>' + changeText(r.change_7d) + ' / 7d<small>1 + 0.5 · tanh(change ÷ 40)</small></dd></div>' +
      '<div><dt>Age ×' + f.age.toFixed(3) + '</dt><dd>' + ageText(r.age_days) + ' listed<small>0.70 + 0.30 · (1 − e^(−days/365))</small></dd></div>' +
      '<div><dt>Chains ×' + f.chains.toFixed(2) + '</dt><dd>' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + '<small>+0.04 per extra chain, max five</small></dd></div>' +
      '<div><dt>Implied value</dt><dd>' + fullUsd(r.implied_value_usd) + '<small>the board\'s claim for this token</small></dd></div>' +
      '</dl>' +
      '<h2>Farm plan</h2>' +
      '<ol class="steps">' + r.farm_steps.map(function (s) {
        return '<li>' + esc(s.action) + '<span class="meta-line">Cost: ' + esc(s.cost) + ' · Time: ' + esc(s.time) + '</span></li>';
      }).join('') + '</ol>';
  }

  // ---- live + set aside ---------------------------------------------------
  document.getElementById('live-rows').innerHTML = R.live.map(function (p) {
    return '<tr><td class="name"><b>' + esc(p.name) + '</b><span>' + esc(p.slug) + (p.symbol ? ' · ' + esc(p.symbol) : '') + '</span></td><td>' + esc(p.category || '—') + '</td><td class="num">' + shortUsd(p.mcap_usd) + '</td></tr>';
  }).join('');

  var reasons = {};
  R.set_aside.forEach(function (p) {
    reasons[p.reason] = (reasons[p.reason] || 0) + 1;
  });
  var reasonText = Object.keys(reasons).sort().map(function (k) { return reasons[k] + ' ' + k; }).join(', ');
  document.getElementById('aside-note').textContent =
    R.meta.set_aside_total + ' pre-token protocols were set aside rather than ranked (' + reasonText + '). They are exchanges, bridges and wrapped or staked products — not launches waiting to happen. First ' + Math.min(40, R.set_aside.length) + ' by slug:';
  document.getElementById('aside-list').innerHTML = R.set_aside.slice(0, 40).map(function (p) {
    return '<li><b>' + esc(p.name) + '</b> <span>' + esc(p.slug) + ' — ' + esc(p.reason) + '</span></li>';
  }).join('');

  // ---- wiring -------------------------------------------------------------
  document.getElementById('q').addEventListener('input', function (e) { state.q = e.target.value; renderBoard(); });
  document.getElementById('cat').addEventListener('change', function (e) { state.cat = e.target.value; renderBoard(); });
  document.getElementById('chain').addEventListener('change', function (e) { state.chain = e.target.value; renderBoard(); });
  document.getElementById('wl').addEventListener('change', function (e) { state.wl = e.target.checked; renderBoard(); });
  document.getElementById('sort').addEventListener('change', function (e) {
    state.sort = e.target.value; state.dir = -1; renderBoard();
  });
  document.querySelectorAll('#board th[data-k]').forEach(function (th) {
    th.addEventListener('click', function () {
      var k = th.getAttribute('data-k');
      var map = { rank: 'implied', name: 'implied', tvl: 'tvl', growth: 'growth', age: 'age', implied: 'implied' };
      var key = map[k] || 'implied';
      if (state.sort === key) { state.dir = -state.dir; } else { state.sort = key; state.dir = -1; }
      document.getElementById('sort').value = state.sort;
      renderBoard();
    });
  });
  document.getElementById('rows').addEventListener('click', function (e) {
    var box = e.target.closest('input[data-cmp]');
    if (box) {
      var slug = box.getAttribute('data-cmp');
      var at = state.compare.indexOf(slug);
      if (box.checked && at < 0) {
        state.compare.push(slug);
        if (state.compare.length > 2) state.compare.shift();
      } else if (!box.checked && at >= 0) {
        state.compare.splice(at, 1);
      }
      renderBoard();
      renderCompare();
      return;
    }
    var tr = e.target.closest('tr[data-slug]');
    if (!tr) return;
    state.selected = tr.getAttribute('data-slug');
    renderBoard();
    renderDetail();
    document.getElementById('detail').scrollIntoView({ block: 'nearest' });
  });

  // ---- deep links (?view=detail&slug=… / ?view=filter&category=… / &watchlist=1 / ?compare=a,b)
  var params = new URLSearchParams(window.location.search);
  if (params.get('category')) {
    state.cat = params.get('category');
    document.getElementById('cat').value = state.cat;
  }
  if (params.get('watchlist') === '1') {
    state.wl = true;
    document.getElementById('wl').checked = true;
  }
  if (params.get('compare')) {
    state.compare = params.get('compare').split(',').filter(function (s) { return bySlug[s]; }).slice(0, 2);
  }
  renderBoard();
  renderCompare();
  if (params.get('view') === 'detail' && params.get('slug') && bySlug[params.get('slug')]) {
    state.selected = params.get('slug');
    renderBoard();
    renderDetail();
  } else {
    renderDetail();
  }
})();
