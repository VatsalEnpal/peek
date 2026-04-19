/**
 * Emoji glyphs per SpanType. Zero-dependency, zero-weight "icon set" that
 * aligns with the design doc. Unknown types fall back to a neutral dot.
 *
 * Span type keys match the server enum verbatim (see server/pipeline/model.ts).
 */

export type SpanType =
  | 'user_prompt'
  | 'api_call'
  | 'thinking_block'
  | 'tool_call'
  | 'subagent'
  | 'skill_activation'
  | 'mcp_call'
  | 'memory_read'
  | 'hook_fire'
  | 'unknown';

const MAP: Record<string, string> = {
  user_prompt: '📝',
  api_call: '🌐',
  thinking_block: '💭',
  tool_call: '🔧',
  subagent: '🌳',
  skill_activation: '🎯',
  mcp_call: '🧩',
  memory_read: '📄',
  hook_fire: '🪝',
  unknown: '•',
};

export function iconFor(type: string): string {
  return MAP[type] ?? '•';
}

/**
 * Chip labels for the filter row — plural form, matches filter set keys.
 *
 * `matches` lists the server SpanType keys each chip governs. A chip covers
 * exactly the types listed; types not covered by any chip are always visible
 * (e.g. `unknown`).
 *
 * Notes:
 *   - `files` aggregates `memory_read`. File-reading `tool_call` spans (Read,
 *     Write, Edit, Glob, Grep) remain under `tools`; splitting them by tool
 *     name is a v0.3 concern and requires inspecting `span.name`.
 *   - `api` covers both assistant model replies (`api_call`) and thinking
 *     blocks, which are rendered with thresholds already.
 */
export const CHIP_DEFS: ReadonlyArray<{ key: string; label: string; matches: string[] }> = [
  { key: 'prompts', label: 'prompts', matches: ['user_prompt'] },
  { key: 'files', label: 'files', matches: ['memory_read'] },
  { key: 'skills', label: 'skills', matches: ['skill_activation'] },
  { key: 'hooks', label: 'hooks', matches: ['hook_fire'] },
  { key: 'api', label: 'api', matches: ['api_call', 'thinking_block'] },
  { key: 'tools', label: 'tools', matches: ['tool_call', 'mcp_call'] },
  { key: 'subagents', label: 'subagents', matches: ['subagent'] },
];
