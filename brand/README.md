# Brand imagery

Banners, social images and logo lockups built from [docs/design.md](../docs/design.md): the Frame idea, the person colors, Bricolage Grotesque, and the mark. Open `index.html` to see the whole set.

| Folder | Size | Contents |
| --- | --- | --- |
| `creem/` | 1920×400, 52×52 | Creem storefront banner (stack, spectrum, plain; light and dark) and logo, at exact size plus `@2x` |
| `og/` | 1200×630 | Link previews |
| `x/` | 1500×500 | X header (content kept right of the avatar) |
| `linkedin/` | 1584×396 | LinkedIn banner (content kept right of the avatar) |
| `github/` | 1280×640 | Repository social preview |
| `square/` | 1080×1080 | One Frame per person color, plus light and dark |
| `wide/` | 1920×1080 | Decks, video, desktop |
| `logo/` | — | Transparent wordmarks and the 512px app icon |

Images are 2x unless the name says otherwise; `creem/` files without `@2x` are the exact upload size.

## Regenerate

```bash
node brand/render.mjs          # everything
node brand/render.mjs creem    # only jobs whose name contains "creem"
```

The script uses Playwright's Chromium from `apps/web` and the Bricolage font from `node_modules`, so run `bun install` first. Copy lives at the bottom of `render.mjs`.
