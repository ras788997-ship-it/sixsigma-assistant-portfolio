/* 六西格玛 AI 助手 · 离线演示页脚本
 * 数据唯一来源：assets/demo-data.js 暴露的 window.SIGMA_DATA（只读）
 * 本文件不写业务数字：页面上的数值要么直接来自 SIGMA_DATA，要么由数据字段推导
 * 检索为纯前端 bigram + IDF + 覆盖率修正，页面不发起任何网络请求、不调用模型
 */
(function (global) {
  'use strict';

  var doc = global.document;
  var D = global.SIGMA_DATA || null;

  var ROUTES = ['overview', 'replay', 'search', 'audit', 'defects', 'boundary'];
  var ROUTE_TITLE = {
    overview: '概览',
    replay: '真实记录回放',
    search: '检索演示',
    audit: '资料审核发现',
    defects: '缺陷与口径',
    boundary: '判断与边界'
  };
  var ROUTE_KICKER = {
    overview: '01 / 概览',
    replay: '02 / 真实记录回放',
    search: '03 / 检索演示',
    audit: '04 / 资料审核发现',
    defects: '05 / 后端缺陷与口径',
    boundary: '06 / 判断与边界'
  };
  var TAG_ORDER = ['self', 'history', 'platform', 'measured', 'warn', 'pass', 'issue'];

  /* ================= 基础工具 ================= */
  var ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC_MAP[c]; });
  }
  function fmt(n) {
    var s = String(n == null ? '' : n);
    if (!/^-?\d+$/.test(s)) { return s; }
    return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function len(arr) { return arr && arr.length ? arr.length : 0; }
  function tagSpan(key, legend) {
    if (!key) { return ''; }
    var text = legend && legend[key] ? legend[key] : '';
    return '<span class="tag tag-' + esc(key) + '" title="' + esc(text) + '">' + esc(key) + '</span>';
  }
  function tagLegend() { return D && D.tagLegend ? D.tagLegend : {}; }
  function evFile(name) {
    var list = (D && D.evidence) || [];
    for (var i = 0; i < list.length; i++) { if (list[i].name === name) { return list[i].file; } }
    return '';
  }
  function kicker(key) { return '<div class="kicker">' + esc(ROUTE_KICKER[key]) + '</div>'; }

  /* ================= S3 检索引擎（纯函数，可单独测试） ================= */
  var SEARCH = (function () {
    var TOP = 3;
    var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
    var ALNUM = /[a-z0-9]/;
    var WS = /[\s\u3000]/;

    /* 归一化：全角转半角、小写、去空白 */
    function normalize(input) {
      var s = String(input == null ? '' : input);
      var out = '';
      for (var i = 0; i < s.length; i++) {
        var c = s.charAt(i);
        var code = c.charCodeAt(0);
        if (code >= 0xFF01 && code <= 0xFF5E) { c = String.fromCharCode(code - 0xFEE0); }
        if (WS.test(c)) { continue; }
        out += c.toLowerCase();
      }
      return out;
    }

    /* 分词：中文按字二元组，英文/数字按词 */
    function tokenize(input) {
      var s = normalize(input);
      var out = [];
      var n = s.length;
      var i = 0;
      while (i < n) {
        var c = s.charAt(i);
        if (CJK.test(c)) {
          var j = i;
          while (j < n && CJK.test(s.charAt(j))) { j++; }
          var run = s.slice(i, j);
          if (run.length === 1) {
            out.push(run);
          } else {
            for (var k = 0; k < run.length - 1; k++) { out.push(run.substr(k, 2)); }
          }
          i = j;
        } else if (ALNUM.test(c)) {
          var m = i;
          while (m < n && ALNUM.test(s.charAt(m))) { m++; }
          out.push(s.slice(i, m));
          i = m;
        } else {
          i++;
        }
      }
      return out;
    }

    function unique(arr) {
      var seen = Object.create(null);
      var out = [];
      arr.forEach(function (x) { if (!seen[x]) { seen[x] = 1; out.push(x); } });
      return out;
    }

    /* 建索引：标题算 2 次、正文算 1 次（字段加权），再统计文档频率 */
    function buildIndex(docs) {
      var TITLE_WEIGHT = 2;
      function bump(tf, text, times) {
        tokenize(text).forEach(function (t) { tf[t] = (tf[t] || 0) + times; });
      }
      var records = docs.map(function (d) {
        var tf = Object.create(null);
        bump(tf, String(d.title), TITLE_WEIGHT);
        bump(tf, String(d.text), 1);
        return { doc: d, tf: tf };
      });
      var df = Object.create(null);
      records.forEach(function (r) {
        Object.keys(r.tf).forEach(function (t) { df[t] = (df[t] || 0) + 1; });
      });
      return { n: docs.length, records: records, df: df };
    }

    function search(idx, q) {
      var qTerms = unique(tokenize(q));
      if (!qTerms.length) { return { hits: [], terms: [] }; }
      var scored = [];
      idx.records.forEach(function (r) {
        var raw = 0;
        var matched = [];
        qTerms.forEach(function (t) {
          var c = r.tf[t] || 0;
          if (c > 0) {
            raw += Math.log(1 + idx.n / (idx.df[t] || idx.n)) * c;
            matched.push(t);
          }
        });
        if (raw > 0) {
          var coverage = matched.length / qTerms.length;
          scored.push({ doc: r.doc, raw: raw * (0.6 + 0.4 * coverage), matched: matched });
        }
      });
      scored.sort(function (a, b) { return b.raw - a.raw; });
      var top = scored.slice(0, TOP);
      var best = top.length ? top[0].raw : 0;
      top.forEach(function (s) { s.score = best > 0 ? Math.round((s.raw / best) * 100) : 0; });
      return { hits: top, terms: qTerms };
    }

    function splitSentences(text) {
      var out = [];
      var buf = '';
      for (var i = 0; i < text.length; i++) {
        var c = text.charAt(i);
        buf += c;
        if (c === '。' || c === '；' || c === '！' || c === '？') { out.push(buf); buf = ''; }
      }
      if (buf) { out.push(buf); }
      return out.length ? out : [text];
    }

    /* 取命中词最多的一句作片段；过长时围绕首个命中词截窗 */
    function makeSnippet(d, qTerms) {
      var text = String(d.text || '');
      var terms = qTerms.filter(function (t) { return t.length >= 2; });
      var sents = splitSentences(text);
      var best = sents[0];
      var bestHit = -1;
      sents.forEach(function (s) {
        var low = s.toLowerCase();
        var c = 0;
        terms.forEach(function (t) { if (low.indexOf(t) >= 0) { c++; } });
        if (c > bestHit) { bestHit = c; best = s; }
      });
      var out = best;
      var MAXLEN = 150;
      if (out.length > MAXLEN) {
        var low2 = out.toLowerCase();
        var at = -1;
        terms.forEach(function (t) {
          var p = low2.indexOf(t);
          if (p >= 0 && (at < 0 || p < at)) { at = p; }
        });
        var start = at > 36 ? at - 36 : 0;
        if (start + MAXLEN > out.length) { start = Math.max(0, out.length - MAXLEN); }
        out = (start > 0 ? '…' : '') + out.substr(start, MAXLEN) + (start + MAXLEN < out.length ? '…' : '');
      }
      return out;
    }

    function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    /* 在已转义的文本里包 <mark>：只高亮长度 ≥ 2 的命中词，长词优先；相邻标记合并 */
    function highlight(escapedText, terms) {
      var list = [];
      (terms || []).forEach(function (t) {
        if (t && t.length >= 2 && list.indexOf(t) < 0) { list.push(t); }
      });
      if (!list.length) { return escapedText; }
      list.sort(function (a, b) { return b.length - a.length; });
      var re = new RegExp('(' + list.map(escRe).join('|') + ')', 'gi');
      return escapedText.replace(re, '<mark>$1</mark>').replace(/<\/mark>(?=<mark>)/g, '');
    }

    function hitHtml(h, i, qTerms) {
      var d = h.doc;
      var snippet = makeSnippet(d, qTerms);
      var chips = h.matched.slice(0, 8).map(function (t) {
        return '<em class="tchip">' + esc(t) + '</em>';
      }).join('');
      return '<article class="hit">' +
        '<div class="hit-head">' +
          '<span class="hit-rank">#' + (i + 1) + '</span>' +
          '<span class="hit-card">' + esc(d.card) + '</span>' +
          '<h4 class="hit-title">' + highlight(esc(d.title), qTerms) + '</h4>' +
          '<span class="hit-score">' + h.score + '</span>' +
        '</div>' +
        '<p class="snippet">' + highlight(esc(snippet), qTerms) + '</p>' +
        '<div class="hit-foot">' +
          '<span class="hit-src">' + esc(d.id) + ' · ' + esc(d.source) + '</span>' +
          (chips ? '<span class="hit-terms">命中 ' + chips + '</span>' : '') +
        '</div>' +
        '<div class="bar"><i style="width:' + h.score + '%"></i></div>' +
      '</article>';
    }

    function noHitHtml() {
      return '<div class="no-hit"><b>没有命中</b>' +
        '<p>这题超出演示语料，正式产品应回答「没有依据」并给出补充路径。</p></div>';
    }

    var indexCache = null;
    function getIndex() {
      if (!indexCache && D && D.searchCorpus) { indexCache = buildIndex(D.searchCorpus); }
      return indexCache;
    }

    function result(q) {
      var idx = getIndex();
      if (!idx) { return { hits: [], terms: [], html: noHitHtml() }; }
      var r = search(idx, q);
      var html = r.hits.length
        ? r.hits.map(function (h, i) { return hitHtml(h, i, r.terms); }).join('')
        : noHitHtml();
      return { hits: r.hits, terms: r.terms, html: html };
    }

    return {
      TOP: TOP,
      normalize: normalize,
      tokenize: tokenize,
      result: result
    };
  })();
  global.SIGMA_SEARCH = SEARCH;

  /* 没有 DOM 时（例如在 Node 里做纯逻辑自检）到此为止 */
  if (!doc || !doc.getElementById || !D) { return; }

  /* ================= 页头 / 页脚 ================= */
  function fillHead() {
    var m = D.meta || {};
    var t = doc.getElementById('siteTitle');
    if (t) { t.textContent = m.title || ''; }
    var p = doc.getElementById('sitePeriod');
    if (p) { p.textContent = m.period || ''; }
    var s = doc.getElementById('siteScope');
    if (s) { s.textContent = m.scope || ''; }
    var meta = doc.getElementById('siteMeta');
    if (meta) {
      meta.innerHTML = '<span>' + esc(m.stack) + '</span>' +
        '<span class="sep">·</span><span>' + esc(m.author) + '</span>';
    }
  }

  function fillFoot() {
    var m = D.meta || {};
    var notice = doc.getElementById('footNotice');
    if (notice) {
      notice.innerHTML = esc(m.repoNotice) + ' · 本页为离线演示，不连接大模型。数据口径见下方图例（数值徽章的含义）。';
    }
    var legend = doc.getElementById('footLegend');
    if (legend && D.tagLegend) {
      legend.innerHTML = TAG_ORDER.map(function (k) {
        return '<span class="leg">' + tagSpan(k, D.tagLegend) +
          '<span>' + esc(D.tagLegend[k]) + '</span></span>';
      }).join('');
    }
  }

  /* ================= S1 概览 ================= */
  function renderOverview() {
    var host = doc.getElementById('mount-overview');
    if (!host) { return; }
    var legend = tagLegend();
    var f = D.funnel || [];
    var maxLevel = 1;
    f.forEach(function (x) { if (x.level > maxLevel) { maxLevel = x.level; } });
    var MIN_W = 40;

    var funnelHtml = f.map(function (x) {
      var w = MIN_W + Math.round((x.level / maxLevel) * (100 - MIN_W));
      return '<li class="frow">' +
        '<div class="fbar" style="--w:' + w + '%">' +
          '<div class="fval"><b>' + esc(x.value) + '</b>' +
            '<span class="funit">' + esc(x.unit) + '</span>' +
            tagSpan(x.tag, legend) + '</div>' +
          '<p class="fnote">' + esc(x.note) + '</p>' +
        '</div></li>';
    }).join('');

    var roleNames = [['me', '我'], ['ai', 'AI 助手'], ['third', '第三方组件与平台']];
    var rolesHtml = roleNames.map(function (pair) {
      var items = (D.role && D.role[pair[0]]) || [];
      return '<div class="role"><h4>' + esc(pair[1]) + '</h4><ul>' +
        items.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
        '</ul></div>';
    }).join('');

    var kpiHtml = (D.kpis || []).map(function (k) {
      var unit = k.unit ? '<span class="kpi-unit">' + esc(k.unit) + '</span>' : '';
      return '<div class="kpi">' +
        '<div class="kpi-val">' + esc(k.value) + unit + '</div>' +
        '<div class="kpi-label">' + esc(k.label) + '</div>' +
        '<p class="kpi-note">' + esc(k.note) + '</p>' +
        tagSpan(k.tag, legend) +
      '</div>';
    }).join('');

    var tlHtml = (D.timeline || []).map(function (t) {
      return '<li class="tl-item">' +
        '<span class="tl-date">' + esc(t.date) + '</span>' +
        '<p class="tl-text">' + esc(t.text) + '</p>' +
      '</li>';
    }).join('');

    var first = f[0] || { value: '', unit: '' };
    var last = f[f.length - 1] || { value: '', unit: '' };
    var claim = esc(first.value) + ' ' + esc(first.unit) + '进来，' +
      esc(last.value) + ' ' + esc(last.unit) + '出去——每一段都保留文件名、标题与原文位置。';

    host.innerHTML =
      kicker('overview') +
      '<h2 id="h-overview">从资料治理到可验收问答</h2>' +
      '<p class="claim">' + claim + '</p>' +
      '<p class="lead">' + esc(D.meta.subtitle) + '</p>' +
      '<div class="ov-grid" style="display:block;width:100%">' +
        '<div class="ov-col side">' +
          '<h3 class="sub-h">分工：谁做了什么</h3>' +
          '<div class="roles" style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px 20px">' + rolesHtml + '</div>' +
        '</div>' +
        '<div class="ov-col">' +
          '<h3 class="sub-h">资料治理漏斗</h3>' +
          '<ol class="funnel">' + funnelHtml + '</ol>' +
        '</div>' +
        '<div class="ov-col">' +
          '<h3 class="sub-h">关键数字</h3>' +
          '<div class="kpis" style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px">' + kpiHtml + '</div>' +
        '</div>' +
      '</div>' +
      '<h3 class="sub-h">时间线</h3>' +
      '<ol class="tl">' + tlHtml + '</ol>' +
      '<p class="footnote">证据：' +
        esc(evFile('资料盘点')) + '；' + esc(evFile('处理统计')) + '；' +
        esc(evFile('OCR 统计')) + '；' + esc(evFile('小程序检查')) +
        '。徽章含义见页脚图例。</p>';
  }

  /* ================= S2 真实记录回放 ================= */
  function renderReplay() {
    var host = doc.getElementById('mount-replay');
    if (!host) { return; }
    var legend = tagLegend();
    var list = D.replay || [];

    var cardsHtml = list.map(function (r) {
      var openAttr = (r.id === 'R1') ? ' open' : '';
      var verdictCls = r.tag === 'pass' ? 'verdict-pass' : 'verdict-issue';
      var basisHtml = (r.basis || []).map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('');
      var srcRows = (r.sources || []).map(function (s) {
        return '<tr><td class="num">' + esc(s.card) + '</td><td>' + esc(s.file) + '</td>' +
          '<td>' + esc(s.location) + '</td><td>' + esc(s.heading) + '</td></tr>';
      }).join('');

      return '<article class="rec">' +
        '<div class="rec-head">' +
          '<div class="rec-idline">' +
            '<span class="rec-id">' + esc(r.id) + '</span>' +
            '<span class="rec-kind">' + esc(r.kind) + '</span>' +
            tagSpan(r.tag, legend) +
          '</div>' +
          '<div class="rec-meta">' +
            '<span>' + esc(r.when) + '</span><span>' + esc(r.env) + '</span>' +
          '</div>' +
        '</div>' +
        '<blockquote class="rec-q"><span class="rec-label">提问</span>' + esc(r.question) + '</blockquote>' +
        '<div class="rec-answer"><span class="rec-label">回答原文</span><p>' + esc(r.conclusion) + '</p></div>' +
        '<details class="rec-more"' + openAttr + '>' +
          '<summary><span>依据与来源</span>' +
            '<span class="sum-meta">' + len(r.basis) + ' 条依据 · ' + len(r.sources) + ' 张卡</span>' +
          '</summary>' +
          '<div class="rec-more-body">' +
            '<ul class="rec-basis">' + basisHtml + '</ul>' +
            '<div class="tbl-wrap"><table class="tbl tbl-src">' +
              '<thead><tr><th>卡号</th><th>文件</th><th>位置</th><th>标题</th></tr></thead>' +
              '<tbody>' + srcRows + '</tbody></table></div>' +
          '</div>' +
        '</details>' +
        '<p class="verdict ' + verdictCls + '">' +
          '<span class="verdict-label">复核结论</span>' +
          '<span class="verdict-text">' + esc(r.verdict) + '</span>' +
        '</p>' +
      '</article>';
    }).join('');

    var boundaryHtml = (D.replayBoundary || []).map(function (b) {
      return '<li>' + esc(b) + '</li>';
    }).join('');

    var claim = '只回放，不现场生成：' + len(list) + ' 条记录里，' +
      esc((list[0] || {}).id) + ' 的数字全对，多出来的那句「正态近似」才是问题。';

    host.innerHTML =
      kicker('replay') +
      '<h2 id="h-replay">' + len(list) + ' 条记录，原样回放</h2>' +
      '<p class="claim">' + claim + '</p>' +
      '<p class="lead">' + esc(D.replayIntro) + '</p>' +
      '<div class="rec-tools">' +
        '<button class="btn" type="button" id="recExpand">全部展开</button>' +
        '<button class="btn" type="button" id="recCollapse">全部收起</button>' +
      '</div>' +
      cardsHtml +
      '<ul class="bd-strip">' + boundaryHtml + '</ul>' +
      '<p class="footnote">边界：' + len(D.replayBoundary) + ' 条记录之外的稳定性未验证。' +
        '证据：' + esc(evFile('接手核对')) + '；' + esc(evFile('校对记录')) + '。</p>';

    var nodes = host.querySelectorAll ? host.querySelectorAll('details.rec-more') : [];
    function setAll(openState) {
      for (var i = 0; i < nodes.length; i++) { nodes[i].open = openState; }
    }
    var btnExpand = doc.getElementById('recExpand');
    var btnCollapse = doc.getElementById('recCollapse');
    if (btnExpand) { btnExpand.addEventListener('click', function () { setAll(true); }); }
    if (btnCollapse) { btnCollapse.addEventListener('click', function () { setAll(false); }); }
  }

  /* ================= S3 检索演示 ================= */
  function runSearch(text) {
    var box = doc.getElementById('hits');
    if (!box) { return; }
    var q = String(text == null ? '' : text).replace(/^\s+|\s+$/g, '');
    if (!q) {
      box.innerHTML = '<p class="hint">输入问题，或点上面的示例问题。</p>';
      return;
    }
    var r = SEARCH.result(q);
    box.innerHTML = r.html;
    var live = doc.getElementById('searchLive');
    if (live) {
      live.textContent = r.hits.length
        ? ('检索完成：返回 ' + r.hits.length + ' 条结果，最高分 ' + r.hits[0].score)
        : '没有命中';
    }
  }

  function renderSearch() {
    var host = doc.getElementById('mount-search');
    if (!host) { return; }
    var examples = D.searchExamples || [];
    var corpusN = len(D.searchCorpus);
    var f = D.funnel || [];
    var last = f[f.length - 1] || { value: '', unit: '' };

    var exHtml = examples.map(function (q) {
      return '<button class="ex-btn" type="button" data-q="' + esc(q) + '">' + esc(q) + '</button>';
    }).join('');

    var bottomLine = '检索结果只来自 ' + corpusN + ' 条演示语料（自拟，非原始培训资料）；' +
      '正式产品的语料是 ' + esc(last.value) + ' ' + esc(last.unit) + '，不随仓库发布。';

    host.innerHTML =
      kicker('search') +
      '<h2 id="h-search">前端检索 + 引用绑定</h2>' +
      '<p class="claim">不接大模型，也能把「问题 → 卡号 → 原文片段」这条链路走完，并让它可复核。</p>' +
      '<p class="lead">' + esc(D.searchNote) + '</p>' +
      '<div class="search-shell">' +
        '<div class="search-badges">' +
          '<span class="badge-strong">本地检索 · 无大模型</span>' +
          '<span class="algo-note">bigram + IDF + 覆盖率修正 · 每次取 top ' + SEARCH.TOP + '</span>' +
        '</div>' +
        '<form class="search-form" id="searchForm" role="search">' +
          '<label class="sr-only" for="searchQ">输入要检索的问题</label>' +
          '<input class="search-input" id="searchQ" type="text" autocomplete="off" ' +
            'placeholder="输入问题，例如：' + esc(examples[0] || '') + '">' +
          '<button class="search-btn" type="submit">检索</button>' +
        '</form>' +
        '<div class="ex-list" id="searchExamples">' +
          '<span class="ex-h">示例问题</span>' + exHtml +
        '</div>' +
        '<p class="sr-only" id="searchLive" aria-live="polite"></p>' +
        '<div class="hits" id="hits"></div>' +
        '<p class="search-line">语料 ' + corpusN + ' 条 · 取 top ' + SEARCH.TOP +
          ' · 分数按最高分归一化到 0–100 · 命中词已高亮</p>' +
        '<p class="search-line">' + bottomLine + '</p>' +
      '</div>' +
      '<p class="footnote">检索完全在前端完成：不请求接口、不调用模型；无命中时按「没有依据」处理。</p>';

    var form = doc.getElementById('searchForm');
    var input = doc.getElementById('searchQ');
    if (form && input) {
      form.addEventListener('submit', function (ev) {
        if (ev && ev.preventDefault) { ev.preventDefault(); }
        runSearch(input.value);
      });
    }
    var quick = doc.getElementById('searchExamples');
    if (quick && quick.addEventListener) {
      quick.addEventListener('click', function (ev) {
        var el = ev ? ev.target : null;
        while (el && el !== quick && !(el.getAttribute && el.getAttribute('data-q') != null)) {
          el = el.parentNode;
        }
        if (!el || !el.getAttribute) { return; }
        var q = el.getAttribute('data-q');
        if (q == null) { return; }
        if (input) { input.value = q; }
        runSearch(q);
      });
    }
    /* 首屏先跑第一条示例，保证直接打开或截图时就有结果 */
    if (input && examples.length) {
      input.value = examples[0];
      runSearch(examples[0]);
    }
  }

  /* ================= S4 资料审核发现 ================= */
  function renderAudit() {
    var host = doc.getElementById('mount-audit');
    if (!host) { return; }
    var fmea = D.fmea || {};
    var summary = fmea.summary || {};

    var errHtml = (D.auditErrors || []).map(function (e) {
      return '<article class="err">' +
        '<div class="err-head"><span class="err-id">' + esc(e.id) + '</span>' +
          '<h4>' + esc(e.title) + '</h4></div>' +
        '<dl class="err-rows">' +
          '<div class="err-row"><dt>发现</dt><dd>' + esc(e.found) + '</dd></div>' +
          '<div class="err-row"><dt>处理</dt><dd>' + esc(e.action) + '</dd></div>' +
        '</dl>' +
        '<p class="err-foot">出处：' + esc(e.where) + '</p>' +
      '</article>';
    }).join('');

    var caseRows = (fmea.cases || []).map(function (c) {
      return '<tr><td>' + esc(c.name) + '</td>' +
        '<td class="num">' + fmt(c.records) + '</td>' +
        '<td>' + esc(c.kind) + '</td>' +
        '<td>' + esc(c.problem) + '</td></tr>';
    }).join('');

    var sumLabels = [
      ['cases', '案例'], ['records', '条记录'], ['issues', '项问题'],
      ['pfmeaRecords', '条 PFMEA 记录'], ['weakEvidence', '处依据不足'], ['quizzes', '道验收题']
    ];
    var sumHtml = sumLabels.map(function (pair) {
      if (summary[pair[0]] == null) { return ''; }
      return '<span class="sum"><b>' + fmt(summary[pair[0]]) + '</b>' + pair[1] + '</span>';
    }).join('');

    var verItems = (D.versionNote && D.versionNote.items) || [];
    var verHtml = verItems.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');

    var ap = D.ap || {};
    var layers = ap.layers || [];
    var side = Math.max(1, Math.round(Math.cbrt(ap.combos || 1)));
    var figsHtml = layers.map(function (d) {
      var cells = '';
      for (var r = 0; r < side; r++) {
        for (var c = 0; c < side; c++) {
          cells += '<i class="apc" title="S' + (r + 1) + ' · O' + (c + 1) + ' · D' + d + '"></i>';
        }
      }
      return '<figure class="ap-fig">' +
        '<figcaption>D = ' + d + '</figcaption>' +
        '<div class="ap-grid" role="img" aria-label="D = ' + d + ' 层的 ' + side + '×' + side + ' 组合示意网格">' +
          cells + '</div></figure>';
    }).join('');

    var maxLayer = layers.length ? layers[layers.length - 1] : side;
    var apCap = '按 D 分 ' + maxLayer + ' 层，共 ' + fmt(ap.combos) + ' 组合，此处取 ' + len(layers) + ' 层示意';

    var apMetrics = [
      { v: fmt(ap.tables), u: '张表', label: 'AP 规则表', note: '逐格求值，不留缺口', tag: 'self' },
      { v: fmt(ap.combos), u: '组合', label: 'S/O/D 全组合', note: '缺口 ' + fmt(ap.gap) + ' · 重叠 ' + fmt(ap.overlap) + ' · 冲突 ' + fmt(ap.conflict), tag: 'self' },
      { v: fmt(ap.formulas), u: '个公式', label: '公式复算', note: '与文件保存结果 ' + fmt(ap.mismatch) + ' 不一致', tag: 'self' }
    ].map(function (m) {
      return '<div class="apm">' +
        '<div class="apm-val">' + esc(m.v) + '<small>' + esc(m.u) + '</small></div>' +
        '<div class="apm-label">' + esc(m.label) + '</div>' +
        '<div class="apm-note">' + esc(m.note) + '</div>' +
        tagSpan(m.tag, tagLegend()) +
      '</div>';
    }).join('');

    var apFacts = '<span>区间端点越界 <b>' + fmt(ap.rangeRows) + '</b> 行（' +
      fmt(ap.rangeTables) + ' 表 × ' + fmt(ap.rangePerTable) + ' 行）</span>';

    var claim = '从 ' + len(D.auditErrors) + ' 处资料错误到 ' + fmt(summary.records) +
      ' 条 FMEA 记录：问题留在资料里，另开一列写校对结论。';

    host.innerHTML =
      kicker('audit') +
      '<h2 id="h-audit">资料里的错，逐条留出处</h2>' +
      '<p class="claim">' + claim + '</p>' +
      '<p class="lead">原答案不改，另开一列写校对结论；供应商的原始记录不被覆盖。</p>' +
      '<div class="err-grid">' + errHtml + '</div>' +
      '<h3 class="sub-h">FMEA 案例审核</h3>' +
      '<div class="tbl-wrap"><table class="tbl tbl-wide">' +
        '<thead><tr><th>案例</th><th>记录数</th><th>问题类型</th><th>具体问题</th></tr></thead>' +
        '<tbody>' + caseRows + '</tbody></table></div>' +
      '<div class="sum-row">' + sumHtml + '</div>' +
      '<p class="footnote">' + esc(fmea.note) + '</p>' +
      '<div class="note-block"><h4>' + esc(D.versionNote.title) + '</h4>' +
        '<ul>' + verHtml + '</ul></div>' +
      '<div class="ap-sec">' +
        '<h3 class="sub-h">AP 规则表核对</h3>' +
        '<div class="ap-metrics">' + apMetrics + '</div>' +
        '<div class="ap-facts">' + apFacts + '</div>' +
        '<div class="ap-figs">' + figsHtml + '</div>' +
        '<p class="ap-axis">行 = S（严重度）· 列 = O（频度）· 每张分图 = 一个 D（探测度）取值</p>' +
        '<p class="ap-cap">' + apCap + '</p>' +
        '<p class="ap-note">' + esc(ap.note) + '</p>' +
      '</div>' +
      '<p class="footnote">证据：' + esc(evFile('AP 核对')) + '；' +
        esc(evFile('AP 复算')) + '；' + esc(evFile('案例审核')) + '。</p>';
  }

  /* ================= S5 后端缺陷与口径 ================= */
  function renderDefects() {
    var host = doc.getElementById('mount-defects');
    if (!host) { return; }
    var defs = D.defects || [];
    var half = Math.ceil(defs.length / 2);

    function defItem(d) {
      return '<li class="def">' +
        '<span class="def-n">' + esc(d.n) + '</span>' +
        '<div><b class="def-b">' + esc(d.title) + '</b>' +
          '<p class="def-d">' + esc(d.detail) + '</p></div>' +
      '</li>';
    }
    var colA = defs.slice(0, half).map(defItem).join('');
    var colB = defs.slice(half).map(defItem).join('');

    var rows = (D.statusMatrix || []).map(function (s) {
      return '<tr>' +
        '<td>' + esc(s.item) + '</td>' +
        '<td>' + esc(s.claimed) + '</td>' +
        '<td><span class="dot dot-' + esc(s.level) + '" aria-hidden="true"></span>' + esc(s.mine) + '</td>' +
      '</tr>';
    }).join('');

    var legend = tagLegend();
    var first = (D.statusMatrix || [])[0] || { item: '' };
    var claim = '「' + esc(first.item) + '」和源码对不上，按 ' + len(defs) + ' 条返工。';

    host.innerHTML =
      kicker('defects') +
      '<h2 id="h-defects">后端缺陷与口径对照</h2>' +
      '<p class="claim">' + claim + '</p>' +
      '<p class="lead">缺陷由 AI 逐条读源码得出；平台方口径与项目内核对结果分开写，能核的写能核，不能核的标不能核。</p>' +
      '<div class="def-grid">' +
        '<ol class="def-col">' + colA + '</ol>' +
        '<ol class="def-col">' + colB + '</ol>' +
      '</div>' +
      '<div class="matrix-wrap">' +
        '<h3 class="sub-h">平台方口径 vs 项目内核对结果</h3>' +
        '<div class="tbl-wrap"><table class="tbl smatrix">' +
          '<thead><tr><th>项目</th><th>平台方口径</th><th>项目内核对结果</th></tr></thead>' +
          '<tbody>' + rows + '</tbody></table></div>' +
        '<p class="legend-inline">' +
          '<span class="dot dot-warn" aria-hidden="true"></span>' + esc(legend.warn) +
          ' ｜ <span class="dot dot-pass" aria-hidden="true"></span>' + esc(legend.pass) +
        '</p>' +
      '</div>' +
      '<p class="footnote">证据：' + esc(evFile('返工清单')) + '；' + esc(evFile('小程序检查')) + '。</p>';
  }

  /* ================= S6 判断与边界 ================= */
  function renderBoundary() {
    var host = doc.getElementById('mount-boundary');
    if (!host) { return; }
    var stop = D.stopReason || {};
    var bd = D.boundary || {};

    var holes = (stop.holes || []).map(function (h) { return '<li>' + esc(h) + '</li>'; }).join('');
    var narrow = (stop.narrow || []).map(function (n) { return '<span class="chip">' + esc(n) + '</span>'; }).join('');

    var groups = [
      { cls: 'g-warn', name: '未验证', items: bd.unverified || [] },
      { cls: 'g-warn', name: '未见证据', items: bd.noEvidence || [] },
      { cls: 'g-next', name: '下一步', items: bd.next || [] }
    ].map(function (g) {
      var items = g.items.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('');
      return '<div class="bgroup ' + g.cls + '">' +
        '<h4>' + esc(g.name) + '<span class="n">' + len(g.items) + ' 项</span></h4>' +
        '<ul>' + items + '</ul></div>';
    }).join('');

    var evRows = (D.evidence || []).map(function (e) {
      return '<tr><td>' + esc(e.name) + '</td>' +
        '<td><span class="mono">' + esc(e.file) + '</span></td>' +
        '<td>' + esc(e.proves) + '</td>' +
        '<td>' + tagSpan(e.tag, tagLegend()) + '</td></tr>';
    }).join('');

    var quote = String(stop.quote || '');
    var claim = quote.split('。')[0] + '。';

    host.innerHTML =
      kicker('boundary') +
      '<h2 id="h-boundary">暂停的判断与边界</h2>' +
      '<p class="claim">' + esc(claim) + '</p>' +
      '<div class="bd-grid">' +
        '<div class="bd-left">' +
          '<blockquote class="bigq"><p>' + esc(quote) + '</p>' +
            '<footer>当时的判断 · <span class="num">' + esc(stop.when) + '</span></footer>' +
          '</blockquote>' +
          '<h3 class="sub-h">列出来的漏洞</h3>' +
          '<ul class="holes">' + holes + '</ul>' +
          '<h3 class="sub-h">收窄到首版的三件事</h3>' +
          '<div class="narrow">' + narrow + '</div>' +
        '</div>' +
        '<div class="bd-right">' + groups + '</div>' +
      '</div>' +
      '<div class="ev-block">' +
        '<h3 class="sub-h">可核查的证据文件</h3>' +
        '<div class="tbl-wrap"><table class="tbl tbl-wide">' +
          '<thead><tr><th>证据</th><th>文件路径</th><th>证明什么</th><th>口径</th></tr></thead>' +
          '<tbody>' + evRows + '</tbody></table></div>' +
        '<p class="footnote">文件不随仓库发布；口径徽章含义见页脚图例。</p>' +
      '</div>';
  }

  /* ================= 对话壳（侧栏 / 消息 / 输入框） ================= */
  /* 每个会话开头显示一句提问，正文作为助手回答放在消息体里 */
  var CHAT_Q = {
    overview: '这个助手从资料到问答，最后做成了什么？',
    replay: '同一道题，为什么前后两次回答不一样？',
    search: '检索是怎么命中、又怎么绑定引用的？',
    audit: '资料本身有哪些错？',
    defects: '平台方说「12/12 通过」，你怎么看？',
    boundary: '哪些还没做到？'
  };
  var CHAT_SUB = {
    overview: '资料治理 → 带来源片段 → 知识卡 → 问答',
    replay: '2026-11-04 · 2026-11-05 两次真实记录',
    search: '纯前端 bigram + IDF，不连接模型',
    audit: '4 处资料错误 · FMEA 29 条记录 · AP 1,000 组合',
    defects: '9 处后端缺陷 · 模拟 vs 真实口径',
    boundary: '未验证 / 未见证据 / 下一步'
  };

  function decorate(name) {
    var host = doc.getElementById('mount-' + name);
    if (!host || host.getAttribute('data-chat') === '1') { return; }
    var inner = host.innerHTML;
    host.innerHTML =
      '<div class="msg msg-user"><div class="bubble">' + esc(CHAT_Q[name] || '') + '</div></div>' +
      '<div class="msg msg-ai">' +
        '<div class="avatar" aria-hidden="true">六</div>' +
        '<div class="msg-body">' + inner +
          '<div class="msg-tools">' +
            '<button class="tool tool-copy" type="button" data-copy="' + esc(name) + '">⧉ 复制回答</button>' +
            '<span class="tool">离线回放 · 不连接模型</span>' +
          '</div>' +
        '</div>' +
      '</div>';
    host.setAttribute('data-chat', '1');
    /* 对话列比原页面窄，主栅格改单列（内联样式优先，避免被内容 CSS 的媒体查询覆盖） */
    var flatten = ['.ov-grid', '.a4-grid', '.d5-grid', '.bd-grid'];
    for (var gi = 0; gi < flatten.length; gi++) {
      var gn = host.querySelectorAll ? host.querySelectorAll(flatten[gi]) : [];
      for (var gj = 0; gj < gn.length; gj++) {
        gn[gj].style.display = 'block';
        gn[gj].style.width = '100%';
      }
    }
    var roleBox = host.querySelector ? host.querySelector('.roles') : null;
    if (roleBox) {
      roleBox.style.display = 'grid';
      roleBox.style.gridTemplateColumns = 'repeat(3, minmax(0, 1fr))';
      roleBox.style.gap = '10px 20px';
    }
    var kpiBox = host.querySelector ? host.querySelector('.kpis') : null;
    if (kpiBox) { kpiBox.style.gridTemplateColumns = 'repeat(2, minmax(0, 1fr))'; }
  }

  function fillChatHead(name) {
    var t = doc.getElementById('chatTitle');
    if (t) { t.textContent = ROUTE_TITLE[name] || ''; }
    var s = doc.getElementById('chatSub');
    if (s) { s.textContent = CHAT_SUB[name] || '离线回放 · 不连接大模型'; }
  }

  function closeDrawer() {
    if (doc.body && doc.body.classList) { doc.body.classList.remove('side-open'); }
    var btn = doc.getElementById('sideToggle');
    if (btn) { btn.setAttribute('aria-expanded', 'false'); }
  }

  function initShell() {
    var toggle = doc.getElementById('sideToggle');
    if (toggle) {
      toggle.addEventListener('click', function () {
        var open = doc.body.classList.toggle('side-open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }, false);
    }
    var scrim = doc.createElement('div');
    scrim.className = 'side-scrim';
    scrim.addEventListener('click', closeDrawer, false);
    if (doc.body && doc.body.appendChild) { doc.body.appendChild(scrim); }

    var newChat = doc.getElementById('newChat');
    if (newChat) {
      newChat.addEventListener('click', function () {
        if (global.location) { global.location.hash = '#/overview'; }
        closeDrawer();
      }, false);
    }

    var conv = doc.querySelectorAll ? doc.querySelectorAll('.tabs a') : [];
    for (var i = 0; i < conv.length; i++) {
      conv[i].addEventListener('click', closeDrawer, false);
    }

    doc.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.getAttribute || t.getAttribute('data-copy') == null) { return; }
      var name = t.getAttribute('data-copy');
      var sec = doc.getElementById('page-' + name);
      var text = sec ? String(sec.textContent || '').replace(/\s+/g, ' ').trim() : '';
      try {
        if (global.navigator && global.navigator.clipboard) {
          global.navigator.clipboard.writeText(text);
        }
      } catch (err) { /* 剪贴板不可用时忽略 */ }
      t.textContent = '✓ 已复制';
      global.setTimeout(function () { t.textContent = '⧉ 复制回答'; }, 1600);
    }, false);

    var form = doc.getElementById('askForm');
    var input = doc.getElementById('askInput');
    var hint = doc.getElementById('askHint');
    if (form) {
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!hint) { return; }
        hint.className = 'composer-hint is-warn';
        hint.textContent = '演示模式：本页不连接后端与模型，不能真的回答。要试检索，请打开左侧「检索是怎么命中的」，在那一页输入。';
        if (input) { input.value = ''; input.blur(); }
        global.setTimeout(function () {
          hint.className = 'composer-hint';
          hint.textContent = '本页是离线回放：不连接后端与模型。想试检索，去左侧「检索是怎么命中的」。';
        }, 4200);
      }, false);
    }
    if (input) {
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          if (form && form.dispatchEvent) { form.dispatchEvent(new global.Event('submit')); }
        }
      }, false);
    }
  }

  /* ================= 路由 ================= */
  var CURRENT = '';
  function currentHash() {
    try {
      return (global.location && global.location.hash) ? String(global.location.hash) : '';
    } catch (e) {
      return '';
    }
  }
  function parseRoute(hash) {
    var m = /^#\/([a-z]+)/.exec(hash || '');
    return m ? m[1] : '';
  }
  function showRoute(name) {
    if (ROUTES.indexOf(name) < 0) { name = ROUTES[0]; }
    ROUTES.forEach(function (r) {
      var sec = doc.getElementById('page-' + r);
      if (!sec) { return; }
      if (r === name) { sec.removeAttribute('hidden'); }
      else { sec.setAttribute('hidden', 'hidden'); }
    });
    var tabs = doc.querySelectorAll ? doc.querySelectorAll('.tabs a') : [];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      if (t.getAttribute('data-route') === name) { t.setAttribute('aria-current', 'page'); }
      else { t.removeAttribute('aria-current'); }
    }
    if (name !== CURRENT && typeof global.scrollTo === 'function') {
      global.scrollTo(0, 0);
    }
    CURRENT = name;
    decorate(name);
    fillChatHead(name);
    closeDrawer();
    if (D.meta && D.meta.title) {
      doc.title = D.meta.title + ' · ' + (ROUTE_TITLE[name] || '') + ' · 离线演示页';
    }
  }
  function onHashChange() {
    var hash = currentHash();
    if (hash && hash.indexOf('#/') !== 0) { return; }
    showRoute(parseRoute(hash));
  }

  function init() {
    fillHead();
    fillFoot();
    renderOverview();
    renderReplay();
    renderSearch();
    renderAudit();
    renderDefects();
    renderBoundary();
    showRoute(parseRoute(currentHash()));
    initShell();
    if (global.addEventListener) { global.addEventListener('hashchange', onHashChange, false); }
  }

  init();
})(typeof window !== 'undefined' ? window : globalThis);
