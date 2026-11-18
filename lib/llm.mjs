/**
 * llm.mjs —— 轻量版宿主模型调用（只为「生成发布草稿」服务）。
 *
 * 从 dsh-fish-soul-main/lib/llm.js 精简而来：
 *  - 用 ctx.get('llm') 的 stream()；
 *  - 默认模型取 ctx.get('agentDefaultModel').currentSelection()；
 *  - 拿不到模型就省略 provider/model，交给宿主决定；
 *  - 推理模型把额度花在思考上返回空 → 放大额度重试一次；失败/无模型返回 null（调用方有兜底）。
 */

const ROOMY_TOKENS = 8000;

export function createLlm({ ctx, log = () => {} } = {}) {
  const llm = () => {
    const l = ctx.get?.('llm') ?? ctx.llm;
    return l && typeof l.stream === 'function' ? l : null;
  };

  /** 宿主设置里的默认模型 { provider, model } 或 null。 */
  function hostDefault() {
    try {
      const s = ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (s && typeof s.provider === 'string' && s.provider !== '' && typeof s.model === 'string' && s.model !== '') {
        return { provider: s.provider, model: s.model };
      }
    } catch {
      /* 没配 */
    }
    return null;
  }

  function available() {
    return llm() !== null;
  }

  /**
   * 调一次模型，返回正文文本；失败 / 无模型返回 null。
   * @param {string} prompt
   * @param {{maxTokens?: number, temperature?: number, signal?: AbortSignal}} [opts]
   */
  async function complete(prompt, { maxTokens = 1600, temperature = 0.8, signal } = {}) {
    const client = llm();
    if (client === null) return null;
    const target = hostDefault(); // 可能为 null → 交宿主决定
    const once = async (budget) => {
      let out = '';
      let block = '';
      let finish = '';
      try {
        for await (const chunk of client.stream({
          ...(target ? { provider: target.provider, model: target.model } : {}),
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          maxTokens: budget,
          temperature,
          ...(signal ? { signal } : {}),
        })) {
          if (signal?.aborted) return { text: '', aborted: true };
          const type = String(chunk?.type ?? typeof chunk);
          if (type === 'text-delta') out += chunk.text ?? chunk.delta ?? '';
          else if (type === 'block-end') {
            const b = chunk.block ?? {};
            if (b.type === 'text') block += String(b.text ?? '');
          } else if (type === 'finish' || type === 'done') {
            const r = chunk.reason ?? chunk.finishReason;
            finish = typeof r === 'string' ? r : String(r?.kind ?? r?.unified ?? r?.type ?? '');
          } else if (type === 'error' || type === 'failure') {
            throw new Error(String(chunk.error?.message ?? chunk.message ?? 'stream error'));
          }
        }
      } catch (error) {
        log(`模型调用失败：${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
        return { text: '', error: true };
      }
      return { text: out.trim() || block.trim(), finish };
    };

    let r = await once(maxTokens);
    if (!r.aborted && r.text === '' && maxTokens < ROOMY_TOKENS) {
      // 空回复多半是额度花在思考上：放大额度再来一次
      r = await once(ROOMY_TOKENS);
    }
    if (r.aborted) return null;
    return r.text || null;
  }

  return { available, complete, hostDefault };
}
