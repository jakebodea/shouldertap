# Bundled fonts

All are licensed under the SIL Open Font License 1.1 (no Reserved Font Names); each family's license is the `OFL*.txt` beside it, and every file carries its copyright and license in its name table. The Mac app registers them through `ATSApplicationFontsPath`; the Windows app compiles them in (`apps/windows/app/src/assets.rs`).

| Files | Family | Source | Used by |
| --- | --- | --- | --- |
| `BricolageGrotesque-*.ttf` | Bricolage Grotesque | [ateliertriay/bricolage](https://github.com/ateliertriay/bricolage) | Default and every app surface (`OFL.txt`) |
| `InstrumentSerif-Regular.ttf`, `-Italic.ttf` | Instrument Serif | [google/fonts `ofl/instrumentserif`](https://github.com/google/fonts/tree/main/ofl/instrumentserif) | Broadsheet |
| `BigShouldersDisplay-Black.ttf`, `-Bold.ttf` | Big Shoulders Display | [google/fonts `ofl/bigshouldersdisplay`](https://github.com/google/fonts/tree/main/ofl/bigshouldersdisplay) | Billboard |
| `VT323-Regular.ttf` | VT323 | [google/fonts `ofl/vt323`](https://github.com/google/fonts/tree/main/ofl/vt323) | Terminal |
| `GeistMono-Medium.ttf`, `-Bold.ttf` | Geist Mono | [google/fonts `ofl/geistmono`](https://github.com/google/fonts/tree/main/ofl/geistmono) | Terminal status bar |
| `Caveat-Bold.ttf` | Caveat | [google/fonts `ofl/caveat`](https://github.com/google/fonts/tree/main/ofl/caveat) | Note |

Static weights were cut from the variable sources with `fonttools varLib.instancer --update-name-table` (Big Shoulders Display 900 and 700, Geist Mono 500 and 700, Caveat 700).
