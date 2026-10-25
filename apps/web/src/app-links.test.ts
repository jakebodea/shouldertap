import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

// iOS opens /join and /qr links in the app only when the site's
// apple-app-site-association names the app exactly as the Xcode project
// builds it, and the app's entitlements claim the domain.
const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf-8");

const association = JSON.parse(
  read("../public/.well-known/apple-app-site-association")
);
const project = read("../../ios/Shouldertap.xcodeproj/project.pbxproj");
const entitlements = read("../../ios/Shouldertap.entitlements");

/** Team-qualified ids of the iPhone app, from its Xcode build settings. */
const xcodeAppIds = () => {
  const [team] = new Set(
    [...project.matchAll(/DEVELOPMENT_TEAM = (?<team>\w+);/gu)].map(
      (m) => m.groups?.team
    )
  );
  const bundles = [
    ...project.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = (?<id>[\w.]+);/gu),
  ]
    .map((m) => m.groups?.id ?? "")
    .filter((id) => !id.endsWith(".widgets"));
  return [...new Set(bundles)].map((id) => `${team}.${id}`).toSorted();
};

describe("iPhone app links", () => {
  it("name the app the Xcode project builds, which claims the domain", () => {
    expect(entitlements).toContain("<string>applinks:shouldertap.app</string>");
    expect(xcodeAppIds()).toStrictEqual([
      "6C46GY4Z38.app.shouldertap.iphone",
      "6C46GY4Z38.app.shouldertap.iphone.debug",
    ]);
    expect(association.applinks.details[0].appIDs.toSorted()).toStrictEqual(
      xcodeAppIds()
    );
  });

  it("cover invite and computer sign-in links", () => {
    expect(
      association.applinks.details[0].components.map(
        (component: { "/": string }) => component["/"]
      )
    ).toStrictEqual(["/join", "/qr"]);
  });
});
