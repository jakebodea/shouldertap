import { MAX_NAME_LENGTH, personColors, swatches } from "@shouldertap/domain";
import type { PersonColor } from "@shouldertap/domain";

/** Decorative, public URL data. Acceptance always looks up the secret separately. */
export const cardPerson = (url: URL) => {
  const name = (url.searchParams.get("from") ?? "").trim();
  const color = url.searchParams.get("color") as PersonColor;
  if (
    !name ||
    name.length > MAX_NAME_LENGTH ||
    [...name].some((char) => (char.codePointAt(0) ?? 0) < 32) ||
    !personColors.includes(color)
  ) {
    return null;
  }
  return { name, color };
};

export const escapeMarkup = (value: string) =>
  value.replaceAll(
    /[&<>"']/gu,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char] ?? char
  );

export const cardUrls = (
  url: URL,
  person: NonNullable<ReturnType<typeof cardPerson>>
) => {
  const canonical = new URL("/join", url.origin);
  canonical.searchParams.set("from", person.name);
  canonical.searchParams.set("color", person.color);
  const image = new URL("/invite-card.png", canonical);
  image.search = canonical.search;
  return { canonical: canonical.href, image: image.href };
};

export const personalizeInviteHtml = (html: string, url: URL) => {
  const person = cardPerson(url);
  if (!person) {
    return html;
  }
  const { canonical, image } = cardUrls(url, person);
  const title = `${person.name} invited you · Shouldertap`;
  const description = `Connect with ${person.name} on Shouldertap. Tap each other on the shoulder, and see when they answer.`;
  const values: Record<string, string> = {
    description,
    "og:title": title,
    "og:description": description,
    "og:url": canonical,
    "og:image": image,
    "og:image:alt": `${person.name} invited you, framed in ${swatches[person.color].label}.`,
  };
  return html
    .replace(
      /<title>[^<]*<\/title>/u,
      () => `<title>${escapeMarkup(title)}</title>`
    )
    .replaceAll(
      /<meta\s+content="[^"]*"\s+(?<attribute>name|property)="(?<key>[^"]+)"\s*\/>/gu,
      (tag, attribute: string, key: string) =>
        values[key]
          ? `<meta content="${escapeMarkup(values[key])}" ${attribute}="${key}" />`
          : tag
    );
};

/** Keep words together when possible, with a bounded split for unbroken names. */
export const inviteNameLines = (name: string) => {
  const chars = [...name];
  if (chars.length <= 22) {
    return [name];
  }
  const first = chars.slice(0, 22).join("");
  const space = first.lastIndexOf(" ");
  const split = space > 8 ? space : 22;
  return [
    chars.slice(0, split).join("").trim(),
    chars.slice(split).join("").trim(),
  ];
};

/** Same paper, frame, type and mark as the shipped share cards. */
export const inviteCardSvg = (
  person: NonNullable<ReturnType<typeof cardPerson>>,
  nameSize = 100
) => {
  const { base, ink } = swatches[person.color];
  const lines = inviteNameLines(person.name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="${base}"/>
    <g transform="translate(54 29) scale(.72)" fill="none" stroke="${ink}" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 0C23.59 0 30 6.41 30 27.5V28C30 31.07 29.07 32 26 32H4C0.93 32 0 31.07 0 28V4C0 0.93 0.93 0 4 0Z" stroke-width="5"/>
      <path d="M26.8 -3.08L29.19 -9.65M30.63 -.63L35.58 -5.58M33.08 3.2L39.65 .81" stroke-width="3.75"/>
    </g>
    <g font-family="Bricolage Grotesque" font-weight="800">
      <text x="94" y="56" font-size="30" fill="${ink}">Shouldertap</text>
      <rect x="24" y="84" width="1152" height="570" rx="30" fill="#f6f5f1"/>
      ${lines.map((line, index) => `<text x="80" y="${193 + index * 84}" font-size="${nameSize}" fill="#161616">${escapeMarkup(line)}</text>`).join("")}
      <text x="80" y="${lines.length > 1 ? 391 : 321}" font-size="112" letter-spacing="-4" fill="#161616">invited you.</text>
      <text x="80" y="${lines.length > 1 ? 462 : 411}" font-size="30" fill="#6f6e69">Connect on Shouldertap.</text>
      <path d="M80 535H1120" stroke="#dedcd5" stroke-width="1.5"/>
      <text x="80" y="588" font-size="28" fill="#161616">Tap each other on the shoulder.</text>
      <text x="1120" y="588" text-anchor="end" font-size="24" fill="#6f6e69">shouldertap.app</text>
    </g>
  </svg>`;
};
