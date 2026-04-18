/**
 * @peek/secretlint-rule-anthropic
 *
 * Detects Anthropic API keys in content. Exposed as a plain object
 * (not a real secretlint plugin) so peek-trace can run without the
 * heavy `@secretlint/*` dependency stack. If/when secretlint compat
 * becomes a requirement, this module can be wrapped into a proper
 * SecretLintRuleCreator.
 */

export type DetectionMatch = {
  start: number;
  end: number;
  pattern: string;
  matched: string;
};

export type AnthropicPattern = {
  name: string;
  regex: RegExp;
};

const patterns: AnthropicPattern[] = [
  {
    name: 'anthropic-api03',
    regex: /sk-ant-api03-[A-Za-z0-9_-]{32,}/g,
  },
  {
    name: 'anthropic-admin01',
    regex: /sk-ant-admin01-[A-Za-z0-9_-]{32,}/g,
  },
];

function detect(content: string): DetectionMatch[] {
  const results: DetectionMatch[] = [];
  for (const { name, regex } of patterns) {
    // Clone per call so the caller's regex state (lastIndex) is never shared.
    const re = new RegExp(regex.source, regex.flags);
    for (const m of content.matchAll(re)) {
      if (m.index === undefined) continue;
      const matched = m[0];
      results.push({
        start: m.index,
        end: m.index + matched.length,
        pattern: name,
        matched,
      });
    }
  }
  return results.sort((a, b) => a.start - b.start);
}

export const anthropicRule = {
  id: '@peek/secretlint-rule-anthropic',
  patterns,
  detect,
};
