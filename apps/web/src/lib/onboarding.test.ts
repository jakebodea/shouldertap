import { ApiError } from "@shouldertap/client";
import { describe, expect, it } from "vitest";

import {
  browserDeviceName,
  codeFailureMessage,
  codeFromPaste,
  codeFromScan,
  failureMessage,
  inviteFailure,
  inviteLink,
  otpDigits,
  safeRedirect,
  isIPhoneBrowser,
  isPhoneBrowser,
} from "./onboarding";

describe("the six-digit code field", () => {
  it("keeps only digits from a pasted code", () => {
    expect(otpDigits("123 456")).toBe("123456");
    expect(otpDigits("Your code: 12-34-56.")).toBe("123456");
  });

  it("stops at six digits", () => {
    expect(otpDigits("1234567890")).toBe("123456");
  });
});

describe("where sign-in returns to", () => {
  it("returns to a page on this site", () => {
    expect(safeRedirect("/account?intent=patron")).toBe(
      "/account?intent=patron"
    );
  });

  it("never leaves the site", () => {
    expect(safeRedirect("//evil.example/tap")).toBe("/tap");
    expect(safeRedirect("/\\evil.example")).toBe("/tap");
    expect(safeRedirect("https://evil.example")).toBe("/tap");
    expect(safeRedirect()).toBe("/tap");
  });
});

describe("invite links", () => {
  it("round-trips a code through the shared link", () => {
    const link = inviteLink(
      "https://shouldertap.app",
      "inboxAAA.inv12345.s3cret_x"
    );
    expect(link).toBe(
      "https://shouldertap.app/join#inboxAAA.inv12345.s3cret_x"
    );
    expect(codeFromPaste(` ${link} `)).toBe("inboxAAA.inv12345.s3cret_x");
    expect(codeFromScan(link)).toBe("inboxAAA.inv12345.s3cret_x");
  });

  it("accepts a bare code", () => {
    expect(codeFromPaste("inboxAAA.inv12345.s3cret_x")).toBe(
      "inboxAAA.inv12345.s3cret_x"
    );
  });

  it("ignores QR codes that aren't invites", () => {
    expect(codeFromScan("https://example.com/menu#today")).toBeNull();
    expect(codeFromScan("WIFI:S:home;T:WPA;P:secret;;")).toBeNull();
  });
});

describe("this browser's device name", () => {
  it("names Safari on an iPhone", () => {
    expect(
      browserDeviceName(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
        5
      )
    ).toBe("Safari on iPhone");
  });

  it("names Chrome on Windows", () => {
    expect(
      browserDeviceName(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
      )
    ).toBe("Chrome on Windows");
  });

  it("recognizes an iPad that reports itself as a Mac", () => {
    const desktopSafari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
    expect(browserDeviceName(desktopSafari, 5)).toBe("Safari on iPad");
    expect(browserDeviceName(desktopSafari, 0)).toBe("Safari on Mac");
  });
});

describe("phone browsers", () => {
  it("tells phones from computers and tablets", () => {
    expect(
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
        "Mozilla/5.0 (Linux; Android 15; Pixel Tablet) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      ].map(isPhoneBrowser)
    ).toStrictEqual([true, true, false, false]);
  });
});

describe("invites opened on an iPhone", () => {
  it("send iPhones, and only iPhones, to the App Store", () => {
    expect(
      [
        "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1",
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15",
      ].map(isIPhoneBrowser)
    ).toStrictEqual([true, false, false]);
  });
});

describe("failure wording", () => {
  it("explains a wrong or expired code", () => {
    expect(
      codeFailureMessage(new ApiError("invalid_request", "Invalid OTP", 400))
    ).toBe("That code didn't work. Check it or send a new one.");
  });

  it("keeps the server's reason for other refusals", () => {
    expect(
      codeFailureMessage(
        new ApiError("rate_limited", "Too many tries. Wait a minute.", 429)
      )
    ).toBe("Too many tries. Wait a minute.");
    expect(
      failureMessage(
        new ApiError("invalid_request", "That's your own invite", 400)
      )
    ).toBe("That's your own invite");
  });

  it("blames the connection when the server wasn't reached", () => {
    expect(failureMessage(new ApiError("network", "Load failed", 0))).toBe(
      "Couldn't reach Shouldertap. Check your connection and try again."
    );
  });
});

describe("an invite that won't open", () => {
  it("asks for a new link only when the server refused the code", () => {
    expect(
      inviteFailure(
        new ApiError("not_found", "This invite link isn't valid", 404)
      )
    ).toStrictEqual({
      title: "This invite doesn't work",
      message: "This invite link isn't valid. Ask them for a new link.",
      retry: false,
    });
  });

  it("offers a retry when the server wasn't reached", () => {
    expect(
      inviteFailure(new ApiError("network", "Load failed", 0))
    ).toStrictEqual({
      title: "Couldn't open this invite",
      message:
        "Couldn't reach Shouldertap. Check your connection and try again.",
      retry: true,
    });
  });
});

describe("personalized invite links", () => {
  it("shares public inviter details while keeping the pairing secret in the fragment", () => {
    const link = inviteLink("https://shouldertap.app", "inbox.id.secret", {
      name: "Jake & Ana",
      color: "moss",
    });
    expect(link).toBe(
      "https://shouldertap.app/join?from=Jake+%26+Ana&color=moss#inbox.id.secret"
    );
    expect(codeFromScan(link)).toBe("inbox.id.secret");
  });
});
