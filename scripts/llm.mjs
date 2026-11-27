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

const CFG_FILE = path.join(path.resolve(process.cwd()), "config", "llm.json");

function loadConfig() {
  let file = {};
  try {
    if (fs.existsSync(CFG_FILE)) file = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
  } catch { /* 配置坏了就当没有 */ }

  const baseUrl = process.env.LLM_BASE_URL || file.baseUrl || "";
  const apiKey = process.env.LLM_API_KEY || file.apiKey || "";
  const model = process.env.LLM_MODEL || file.model || "";

  if (!baseUrl || !model) return null;
  // 本地 Ollama 不需要 key；云端没有 key 直接视为未配置
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost)/.test(baseUrl);
  if (!apiKey && !isLocal) return null;

  return {
    baseUrl: baseUrl.replace(/\/+$/, ""),
    apiKey,
    model,
    temperature: file.temperature ?? 0.3,
    maxTokens: file.maxTokens ?? 1200,
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
      const text = j?.choices?.[0]?.message?.content?.trim();
      if (!text) throw new Error("返回内容为空");
      return { ok: true, text, model: cfg.model, usage: j?.usage || null };
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return { ok: false, reason: lastErr?.message || "调用失败" };
}
