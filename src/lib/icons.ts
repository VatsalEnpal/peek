/**
 * Emoji glyphs per SpanType. Zero-dependency, zero-weight "icon set" that
 * aligns with the design doc. Unknown types fall back to a neutral dot.
 */

export type SpanType =
  | 'user'
  | 'prompt'
  | 'file'
  | 'skill'
  | 'hook'
  | 'api'
  | 'tool'
  | 'subagent'
  | 'attachment'
  | 'system'
  | 'thinking';

const MAP: Record<string, string> = {
  user: '📝',
  prompt: '📝',
  file: '📄',
  skill: '🎯',
  hook: '🪝',
  api: '🌐',
  tool: '🔧',
  subagent: '🌳',
  attachment: '📎',
  system: '⚙️',
  thinking: '💭',
};

export function iconFor(type: string): string {
  return MAP[type] ?? '•';
}

/** Chip labels for the filter row — plural form, matches filter set keys. */
export const CHIP_DEFS: ReadonlyArray<{ key: string; label: string; matches: string[] }> = [
  { key: 'prompts', label: 'prompts', matches: ['user', 'prompt'] },
  { key: 'files', label: 'files', matches: ['file', 'attachment'] },
  { key: 'skills', label: 'skills', matches: ['skill'] },
  { key: 'hooks', label: 'hooks', matches: ['hook'] },
  { key: 'api', label: 'api', matches: ['api'] },
  { key: 'tools', label: 'tools', matches: ['tool'] },
  { key: 'subagents', label: 'subagents', matches: ['subagent'] },
];
