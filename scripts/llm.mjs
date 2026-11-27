/**
 * LLM 客户端（OpenAI 兼容协议）
 *
 * 支持任何 /v1/chat/completions 形态的服务：
 *   DeepSeek   https://api.deepseek.com                    deepseek-chat
 *   阿里百炼    https://dashscope.aliyuncs.com/compatible-mode/v1   qwen-plus
 *   月之暗面    https://api.moonshot.cn/v1                  moonshot-v1-8k
 *   智谱        https://open.bigmodel.cn/api/paas/v4        glm-4-flash
 *   本地 Ollama http://127.0.0.1:11434/v1                   qwen2.5:7b
 *
 * 配置优先级：环境变量 > config/llm.json > 无
 *   LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
 *
 * 没有配置时返回 null，调用方必须能降级到规则引擎。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CFG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "config", "llm.json");

function loadConfig() {
  let file = {};
  try {
    if (fs.existsSync(CFG_FILE)) file = JSON.parse(fs.readFileSync(CFG_FILE, "utf8").replace(/^\uFEFF/, ""));
  } catch { /* 配置坏了就当没有 */ }

  const baseUrl = process.env.LLM_BASE_URL || file.baseUrl || "";
  const apiKey = process.env.LLM_API_KEY || file.apiKey || "";
  const model = process.env.LLM_MODEL || file.model || "";

  if (!baseUrl || !model) return null;
  // 本地 Ollama 不需要 key；云端没有 key 直接视为未配置
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl);
  if (!apiKey && !isLocal) return null;

  return {
    // 容忍把完整的 /chat/completions 也写进 baseUrl 的情况
    baseUrl: baseUrl.replace(/\/+$/, "").replace(/\/chat\/completions$/, ""),
    apiKey,
    model,
    temperature: file.temperature ?? 0.3,
    maxTokens: file.maxTokens ?? 2048,
    timeoutMs: file.timeoutMs ?? 60000,
  };
}

export function llmConfigured() {
  return !!loadConfig();
}

export async function chat({ system, user }) {
  const cfg = loadConfig();
  if (!cfg) return { ok: false, reason: "未配置 LLM" };

  const url = `${cfg.baseUrl}/chat/completions`;
  const body = {
    model: cfg.model,
    temperature: cfg.temperature,
    max_tokens: cfg.maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  let lastErr = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${t.slice(0, 200)}`);
      }
      const j = await res.json();
      const choice = j?.choices?.[0] || {};
      const msg = choice.message || {};
      // 推理模型（deepseek-reasoner 等）正文在 content，思考过程在 reasoning_content；
      // 若 content 为空但 reasoning_content 有内容，说明思考把额度吃完了
      const text = String(msg.content || "").trim();
      if (!text) {
        const fr = choice.finish_reason || "?";
        const usage = JSON.stringify(j?.usage || {});
        // 推理模型：思考过程写满了额度，正文一个字没留。这种情况不能拿思考内容顶替
        const thinking = String(msg.reasoning_content || msg.reasoning || "").trim();
        const err = new Error(
          thinking
            ? `模型只返回了思考过程、正文为空（finish_reason=${fr}）——把 maxTokens 调到 4000 以上，或换成非推理模型（如 deepseek-chat）`
            : `返回内容为空（finish_reason=${fr}，usage=${usage}）`
        );
        err.detail = JSON.stringify(j).slice(0, 600);
        throw err;
      }
      return { ok: true, text, model: cfg.model, usage: j?.usage || null, finishReason: choice.finish_reason };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { ok: false, reason: (lastErr?.message || "调用失败") + (lastErr?.detail ? "\n原始响应：" + lastErr.detail : "") };
}
