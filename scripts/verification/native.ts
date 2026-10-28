/* eslint-disable promise/avoid-new, no-await-in-loop -- Sequential UI/readiness steps and Node child-process events are actual external boundaries. */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { digest } from "./environment";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for native verification`);
  }
  return value;
};
const run = required("SHOULDERTAP_VERIFY_RUN");
const api = required("SHOULDERTAP_SERVER_URL");
const web = required("SHOULDERTAP_WEB_URL");
const token = required("SHOULDERTAP_VERIFY_TOKEN");
const command = required("SHOULDERTAP_DEVICE_COMMAND");
const target: string[] = JSON.parse(required("SHOULDERTAP_DEVICE_ARGS"));
if (!Array.isArray(target) || !target.every((arg) => typeof arg === "string")) {
  throw new Error(
    "Device arguments must be a JSON string array from device_open"
  );
}
const udid = target[target.indexOf("--udid") + 1];
if (!target.includes("--udid") || !udid) {
  throw new Error("Device launcher must target one leased shared simulator");
}
const exchange = required("SHOULDERTAP_VERIFY_EXCHANGE");
const evidence = required("SHOULDERTAP_VERIFY_ARTIFACTS");
const bundle = "app.shouldertap.iphone.debug";
const launchArgs = [
  "--verify-run",
  run,
  "--verify-api",
  api,
  "--verify-web",
  web,
].map((arg) => `--launch-args=${arg}`);
let failure: unknown;
let interrupted = false;
let cleaning = false;
let installed = false;
let validatedSimulator = false;
const activeChildren = new Set<ReturnType<typeof spawn>>();
const signalChild = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals
) => {
  if (
    !child.pid ||
    ((child.exitCode !== null || child.signalCode !== null) &&
      signal !== "SIGKILL")
  ) {
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
};
const interrupt = () => {
  interrupted = true;
  failure ??= new Error("Native verification interrupted");
  const children = [...activeChildren];
  for (const child of children) {
    signalChild(child, "SIGTERM");
  }
  setTimeout(() => {
    for (const child of children) {
      signalChild(child, "SIGKILL");
    }
  }, 3000).unref();
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const pause = (ms = 750) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const execute = async (
  executable: string,
  args: string[],
  env = process.env,
  input?: string
): Promise<string> => {
  if (interrupted && !cleaning) {
    throw new Error("Native verification interrupted");
  }
  const child = spawn(executable, args, {
    env,
    detached: true,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (input !== undefined) {
    child.stdin?.end(input);
  }
  activeChildren.add(child);
  let timedOut = false;
  const deadline = setTimeout(
    () => {
      timedOut = true;
      signalChild(child, "SIGKILL");
    },
    executable === "xcodebuild" ? 600_000 : 30_000
  );
  const chunks: Buffer[] = [];
  child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => chunks.push(chunk));
  let code: number;
  try {
    code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
  } finally {
    clearTimeout(deadline);
    activeChildren.delete(child);
  }
  if (timedOut) {
    throw new Error(`${path.basename(executable)} ${args[0]} timed out`);
  }
  if (code !== 0) {
    throw new Error(
      `${path.basename(executable)} ${args[0]} failed: ${input ? Buffer.concat(chunks).toString().replaceAll(input, "[redacted]") : Buffer.concat(chunks).toString()}`
    );
  }
  return Buffer.concat(chunks).toString();
};
const device = (...args: string[]) => execute(command, [...args, ...target]);
const snapshot = () => device("snapshot", "--json");
const waitFor = async <T>(
  action: () => Promise<T | undefined>,
  label: string
): Promise<T> => {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (interrupted && !cleaning) {
      throw new Error("Native verification interrupted");
    }
    const result = await action();
    if (result !== undefined) {
      return result;
    }
    await pause();
  }
  throw new Error(`Timed out waiting for ${label}`);
};
// AX nodes are traversed rather than relying on coordinates or tree order.
const findNode = (
  tree: unknown,
  selector: string
): Record<string, unknown> | undefined => {
  if (!tree || typeof tree !== "object") {
    return undefined;
  }
  if (Array.isArray(tree)) {
    return tree.map((node) => findNode(node, selector)).find(Boolean);
  }
  const element = tree as Record<string, unknown>;
  if (
    [
      element.identifier,
      element.label,
      element.name,
      element.accessibilityIdentifier,
    ].includes(selector) &&
    (element.ref || element.id)
  ) {
    return element;
  }
  return Object.values(element)
    .map((child) => findNode(child, selector))
    .find(Boolean);
};
const node = async (selector: string) =>
  await waitFor(
    async () => findNode(JSON.parse(await snapshot()), selector),
    selector
  );
const ref = (element: Record<string, unknown>) =>
  `@${String(element.ref ?? element.id).replace(/^@/u, "")}`;
const click = async (selector: string) => {
  process.stdout.write(`UI click ${selector}\n`);
  await node(selector);
  return device(
    "click",
    selector === "Inbox" ? "text=Inbox" : `id=${selector}`,
    "--settle"
  );
};
const fill = async (selector: string, text: string) => {
  process.stdout.write(`UI fill ${selector}\n`);
  return execute(
    command,
    [
      "fill",
      ref(await node(selector)),
      "--text-stdin",
      "--no-record",
      "--settle",
      ...target,
    ],
    process.env,
    text
  );
};
let browser: ReturnType<typeof spawn> | undefined;
let browserDone: Promise<number> | undefined;
try {
  const inventory = JSON.parse(
    await execute("xcrun", ["simctl", "list", "devices", "--json"])
  ) as {
    devices: Record<string, { udid: string; name: string; state: string }[]>;
  };
  const simulator = Object.values(inventory.devices)
    .flat()
    .find((item) => item.udid === udid);
  if (
    !simulator ||
    !["agent-sim-1", "agent-sim-2", "agent-sim-3", "agent-sim-ipad"].includes(
      simulator.name
    ) ||
    simulator.state !== "Booted"
  ) {
    throw new Error(
      "Native verification requires an already leased, booted shared simulator from device_open"
    );
  }
  validatedSimulator = true;
  const build = path.join(path.dirname(exchange), "ios-build");
  const app = path.join(
    build,
    "Build/Products/Debug-iphonesimulator/Shouldertap.app"
  );
  await execute("xcodebuild", [
    "-quiet",
    "-project",
    "apps/ios/Shouldertap.xcodeproj",
    "-scheme",
    "ShouldertapIOS",
    "-configuration",
    "Debug",
    "-onlyUsePackageVersionsFromResolvedFile",
    "-destination",
    `platform=iOS Simulator,id=${udid}`,
    "-derivedDataPath",
    build,
    "CODE_SIGNING_ALLOWED=YES",
    "CODE_SIGN_IDENTITY=-",
    "build",
  ]);
  const executable = path.join(app, "Shouldertap");
  writeFileSync(
    path.join(evidence, "native-binary.json"),
    JSON.stringify({ sha256: digest(readFileSync(executable)), run, bundle })
  );
  await device("install", bundle, app);
  installed = true;
  await device("open", bundle, "--relaunch", ...launchArgs);
  await click("welcome-start");
  const email = `native-${run}@example.com`;
  await fill("email-field", email);
  await click("send-code");
  const otp = await waitFor(async () => {
    const response = await fetch(
      `${api}/__verify/mail?email=${encodeURIComponent(email)}`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10_000),
      }
    );
    if (!response.ok) {
      return;
    }
    const mail = (await response.json()) as { text: string };
    return mail.text.match(/\b\d{6}\b/u)?.[0];
  }, "sign-in mail");
  try {
    await fill("code-field", otp);
  } catch (error) {
    // Auto-submitting OTP fields disappear before the tool's read-back.
    // Accept that tool result only when real sign-in reached profile setup.
    if (
      !(error instanceof Error) ||
      !error.message.includes("TEXT_ENTRY_MISMATCH")
    ) {
      throw error;
    }
    await node("name-field");
  }
  await fill("name-field", "Verification Receiver");
  await click("profile-continue");
  await click("notifications-skip");
  await click("Inbox");
  await click("invite-someone");
  const inviteNode = await node("invite-qr");
  const invite = String(inviteNode.value ?? "");
  if (!invite.startsWith(web) || !new URL(invite).hash) {
    throw new Error("Native invite did not point to this run's website");
  }
  writeFileSync(exchange, JSON.stringify({ invite }), { mode: 0o600 });
  const browserChild = spawn(
    "bun",
    ["run", "--cwd", "apps/web", "test:verify"],
    {
      env: { ...process.env, SHOULDERTAP_VERIFY_NATIVE: "1" },
      detached: true,
      stdio: "inherit",
    }
  );
  browser = browserChild;
  activeChildren.add(browserChild);
  const browserDeadline = setTimeout(
    () => signalChild(browserChild, "SIGKILL"),
    300_000
  );
  browserDone = new Promise<number>((resolve) => {
    browserChild.on("error", () => {
      clearTimeout(browserDeadline);
      activeChildren.delete(browserChild);
      resolve(1);
    });
    browserChild.on("close", (code) => {
      clearTimeout(browserDeadline);
      activeChildren.delete(browserChild);
      resolve(code ?? 1);
    });
  });
  await waitFor(
    () =>
      Promise.resolve(existsSync(`${exchange}.sent.json`) ? true : undefined),
    "browser send"
  );
  const sent = JSON.parse(readFileSync(`${exchange}.sent.json`, "utf-8")) as {
    tapId?: unknown;
    body?: unknown;
  };
  if (
    typeof sent.tapId !== "string" ||
    !sent.tapId ||
    sent.body !== "Verification native foreground tap"
  ) {
    throw new Error("Browser did not identify the expected tap");
  }
  const { tapId } = sent;
  await waitFor(async () => {
    const element = findNode(JSON.parse(await snapshot()), "takeover-message");
    return element?.label === "Verification native foreground tap" &&
      element.value === tapId
      ? true
      : undefined;
  }, "native rendered tap ID and exact message");
  await device("screenshot", path.join(evidence, "native-receive.png"));
  await waitFor(
    () =>
      Promise.resolve(
        existsSync(`${exchange}.displayed.json`) ? true : undefined
      ),
    "app-originated displayed receipt"
  );
  const displayed = JSON.parse(
    readFileSync(`${exchange}.displayed.json`, "utf-8")
  ) as { tapId?: unknown };
  if (displayed.tapId !== tapId) {
    throw new Error("Displayed receipt belongs to a different tap");
  }
  await click("takeover-on-it");
  if ((await browserDone) !== 0) {
    throw new Error("Browser did not observe the native reply");
  }
  await waitFor(
    async () =>
      findNode(JSON.parse(await snapshot()), "takeover-message") === undefined
        ? true
        : undefined,
    "native takeover dismissal"
  );
  writeFileSync(
    path.join(evidence, "native-result.json"),
    JSON.stringify({
      tapId,
      message: "Verification native foreground tap",
      reply: "On it",
      appDisplayed: true,
      appDismissed: true,
    })
  );
} catch (error) {
  failure = error;
} finally {
  cleaning = true;
  if (browser && browser.exitCode === null && browser.signalCode === null) {
    signalChild(browser, "SIGTERM");
    await Promise.race([browserDone, pause(3000)]);
    signalChild(browser, "SIGKILL");
    await Promise.race([browserDone, pause(1000)]);
  }
  try {
    if (installed) {
      await device(
        "open",
        bundle,
        "--relaunch",
        ...launchArgs,
        "--launch-args=--verify-clear",
        "--launch-args=1"
      );
      await device("close", bundle);
    }
  } catch (error) {
    failure ??= error;
  }
  if (installed) {
    try {
      await device("uninstall", bundle);
    } catch (error) {
      failure ??= error;
    }
  }
  if (
    validatedSimulator &&
    process.env.SHOULDERTAP_VERIFY_SHUTDOWN_SIM === "1"
  ) {
    try {
      await execute("xcrun", ["simctl", "shutdown", udid]);
    } catch (error) {
      failure ??= error;
    }
  }
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}

if (failure) {
  throw failure;
}
