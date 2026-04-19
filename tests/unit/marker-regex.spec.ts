/**
 * Marker regex — L1.3 unit coverage.
 *
 * The v0.2.1 plan specifies a single regex that must recognise BOTH the new
 * slash-command shape (`/peek_start NAME`) and the legacy text fallback
 * (`@peek-start NAME`). It is intentionally strict (anchored, single line) so
 * plain-prose mentions don't register markers:
 *
 *   /^\s*(?:@|\/)peek[-_](start|end)(?:\s+(.+))?\s*$/i
 *
 * `matchMarker(text)` returns `{ type: 'start'|'end', name?: string } | null`.
 *
 * The 12 cases below document exactly what matches and what doesn't. They
 * constitute the contract L1.3 depends on.
 */

import { describe, test, expect } from 'vitest';

import { matchMarker } from '../../server/bookmarks/marker-detector';

describe('matchMarker (v0.2.1 L1.3)', () => {
  test('1. /peek_start NAME matches start with name', () => {
    expect(matchMarker('/peek_start investigate-leak')).toEqual({
      type: 'start',
      name: 'investigate-leak',
    });
  });

  test('2. @peek-start NAME matches start with name', () => {
    expect(matchMarker('@peek-start investigate-leak')).toEqual({
      type: 'start',
      name: 'investigate-leak',
    });
  });

  test('3. /peek_end matches end with no name', () => {
    expect(matchMarker('/peek_end')).toEqual({ type: 'end' });
  });

  test('4. @peek-end matches end with no name', () => {
    expect(matchMarker('@peek-end')).toEqual({ type: 'end' });
  });

  test('5. case-insensitive: /PEEK-START matches', () => {
    expect(matchMarker('/PEEK-START Foo')).toEqual({ type: 'start', name: 'Foo' });
  });

  test('6. leading/trailing whitespace + multi-word name preserved', () => {
    expect(matchMarker('  @peek-start  name with spaces  ')).toEqual({
      type: 'start',
      name: 'name with spaces',
    });
  });

  test('7. /peek_start with no name is a valid unlabeled start', () => {
    expect(matchMarker('/peek_start')).toEqual({ type: 'start' });
  });

  test('8. /peek_start with trailing whitespace only is still unlabeled', () => {
    expect(matchMarker('/peek_start   ')).toEqual({ type: 'start' });
  });

  test('9. malformed @peek-start-broken does NOT match', () => {
    expect(matchMarker('@peek-start-broken')).toBeNull();
  });

  test('10. hyphen/underscore are interchangeable on both sigils', () => {
    expect(matchMarker('@peek_start hello')).toEqual({ type: 'start', name: 'hello' });
    expect(matchMarker('/peek-start hello')).toEqual({ type: 'start', name: 'hello' });
    expect(matchMarker('@peek_end')).toEqual({ type: 'end' });
    expect(matchMarker('/peek-end')).toEqual({ type: 'end' });
  });

  test('11. mixed case inside the name is preserved verbatim', () => {
    expect(matchMarker('/Peek_Start MyCoolName')).toEqual({
      type: 'start',
      name: 'MyCoolName',
    });
  });

  test('12. plain prose mentioning peek-start does NOT match (anchored)', () => {
    // Rejection cases: inline inside prose, wrong sigil, typos.
    expect(matchMarker('I will @peek-start later')).toBeNull();
    expect(matchMarker('peek-start foo')).toBeNull(); // no sigil
    expect(matchMarker('/peekstart foo')).toBeNull(); // missing separator
    expect(matchMarker('/peek_starter')).toBeNull(); // suffix typo
    expect(matchMarker('')).toBeNull();
  });
});
