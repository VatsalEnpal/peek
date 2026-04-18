# peek-trace — Design notes

**Aesthetic:** terminal-adjacent, dense, monochrome with a single sharp accent. Think
`htop` crossed with a DAW track view — every pixel carries meaning, no decoration.

## Principles

- **Dark by default.** This runs alongside the editor. Light mode is out of scope for v0.1.
- **Monospace numerics.** Timestamps, token counts, durations, byte offsets — all
  numbers sit in a mono column and right-align so the eye can scan magnitude at a
  glance.
- **One accent.** `--peek-accent` (amber `#ffb454`) marks live/selected state only.
  Nothing else competes for attention.
- **No gradients, no glassmorphism, no drop-shadows.** Borders and background-tone
  shifts separate regions.
- **Grid-locked spacing** on a 4 px rhythm.

## Type

- Body + UI: **IBM Plex Sans** (system-fallback chain), 13 px.
- Numerics + code: **IBM Plex Mono**, 12 px, tabular figures.
- Display / timeline header: **IBM Plex Mono** at 11 px, uppercase, letter-spaced.

The font stack prefers the user's locally-installed IBM Plex; no webfont is shipped
(this is a privacy-local tool — no network calls for type).

## Color

| Token              | Hex       | Role                               |
| ------------------ | --------- | ---------------------------------- |
| `--peek-bg`        | `#0c0d10` | Canvas                             |
| `--peek-surface`   | `#14161b` | Raised panels (top bar, inspector) |
| `--peek-surface-2` | `#1b1e25` | Row hover / selected               |
| `--peek-border`    | `#242832` | 1 px separators                    |
| `--peek-fg`        | `#e6e8ec` | Primary text                       |
| `--peek-fg-dim`    | `#8b92a0` | Secondary text                     |
| `--peek-fg-faint`  | `#565c6a` | Tertiary / timestamps              |
| `--peek-accent`    | `#ffb454` | Selection, active record, focus    |
| `--peek-ok`        | `#7fc97f` | Context gauge ≤ 60 %               |
| `--peek-warn`      | `#e6c260` | Context gauge 60–85 %              |
| `--peek-bad`       | `#e86a6a` | Context gauge > 85 %, errors       |

## Layout

```
 ┌──────────────────────────────────────────────────────────────────┬─────────────┐
 │ [session ▾]   [● rec]   [chips …]                                │   inspector │
 ├──────────────────────────────────────────────────────────────────┤  (aside)    │
 │                                                                  │             │
 │  timeline (flat DOM, cascading rows, indent 2ch per depth)       │  sticky     │
 │                                                                  │  context    │
 │                                                                  │  gauge      │
 │                                                                  │             │
 └──────────────────────────────────────────────────────────────────┴─────────────┘
```

The inspector is collapsed by default and takes 420 px when open. The center
timeline fills remaining width.

## Icons

Plan calls for emoji glyphs per SpanType — kept as-is (no icon font, zero weight):
user 📝 · file 📄 · skill 🎯 · hook 🪝 · api 🌐 · tool 🔧 · subagent 🌳 ·
attachment 📎 · system ⚙️ · thinking 💭.

## Motion

- Inspector open/close: 140 ms `ease-out` on `transform: translateX`.
- Row hover: instant background swap (no transition) — this is a scan-heavy view.
- Accent indicator on selected row: 1 px left border in `--peek-accent`.

## Accessibility

- All interactive rows are real `<button>` elements so keyboard nav and screen
  readers both work.
- Focus ring is a 2 px outline in `--peek-accent` with 2 px offset. Never removed.
- The `?` help overlay is a `<dialog>` so it behaves natively with `esc`.
