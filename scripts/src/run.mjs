import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { clusterApiUrl, Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { commitment, devnetGenesis, newWorld } from "./chain.mjs";
import { cancelledCase, localAcceptance } from "./scenarios.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const defaultIdl = join(root, "target/idl/next_milestone.json");
const defaultProgram = join(root, "target/deploy/next_milestone.so");
const [mode, ...args] = process.argv.slice(2);
const { values } = parseArgs({
  args,
  options: {
    rpc: { type: "string" },
    wallet: { type: "string" },
    idl: { type: "string" },
    program: { type: "string" },
    manifest: { type: "string" },
    "public-idl": { type: "string" },
    "evidence-base": { type: "string" },
    "include-dispute": { type: "boolean" },
    help: { type: "boolean" },
  },
});

async function json(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function atomicJson(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}`);
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

function evidenceUrl(value) {
  const url = new URL(value);
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

async function requirePublication(baseUrl) {
  assert.equal(baseUrl.protocol, "https:", "Publish the evidence on HTTPS before seeding Devnet");
  const files = values["include-dispute"] ? ["hito-1.json", "hito-2.json"] : ["hito-1.json"];
  for (const file of files) {
    const response = await fetch(new URL(file, baseUrl), { signal: AbortSignal.timeout(15_000) });
    assert.ok(response.ok, `Published evidence ${file} returned HTTP ${response.status}`);
    const source = await readFile(join(root, "web/public/evidence", file));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), source, `Published evidence ${file} differs from the source`);
  }
}

async function seedDevnet(idl) {
  assert.ok(values.wallet && values["evidence-base"], "Provide --wallet and --evidence-base");
  const baseUrl = evidenceUrl(values["evidence-base"]);
  await requirePublication(baseUrl);
  const connection = new Connection(values.rpc ?? clusterApiUrl("devnet"), commitment);
  assert.equal(await connection.getGenesisHash(), devnetGenesis, "The RPC must belong to Solana Devnet");
  const payer = Keypair.fromSecretKey(Uint8Array.from(await json(resolve(values.wallet))));
  assert.ok(await connection.getBalance(payer.publicKey) >= LAMPORTS_PER_SOL / 10, "Fund the Devnet fee payer before seeding");
  const world = await newWorld(connection, idl, payer);
  const first = await cancelledCase(world, { order: [0, 1], evidenceBaseUrl: baseUrl, local: false });
  console.log(`Confirmed expiry and refunds A → B · ${first.campaignId}`);
  const second = await cancelledCase(world, { order: [1, 0], evidenceBaseUrl: baseUrl, local: false });
  console.log(`Confirmed expiry and refunds B → A · ${second.campaignId}`);
  const campaigns = [first, second];
  if (values["include-dispute"]) {
    const disputed = await cancelledCase(world, {
      order: [0, 1], evidenceBaseUrl: baseUrl, local: false, dispute: true,
    });
    campaigns.push(disputed);
    console.log(`Confirmed objection, cancellation and refunds · ${disputed.campaignId}`);
  }

  const publicIdl = values["public-idl"] ? resolve(values["public-idl"]) : join(root, "web/public/devnet-idl.json");
  const manifest = values.manifest ? resolve(values.manifest) : join(root, "web/public/demo-manifest.json");
  await atomicJson(publicIdl, idl);
  await atomicJson(manifest, {
    schemaVersion: 1,
    cluster: "devnet",
    programId: world.program.programId.toBase58(),
    mint: world.mint.toBase58(),
    primaryCampaignId: first.campaignId,
    campaigns,
  });
  console.log("Wrote public Devnet addresses and transaction signatures.");
}

async function launchValidator(idl, url) {
  const executable = values.program ? resolve(values.program) : defaultProgram;
  await access(executable);
  const parent = resolve(tmpdir());
  const ledger = await mkdtemp(join(parent, "next-milestone-"));
  assert.match(relative(parent, ledger), /^next-milestone-[\w-]+$/, "Use a newly allocated temporary ledger");
  const child = spawn("solana-test-validator", [
    "--ledger", ledger,
    "--bind-address", "127.0.0.1",
    "--rpc-port", url.port,
    "--bpf-program", idl.address, executable,
    "--log",
  ], { stdio: ["ignore", "pipe", "pipe"] });
  let failure;
  let validatorOutput = "";
  child.on("error", (error) => { failure = error; });
  const collectOutput = (chunk) => { validatorOutput = (validatorOutput + chunk).slice(-6_000); };
  child.stdout.on("data", collectOutput);
  child.stderr.on("data", collectOutput);
  const cleanup = async () => {
    if (!failure && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit").then(() => true);
      child.kill();
      if (!await Promise.race([exited, delay(5_000, false)])) child.kill("SIGKILL");
      await exited;
    }
    await rm(ledger, { recursive: true, force: true });
  };
  try {
    const connection = new Connection(url.href, commitment);
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (failure || child.exitCode !== null) break;
      try {
        await connection.getVersion();
        return { connection, cleanup };
      } catch {
        await delay(500);
      }
    }
    throw new Error(`Unable to start solana-test-validator: ${failure?.message ?? validatorOutput.trim()}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function testLocal(idl) {
  const url = new URL(values.rpc ?? "http://127.0.0.1:18899");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Local tests require a loopback validator");
  const { connection, cleanup } = values.rpc
    ? { connection: new Connection(url.href, commitment), cleanup: async () => {} }
    : await launchValidator(idl, url);
  try {
    const protectedGeneses = [
      devnetGenesis,
      "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY",
    ];
    assert.ok(!protectedGeneses.includes(await connection.getGenesisHash()), "Refusing to run local fixtures on a public cluster");
    const payer = Keypair.generate();
    const signature = await connection.requestAirdrop(payer.publicKey, 2 * LAMPORTS_PER_SOL);
    const blockhash = await connection.getLatestBlockhash(commitment);
    const confirmation = await connection.confirmTransaction({ signature, ...blockhash }, commitment);
    assert.equal(confirmation.value.err, null, "Local test airdrop");
    const world = await newWorld(connection, idl, payer);
    await localAcceptance(world, evidenceUrl(values["evidence-base"] ?? "http://127.0.0.1:4173/evidence/"));
  } finally {
    // web3.js closes idle signature subscriptions after 500 ms. Keep the
    // validator available until the connection can close without reconnecting.
    if (!values.rpc) await delay(750);
    await cleanup();
  }
}

async function main() {
  if (values.help) {
    console.log("test:local [--idl FILE] [--program FILE] [--rpc EXISTING_LOOPBACK_RPC]");
    console.log("seed:devnet --wallet FILE --evidence-base HTTPS_URL [--rpc DEVNET_RPC] [--include-dispute]");
    return;
  }
  assert.ok(mode === "devnet" || mode === "local", "Choose local or devnet mode");
  const idl = await json(values.idl ? resolve(values.idl) : defaultIdl);
  if (mode === "devnet") {
    await seedDevnet(idl);
  } else {
    await testLocal(idl);
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
