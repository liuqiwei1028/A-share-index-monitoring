/**
 * 每日复盘报告 · 规则引擎
 *
 * 读取 data/indicators.json，结合指数与持仓行情，生成：
 *   data/report.json  结构化数据（页面渲染用）
 *   data/report.md    可直接阅读的文本复盘
 *
 * 不用大模型：所有结论都由可复现的阈值规则得出，便于回溯和调参。
 * 侧重点：创业板 / 科创板，以及 CPO 光模块持仓（300308 / 300502 / 300394）。
 */
import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import { chat, llmConfigured } from "./llm.mjs";

dns.setDefaultResultOrder("ipv4first");
process.env.NO_PROXY = "*";
process.env.no_proxy = "*";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36";

const HOLDINGS = [
  { code: "300308", name: "中际旭创" },
  { code: "300502", name: "新易盛" },
  { code: "300394", name: "天孚通信" },
];

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------------------------------------------------------- 工具 */

async function kline(sym, n = 1200) {
  const pages = [];
  let end = "";
  for (let k = 0; k < 2; k++) {
    const url = `http://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?param=${sym},day,,${end || ""},750,qfq`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Referer: "http://gu.qq.com/" } });
      const j = await res.json();
      const node = j?.data?.[sym];
      const rows = node?.qfqday || node?.day || [];
      if (!rows.length) break;
      pages.unshift(rows);
      const first = String(rows[0][0]).slice(0, 10);
      if (first <= "2021-01-01") break;
      const d = new Date(first);
      d.setDate(d.getDate() - 1);
      end = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    } catch {
      break;
    }
  }
  return pages.flat().map((r) => ({ d: String(r[0]).slice(0, 10), c: Number(r[2]) })).filter((r) => r.c > 0).slice(-n);
}

const pctChange = (series, n) => {
  if (series.length <= n) return NaN;
  const a = series[series.length - 1 - n].c;
  return (series[series.length - 1].c / a - 1) * 100;
};
const dayChange = (series) => pctChange(series, 1);

function percentile(values, v) {
  const a = values.filter(Number.isFinite).slice().sort((x, y) => x - y);
  if (!a.length || !Number.isFinite(v)) return NaN;
  return a.filter((x) => x < v).length / a.length * 100;
}

function maAt(series, n) {
  if (series.length < n) return NaN;
  const s = series.slice(-n).reduce((acc, r) => acc + r.c, 0);
  return s / n;
}

/* ------------------------------------------------------------ 主逻辑 */

async function main() {
  const D = JSON.parse(fs.readFileSync(path.join(DATA, "indicators.json"), "utf8"));
  const date = D.tradeDate;
  if (date !== today) {
    log(`库内最新 ${date}，今天 ${today}，跳过生成报告`);
    return;
  }

  const trin = D.trin[D.trin.length - 1] || {};
  const mcl = D.mcl[D.mcl.length - 1] || {};
  const pcr = D.pcr[D.pcr.length - 1] || {};
  const ho = D.ho[D.ho.length - 1] || {};
  const erp = D.erp[D.erp.length - 1] || {};
  const B = D.breadth[D.breadth.length - 1] || {};
  const total = (B.up || 0) + (B.down || 0) + (B.flat || 0);
  const redRate = total ? B.up / total * 100 : NaN;
  const upAmtYi = (B.upAmt || 0) / 1e8;
  const downAmtYi = (B.downAmt || 0) / 1e8;
  const upAmtShare = upAmtYi + downAmtYi ? upAmtYi / (upAmtYi + downAmtYi) * 100 : NaN;

  // —— 指数与结构
  const [gemS, starS, hs300S] = await Promise.all([
    kline("sz399006"), kline("sh000688"),
    Promise.resolve(D.erp.map((r) => ({ d: r.d, c: r.close }))),
  ]);
  const [h1, h2, h3] = await Promise.all(HOLDINGS.map((h) => kline("sz" + h.code, 60)));

  const gemPct = dayChange(gemS), starPct = dayChange(starS);
  const hs300Pct = dayChange(hs300S);
  const gemRel = gemPct - hs300Pct;
  const starRel = starPct - hs300Pct;

  const ratioSeries = (D.ratio || []).map((r) => r.v);
  const ratioNow = ratioSeries.length ? ratioSeries[ratioSeries.length - 1] : NaN;
  const ratioPct = percentile(ratioSeries, ratioNow);

  // 创业板 ETF 份额 20 日变化
  const gemShare = (D.etfShares || []).find((g) => g.key === "gem");
  let gemShareChg = NaN, gemShareNow = NaN;
  if (gemShare && gemShare.series.length) {
    const m = {};
    gemShare.series.forEach((s) => s.data.forEach((p) => { m[p.d] = (m[p.d] || 0) + p.v; }));
    const arr = Object.keys(m).sort().map((d) => m[d]);
    if (arr.length > 21) {
      gemShareNow = arr[arr.length - 1];
      gemShareChg = arr[arr.length - 1] - arr[arr.length - 21];
    }
  }

  // 趋势状态
  const hs300Ma200 = maAt(hs300S, 200);
  const aboveMa200 = hs300S[hs300S.length - 1].c > hs300Ma200;
  const red5 = D.breadth.slice(-5).reduce((s, r) => s + r.up / (r.up + r.down + r.flat) * 100, 0) / 5;
  const red20 = D.breadth.slice(-20).reduce((s, r) => s + r.up / (r.up + r.down + r.flat) * 100, 0) / 20;
  const mcl5 = D.mcl.slice(-5).map((r) => r.mcl);
  const mclRising = mcl5[mcl5.length - 1] > mcl5[0];

  // 成交额环比
  const amtToday = upAmtYi + downAmtYi;
  const amtPrev = D.breadth.slice(-6, -1).map((r) => ((r.upAmt || 0) + (r.downAmt || 0)) / 1e8);
  const amtAvg5 = amtPrev.length ? amtPrev.reduce((a, b) => a + b, 0) / amtPrev.length : NaN;
  const amtRatio = amtAvg5 ? amtToday / amtAvg5 : NaN;

  // 情绪状态判定
  let regime, regimeTone;
  if (redRate >= 65) { regime = "普涨"; regimeTone = "success"; }
  else if (redRate <= 35) { regime = (B.ld || 0) >= 20 ? "普跌·恐慌" : "普跌·未恐慌"; regimeTone = "warning"; }
  else { regime = "分化"; regimeTone = "info"; }

  let amtState = "平量";
  if (isFinite(amtRatio)) amtState = amtRatio >= 1.2 ? "放量" : (amtRatio <= 0.8 ? "缩量" : "平量");

  // 趋势判断：均线位置 + 广度趋势 + 动能方向
  let trendTitle, trendBody;
  if (aboveMa200 && red20 > 50 && mclRising) {
    trendTitle = "趋势向上，回踩可加";
    trendBody = `沪深300 在 200 日线上方，20 日平均红盘率 ${red20.toFixed(0)}%，MCL 五天以来${mclRising ? "抬升" : "走低"}。这种组合下，回踩是买点而不是卖点。`;
  } else if (aboveMa200 && (red20 <= 50 || !mclRising)) {
    trendTitle = "指数在年线上方，但广度没跟上";
    trendBody = `沪深300 仍在 200 日线上方，但 20 日平均红盘率只有 ${red20.toFixed(0)}%、MCL ${mclRising ? "虽在抬升" : "仍在下行"}。指数靠权重撑着，个股赚钱效应不足，属于「指数牛、个股熊」，加仓要克制。`;
  } else if (!aboveMa200 && red5 > red20 && mclRising) {
    trendTitle = "年线下方修复中，先看反弹";
    trendBody = `沪深300 在 200 日线下方，但近 5 日红盘率 ${red5.toFixed(0)}% 已高于 20 日均值 ${red20.toFixed(0)}%，MCL 也在抬升。这是下跌趋势里的修复尝试，可以试仓，但要设好止损——年线没站稳之前不算反转。`;
  } else {
    trendTitle = "年线下方，趋势仍偏弱";
    trendBody = `沪深300 在 200 日线下方，5 日平均红盘率 ${red5.toFixed(0)}%、20 日 ${red20.toFixed(0)}%，MCL 五日内${mclRising ? "抬升" : "继续走低"}。下跌趋势未破，反弹以减仓为主。`;
  }

  // 创业板 / 科创板
  const starBias = gemRel > 1 || starRel > 1;
  const structureBody = [
    `创业板指 ${gemPct >= 0 ? "+" : ""}${gemPct.toFixed(2)}%，相对沪深300 ${gemRel >= 0 ? "跑赢" : "跑输"} ${Math.abs(gemRel).toFixed(2)} 个百分点；`,
    `科创50 ${starPct >= 0 ? "+" : ""}${starPct.toFixed(2)}%，相对 ${starRel >= 0 ? "跑赢" : "跑输"} ${Math.abs(starRel).toFixed(2)} 个百分点。`,
    starBias ? "成长风格占优，对 CPO 这类高 β 持仓是顺风。" : "成长风格偏弱，高 β 持仓会更难受。",
    isFinite(ratioPct) ? `创业板/红利比值 ${ratioNow.toFixed(3)}，处于历史 ${ratioPct.toFixed(0)}% 分位${ratioPct <= 30 ? "（成长相对便宜）" : ratioPct >= 70 ? "（成长相对贵）" : ""}。` : "",
    isFinite(gemShareChg) ? `创业板 ETF 合计份额 ${gemShareNow.toFixed(0)} 亿份，20 日${gemShareChg >= 0 ? "净申购 +" : "净赎回 "}${gemShareChg.toFixed(0)} 亿份。` : "",
  ].filter(Boolean).join("");

  // 持仓
  const holdings = HOLDINGS.map((h, i) => {
    const s = i === 0 ? h1 : i === 1 ? h2 : h3;
    const pct = dayChange(s);
    const d5 = pctChange(s, 5);
    const d20 = pctChange(s, 20);
    return { code: h.code, name: h.name, pct, d5, d20, rel: pct - gemPct };
  }).filter((h) => isFinite(h.pct));

  const holdBody = holdings.length
    ? `持仓 ${holdings.map((h) => `${h.name} ${h.pct >= 0 ? "+" : ""}${h.pct.toFixed(2)}%`).join("、")}。` +
      `相对创业板指，${holdings.filter((h) => h.rel > 0).length} 只跑赢、${holdings.filter((h) => h.rel <= 0).length} 只跑输。` +
      (holdings.every((h) => h.rel < -1) ? "三只全部明显跑输指数，说明资金在撤离 CPO 主线，这是比大盘更该警惕的信号。" : "")
    : "持仓行情获取失败。";

  // 仓位建议（复用页面口径）
  const trinPct = percentile(D.trin.map((r) => r.trin), trin.trin);
  const mclPct = percentile(D.mcl.map((r) => r.mcl), mcl.mcl);
  const pcrPct = percentile(D.pcr.map((r) => r.volPcr), pcr.volPcr);
  const erpPct = percentile(D.erp.map((r) => r.erp), erp.erp);
  const fear = (trinPct + pcrPct + (100 - mclPct)) / 3;
  const score = 0.5 * erpPct + 0.5 * fear;
  let pos = 30 + score * 0.6;
  const capped = !aboveMa200 && pos > 60;
  if (capped) pos = 60;

  const summary =
    `${date}：${regime}，${amtState}（成交 ${amtTotal(amtToday)}），红盘率 ${redRate.toFixed(0)}%，` +
    `涨停 ${B.lu || 0} / 跌停 ${B.ld || 0}。${trendTitle}。`;

  const report = {
    generatedAt: now.toISOString(),
    date,
    summary,
    regime, regimeTone, amtState,
    market: {
      hs300: erp.close, hs300Pct, aboveMa200,
      redRate: +redRate.toFixed(1), up: B.up, down: B.down, flat: B.flat,
      lu: B.lu, ld: B.ld,
      amt: +amtToday.toFixed(0), amtRatio: +amtRatio.toFixed(2),
      trin: trin.trin, trinPct: +trinPct.toFixed(0),
      mcl: mcl.mcl, mclPct: +mclPct.toFixed(0),
      pcr: pcr.volPcr, pcrHo: ho.volPcr,
      erp: erp.erp, erpPct: +erpPct.toFixed(0), pe: erp.pe, y10: erp.y10,
    },
    structure: {
      gemPct: +gemPct.toFixed(2), starPct: +starPct.toFixed(2),
      gemRel: +gemRel.toFixed(2), starRel: +starRel.toFixed(2),
      ratio: +ratioNow.toFixed(3), ratioPct: +ratioPct.toFixed(0),
      gemShare: isFinite(gemShareNow) ? +gemShareNow.toFixed(0) : null,
      gemShareChg: isFinite(gemShareChg) ? +gemShareChg.toFixed(0) : null,
    },
    trend: { title: trendTitle, body: trendBody, state: trendTitle },
    position: { score: +score.toFixed(0), pos: +pos.toFixed(0), capped },
    holdings: holdings.map((h) => ({
      ...h, pct: +h.pct.toFixed(2), d5: +h.d5.toFixed(2), d20: +h.d20.toFixed(2), rel: +h.rel.toFixed(2),
    })),
    sections: [
      { title: "市场与情绪", body: marketBody() },
      { title: "结构：创业板与科创板", body: structureBody },
      { title: "持仓（CPO 光模块）", body: holdBody },
      { title: "走势判断", body: trendBody },
    ],
  };

  function amtTotal(v) { return `${v.toFixed(0)} 亿`; }
  function marketBody() {
    return `沪深300 ${erp.close}（${hs300Pct >= 0 ? "+" : ""}${hs300Pct.toFixed(2)}%），${aboveMa200 ? "在" : "跌破"} 200 日线。` +
      `涨 ${B.up} / 平 ${B.flat} / 跌 ${B.down}，红盘率 ${redRate.toFixed(0)}%，涨停 ${B.lu} / 跌停 ${B.ld}。` +
      `成交额 ${amtTotal(amtToday)}，是前 5 日均值的 ${amtRatio.toFixed(2)} 倍。` +
      `TRIN ${trin.trin}（分位 ${trinPct.toFixed(0)}%）、MCL ${mcl.mcl}（分位 ${mclPct.toFixed(0)}%）、` +
      `沪深300 期权 PCR ${pcr.volPcr}、股债利差 ${erp.erp}%（分位 ${erpPct.toFixed(0)}%）。`;
  }

  // —— 可选：调用大模型补充分析（未配置或调用失败时静默降级）
  if (llmConfigured()) {
    const facts = {
      日期: date, 市场状态: `${regime} · ${amtState}`,
      沪深300: `${erp.close}（${hs300Pct >= 0 ? "+" : ""}${hs300Pct.toFixed(2)}%）`,
      在200日线上方: aboveMa200,
      涨跌家数: `涨 ${B.up} / 平 ${B.flat} / 跌 ${B.down}`,
      红盘率: `${redRate.toFixed(1)}%`,
      涨停跌停: `${B.lu} / ${B.ld}`,
      成交额: `${amtToday.toFixed(0)} 亿（前5日均值的 ${amtRatio.toFixed(2)} 倍）`,
      TRIN: `${trin.trin}（分位 ${trinPct.toFixed(0)}%）`,
      MCL: `${mcl.mcl}（分位 ${mclPct.toFixed(0)}%）`,
      期权PCR: `沪深300 ${pcr.volPcr}，上证50 ${ho.volPcr}`,
      股债利差: `${erp.erp}%（分位 ${erpPct.toFixed(0)}%，PE ${erp.pe}，10Y国债 ${erp.y10}%）`,
      创业板指: `${gemPct.toFixed(2)}%（相对沪深300 ${gemRel >= 0 ? "+" : ""}${gemRel.toFixed(2)}pp）`,
      科创50: `${starPct.toFixed(2)}%（相对 ${starRel >= 0 ? "+" : ""}${starRel.toFixed(2)}pp）`,
      创业板相对红利: `${ratioNow.toFixed(3)}（历史 ${ratioPct.toFixed(0)}% 分位）`,
      创业板ETF份额: isFinite(gemShareChg) ? `${gemShareNow.toFixed(0)} 亿份，20日 ${gemShareChg >= 0 ? "+" : ""}${gemShareChg.toFixed(0)} 亿份` : "无",
      持仓: holdings.map((h) => `${h.name} ${h.pct >= 0 ? "+" : ""}${h.pct.toFixed(2)}%（5日 ${h.d5 >= 0 ? "+" : ""}${h.d5.toFixed(1)}%）`),
      规则引擎判断: trendTitle,
      规则仓位参考: `${pos.toFixed(0)}%`,
    };
    const sys = "你是一名A股量化策略分析师。只根据用户给出的数字做判断，不得编造或推算任何未提供的数值。" +
      "语言简洁、直接给结论，不要用「综上所述」「值得注意的是」这类套话，不要写免责声明。";
    const user = [
      "以下是今日收盘的量化指标与持仓数据（JSON）：",
      JSON.stringify(facts, null, 1),
      "",
      "请输出 4 段，每段 60-100 字，不要小标题：",
      "1. 一句话结论：今天是什么状态，对后市怎么判断。",
      "2. 结构：创业板/科创板相对强弱说明什么，成长风格处于什么位置。",
      "3. 持仓：CPO 光模块三只的表现与指数对比，给出持有/减仓/观察的具体倾向。",
      "4. 风险：接下来 1-2 个交易日最需要盯的 1-2 个指标，以及触发什么条件就该改变判断。",
    ].join("\n");

    const r = await chat({ system: sys, user });
    if (r.ok) {
      report.ai = { model: r.model, text: r.text };
      log(`AI 分析已生成（${r.model}）`);
    } else {
      log(`AI 分析跳过：${r.reason}`);
    }
  }
  fs.writeFileSync(path.join(DATA, "report.json"), JSON.stringify(report, null, 1), "utf8");
  fs.writeFileSync(path.join(DATA, "report.js"), "window.REPORT=" + JSON.stringify(report) + ";", "utf8");

  const md = [
    `# 每日复盘 ${date}`,
    "",
    `> ${summary}`,
    "",
    "## 一、市场与情绪",
    report.sections[0].body,
    "",
    "## 二、结构：创业板与科创板",
    report.sections[1].body,
    "",
    "## 三、持仓（CPO 光模块）",
    report.sections[2].body,
    "",
    "## 四、走势判断",
    `**${trendTitle}**`,
    "",
    trendBody,
    "",
    `**仓位参考：${pos.toFixed(0)}%**（综合分 ${score.toFixed(0)}${capped ? "，被 200 日线闸门压到 60%" : ""}）`,
    "",
    ...(report.ai ? ["## 五、AI 分析", "", report.ai.text, ""] : []),
    "---",
    "由规则引擎生成，阈值可在 scripts/report.mjs 中调整。",
  ].join("\n");

  fs.writeFileSync(path.join(DATA, "report.md"), md + "\n", "utf8");
  log(`报告已生成：${regime}/${amtState}，仓位 ${pos.toFixed(0)}%`);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
