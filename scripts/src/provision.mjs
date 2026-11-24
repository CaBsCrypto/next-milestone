import assert from "node:assert/strict";
import { parseArgs } from "node:util";
import { createMint, getOrCreateAssociatedTokenAccount, mintTo } from "@solana/spl-token";
import { clusterApiUrl, Connection, PublicKey } from "@solana/web3.js";
import { commitment, devnetGenesis, readTestWallet, requireTestMint } from "./chain.mjs";

const { values } = parseArgs({
  options: {
    wallet: { type: "string" },
    rpc: { type: "string" },
    mint: { type: "string" },
    recipient: { type: "string", multiple: true },
    amount: { type: "string", default: "10000" },
    help: { type: "boolean" },
  },
});

async function provision() {
  if (values.help) {
    console.log("provision:devnet --wallet FILE [--mint TEST_MINT] [--recipient WALLET ...] [--amount MINIMUM_TOKENS] [--rpc DEVNET_RPC]");
    return;
  }
  assert.ok(values.wallet, "Provide --wallet for the test mint authority and fee payer");
  assert.match(values.amount, /^[1-9]\d{0,19}$/, "Amount must be a positive whole number of test tokens");
  const target = BigInt(values.amount);
  assert.ok(target <= (1n << 64n) - 1n, "Amount exceeds the SPL token range");

  const recipients = [...new Set(values.recipient)].map((owner) => new PublicKey(owner));
  assert.ok(recipients.every((owner) => PublicKey.isOnCurve(owner.toBytes())), "Recipients must be wallet addresses");
  const connection = new Connection(values.rpc ?? clusterApiUrl("devnet"), commitment);
  assert.equal(await connection.getGenesisHash(), devnetGenesis, "The RPC must belong to Solana Devnet");

  const authority = await readTestWallet(values.wallet);
  const mint = values.mint
    ? new PublicKey(values.mint)
    : await createMint(connection, authority, authority.publicKey, null, 0, undefined, { commitment });
  if (values.mint) await requireTestMint(connection, mint, authority.publicKey);
  console.log(`VITE_SOLANA_MINT=${mint.toBase58()}`);

  for (const owner of recipients) {
    const account = await getOrCreateAssociatedTokenAccount(
      connection, authority, mint, owner, false, commitment, { commitment },
    );
    if (account.amount < target) {
      await mintTo(connection, authority, mint, account.address, authority, target - account.amount, [], { commitment });
    }
    const { value } = await connection.getTokenAccountBalance(account.address, commitment);
    console.log(`${owner.toBase58()}=${value.amount}`);
  }
}

try {
  await provision();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Test token provisioning failed");
  process.exitCode = 1;
}
