import { fileURLToPath } from "node:url";
/**
 * 盘中前瞻 · 14:30 版
 *
 * 只读不写历史库：用当时的全市场快照算出「当天截至此刻」的 TRIN，
 * 不写入 indicators.json，避免污染收盘后的正式数据。
 *
 * 输出：data/intraday.json（结构化）、data/intraday.md（可直接看）、data/intraday.log（追加）
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";

dns.setDefaultResultOrder("ipv4first");
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const hhmm = `${pad(now.getHours())}:${pad(now.getMinutes())}`;

const LIMIT_OF = (sym) => (/^(688|689|300|301)/.test(String(sym).slice(2)) ? 0.2 : 0.1);

async function snapshot() {
  const rows = [];
  for (let p = 1; p <= 70; p++) {
    const res = await fetch(
      `http://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${p}&num=100&sort=symbol&asc=1&node=hs_a`,
      { headers: { "User-Agent": UA, Referer: "http://finance.sina.com.cn/" } }
    );
    const part = await res.json();
    if (!Array.isArray(part) || !part.length) break;
    rows.push(...part);
    if (part.length < 100) break;
    await sleep(70);
  }
  return rows.filter((r) => {
    const sym = String(r.symbol || "");
    return sym && !sym.startsWith("bj") && isFinite(Number(r.changepercent)) && Number(r.amount) > 0;
  });
}

async function indexQuote() {
  try {
    const res = await fetch("http://qt.gtimg.cn/q=sh000300", { headers: { "User-Agent": UA } });
    const text = new TextDecoder("gbk").decode(Buffer.from(await res.arrayBuffer()));
    const m = text.match(/v_sh000300="([^"]*)"/);
    if (!m) return null;
    const f = m[1].split("~");
    const ts = String(f[30] || "");
    return {
      close: Number(f[3]),
      pct: Number(f[32]),
      date: `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`,
      time: `${ts.slice(8, 10)}:${ts.slice(10, 12)}`,
    };
  } catch {
    return null;
  }
}

function comment(trin, p20, p80, redRate, lu, ld, upShare) {
  // 先判断当天是普涨、普跌还是「指数与个股背离」，再看 TRIN 落点
  if (redRate >= 65) {
    const note = trin >= p80
      ? "；但家数扩张远快于成交额（TRIN 偏高），是全面普涨而非资金集中主攻"
      : "，量能与家数基本匹配";
    return `普涨行情：红盘率 ${redRate.toFixed(0)}%、涨停 ${lu} 家 / 跌停 ${ld} 家${note}`;
  }
  if (redRate <= 35 && upShare > 50) {
    return `指数与个股背离：红盘率只有 ${redRate.toFixed(0)}%，但上涨股占了 ${upShare.toFixed(0)}% 的成交额——权重放量撑指数，题材在失血`;
  }
  if (redRate <= 35) {
    // 跌停家数才是恐慌度的直接读数：跌停少说明只是个股普跌，不是抛售
    if (ld >= 20) return `普跌行情：红盘率 ${redRate.toFixed(0)}%、跌停 ${ld} 家，抛压扩散`;
    return `个股普跌但未恐慌：红盘率 ${redRate.toFixed(0)}%，涨停 ${lu} 家 / 跌停 ${ld} 家，指数靠权重撑住，题材还有局部活跃`;
  }
  if (trin <= p20) {
    return `资金抱团于上涨股（涨停 ${lu} / 跌停 ${ld}），指数不弱但红盘率只有 ${redRate.toFixed(0)}%，结构性行情`;
  }
  if (trin >= p80) return "抛压扩散、量能偏向下跌股，情绪转弱";
  return "宽度与量能基本匹配，情绪中性";
}

async function main() {
  const rows = await snapshot();
  const idx = await indexQuote();
  if (idx && idx.date !== today) {
    console.log(`${today} 非交易日（行情最新 ${idx.date}），跳过`);
    return;
  }

  let up = 0, down = 0, flat = 0, upAmt = 0, downAmt = 0, lu = 0, ld = 0;
  for (const r of rows) {
    const pct = Number(r.changepercent);
    const amt = Number(r.amount);
    if (pct > 0) { up++; upAmt += amt; }
    else if (pct < 0) { down++; downAmt += amt; }
    else flat++;
    const lim = LIMIT_OF(r.symbol);
    if (pct / 100 >= lim - 0.002) lu++;
    else if (pct / 100 <= -(lim - 0.002)) ld++;
  }
  const total = up + down + flat;
  const trin = up / (flat + down) / (upAmt / downAmt);
  const redRate = up / total * 100;
  const upShare = upAmt / (upAmt + downAmt) * 100;

  // 历史参照（用上一次收盘的库）
  let pctRank = NaN, p20 = NaN, p80 = NaN, prev = null;
  try {
    const D = JSON.parse(fs.readFileSync(path.join(DATA, "indicators.json"), "utf8"));
    const hist = D.trin.map((r) => r.trin).filter(isFinite);
    const sorted = hist.slice().sort((a, b) => a - b);
    pctRank = hist.filter((v) => v < trin).length / hist.length * 100;
    p20 = sorted[Math.floor(sorted.length * 0.2)];
    p80 = sorted[Math.floor(sorted.length * 0.8)];
    prev = D.trin.filter((r) => r.d < today).slice(-1)[0] || null;
  } catch { /* 库不可用时只给当期值 */ }

  const out = {
    generatedAt: now.toISOString(),
    date: today,
    time: hhmm,
    index: idx ? { close: idx.close, pct: idx.pct, time: idx.time } : null,
    trin: +trin.toFixed(4),
    pctRank: isFinite(pctRank) ? +pctRank.toFixed(0) : null,
    p20: isFinite(p20) ? +p20.toFixed(3) : null,
    p80: isFinite(p80) ? +p80.toFixed(3) : null,
    prevTrin: prev ? { d: prev.d, trin: prev.trin } : null,
    up, down, flat, total,
    redRate: +redRate.toFixed(1),
    upAmt: +(upAmt / 1e8).toFixed(0),
    downAmt: +(downAmt / 1e8).toFixed(0),
    totalAmt: +((upAmt + downAmt) / 1e8).toFixed(0),
    upShare: +upShare.toFixed(1),
    lu, ld,
  };

  fs.writeFileSync(path.join(DATA, "intraday.json"), JSON.stringify(out), "utf8");

  const md = [
    `# 盘中前瞻 ${today} ${hhmm}`,
    "",
    `**TRIN ${out.trin}**（历史分位 ${out.pctRank ?? "—"}%）｜ 上一交易日 ${out.prevTrin ? out.prevTrin.trin : "—"}`,
    "",
    `- 上涨家数 **${up}**　下跌家数 **${down}**　平盘家数 **${flat}**　上涨家数占比 **${out.redRate}%**`,
    `- 上涨成交额 **${out.upAmt} 亿**　下跌成交额 **${out.downAmt} 亿**　上涨成交额占比 **${out.upShare}%**（合计 ${out.totalAmt} 亿，涨跌额比 ${(upAmt / downAmt).toFixed(2)}）`,
    `- 涨停 ${lu} / 跌停 ${ld}`,
    out.index ? `- 沪深300 ${out.index.close}（${out.index.pct > 0 ? "+" : ""}${out.index.pct}%）` : "",
    "",
    `> ${comment(trin, isFinite(p20) ? p20 : 0.5, isFinite(p80) ? p80 : 1.2, redRate, lu, ld, upShare)}`,
    "",
    hhmm < "15:00"
      ? `注：这是 ${hhmm} 的前瞻值，尾盘（含集合竞价）仍会改动，最终以 16:00 写入的收盘值为准。`
      : "注：已过收盘，此为当日近似终值；正式值以 16:00 写入的为准。",
  ].filter(Boolean).join("\n");

  fs.writeFileSync(path.join(DATA, "intraday.md"), md + "\n", "utf8");
  fs.appendFileSync(path.join(DATA, "intraday.log"), `${today} ${hhmm} TRIN=${out.trin} 红盘率=${out.redRate}% 涨${up}/跌${down} 涨停${lu}/跌停${ld}\n`, "utf8");

  console.log(md);
}

main().catch((e) => {
  console.error("FATAL", e);
  try { fs.appendFileSync(path.join(DATA, "intraday.log"), `${today} ${hhmm} FATAL ${e.message}\n`, "utf8"); } catch {}
  process.exit(1);
});
