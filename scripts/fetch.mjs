import { fileURLToPath } from "node:url";
/**
 * A股指标监测 · 数据管道
 *
 * 指标 1  TRIN      = (上涨家数 / (平盘家数 + 下跌家数)) ÷ (上涨股成交额 / 下跌股成交额)
 * 指标 2  MCL       = 麦克莱伦振荡指标 = EMA19(涨跌家数差) − EMA39(涨跌家数差)
 * 指标 3  PCR       = 沪深300股指期权 认沽成交量 ÷ 认购成交量（另附持仓量口径）
 * 指标 4  ETF占比    = 四只头部沪深300ETF 净资产合计 ÷ 沪深300 流通市值
 * 指标 5  股债利差   = 沪深300 盈利收益率(1/PE) − 10年期国债收益率
 *
 * 用法：
 *   node scripts/fetch.mjs          全量：回补 TRIN / PCR 历史（首次约 8 分钟）
 *   node scripts/fetch.mjs --daily  日常：只补最新一天（约 20 秒，供 16:00 定时任务调用）
 *
 * 数据源（公开免费接口，2026-10 实测可用）
 *   全A快照   新浪 hs_a 节点          含涨跌幅/成交额/流通市值
 *   个股日线  腾讯 newfqkline          含成交额（万元），用于 TRIN 回补
 *   期权行情  中金所 日行情 CSV        含成交量与持仓量，用于 PCR
 *   指数估值  中证指数官网 perf         含收盘价与 PE
 *   国债收益率 东财 datacenter          RPTA_WEB_TREASURYYIELD
 *   基金规模  东财 fundf10 gmbd         季度披露的份额与净资产
 *   成分股    新浪 hs300 节点           沪深300 成分与流通市值
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = path.join(ROOT, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const DAILY = process.argv.includes("--daily");
const RECALC = process.argv.includes("--recalc"); // 不重抓个股，仅用已存底表重算 TRIN/MCL
const MIN_STOCKS = 2000; // 单日参与统计的个股少于此数视为覆盖不全（停牌股稀疏 K 线会拖出早期空洞）
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LOG_FILE = path.join(DATA_DIR, "update.log");
const log = (...a) => {
  const line = new Date().toISOString().slice(11, 19) + " " + a.join(" ");
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n", "utf8"); } catch {}
};

const ETF_LIST = [
  { code: "510300", name: "华泰柏瑞", secid: "1.510300" },
  { code: "510330", name: "华夏", secid: "1.510330" },
  { code: "159919", name: "嘉实", secid: "0.159919" },
  { code: "510310", name: "易方达", secid: "1.510310" },
];

const PCR_START = "2020-01-02"; // 沪深300股指期权 2019-12 上市
const HO_START = "2022-12-19"; // 上证50股指期权 2022-12 上市

/* ------------------------------------------------------------------ 工具 */

async function http(url, referer, asJson = true, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer } });
      if (!res.ok) throw new Error("http " + res.status);
      const text = await res.text();
      if (!asJson) return text;
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      await sleep(280 * (i + 1));
    }
  }
  throw lastErr;
}

async function httpGbk(url, referer, retry = 2) {
  let lastErr;
  for (let i = 0; i <= retry; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Referer: referer } });
      if (!res.ok) throw new Error("http " + res.status);
      const buf = Buffer.from(await res.arrayBuffer());
      return new TextDecoder("gbk").decode(buf);
    } catch (e) {
      lastErr = e;
      await sleep(280 * (i + 1));
    }
  }
  throw lastErr;
}

async function pMap(items, fn, conc = 10) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(conc, items.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const compact = (d) => ymd(d).replace(/-/g, "");
const num = (v) => (v === "-" || v === "" || v == null ? NaN : Number(String(v).replace(/,/g, "")));

/* ------------------------------------------------- 全A快照（当日 TRIN） */

async function fetchSnapshot() {
  // 新浪全A节点：分页 100 条/页，含涨跌幅、成交额、流通市值，稳定性优于东财 clist
  const rows = [];
  for (let page = 1; page <= 70; page++) {
    const part = await http(
      `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`,
      "http://finance.sina.com.cn/"
    );
    if (!Array.isArray(part) || part.length === 0) break;
    rows.push(...part);
    if (part.length < 100) break;
    await sleep(80);
  }
  return rows
    .map((r) => {
      const sym = String(r.symbol || "");
      return {
        code: String(r.code),
        market: sym.startsWith("sh") ? 1 : 0,
        symbol: sym,
        name: r.name,
        price: Number(r.trade),
        pct: Number(r.changepercent),
        amount: Number(r.amount), // 元
        floatCap: Number(r.nmc) * 1e4, // 万元 -> 元
      };
    })
    // 剔除北交所（30% 涨跌幅、流动性结构与主板差异过大）
    .filter((r) => r.symbol && !r.symbol.startsWith("bj"))
    .filter((r) => r.code && isFinite(r.pct) && isFinite(r.amount) && r.amount > 0);
}

/** 涨跌家数差（MCL 用） */
function adOf(rows) {
  let up = 0, down = 0, flat = 0;
  for (const r of rows) {
    if (r.pct > 0) up++;
    else if (r.pct < 0) down++;
    else flat++;
  }
  return { up, down, flat, ad: up - down };
}

/**
 * TRIN：（上涨家数 / (平盘家数 + 下跌家数)） ÷ （上涨成交额 / 下跌成交额）
 * 平盘计入分母，与「涨跌比」的分母口径一致
 */
function breadthOf(rows) {
  let up = 0, down = 0, flat = 0, upAmt = 0, downAmt = 0;
  for (const r of rows) {
    if (r.pct > 0) { up++; upAmt += r.amount; }
    else if (r.pct < 0) { down++; downAmt += r.amount; }
    else { flat++; }
  }
  const trin = upAmt > 0 && downAmt > 0 && flat + down > 0
    ? up / (flat + down) / (upAmt / downAmt)
    : NaN;
  return {
    up, down, flat,
    upAmt, downAmt,
    trin,
    adr: flat + down > 0 ? up / (flat + down) : NaN,
    upAmtShare: upAmt + downAmt > 0 ? (upAmt / (upAmt + downAmt)) * 100 : NaN,
  };
}

/* --------------------------------------- TRIN 历史回补（腾讯个股日线） */

async function klinePage(sym, end) {
  const url =
    `http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,,${end || ""},750,qfq`;
  const j = await http(url, "http://gu.qq.com/");
  const node = j?.data?.[sym];
  return node?.qfqday || node?.day || [];
}

/** 单次接口上限 750 根，用结束日期向前翻页，最多 2 段（约 6 年） */
async function klineHistory(sym) {
  const pages = [];
  let end = "";
  for (let k = 0; k < 2; k++) {
    const rows = await klinePage(sym, end);
    if (!rows.length) break;
    pages.unshift(rows);
    const first = String(rows[0][0]).slice(0, 10);
    if (first <= "2020-01-01") break;
    const d = new Date(first);
    d.setDate(d.getDate() - 1);
    end = ymd(d);
  }
  return pages.flat();
}

/** 涨跌幅限制：双创 20%，主板 10%（北交所已在样本外） */
function limitOf(sym) {
  const c = String(sym).slice(2);
  return /^(688|689|300|301)/.test(c) ? 0.2 : 0.1;
}

async function backfillTrin(universe) {
  log(`回补涨跌家数：${universe.length} 只个股日线…`);
  const agg = new Map();
  const cache = {};
  let done = 0, failed = 0;

  const bucket = (d) => {
    let b = agg.get(d);
    if (!b) {
      b = { d, up: 0, down: 0, flat: 0, upAmt: 0, downAmt: 0,
            a20: 0, n20: 0, a60: 0, n60: 0, a250: 0, n250: 0, lu: 0, ld: 0 };
      agg.set(d, b);
    }
    return b;
  };

  await pMap(universe, async (s) => {
    const sym = (s.market === 1 ? "sh" : "sz") + s.code;
    try {
      const rows = await klineHistory(sym);
      const closes = [], dates = [], volts = [], amts = [];
      for (const r of rows) {
        const c = Number(r[2]);
        if (!isFinite(c) || c <= 0) continue;
        closes.push(c);
        dates.push(String(r[0]).slice(0, 10));
        volts.push(Number(r[5]) || 0);
        amts.push(Number(r[8]) || 0); // 万元
      }

      const lim = limitOf(sym);
      let s20 = 0, s60 = 0, s250 = 0;

      for (let i = 0; i < closes.length; i++) {
        const c = closes[i];
        s20 += c; if (i >= 20) s20 -= closes[i - 20];
        s60 += c; if (i >= 60) s60 -= closes[i - 60];
        s250 += c; if (i >= 250) s250 -= closes[i - 250];

        // 上市不足 60 个交易日的新股、停牌日均不参与统计
        if (i < 60 || volts[i] <= 0) continue;

        const pct = c / closes[i - 1] - 1;
        const b = bucket(dates[i]);
        if (pct > 0) { b.up++; b.upAmt += amts[i]; }
        else if (pct < 0) { b.down++; b.downAmt += amts[i]; }
        else { b.flat++; }

        if (i >= 19) { b.n20++; if (c > s20 / 20) b.a20++; }
        if (i >= 59) { b.n60++; if (c > s60 / 60) b.a60++; }
        if (i >= 249) { b.n250++; if (c > s250 / 250) b.a250++; }

        if (pct >= lim - 0.002) b.lu++;
        else if (pct <= -(lim - 0.002)) b.ld++;
      }

      cache[sym] = { d: dates[dates.length - 1], c: closes.slice(-250).map((v) => Math.round(v * 1000) / 1000) };
      done++;
    } catch {
      failed++;
    }
    if (done % 500 === 0) log(`  …${done}/${universe.length}（失败 ${failed}）`);
  }, 10);

  const breadth = [...agg.values()].sort((a, b) => a.d.localeCompare(b.d));
  log(`回补完成：${breadth.length} 个交易日，失败 ${failed} 只`);
  return { breadth, cache };
}

/**
 * 用收盘快照 + 均线缓存补齐当日一行（日常增量走这里，避免重抓 5000 只个股）
 * 均线含当日收盘价，与「站上 n 日均线」的常规口径一致
 */
function todayFromCache(universe, cache, todayStr) {
  const b = { up: 0, down: 0, flat: 0, upAmt: 0, downAmt: 0,
              a20: 0, n20: 0, a60: 0, n60: 0, a250: 0, n250: 0, lu: 0, ld: 0 };

  for (const r of universe) {
    const sym = r.symbol;
    let entry = cache[sym];
    // 兼容早期的纯数组格式（该版本缓存刚好是当日收盘为止）
    if (Array.isArray(entry)) entry = { d: todayStr, c: entry };
    const hist = entry && entry.c ? entry.c : [];
    const hasToday = !!entry && entry.d === todayStr;
    const close = r.price;
    if (!isFinite(close) || close <= 0) continue;

    if (r.pct > 0) { b.up++; b.upAmt += r.amount; }
    else if (r.pct < 0) { b.down++; b.downAmt += r.amount; }
    else { b.flat++; }

    // n 日均线含当日收盘价：缓存未含当日时，用「最近 n-1 根 + 当日」合成
    const maN = (n) => {
      if (hasToday) {
        if (hist.length < n) return NaN;
        let s = 0;
        for (let i = hist.length - n; i < hist.length; i++) s += hist[i];
        return s / n;
      }
      if (hist.length < n - 1) return NaN;
      let s = close;
      for (let i = hist.length - (n - 1); i < hist.length; i++) s += hist[i];
      return s / n;
    };

    const m20 = maN(20), m60 = maN(60), m250 = maN(250);
    if (isFinite(m20)) { b.n20++; if (close > m20) b.a20++; }
    if (isFinite(m60)) { b.n60++; if (close > m60) b.a60++; }
    if (isFinite(m250)) { b.n250++; if (close > m250) b.a250++; }

    const lim = limitOf(sym);
    const p = r.pct / 100;
    if (p >= lim - 0.002) b.lu++;
    else if (p <= -(lim - 0.002)) b.ld++;

    if (!hasToday) {
      hist.push(Math.round(close * 1000) / 1000);
      if (hist.length > 250) hist.shift();
    }
    cache[sym] = { d: todayStr, c: hist };
  }
  return b;
}

/** 剔除覆盖不全的早期日期：这些天空洞会让 MCL 的 EMA39 严重失真 */
function cleanBreadth(rows) {
  const kept = rows.filter((b) => (b.up + b.down + b.flat) >= MIN_STOCKS);
  if (kept.length !== rows.length) log(`覆盖度过滤：${rows.length} → ${kept.length} 个交易日（剔除 ${rows.length - kept.length} 天）`);
  return kept;
}

/* ------------------------------------------------ MCL（麦克莱伦振荡指标） */

function ema(values, n) {
  const k = 2 / (n + 1);
  const out = new Array(values.length).fill(null);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!isFinite(v)) { out[i] = prev; continue; }
    prev = prev === null ? v : v * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function computeMcl(breadth) {
  const ad = breadth.map((b) => b.up - b.down);
  const e19 = ema(ad, 19);
  const e39 = ema(ad, 39);
  const mcl = ad.map((_, i) => (isFinite(e19[i]) && isFinite(e39[i]) ? e19[i] - e39[i] : NaN));
  // 累积指标（McClellan Summation）用于看中期方向
  let sum = 0;
  const summ = mcl.map((v) => { if (isFinite(v)) sum += v; return sum; });
  // 前 39 个交易日 EMA 尚未收敛，丢弃
  const out = [];
  for (let i = 0; i < breadth.length; i++) {
    if (i < 39 || !isFinite(mcl[i])) continue;
    out.push({ d: breadth[i].d, ad: breadth[i].up - breadth[i].down, mcl: +mcl[i].toFixed(2), sum: Math.round(summ[i]) });
  }
  return out;
}

/* ------------------------------------------- PCR（沪深300股指期权） */

function cffexUrl(dateStr) {
  const [y, m, d] = dateStr.split("-");
  return `http://www.cffex.com.cn/sj/hqsj/rtj/${y}${m}/${d}/${y}${m}${d}_1.csv`;
}

async function fetchPcrDay(dateStr) {
  let txt;
  try {
    txt = await httpGbk(cffexUrl(dateStr), "http://www.cffex.com.cn/");
  } catch {
    return null;
  }
  if (!txt || !txt.includes("合约代码")) return null;
  let cVol = 0, pVol = 0, cOi = 0, pOi = 0;
  for (const line of txt.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    const m = String(c[0]).match(/^IO\d+-([CP])-/); // 沪深300股指期权
    if (!m) continue;
    const vol = Number(c[4]) || 0;
    const oi = Number(c[6]) || 0;
    if (m[1] === "C") { cVol += vol; cOi += oi; }
    else { pVol += vol; pOi += oi; }
  }
  if (!cVol || !cOi) return null;
  return {
    d: dateStr,
    volPcr: +(pVol / cVol).toFixed(4),
    oiPcr: +(pOi / cOi).toFixed(4),
    callVol: cVol, putVol: pVol,
    callOi: cOi, putOi: pOi,
  };
}

/**
 * 上证50股指期权（HO）—— 与 50ETF 期权同标的指数，但数据在中金所，
 * 有完整历史，因此用它做「50」的长序列。
 */
async function fetchHoDay(dateStr) {
  let txt;
  try {
    txt = await httpGbk(cffexUrl(dateStr), "http://www.cffex.com.cn/");
  } catch {
    return null;
  }
  if (!txt || !txt.includes("合约代码")) return null;
  let cVol = 0, pVol = 0, cOi = 0, pOi = 0;
  for (const line of txt.split(/\r?\n/).slice(1)) {
    const c = line.split(",");
    const m = String(c[0]).match(/^HO\d+-([CP])-/);
    if (!m) continue;
    const vol = Number(c[4]) || 0;
    const oi = Number(c[6]) || 0;
    if (m[1] === "C") { cVol += vol; cOi += oi; }
    else { pVol += vol; pOi += oi; }
  }
  if (!cVol || !cOi) return null;
  return {
    d: dateStr,
    volPcr: +(pVol / cVol).toFixed(4),
    oiPcr: +(pOi / cOi).toFixed(4),
    callVol: cVol, putVol: pVol,
    callOi: cOi, putOi: pOi,
  };
}

async function backfillHo(dates) {
  const cacheFile = path.join(DATA_DIR, "ho_cache.json");
  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { cache = {}; }
  }
  const need = dates.filter((d) => d >= HO_START && !(d in cache));
  log(`HO：已有 ${Object.keys(cache).length} 日，待补 ${need.length} 日`);

  let done = 0;
  await pMap(need, async (d) => {
    const row = await fetchHoDay(d);
    cache[d] = row || { d, empty: true };
    done++;
    if (done % 200 === 0) log(`  …${done}/${need.length}`);
  }, 4);

  const valid = {};
  for (const [k, v] of Object.entries(cache)) if (!v.empty) valid[k] = v;
  fs.writeFileSync(cacheFile, JSON.stringify(valid), "utf8");
  return Object.values(valid).sort((a, b) => a.d.localeCompare(b.d));
}

async function backfillPcr(dates) {  const cacheFile = path.join(DATA_DIR, "pcr_cache.json");
  let cache = {};
  if (fs.existsSync(cacheFile)) {
    try { cache = JSON.parse(fs.readFileSync(cacheFile, "utf8")); } catch { cache = {}; }
  }
  const need = dates.filter((d) => d >= PCR_START && !(d in cache));
  log(`PCR：已有 ${Object.keys(cache).length} 日，待补 ${need.length} 日`);

  let done = 0;
  await pMap(need, async (d) => {
    const row = await fetchPcrDay(d);
    cache[d] = row || { d, empty: true };
    done++;
    if (done % 200 === 0) log(`  …${done}/${need.length}`);
  }, 4);

  const valid = {};
  for (const [k, v] of Object.entries(cache)) if (!v.empty) valid[k] = v;
  fs.writeFileSync(cacheFile, JSON.stringify(valid), "utf8");

  return Object.values(valid).sort((a, b) => a.d.localeCompare(b.d));
}

/* ---------------------------------------------------- 股债利差（PE + 10Y） */

/**
 * 沪深300 实时收盘（腾讯行情），用于判断今天是否开市，
 * 并在中证指数晚间发布前推算当日 PE。
 */
async function fetchIndexQuote() {
  try {
    const res = await fetch("http://qt.gtimg.cn/q=sh000300", { headers: { "User-Agent": UA } });
    const text = new TextDecoder("gbk").decode(Buffer.from(await res.arrayBuffer()));
    const m = text.match(/v_sh000300="([^"]*)"/);
    if (!m) return null;
    const f = m[1].split("~");
    const ts = String(f[30] || "");
    if (ts.length < 8) return null;
    return {
      d: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      close: Number(f[3]),
      pct: Number(f[32]),
    };
  } catch {
    return null;
  }
}

async function fetchErp() {
  const end = compact(new Date());
  const perf = await http(
    `https://www.csindex.com.cn/csindex-home/perf/index-perf?indexCode=000300&startDate=20150101&endDate=${end}`,
    "https://www.csindex.com.cn/"
  );
  const indexRows = (perf?.data || [])
    .map((r) => ({
      d: `${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}`,
      close: Number(r.close),
      pe: Number(r.peg),
    }))
    .filter((r) => isFinite(r.pe) && r.pe > 0)
    .sort((a, b) => a.d.localeCompare(b.d));

  // 该接口单页上限 500 条，需翻页覆盖 2015 年至今
  const y10 = new Map();
  const us10 = new Map();
  for (let page = 1; page <= 20; page++) {
    const bond = await http(
      "https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPTA_WEB_TREASURYYIELD" +
        `&columns=ALL&pageNumber=${page}&pageSize=500&sortColumns=SOLAR_DATE&sortTypes=-1&source=WEB&client=WEB`,
      "https://data.eastmoney.com/"
    );
    const rows = bond?.result?.data || [];
    if (!rows.length) break;
    let oldest = "";
    for (const r of rows) {
      const d = String(r.SOLAR_DATE).slice(0, 10);
      const v = Number(r.EMM00166466); // 中国国债收益率 10 年
      const us = Number(r.EMG00001308); // 美国国债收益率 10 年
      if (!oldest || d < oldest) oldest = d;
      if (isFinite(v) && v > 0) y10.set(d, v);
      if (isFinite(us) && us > 0) us10.set(d, us);
    }
    if (oldest < "2014-12-31") break;
    await sleep(120);
  }

  const bondDates = [...y10.keys()].sort();  const series = [];
  for (const row of indexRows) {
    let rate = y10.get(row.d);
    if (rate === undefined) {
      const pos = bondDates.findLastIndex((d) => d <= row.d);
      if (pos >= 0) rate = y10[bondDates[pos]];
    }
    if (!isFinite(rate)) continue;
    series.push({ d: row.d, close: row.close, pe: row.pe, y10: rate, erp: +(100 / row.pe - rate).toFixed(3) });
  }
  log(`股债利差：${series.length} 个交易日（${series[0].d} ~ ${series[series.length - 1].d}）`);
  const us10y = [...us10.entries()].map(([d, y]) => ({ d, y })).sort((a, b) => a.d.localeCompare(b.d));
  log(`美债10年：${us10y.length} 个交易日，最新 ${us10y[us10y.length - 1]?.y}`);
  return { series, us10y };
}

/* --------------------------------------------------- 四只 ETF 规模（季度） */

function parseGmbd(html) {
  const rows = [];
  const trRe = /<tr>([\s\S]*?)<\/tr>/g;
  let m;
  while ((m = trRe.exec(html))) {
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) =>
      x[1].replace(/<[^>]+>/g, "").trim()
    );
    if (cells.length >= 5 && /^\d{4}-\d{2}-\d{2}$/.test(cells[0])) {
      rows.push({
        d: cells[0],
        buy: num(cells[1]),
        sell: num(cells[2]),
        shares: num(cells[3]),
        nav: num(cells[4]),
      });
    }
  }
  return rows;
}

async function fetchEtfQuarterly() {
  const byDate = new Map();
  for (const f of ETF_LIST) {
    const html = await http(
      `http://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=gmbd&code=${f.code}`,
      "http://fundf10.eastmoney.com/",
      false
    );
    const raw = String(html).match(/content:"([\s\S]*?)"\s*,\s*arryear/)?.[1] || String(html);
    const rows = parseGmbd(raw);
    log(`  ${f.code} ${f.name}：${rows.length} 期`);
    for (const r of rows) {
      let b = byDate.get(r.d);
      if (!b) { b = { d: r.d, nav: 0, shares: 0, buy: 0, sell: 0, funds: 0 }; byDate.set(r.d, b); }
      if (isFinite(r.nav)) b.nav += r.nav;
      if (isFinite(r.shares)) b.shares += r.shares;
      if (isFinite(r.buy)) b.buy += r.buy;
      if (isFinite(r.sell)) b.sell += r.sell;
      b.funds++;
    }
  }
  return [...byDate.values()].filter((r) => r.funds === ETF_LIST.length).sort((a, b) => a.d.localeCompare(b.d));
}

async function fetchHs300Cap() {
  let total = 0, count = 0;
  for (let page = 1; page <= 5; page++) {
    const rows = await http(
      `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs300`,
      "http://finance.sina.com.cn/"
    );
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const r of rows) {
      const v = Number(r.nmc);
      if (isFinite(v) && v > 0) { total += v; count++; }
    }
    if (rows.length < 100) break;
    await sleep(120);
  }
  log(`沪深300 成分 ${count} 只，流通市值合计 ${(total / 1e4).toFixed(0)} 亿元`);
  return { capYi: total / 1e4, count };
}

/* --------------------------------------------------------- ETF 放量监控 */

// 排除货币、债券、商品类 ETF，只保留股票型
const ETF_EXCLUDE = /货币|债|国债|政金|短融|信用|利率|黄金|白银|豆粕|有色|原油|商品|期货|油气|日利|添益|现金|理财|保证金/;

async function fetchEtfList() {
  // 新浪 ETF 节点：按成交额降序，100 条/页；比东财 clist 稳定得多
  const rows = [];
  for (let page = 1; page <= 4; page++) {
    const part = await http(
      `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=amount&asc=0&node=etf_hq_fund`,
      "http://finance.sina.com.cn/"
    );
    if (!Array.isArray(part) || !part.length) break;
    rows.push(...part);
    if (part.length < 100) break;
    await sleep(100);
  }
  return rows
    .map((r) => {
      const sym = String(r.symbol || "");
      return {
        code: String(r.code),
        market: sym.startsWith("sh") ? 1 : 0,
        name: String(r.name),
        pct: Number(r.changepercent),
        amount: Number(r.amount),
        cap: Number(r.nmc) * 1e4,
      };
    })
    // 剔除货币/债券/商品类，以及 511 开头的场内货币与债券 ETF
    .filter((r) => r.code && isFinite(r.amount) && r.amount > 0 && !/^511/.test(r.code) && !ETF_EXCLUDE.test(r.name));
}

/**
 * 对成交额前 N 的股票型 ETF 逐个取日线，算：
 *   放量倍数 = 当日成交额 ÷ 前 20 日均额
 *   成交额分位 = 当日成交额在自身近 250 日中的位置
 *   池子合计成交额（逐日）
 * 计算统一用「万元」，输出转「亿元」。
 */
async function fetchEtfVolume(list, todayStr, topN = 50) {
  const pool = list.slice().sort((a, b) => b.amount - a.amount).slice(0, topN);
  const aggMap = new Map();
  const out = [];

  await pMap(pool, async (e) => {
    const sym = (e.market === 1 ? "sh" : "sz") + e.code;
    try {
      const j = await http(
        `http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,,,750,qfq`,
        "http://gu.qq.com/"
      );
      const node = j?.data?.[sym];
      const rows = node?.qfqday || node?.day || [];
      // 新浪的 ETF 名称是缩写，腾讯报价里的名称更完整
      const fullName = node?.qt?.[sym]?.[1] || e.name;
      const hist = rows
        .map((r) => ({ d: String(r[0]).slice(0, 10), amt: Number(r[8]) || 0 }))
        .filter((r) => r.amt > 0);
      if (!hist.length) return;

      for (const h of hist) aggMap.set(h.d, (aggMap.get(h.d) || 0) + h.amt);

      const todayAmt = e.amount / 1e4; // 元 → 万元
      const prior = hist.filter((h) => h.d < todayStr).slice(-20);
      const avg20 = prior.length ? prior.reduce((s, h) => s + h.amt, 0) / prior.length : NaN;
      const year = hist.slice(-250).map((h) => h.amt);
      const rank = year.length ? (year.filter((v) => v < todayAmt).length / year.length) * 100 : NaN;

      out.push({
        code: e.code,
        name: fullName || e.name,
        pct: e.pct,
        amount: +(e.amount / 1e8).toFixed(2), // 亿元
        avg20: +(avg20 / 1e4).toFixed(2),     // 万元 → 亿元
        mult: isFinite(avg20) && avg20 > 0 ? +(todayAmt / avg20).toFixed(2) : NaN,
        rank: isFinite(rank) ? +rank.toFixed(0) : NaN,
      });
    } catch { /* 单只失败不影响整体 */ }
  }, 6);

  const agg = [...aggMap.entries()]
    .map(([d, v]) => ({ d, amt: +(v / 1e4).toFixed(1) })) // 万元 → 亿元
    .sort((a, b) => a.d.localeCompare(b.d));

  out.sort((a, b) => (b.mult || 0) - (a.mult || 0));
  return { list: out, agg, poolSize: pool.length };
}

/* ------------------------------------------------ 海外宏观（原油 / 黄金） */

const GLOBAL_KLINE = (sym) =>
  `http://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20c=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=${sym}&_=1`;

async function fetchGlobalSeries(sym, keepDays = 1500) {
  const text = await http(GLOBAL_KLINE(sym), "http://finance.sina.com.cn/", false);
  const m = text.match(/=\((\[[\s\S]*\])\)/);
  if (!m) return [];
  const arr = JSON.parse(m[1]);
  return arr
    .slice(-keepDays)
    .map((r) => ({ d: String(r.date), c: Number(r.close) }))
    .filter((r) => isFinite(r.c) && r.c > 0);
}

async function fetchMacro() {
  const [brent, gold] = await Promise.all([
    fetchGlobalSeries("OIL").catch(() => []),
    fetchGlobalSeries("GC").catch(() => []),
  ]);
  log(`海外宏观：布伦特 ${brent[brent.length - 1]?.c}，COMEX 黄金 ${gold[gold.length - 1]?.c}`);
  return { brent, gold };
}

/* ------------------------------------------------------- ETF 份额走势 */

/**
 * 日度份额没有公开历史，但可以从日线反推：
 *   换手率 = 成交量 ÷ 流通份额  →  份额 = 成交量 ÷ 换手率
 * 与东财给出的总份额对照误差约 0.5%（换手率口径与总份额略有差异）。
 */
const SHARE_GROUPS = [
  { key: "hs300", label: "沪深300", list: [
    ["510300", "沪深300ETF华泰柏瑞"], ["510310", "沪深300ETF易方达"],
    ["159919", "沪深300ETF嘉实"], ["510330", "沪深300ETF华夏"],
  ] },
  { key: "gem", label: "创业板", list: [
    ["159915", "创业板ETF易方达"], ["159952", "创业板ETF广发"], ["159977", "创业板ETF天弘"],
  ] },
  { key: "star", label: "科创板", list: [
    ["588000", "科创50ETF华夏"], ["588080", "科创50ETF易方达"], ["588060", "科创50ETF广发"],
  ] },
];

async function fetchEtfShares() {
  const out = [];
  for (const g of SHARE_GROUPS) {
    const series = [];
    await pMap(g.list, async ([code, name]) => {
      const sym = (code.startsWith("5") ? "sh" : "sz") + code;
      try {
        const j = await http(
          `http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,,,750,qfq`,
          "http://gu.qq.com/"
        );
        const rows = j?.data?.[sym]?.qfqday || j?.data?.[sym]?.day || [];
        const data = [];
        for (const r of rows) {
          const vol = Number(r[5]); // 手
          const to = Number(r[7]);  // 换手率 %
          if (!(vol > 0) || !(to > 0)) continue;
          const shares = vol / to / 1e4; // 亿份
          if (isFinite(shares) && shares > 0) data.push({ d: String(r[0]).slice(0, 10), v: +shares.toFixed(2) });
        }
        if (data.length) series.push({ code, name, data: data.slice(-250) });
      } catch { /* 单只失败跳过 */ }
    }, 5);
    series.sort((a, b) => b.data[b.data.length - 1].v - a.data[a.data.length - 1].v);
    out.push({ key: g.key, label: g.label, series });
  }
  const gem = out.find((x) => x.key === "gem");
  const gemSum = gem ? gem.series.reduce((s, x) => s + x.data[x.data.length - 1].v, 0) : 0;
  log(`ETF 份额：创业板 ${gem?.series.length || 0} 只，最新合计 ${gemSum.toFixed(0)} 亿份`);
  return out;
}

/* ------------------------------------------ 创业板 / 中证红利（相对估值） */

/**
 * 创业板指 ÷ 中证红利。比值走低 = 创业板相对红利变便宜（或资金避险），
 * 走高 = 成长跑赢。用它判断「创业板贵不贵」，比单看指数的 PE 更贴近资金的选择。
 */
async function fetchGrowthDividendRatio() {
  const [gem, div] = await Promise.all([
    klineHistory("sz399006").catch(() => []),
    klineHistory("sh000922").catch(() => []),
  ]);
  const toMap = (rows) => {
    const m = new Map();
    for (const r of rows) {
      const c = Number(r[2]);
      if (c > 0) m.set(String(r[0]).slice(0, 10), c);
    }
    return m;
  };
  const a = toMap(gem), b = toMap(div);
  const out = [];
  for (const [d, c] of a) {
    const x = b.get(d);
    if (x) out.push({ d, gem: +c.toFixed(2), div: +x.toFixed(2), v: +(c / x).toFixed(4) });
  }
  out.sort((p, q) => p.d.localeCompare(q.d));
  log(`创业板/红利：${out.length} 个交易日，最新 ${out[out.length - 1]?.v}`);
  return out;
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  const t0 = Date.now();
  log(`===== 运行 ${new Date().toLocaleString("zh-CN", { hour12: false })} =====`);
  log(DAILY ? "模式：日常增量" : RECALC ? "模式：底表重算" : "模式：全量回补");

  const limit = Number(process.env.LIMIT || 0);
  let universe = await fetchSnapshot();
  log(`全A快照 ${universe.length} 只`);
  if (limit > 0) { universe = universe.slice(0, limit); log(`  [测试模式] 仅取前 ${universe.length} 只`); }

  const outFile = path.join(DATA_DIR, "indicators.json");
  const prev = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, "utf8")) : null;

  // —— 股债利差（同时用实时指数判断今天是否开市）
  const { series: erp, us10y } = await fetchErp();
  const todayStr = ymd(new Date());
  const quote = await fetchIndexQuote();

  // 中证指数的 PE 要到傍晚才发布，16:00 只能以实时指数时间戳判断是否开市
  if (quote && quote.d !== todayStr) {
    log(`今日 ${todayStr} 非交易日（行情最新为 ${quote.d}），跳过`);
    return;
  }
  if (!quote && erp[erp.length - 1].d !== todayStr) {
    log(`今日 ${todayStr} 无法确认行情日期，且中证最新为 ${erp[erp.length - 1].d}，跳过`);
    return;
  }

  // 中证当日估值尚未发布：用「上一交易日 PE × 指数涨跌」推算
  let erpEst = false;
  if (erp[erp.length - 1].d !== todayStr && quote) {
    const last = erp[erp.length - 1];
    const pe = +(last.pe * (quote.close / last.close)).toFixed(2);
    erp.push({
      d: todayStr,
      close: quote.close,
      pe,
      y10: last.y10,
      erp: +(100 / pe - last.y10).toFixed(3),
      est: true,
    });
    erpEst = true;
    log(`中证当日估值未发布（最新 ${last.d}），按指数涨跌推算 PE ${pe}，收盘 ${quote.close}`);
  }

  // —— 涨跌家数底表（TRIN / MCL / 宽度 用）
  const MA_CACHE = path.join(DATA_DIR, "ma_cache.json");
  let breadth, maCache = {};
  if (!DAILY && !RECALC && !process.argv.includes("--keep-trin")) {
    const out = await backfillTrin(universe);
    breadth = out.breadth;
    maCache = out.cache;
    fs.writeFileSync(MA_CACHE, JSON.stringify(maCache), "utf8");
    log(`均线缓存：${Object.keys(maCache).length} 只`);
  } else {
    breadth = prev?.breadth || [];
    if (fs.existsSync(MA_CACHE)) {
      try { maCache = JSON.parse(fs.readFileSync(MA_CACHE, "utf8")); } catch { maCache = {}; }
    }
  }
  breadth = cleanBreadth(breadth);

  // 当日一行：有均线缓存则完整重算（含 P20/P60/P250 与涨跌停），否则退化为仅涨跌家数
  let todayRow;
  if (Object.keys(maCache).length) {
    todayRow = { d: todayStr, ...todayFromCache(universe, maCache, todayStr) };
    fs.writeFileSync(MA_CACHE, JSON.stringify(maCache), "utf8");
  } else {
    log("  ! 缺少均线缓存，本次只更新涨跌家数与 TRIN（跑一次全量即可生成缓存）");
    const ad = adOf(universe), amt = breadthOf(universe);
    todayRow = { d: todayStr, up: ad.up, down: ad.down, flat: ad.flat,
                 upAmt: amt.upAmt, downAmt: amt.downAmt,
                 a20: 0, n20: 0, a60: 0, n60: 0, a250: 0, n250: 0, lu: 0, ld: 0 };
  }
  const ti0 = breadth.findIndex((r) => r.d === todayStr);
  if (ti0 >= 0) breadth[ti0] = todayRow; else breadth.push(todayRow);
  breadth.sort((a, b) => a.d.localeCompare(b.d));

  const trin = breadth
    .map((b) => ({
      d: b.d,
      up: b.up, down: b.down, flat: b.flat,
      trin: b.upAmt > 0 && b.downAmt > 0 && b.flat + b.down > 0
        ? +(b.up / (b.flat + b.down) / (b.upAmt / b.downAmt)).toFixed(4)
        : NaN,
      adr: b.flat + b.down > 0 ? +(b.up / (b.flat + b.down)).toFixed(4) : NaN,
      upAmtShare: b.upAmt + b.downAmt > 0 ? +((b.upAmt / (b.upAmt + b.downAmt)) * 100).toFixed(2) : NaN,
    }))
    // 剔除涨跌家数过度失衡的日子：分母极小会让 TRIN 出现无意义极值
    .filter((r) => isFinite(r.trin) && r.up >= 100 && r.down >= 100);

  const mcl = computeMcl(breadth);
  log(`MCL：${mcl.length} 个交易日，最新 ${mcl[mcl.length - 1]?.mcl}`);

  // —— PCR（沪深300股指期权）
  const pcr = await backfillPcr(erp.map((r) => r.d));
  log(`PCR：${pcr.length} 个交易日`);

  // —— 上证50股指期权 PCR（中金所，历史完整）
  const ho = await backfillHo(erp.map((r) => r.d));
  log(`HO：${ho.length} 个交易日，最新 ${ho[ho.length - 1]?.volPcr}`);

  // —— ETF 占比
  log("抓取四只 ETF 季度规模…");
  const quarterly = await fetchEtfQuarterly();
  const anchor = await fetchHs300Cap();

  const indexToday = erp[erp.length - 1].close;
  for (const q of quarterly) {
    const point = [...erp].reverse().find((r) => r.d <= q.d) || erp[0];
    const cap = anchor.capYi * (point.close / indexToday);
    q.cap = +cap.toFixed(2);
    q.ratio = +(q.nav / cap * 100).toFixed(4);
    q.netBuy = +(q.buy - q.sell).toFixed(2);
  }

  // —— ETF 当日规模（失败则退回最近一期季度净资产）
  const etfNow = [];
  try {
    const secids = ETF_LIST.map((f) => f.secid).join(",");
    const q = await http(
      `http://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f2,f3,f12,f14,f21`,
      "http://quote.eastmoney.com/"
    );
    for (const r of q?.data?.diff || []) {
      etfNow.push({ code: String(r.f12), name: r.f14, nav: Number(r.f21) / 1e8, pct: Number(r.f3) });
    }
  } catch (e) {
    log("  ! ETF 实时规模获取失败，退回季度数据：" + e.message);
  }
  const navFallback = quarterly[quarterly.length - 1]?.nav ?? 0;
  const navNow = etfNow.length ? etfNow.reduce((s, r) => s + (isFinite(r.nav) ? r.nav : 0), 0) : navFallback;

  const daily = prev?.etf?.daily ? [...prev.etf.daily] : [];
  const dPoint = { d: todayStr, nav: +navNow.toFixed(2), cap: +anchor.capYi.toFixed(2), ratio: +(navNow / anchor.capYi * 100).toFixed(4) };
  const di = daily.findIndex((r) => r.d === todayStr);
  if (etfNow.length) {
    // 只有取到实时规模才写当日点，避免接口失败时用季度值覆盖掉正确读数
    if (di >= 0) daily[di] = dPoint; else daily.push(dPoint);
    daily.sort((a, b) => a.d.localeCompare(b.d));
  } else if (di < 0) {
    log("  ! 无实时规模且当日无历史读数，ETF 当日点跳过");
  }

  // —— 海外宏观：布伦特原油、COMEX 黄金
  let macro = prev?.macro || null;
  try {
    macro = await fetchMacro();
  } catch (e) {
    log("  ! 海外宏观获取失败：" + e.message);
  }

  // —— ETF 放量监控（抓空时沿用上次结果，避免限流把手里的数据清掉）
  let etfVol = prev?.etfVolume || null;
  try {
    const etfList = await fetchEtfList();
    if (etfList.length < 20) {
      log(`  ! ETF 列表仅 ${etfList.length} 条（疑似限流），沿用上次结果`);
    } else {
      const v = await fetchEtfVolume(etfList, todayStr);
      if (v.list.length) etfVol = v;
      else log("  ! ETF 放量计算为空，沿用上次结果");
    }
    if (etfVol) {
      const mids = etfVol.list.map((r) => r.mult).filter(isFinite).sort((a, b) => a - b);
      log(`ETF 放量：${etfVol.list.length} 只，倍数中位 ${mids.length ? mids[Math.floor(mids.length / 2)] : "—"}`);
    }
  } catch (e) {
    log("  ! ETF 放量获取失败：" + e.message);
  }

  // —— 创业板 / 中证红利 相对估值
  let ratio = prev?.ratio || null;
  try {
    const r = await fetchGrowthDividendRatio();
    if (r.length > 100) ratio = r;
  } catch (e) {
    log("  ! 创业板/红利 获取失败：" + e.message);
  }

  // —— ETF 份额走势（沪深300 / 创业板 / 科创板）
  let etfShares = prev?.etfShares || null;
  try {
    const v = await fetchEtfShares();
    if (v.some((g) => g.series.length)) etfShares = v;
  } catch (e) {
    log("  ! ETF 份额获取失败：" + e.message);
  }

  const snap = adOf(universe);
  const payload = {
    generatedAt: new Date().toISOString(),
    tradeDate: todayStr,
    trin,
    breadth: breadth.map((b) => ({
      d: b.d, up: b.up, down: b.down, flat: b.flat,
      upAmt: Math.round(b.upAmt || 0), downAmt: Math.round(b.downAmt || 0),
      a20: b.a20 || 0, n20: b.n20 || 0,
      a60: b.a60 || 0, n60: b.n60 || 0,
      a250: b.a250 || 0, n250: b.n250 || 0,
      lu: b.lu || 0, ld: b.ld || 0,
    })),
    mcl,
    pcr,
    ho,
    erpEst,
    erp,
    etf: {
      quarterly: quarterly.map((r) => ({ d: r.d, nav: r.nav, shares: r.shares, cap: r.cap, ratio: r.ratio, netBuy: r.netBuy, buy: r.buy, sell: r.sell })),
      daily,
      latest: daily.length ? daily[daily.length - 1].nav : +navNow.toFixed(2),
    },
    etfVolume: etfVol,
    etfShares,
    ratio,
    us10y,
    macro,
    hs300: { close: indexToday, capYi: anchor.capYi, pe: erp[erp.length - 1].pe, cons: anchor.count },
    snapshot: { up: snap.up, down: snap.down, flat: snap.flat, trin: breadthOf(universe).trin },
    universe: universe.length,
    stars: ETF_LIST.map((f) => ({ ...f, nav: etfNow.find((x) => x.code === f.code)?.nav ?? null })),
  };

  fs.writeFileSync(outFile, JSON.stringify(payload), "utf8");
  fs.writeFileSync(path.join(DATA_DIR, "indicators.js"), "window.IND_DATA=" + JSON.stringify(payload) + ";\n", "utf8");

  // —— 每日一行 CSV，便于其他脚本或 Excel 直接取用
  writeDailyCsv(payload);

  log(
    `完成 用时 ${((Date.now() - t0) / 1000).toFixed(1)}s | TRIN ${trin.length} 日 | MCL ${mcl.length} 日 | ` +
    `PCR ${pcr.length} 日 | 利差 ${erp.length} 日 | ETF ${quarterly.length} 季 | ` +
    `今日 TRIN ${trin[trin.length - 1].trin} MCL ${mcl[mcl.length - 1].mcl} PCR ${pcr[pcr.length - 1]?.volPcr}`
  );
}

function writeDailyCsv(p) {
  const file = path.join(DATA_DIR, "daily.csv");
  const head = "date,trin,trin_ma20,mcl,mcl_sum,pcr_vol,pcr_oi,pcr_ho,erp,pe,y10,etf_ratio,etf_nav";
  const trin = p.trin[p.trin.length - 1] || {};
  const mcl = p.mcl[p.mcl.length - 1] || {};
  const pcr = p.pcr[p.pcr.length - 1] || {};
  const erp = p.erp[p.erp.length - 1] || {};
  const etf = p.etf.daily[p.etf.daily.length - 1] || {};
  const tail = p.trin.slice(-20);
  const ma20 = tail.reduce((s, r) => s + r.trin, 0) / Math.max(1, tail.length);
  const row = [
    p.tradeDate, trin.trin, ma20.toFixed(4), mcl.mcl, mcl.sum,
    pcr.volPcr, pcr.oiPcr, (p.ho && p.ho.length ? p.ho[p.ho.length - 1].volPcr : ""),
    erp.erp, erp.pe, erp.y10, etf.ratio, etf.nav,
  ].join(",");

  let lines = [];
  if (fs.existsSync(file)) {
    lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean);
    // 表头变更（新增列）时直接重建，避免列错位
    if (!lines.length || lines[0] !== head) lines = [head];
  } else {
    lines = [head];
  }
  const i = lines.findIndex((l) => l.startsWith(p.tradeDate + ","));
  if (i >= 0) lines[i] = row; else lines.push(row);
  fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
}

main().catch((e) => {
  console.error("FATAL", e);
  try { fs.appendFileSync(path.join(DATA_DIR, "update.log"), `  FATAL ${e && e.message}\n`, "utf8"); } catch {}
  process.exit(1);
});
