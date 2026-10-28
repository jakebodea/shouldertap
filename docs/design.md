# Design

The visual system for every Shouldertap surface: the Mac overlay, the Mac menu bar, the Safari sender, and the landing page. The [Notion concept document](https://www.notion.so/3eb7155b453881c7bc4cdc8ef57d87e2) is the product source of truth.

## The idea: Frame

Every sender picks a color when they pair. **Their color frames a calm paper page.** Words on the page are always ink on paper, so the message carries the weight and the color says who it is from across the room. Shouldertap itself stays neutral (ink and paper) and borrows the color of whoever is tapping.

## Color

Neutrals (paper world):

| Token   | Value     | Use                               |
| ------- | --------- | --------------------------------- |
| `paper` | `#f6f5f1` | Page ground inside every frame    |
| `faint` | `#ebe9e3` | Fields, answer cards, quiet fills |
| `line`  | `#dedcd5` | Hairlines, outline pills          |
| `tone`  | `#6f6e69` | Secondary text on paper           |
| `ink`   | `#161616` | Primary text on paper             |

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
- **Pills:** every action is a pill (`border-radius: 999px`). Primary = person color fill with its ink; secondary = 1.5px `line` outline, ink text, outline darkens to ink on hover. The one exception is a decline directly under a primary ("Not now", "Back"): ink text, no fill, sized to its label, never full width.
- **Fields:** `faint` fill, radius 18px, 17px text, no border.
- **Answer card:** `faint` fill, radius 16px, icon + answer + tabular meta.
- **Progress track:** three 5px segments (Sent, On screen, Answered) in the person color; the current step pulses.
- **Avatars:** circle in the person's `base` with the initial in their `ink`.
- No cards-in-cards, no colored side borders, no gradient text, no glass as decoration, no eyebrow labels above headings, no emoji.

## Icons

Hugeicons stroke (`@hugeicons/react` + `@hugeicons/core-free-icons`), 1.5 stroke, `currentColor`. Standard glyphs: `Tick02Icon` (On it), `Clock01Icon` (In 10 min), `BubbleChatIcon` (Reply), `SentIcon` (Send), `ArrowLeft01Icon` (Back), `UserAdd01Icon` (Invite), `ComputerIcon` (Mac), `Link01Icon` (Add Mac), `Delete02Icon` (Remove), `Copy01Icon` (Copy), `Cancel01Icon` (Close).

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

## Tap themes

A sender chooses how the taps they send look (`TapTheme`), per person they tap, from the Style row under the composer (web, Mac, Windows) or, on iPhone, in how that person sees them (Settings). Default is the Frame above, free for everyone. The others, for senders with active patron support, are whole compositions, not textures over the Frame. Each tap carries its own sender's theme, so a recipient can see different styles from different people; the recipient can reduce motion, for free:

- **Broadsheet:** cream newsprint (`#f2ede1`, ink `#1b1813`) inside a 16px sender-color border. Their name is an Instrument Serif italic nameplate between date and age ears, over a 7px + 2px double rule in their color. The message is the headline (Instrument Serif, 0.96 line height); answers sit in a ruled sidebar: "On it" (filled in their color), "In ten minutes", "Write back". Nothing else goes in the sidebar: no explanatory or invented copy.
- **Billboard:** the whole display in their color with their ink. Name up a rail, message in Big Shoulders Display 900 capitals anchored bottom-left, "Tap from {name}" kicker, three answer blocks across the foot.
- **Terminal:** a dark field tinted by their color (16% into `#060708`), phosphor text (38% into `#f1fff3`) in VT323, a status bar in their color (Geist Mono), `$ tap --from {name}`, a bracketed `[1] on it` menu, static scanlines.
- **Note:** a cream sheet (`#fbf8ee`) taped to a desk in their color, written in Caveat in blue-black ink on ruled lines, signed "— {name}", tick-box answers with a highlighter in their color; a second sheet peeks out when more taps wait.

No theme adds branding, watermarks, badges or advertising to a received tap. Motion: every arrival settles in about a second and nothing loops. Broadsheet's rules draw and its headline words rise from their line masks; Billboard wipes in its color and punches each word; Terminal powers on and prints, its cursor blinks three times and stops; Note settles the sheet and writes the words. Reduced motion (the system's, or the recipient's "Always reduce") is a 160ms fade into the settled screen for every theme. On Windows, GPUI can't rotate or scale, so the Mac's tilted sheet, sideways name and scale punches become level sheets, stacked letters and rises.

On iPhone the takeover (app open) and the Live Activity (Lock Screen and the expanded Dynamic Island) are phone-sized takes on the same compositions (`ThemedTakeover.swift`, `TapLiveActivity.swift`, shared faces and colors in `TapThemeStyle.swift`): the same type, palette and answer controls, laid out for portrait, with the takeover's usual rise and no theme-specific arrival. Billboard keeps its blocks, Terminal its bracketed menu and scanlines, Note its tick boxes and tilted sheet; the island draws the message in the theme's type on its black. The tap's notification banner (Live Activities off) is the system's and stays plain.

## Surfaces

- **Overlay (Mac, every display):** Frame in sender color; top band: sender name (700, 36px) + time + "N more waiting". Page: message 800 at 156→80px by length, left-aligned, then reply pills (On it filled in sender color, In 10 min, Reply) with key hints 1/2/3. Reply mode: pill field + Send + Back.
- **Mac install and welcome:** the DMG window is paper with "Drag Shouldertap into Applications" and a Cobalt arrow from the app to Applications (`apps/macos/scripts/dmg-background.swift`). First launch, before setup, shows a centered 860×600 window (Windows: 520×720, the same steps) framed in Cobalt (the real menu bar icon knocks meanwhile): wordmark on the band beside the traffic lights, "Welcome to Shouldertap." on the page, then email, code, name and color, a patron step when checkout is open ("Help keep Shouldertap free.", their tap cycling through the four themes, Become a patron, Maybe later), and "Open the menu". The close button and esc are "Later". Opened from the disk image, the primary pill moves the app to Applications and relaunches it.
- **Menu bar popover (Windows: the tray flyout, same layout):** native surface, system font. Header (mark, "Shouldertap", "Taps for {name}", connection status, ink "Invite someone" button). Below it two panes: **Send** (everyone you can tap with their latest status, each opening the Send window; "Got a link? Paste it" at the foot) and **Received** (taps you got: avatar, message, answer with icon; who can tap you as avatars by the title). A bottom bar holds Settings, Check for Updates (or Update to the available version), and Quit. Settings replaces the panes: Can tap you, Your devices, Tap motion (opens the Tap Appearance window), Account, Open at login, Patron themes (Become a patron or Manage billing, Choose tap style).
- **Sender (Safari):** the sender's own color frames the phone. Join: name, color picker, live preview of how taps look on the recipient's Mac. Compose: title "Tap {recipient}", live status, one field (the draft persists), full-width send pill, a "Style {theme} ›" row, recent taps with progress track or answer card (a themed tap shows its theme name by the time), unpair link. Style ("Tap style for {recipient}", for the person the composer shows): a large live preview of the chosen theme with the sender's name, color and draft, Replay, the five themes as live thumbnails (Free / Patrons), "Use {theme}", and a Patron section (price, Become a patron, Manage billing, Add another device, Have a code).
- **Sender (iOS app):** same Frame, with navigation on the frame's top edge in the color's ink (wordmark, Back pill, three-segment step track, close; no system bars). Onboarding: welcome (a sample tap cycling people and colors), get the Mac app, get an invite (a looping menu-bar demo), name and color, then the page drops away and the full-screen color knocks the mark twice. Composer: everyone you can tap as avatars on the frame (tap to switch, the color floods in; long-press for their page in Settings), add someone beside them, and the person icon; the page rises into place. Every frame bar after onboarding carries one person icon, Settings: a paper sheet (`.sheetOnPaper()`, system list rows) with You (name, color and reply options for everyone from now on), "You tap" and "Can tap you" as two sections (the server can't link the two directions) and Add someone, Devices (this iPhone, computers, Sign in on a computer), Notifications, Support Shouldertap (US storefront only), Help and privacy, and Account (email, Sign out, Delete account). A person's page: avatar and name, "How {name} sees you" (preview, Name, Color, Tap style; one editor with the color grid and the five themes as compact static cards, the paid ones locked with "Patrons" for non-patrons), and "Remove {name}", which also deletes your taps to them. The Inbox tab keeps your taps and the invite card. When someone accepts your invite, "You're now connected with {name}" asks once how they see you (Save, or Skip to keep it), one person at a time.
- **Sender (Mac and Windows):** the menu's Send pane lists everyone you can tap (avatar, latest status) and opens the Send window: the sender's color frames it, with people as ink chips on the frame's top edge and Add someone beside them. Page: invite link, name and color with a live preview; or "Tap {recipient}", live status, the field (Ctrl/⌘+Enter sends), the color send pill, a Style row ("How {recipient} sees it"; live thumbnail; opens "Tap style for {recipient}": preview, Replay, five themes, Use or Become a patron), an occasional "Enjoying Shouldertap?" card after sending, recent taps with progress track or answer card, and Options (Unpair, Delete my data).
- **Landing (`/` when not paired):** the page is a live tap. Frame cycles through people and their messages; the visitor can answer (click or 1/2/3). Nav sits on the frame's top edge; the pitch sits under the message on the page.
