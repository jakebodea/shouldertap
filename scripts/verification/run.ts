/* eslint-disable promise/avoid-new, no-await-in-loop -- Sequential UI/readiness steps and Node child-process events are actual external boundaries. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  assertDeployment,
  assertVerificationStage,
  digest,
  freePort,
  verificationStage,
} from "./environment";
import { protocolDiagnostics } from "./protocol-diagnostics";

const root = path.resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2).filter((arg: string) => arg !== "--");
const value = (name: string) => args[args.indexOf(name) + 1];
const git = (...command: string[]) =>
  execFileSync("git", command, { cwd: root, encoding: "utf-8" }).trim();
const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
const privateRoot = path.join(root, ".verification");
const safeEnv: Record<string, string | undefined> = {
  ...process.env,
  PULL_REQUEST: undefined,
  CREEM_API_KEY: undefined,
  CREEM_WEBHOOK_SECRET: undefined,
  CREEM_PRODUCT_ID: undefined,
  CREEM_PATRON_PRODUCT_ID: undefined,
  APNS_KEY: undefined,
  APNS_KEY_ID: undefined,
  APNS_TEAM_ID: undefined,
  POSTHOG_PROJECT_TOKEN: undefined,
};

const terminate = (child: ReturnType<typeof spawn>, grace: number) => {
  if (!child.pid) {
    return;
  }
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  setTimeout(() => {
    if (child.pid && child.exitCode === null) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  }, grace).unref();
};
const cleanup = async (stage: string, environment = safeEnv) => {
  assertVerificationStage(stage);
  const child = spawn(
    "bun",
    [
      "alchemy",
      "destroy",
      "alchemy.cleanup.ts",
      "--stage",
      stage,
      "--yes",
      "--env-file",
      "/dev/null",
    ],
    { cwd: root, env: environment, stdio: "inherit" }
  );
  const code = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => resolve(exitCode ?? 1));
  });
  if (code !== 0) {
    throw new Error(
      `Cleanup failed for ${stage}; rerun verify:cleanup -- --run ${stage}`
    );
  }
};

if (args[0] === "cleanup") {
  if (!args.includes("--run")) {
    throw new Error("cleanup requires --run <verification-stage>");
  }
  const cleanupEnv = { ...safeEnv };
  const stage = assertVerificationStage(value("--run") ?? "");
  const ownershipFile = path.join(privateRoot, stage, "ownership.json");
  if (existsSync(ownershipFile)) {
    const owner = JSON.parse(readFileSync(ownershipFile, "utf-8")) as {
      mode: string;
      accountId: string | null;
    };
    if (
      (owner.mode === "hosted") !== args.includes("--hosted") ||
      (owner.mode === "hosted" &&
        owner.accountId !== process.env.CLOUDFLARE_TEST_ACCOUNT_ID)
    ) {
      throw new Error(
        "Cleanup mode/account does not match the run ownership manifest"
      );
    }
  }
  if (args.includes("--hosted")) {
    if (
      !process.env.CLOUDFLARE_TEST_API_TOKEN ||
      !process.env.CLOUDFLARE_TEST_ACCOUNT_ID
    ) {
      throw new Error("Hosted cleanup requires CLOUDFLARE_TEST_* credentials");
    }
    cleanupEnv.CLOUDFLARE_API_TOKEN = process.env.CLOUDFLARE_TEST_API_TOKEN;
    cleanupEnv.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_TEST_ACCOUNT_ID;
  }
  await cleanup(value("--run") ?? "", cleanupEnv);
} else if (args[0] === "doctor") {
  for (const [name, command] of [
    ["Bun", ["bun", "--version"]],
    ["Git", ["git", "--version"]],
  ] as const) {
    execFileSync(command[0], command.slice(1));
    process.stdout.write(`PASS ${name}\n`);
  }
  process.stdout.write(
    `Source ${git("rev-parse", "HEAD")}\nLocal runs require the Alchemy Cloudflare profile; hosted runs require explicit test credentials (the existing account is supported).\nCore additionally requires a shared simulator and SHOULDERTAP_DEVICE_COMMAND/SHOULDERTAP_DEVICE_ARGS from device_open.\n`
  );
} else {
  const scenario = args.includes("--scenario") ? value("--scenario") : "core";
  if (!["core", "browser"].includes(scenario ?? "")) {
    throw new Error("scenario must be core or browser");
  }
  const hosted = args.includes("--hosted");
  if (
    hosted &&
    (!process.env.CLOUDFLARE_TEST_API_TOKEN ||
      !process.env.CLOUDFLARE_TEST_ACCOUNT_ID)
  ) {
    throw new Error(
      "Hosted verification requires CLOUDFLARE_TEST_API_TOKEN and CLOUDFLARE_TEST_ACCOUNT_ID; no production credential fallback"
    );
  }
  if (hosted && args.includes("--local")) {
    throw new Error("Choose local or hosted");
  }
  if (
    scenario === "core" &&
    (!process.env.SHOULDERTAP_DEVICE_COMMAND ||
      !process.env.SHOULDERTAP_DEVICE_ARGS)
  ) {
    throw new Error(
      "Core verification requires the device_open launcher. Browser-only verification is --scenario browser."
    );
  }
  const stage = verificationStage();
  const directory = path.join(privateRoot, stage);
  const evidence = path.join(root, ".artifacts", "verification", stage);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  mkdirSync(evidence, { recursive: true });
  const token = `st-verify-${randomBytes(32).toString("hex")}`;
  const head = git("rev-parse", "HEAD");
  const patch = git("diff", "HEAD", "--binary");
  const untracked = git("ls-files", "--others", "--exclude-standard")
    .split("\n")
    .filter(Boolean);
  const sourceDigest = digest(
    patch +
      untracked
        .map((file) => file + digest(readFileSync(path.join(root, file))))
        .join("\n")
  );
  const apiPort = await freePort();
  let webPort = await freePort();
  while (webPort === apiPort) {
    webPort = await freePort();
  }
  let server = `http://localhost:${apiPort}`;
  let web = `http://localhost:${webPort}`;
  const env = {
    ...safeEnv,
    ...(hosted
      ? {
          CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_TEST_API_TOKEN,
          CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_TEST_ACCOUNT_ID,
        }
      : {}),
    ALCHEMY_STAGE: stage,
    ALCHEMY_TEST_STAGE: stage,
    COMMIT_SHA: head,
    SHOULDERTAP_SOURCE_DIGEST: sourceDigest,
    SHOULDERTAP_VERIFY_TOKEN: token,
    SHOULDERTAP_VERIFY_RUN: stage,
    SHOULDERTAP_API_PORT: String(apiPort),
    SHOULDERTAP_WEB_PORT: String(webPort),
    SHOULDERTAP_WEB_ORIGIN: web,
    SHOULDERTAP_API_ORIGIN: server,
    SHOULDERTAP_VERIFY_EVIDENCE: evidence,
    SHOULDERTAP_VERIFY_ARTIFACTS: evidence,
    SHOULDERTAP_VERIFY_REPORT: path.join(directory, "browser-report.json"),
    SHOULDERTAP_VERIFY_OUTPUT: path.join(directory, "browser-output"),
    SHOULDERTAP_VERIFY_EXCHANGE: path.join(directory, "exchange.json"),
  };
  let active: ReturnType<typeof spawn> | undefined;
  let aborted = false;
  let activeGraceMs = 3000;
  const results: {
    name: string;
    exitCode: number;
    durationMs: number;
    log: string;
    sha256: string;
  }[] = [];
  const run = async (name: string, command: string[], extraEnv = {}) => {
    if (aborted) {
      throw new Error("Verification was interrupted");
    }
    const start = Date.now();
    const child = spawn(command[0] ?? "bun", command.slice(1), {
      cwd: root,
      env: {
        ...env,
        SHOULDERTAP_SERVER_URL: server,
        SHOULDERTAP_WEB_URL: web,
        ...extraEnv,
      },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    active = child;
    let timedOut = false;
    activeGraceMs = name === "native-core" ? 90_000 : 3000;
    const deadline = setTimeout(
      () => {
        timedOut = true;
        terminate(child, activeGraceMs);
      },
      name === "native-core" ? 1_200_000 : 600_000
    );
    const chunks: Buffer[] = [];
    const liveLog = path.join(directory, `${name}.log`);
    writeFileSync(liveLog, "", { mode: 0o600 });
    const capture = (data: Buffer) => {
      chunks.push(data);
      appendFileSync(liveLog, data);
    };
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    const code = await new Promise<number>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (exitCode) => resolve(exitCode ?? 1));
    });
    clearTimeout(deadline);
    // Failure output can include auth request bodies. Logs remain private;
    // public receipts carry only the digest and exit status.
    active = undefined;
    const log = Buffer.concat(chunks);
    writeFileSync(path.join(directory, `${name}.log`), log, { mode: 0o600 });
    results.push({
      name,
      exitCode: code,
      durationMs: Date.now() - start,
      log: `${name}.log`,
      sha256: digest(log),
    });
    process.stdout.write(`${code === 0 ? "PASS" : "FAIL"} ${name}\n`);
    if (name === "protocol") {
      const reportFile = path.join(directory, "protocol-report.json");
      if (existsSync(reportFile)) {
        const diagnostics = JSON.stringify(
          protocolDiagnostics(JSON.parse(readFileSync(reportFile, "utf-8"))),
          null,
          2
        );
        writeFileSync(path.join(evidence, "protocol.json"), diagnostics);
        process.stdout.write(`${diagnostics}\n`);
      }
    }
    if (code !== 0 || timedOut) {
      throw new Error(
        `${name} ${timedOut ? "timed out" : "failed"}; private log: ${path.join(directory, `${name}.log`)}`
      );
    }
    return log.toString();
  };
  let dev: ReturnType<typeof spawn> | undefined;
  let devClosed: Promise<void> | undefined;
  let failure: unknown;
  let cleaned = false;
  const stopDev = () => {
    if (dev?.pid) {
      try {
        process.kill(-dev.pid, "SIGTERM");
      } catch {
        /* already exited */
      }
    }
  };
  const interrupt = () => {
    aborted = true;
    failure ??= new Error("Verification was interrupted");
    if (active) {
      terminate(active, activeGraceMs);
    }
    stopDev();
    process.exitCode = 130;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  writeFileSync(
    path.join(directory, "ownership.json"),
    JSON.stringify({
      stage,
      root,
      head,
      createdAt: new Date().toISOString(),
      mode: hosted ? "hosted" : "local",
      accountId: hosted ? process.env.CLOUDFLARE_TEST_ACCOUNT_ID : null,
      expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    }),
    { mode: 0o600 }
  );
  try {
    if (hosted) {
      await run("deploy-bootstrap", [
        "bun",
        "alchemy",
        "deploy",
        "--stage",
        stage,
        "--yes",
      ]);
      const output = await run("stack-output", [
        "bun",
        "alchemy",
        "state",
        "cat",
        `shouldertap/${stage}/output`,
        "--no-input",
      ]);
      const jsonStart = output.lastIndexOf("\n{");
      const outputJson = JSON.parse(
        output.slice(jsonStart === -1 ? output.indexOf("{") : jsonStart + 1)
      );
      server = new URL(outputJson.server).origin;
      web = new URL(outputJson.web).origin;
      env.SHOULDERTAP_WEB_ORIGIN = web;
      env.SHOULDERTAP_API_ORIGIN = server;
      await run("deploy-origin", [
        "bun",
        "alchemy",
        "deploy",
        "--stage",
        stage,
        "--yes",
      ]);
    } else {
      const log = Bun.file(path.join(directory, "stack.log")).writer();
      dev = spawn("bun", ["alchemy", "dev", "--stage", stage], {
        cwd: root,
        env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      devClosed = new Promise<void>((resolve) => {
        dev?.once("close", () => resolve());
      });
      dev.stdout?.on("data", (chunk) => log.write(chunk));
      dev.stderr?.on("data", (chunk) => log.write(chunk));
      dev.on("error", (error) => {
        failure = error;
      });
      const deadline = Date.now() + 240_000;
      while (true) {
        if (failure || dev.exitCode !== null) {
          throw (
            failure ??
            new Error("Local stack exited; inspect private stack.log")
          );
        }
        try {
          const response = await fetch(`${server}/version`);
          const webResponse = await fetch(web);
          if (response.ok && webResponse.ok) {
            break;
          }
        } catch {
          /* wait for workerd */
        }
        if (Date.now() > deadline) {
          throw new Error(
            "Local stack readiness timed out; inspect private stack.log"
          );
        }
        await pause(1000);
      }
    }
    const version = await fetch(`${server}/version`).then((response) =>
      response.json()
    );
    assertDeployment(version, head, sourceDigest);
    writeFileSync(
      path.join(evidence, "backend.json"),
      JSON.stringify(version, null, 2)
    );
    await run(
      "protocol",
      [
        "bun",
        "run",
        "--cwd",
        "apps/server",
        "test:integ",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${path.join(directory, "protocol-report.json")}`,
        "--includeTaskLocation",
      ],
      { STACK_URL: server }
    );
    await run(
      "preview-smoke",
      ["bun", "scripts/verification/preview-smoke.ts"],
      { STACK_URL: server, EXPECTED_REVISION: head }
    );
    await (scenario === "core"
      ? run("native-core", ["bun", "scripts/verification/native.ts"])
      : run("browser", ["bun", "run", "--cwd", "apps/web", "test:verify"]));
  } catch (error) {
    failure = error;
  } finally {
    stopDev();
    if (devClosed) {
      await Promise.race([
        devClosed,
        pause(10_000).then(() => {
          if (dev?.pid && dev.exitCode === null) {
            try {
              process.kill(-dev.pid, "SIGKILL");
            } catch {
              /* already exited */
            }
          }
        }),
      ]);
    }
    try {
      await cleanup(stage, env);
      cleaned = true;
    } catch (error) {
      failure ??= error;
    }
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    const after = digest(
      git("diff", "HEAD", "--binary") +
        git("ls-files", "--others", "--exclude-standard")
          .split("\n")
          .filter(Boolean)
          .map((file) => file + digest(readFileSync(path.join(root, file))))
          .join("\n")
    );
    if (sourceDigest !== after || head !== git("rev-parse", "HEAD")) {
      failure ??= new Error("Source changed during verification");
    }
    let baseSha: string | null = null;
    try {
      baseSha = git(
        "merge-base",
        process.env.VERIFY_BASE_REF ?? "origin/main",
        "HEAD"
      );
    } catch {
      failure ??= new Error("Cannot establish the verification base revision");
    }
    const artifacts = readdirSync(evidence, {
      recursive: true,
      withFileTypes: true,
    })
      .filter((file) => file.isFile() && file.name !== "receipt.json")
      .map((file) => {
        const filename = path.join(file.parentPath, file.name);
        return {
          path: path.relative(evidence, filename),
          sha256: digest(readFileSync(filename)),
        };
      });
    writeFileSync(
      path.join(evidence, "receipt.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          stage,
          head,
          sourceDigest,
          testedSha: head,
          baseSha,
          scenario,
          mode: hosted ? "hosted" : "local",
          server,
          web,
          results,
          cleaned,
          artifacts,
          verdict: failure ? "FAIL" : "PASS",
          limitations: [
            "Physical APNs delivery, real Creem checkout and Windows OS behavior require separate release verification.",
            "Deterministic billing lifecycle is covered by unit tests, not a verified UI checkout journey.",
            ...(scenario === "browser"
              ? ["Receiver is a protocol client; native UI was not exercised."]
              : []),
          ],
        },
        null,
        2
      )
    );
  }
  if (failure) {
    throw failure;
  }
  process.stdout.write(`PASS ${path.join(evidence, "receipt.json")}\n`);
}
