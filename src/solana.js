import { Connection, Keypair, PublicKey, Transaction, SystemProgram, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { createCloseAccountInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
import { cfg } from './config.js';
import { sleep } from './http.js';

export const connection = new Connection(cfg.rpcUrl, 'confirmed');
export { LAMPORTS_PER_SOL };

export function loadKeypair(secret) {
  const s = secret.trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

export const keypair = cfg.privateKey ? loadKeypair(cfg.privateKey) : null;

export async function getSolBalance() {
  return BigInt(await connection.getBalance(keypair.publicKey, 'confirmed'));
}

// Saldo de un token para cualquier dueño. Funciona con Token y Token-2022.
export async function getTokenBalance(owner, mint) {
  const res = await connection.getParsedTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) }, 'confirmed');
  let raw = 0n;
  let ui = 0;
  let decimals = 0;
  const accounts = [];
  for (const { pubkey, account } of res.value) {
    const info = account.data.parsed.info.tokenAmount;
    raw += BigInt(info.amount);
    ui += Number(info.uiAmount || 0);
    decimals = info.decimals;
    accounts.push({ pubkey, programId: account.owner, amount: BigInt(info.amount) });
  }
  return { raw, ui, decimals, accounts };
}

export async function getMintInfo(mint) {
  const acc = await connection.getParsedAccountInfo(new PublicKey(mint), 'confirmed');
  const info = acc.value?.data?.parsed?.info;
  if (!info) throw new Error('mint no encontrado');
  return {
    decimals: info.decimals,
    supply: BigInt(info.supply),
    mintAuthority: info.mintAuthority || null,
    freezeAuthority: info.freezeAuthority || null,
  };
}

// Envía una transacción firmada y la reenvía hasta que se confirme o caduque.
export async function sendAndConfirm(tx, { timeoutMs = 60_000 } = {}) {
  const raw = tx.serialize();
  const sig = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  const start = Date.now();
  let lastSend = Date.now();
  while (Date.now() - start < timeoutMs) {
    await sleep(1500);
    const { value } = await connection.getSignatureStatuses([sig]);
    const st = value[0];
    if (st?.err) throw new Error(`transacción fallida ${sig}: ${JSON.stringify(st.err)}`);
    if (st && (st.confirmationStatus === 'confirmed' || st.confirmationStatus === 'finalized')) return sig;
    if (Date.now() - lastSend > 3000) {
      lastSend = Date.now();
      connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => {});
    }
  }
  throw new Error(`transacción sin confirmar tras ${timeoutMs / 1000}s: ${sig}`);
}

// Cierra las cuentas de token vacías para recuperar ~0.002 SOL de renta por token.
export async function closeEmptyTokenAccounts(mint) {
  const { accounts } = await getTokenBalance(keypair.publicKey, mint);
  const empty = accounts.filter((a) => a.amount === 0n);
  if (!empty.length) return null;
  const tx = new Transaction();
  for (const a of empty) {
    tx.add(createCloseAccountInstruction(a.pubkey, keypair.publicKey, keypair.publicKey, [], a.programId));
  }
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(keypair);
  return sendAndConfirm(tx);
}

// Envía todo el SOL de la wallet del bot a la dirección de retiro (menos la comisión).
export async function withdrawAll(to) {
  const fee = 5000n;
  const balance = await getSolBalance();
  if (balance <= fee) throw new Error('la wallet del bot está vacía');
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: keypair.publicKey, toPubkey: new PublicKey(to), lamports: balance - fee }),
  );
  tx.feePayer = keypair.publicKey;
  tx.recentBlockhash = (await connection.getLatestBlockhash('confirmed')).blockhash;
  tx.sign(keypair);
  const sig = await sendAndConfirm(tx);
  return { sig, sol: Number(balance - fee) / 1e9 };
}
