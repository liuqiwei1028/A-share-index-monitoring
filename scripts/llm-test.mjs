/**
 * LLM 连通性自检
 *
 * 用法：node scripts/llm-test.mjs
 * 只发一次极小的请求（约 30 token），用来确认 baseUrl / apiKey / model 是否配对。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chat } from "./llm.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG = path.join(ROOT, "config", "llm.json");

const mask = (s) => (s ? s.slice(0, 6) + "…" + s.slice(-4) : "(空)");

console.log("=== 配置检查 ===");
console.log("配置文件:", CFG, fs.existsSync(CFG) ? "✓ 存在" : "✗ 不存在");

let file = {};
if (fs.existsSync(CFG)) {
  try {
    file = JSON.parse(fs.readFileSync(CFG, "utf8").replace(/^\uFEFF/, ""));
  } catch (e) {
    console.log("✗ JSON 解析失败:", e.message);
    process.exit(1);
  }
}

const env = {
  LLM_BASE_URL: process.env.LLM_BASE_URL,
  LLM_MODEL: process.env.LLM_MODEL,
  LLM_API_KEY: process.env.LLM_API_KEY,
};
const hasEnv = Object.values(env).some(Boolean);

console.log("环境变量:", hasEnv ? `LLM_BASE_URL=${env.LLM_BASE_URL || "—"} LLM_MODEL=${env.LLM_MODEL || "—"}` : "未设置（用文件）");
console.log("生效 baseUrl:", env.LLM_BASE_URL || file.baseUrl || "✗ 未配置");
console.log("生效 model:", env.LLM_MODEL || file.model || "✗ 未配置");
console.log("生效 apiKey:", mask(env.LLM_API_KEY || file.apiKey));

if (!(env.LLM_BASE_URL || file.baseUrl) || !(env.LLM_MODEL || file.model)) {
  console.log("\n✗ 缺少 baseUrl 或 model，无法测试");
  process.exit(1);
}

console.log("\n=== 发起测试请求 ===");
const t0 = Date.now();
const r = await chat({
  system: "你是一个连通性测试助手。",
  user: "请只回复两个字：可用",
});
const ms = Date.now() - t0;

if (r.ok) {
  console.log(`✓ 调用成功　用时 ${ms} ms　模型 ${r.model}`);
  if (r.usage) console.log("   token 用量:", JSON.stringify(r.usage));
  console.log("   返回内容:", JSON.stringify(r.text));
} else {
  console.log(`✗ 调用失败（${ms} ms）：${r.reason}`);
  console.log("");
  console.log("排查看这里：");
  console.log("  401 / invalid api key  → key 错了或复制时多了空格");
  console.log("  404 / model not found  → model 名字不对，或 baseUrl 多/少写了 /v1");
  console.log("  400                    → baseUrl 指向了非 OpenAI 兼容路径");
  console.log("  ENOTFOUND / timeout    → 服务器出网有问题，或 baseUrl 写错域名");
  process.exit(1);
}
