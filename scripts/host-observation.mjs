// Summarize a Claude host's stream-json trace without treating prose as tool
// execution or a Skill request as proof of which Skill version was loaded.
// Pure/offline: callers own provenance, launching, receipts and assessment.

/** @param {string} text */
export function observeHostTrace(text) {
  const seen = new Set();
  /** @type {Record<string, number>} */
  const calls = {};
  let toolCalls = 0;
  let skillRequested = false;
  let unparsed = 0;
  /** @type {Record<string, number> | null} */
  let usage = null;
  /** @type {number | null} */
  let cost = null;
  /** @type {boolean | null} */
  let succeeded = null;
  for (const line of text.split('\n').filter((line) => line.trim())) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      unparsed += 1;
      continue;
    }
    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type !== 'tool_use' || typeof block.id !== 'string' || seen.has(block.id)) continue;
        seen.add(block.id);
        toolCalls += 1;
        if (block.name === 'Skill' && /(?:^|:)severally$/.test(block.input?.skill ?? '')) skillRequested = true;
        const name = typeof block.name === 'string' ? block.name.match(/^mcp__severally__(consult_\w+)$/)?.[1] : null;
        if (name) calls[name] = (calls[name] ?? 0) + 1;
      }
    }
    if (event?.type === 'result') {
      succeeded = typeof event.is_error === 'boolean' ? !event.is_error : null;
      cost =
        typeof event.total_cost_usd === 'number' && Number.isFinite(event.total_cost_usd) && event.total_cost_usd >= 0
          ? event.total_cost_usd
          : null;
      const values = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].flatMap((key) =>
        typeof event.usage?.[key] === 'number' && Number.isFinite(event.usage[key]) && event.usage[key] >= 0
          ? [[key, event.usage[key]]]
          : [],
      );
      usage = values.length ? Object.fromEntries(values) : null;
    }
  }
  return {
    tool_calls: toolCalls,
    consultation_calls: calls,
    skill_load_requested: skillRequested,
    skill_version_loaded: null,
    host_succeeded: succeeded,
    usage,
    cost_usd: cost,
    unparsed_lines: unparsed,
  };
}
