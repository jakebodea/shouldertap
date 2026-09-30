# Design

The visual system for every Shouldertap surface: the Mac overlay, the Mac menu bar, the Safari sender, and the landing page. The [Notion concept document](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the product source of truth.

## The idea: Frame

Every sender picks a color when they pair. **Their color frames a calm paper page.** Words on the page are always ink on paper, so the message carries the weight and the color says who it is from across the room. Shouldertap itself stays neutral (ink and paper) and borrows the color of whoever is tapping.

## Color

Neutrals (paper world):

| Token | Value | Use |
| --- | --- | --- |
| `paper` | `#f6f5f1` | Page ground inside every frame |
| `faint` | `#ebe9e3` | Fields, answer cards, quiet fills |
| `line` | `#dedcd5` | Hairlines, outline pills |
| `tone` | `#6f6e69` | Secondary text on paper |
| `ink` | `#161616` | Primary text on paper |

Dark mode (web only; the overlay stays paper): page `#18181a`, faint `#232326`, line `#34343a`, tone `#9a9994`, text `#f1f0ec`. Frames keep the person's color.

Person colors come from `packages/domain/src/colors.ts` (`swatches`), shared by web and Mac. Each has a `base` (the frame) and an `ink` (text/icons placed directly on the frame): Moss, Cobalt, Plum, Tomato, Ochre, Rose, Sky, Graphite. Never put person colors on text over paper; they appear as fields (frames, filled primary buttons, avatars, progress).

Status: live `#2f9e5b`. Destructive uses the platform red.

## Type

**Bricolage Grotesque** (variable, `opsz` 12–96), self-hosted via `@fontsource-variable/bricolage-grotesque` on web and bundled in the Mac app for the overlay.

- Message (overlay, landing hero): 800, tracking −0.04em, line-height ~0.95, `opsz` 96. Size scales down with length.
- Titles: 700–800, tracking −0.02 to −0.035em.
- Body/UI: 500, 15–17px; secondary in `tone`.
- Numerals that change (times, durations): `tabular-nums`.

The Mac menu bar popover uses the system font (it is a native surface); Bricolage appears there only in the "Shouldertap" title.

## Shape and components

- **Frame:** person-colored ground with a paper page inset. Overlay: 40px frame, page radius 28px, sender name + time sit on the frame's top edge (96px band). Phone: 9px sides, page radius ~44px under the status bar.
- **Pills:** every action is a pill (`border-radius: 999px`). Primary = person color fill with its ink; secondary = 1.5px `line` outline, ink text, outline darkens to ink on hover.
- **Fields:** `faint` fill, radius 18px, 17px text, no border.
- **Answer card:** `faint` fill, radius 16px, icon + answer + tabular meta.
- **Progress track:** three 5px segments (Sent, On screen, Answered) in the person color; the current step pulses.
- **Avatars:** circle in the person's `base` with the initial in their `ink`.
- No cards-in-cards, no colored side borders, no gradient text, no glass as decoration, no eyebrow labels above headings, no emoji.

## Icons

Hugeicons stroke (`@hugeicons/react` + `@hugeicons/core-free-icons`), 1.5 stroke, `currentColor`. Standard glyphs: `Tick02Icon` (On it), `Clock01Icon` (In 10 min), `BubbleChatIcon` (Reply), `SentIcon` (Send), `ArrowLeft01Icon` (Back), `UserAdd01Icon` (Invite), `ComputerIcon` (Mac), `Link01Icon` (Add Mac), `Delete02Icon` (Remove), `Copy01Icon` (Copy).

## The mark

A frame whose top-right corner is one big round shoulder, with three knock marks landing on it. Stroke 5 (frame), 3.75 (marks), round caps and joins, `currentColor`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2.5 -8.65 44.65 44.65" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/><path d="M26.8 -3.08L29.19 -9.65" stroke-width="3.75"/><path d="M30.63 -0.63L35.58 -5.58" stroke-width="3.75"/><path d="M33.08 3.2L39.65 0.81" stroke-width="3.75"/></svg>
```

Wordmark: **Shouldertap**, one word, Bricolage 800, tracking −0.035em, mark at ~1.05em to its left. App icon: mark in a person's `ink` on their `base` (default Cobalt). Menu bar: template image of the mark; the knock marks animate (pop twice) when a tap arrives.

## Motion

- Overlay arrives with a 520ms fade (ease-out-expo) and leaves with fade + 1.5% scale + 6px blur over 420ms.
- The knock: marks scale from 0.4 and fade in twice over 900ms (staggered 60ms).
- Landing: the next person's color floods the frame from the top-left corner (clip-path circle, 700ms, ease-in-out); the message swaps with an 18px rise and blur.
- Respect reduced motion: drop scale, blur, and wipes; keep opacity.

## Surfaces

- **Overlay (Mac, every display):** Frame in sender color; top band: sender name (700, 36px) + time + "N more waiting". Page: message 800 at 156→80px by length, left-aligned, then reply pills (On it filled in sender color, In 10 min, Reply) with key hints 1/2/3. Reply mode: pill field + Send + Back.
- **Menu bar popover:** native vibrancy surface, system font. Header (mark, "Shouldertap", "Taps for {name}", connection status), ink "Invite someone" button, "Can tap you" (color avatars), "Your Macs", "Recent" (avatar, message, answer with icon), footer (Open at login, Quit).
- **Sender (Safari):** the sender's own color frames the phone. Join: name, color picker, live preview of how taps look on the recipient's Mac. Compose: title "Tap {recipient}", live status, one field, full-width send pill, recent taps with progress track or answer card, unpair link.
- **Landing (`/` when not paired):** the page is a live tap. Frame cycles through people and their messages; the visitor can answer (click or 1/2/3). Nav sits on the frame's top edge; the pitch sits under the message on the page.
