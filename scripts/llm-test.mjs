/**
 * LLM 连通性自检
 *
 *   node scripts/llm-test.mjs          正常测试（发一次极小请求）
 *   node scripts/llm-test.mjs --raw    打印原始响应，用于排查「返回内容为空」
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "./llm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = path.join(ROOT, "config", "llm.json");
const RAW = process.argv.includes("--raw");
const mask = (s) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "(空)");

let file = {};
const exists = fs.existsSync(CFG);
if (exists) {
  try {
    file = JSON.parse(fs.readFileSync(CFG, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    console.log("✗ config/llm.json 解析失败:", e.message);
    process.exit(1);
  }
}

const baseUrl = (process.env.LLM_BASE_URL || file.baseUrl || "").replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
const model = process.env.LLM_MODEL || file.model || "";
const apiKey = process.env.LLM_API_KEY || file.apiKey || "";

console.log("=== 配置检查 ===");
console.log("配置文件:", CFG, exists ? "✓ 存在" : "✗ 不存在");
console.log("生效 baseUrl:", baseUrl || "✗ 未配置");
console.log("生效 model:", model || "✗ 未配置");
console.log("生效 apiKey:", mask(apiKey));
console.log("maxTokens:", file.maxTokens ?? 2048, "（可删掉该项用默认值）");

if (!baseUrl || !model) {
  console.log("\n✗ 缺少 baseUrl 或 model");
  process.exit(1);
}

if (RAW) {
  console.log("\n=== 原始响应 ===");
  const res = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: "user", content: "请只回复两个字：可用" }] }),
  });
  const body = await res.text();
  console.log("HTTP", res.status);
  console.log(body.slice(0, 1200));
  process.exit(0);
}

console.log("\n=== 发起测试请求 ===");
const t0 = Date.now();
const r = await chat({ system: "你是一个连通性测试助手。", user: "请只回复两个字：可用" });
const ms = Date.now() - t0;

if (r.ok) {
  console.log(`✓ 调用成功　用时 ${ms} ms　模型 ${r.model}　finish_reason=${r.finishReason || "?"}`);
  if (r.usage) console.log("   token 用量:", JSON.stringify(r.usage));
  console.log("   返回内容:", JSON.stringify(r.text.slice(0, 120)));
} else {
  console.log(`✗ 调用失败（${ms} ms）`);
  console.log(r.reason);
  console.log("");
  console.log("排查：");
  console.log("  401 / invalid api key  → key 错了或带了空格");
  console.log("  404 / model not found  → 模型名不对，或 baseUrl 的 /v1 多写/少写");
  console.log("  finish_reason=length 且内容为空 → max_tokens 太小，或推理模型把额度耗在思考上");
  console.log("  再跑一次 node scripts/llm-test.mjs --raw 看原始返回");
  process.exit(1);
}
