import { Hono } from 'hono';

const CACHE_KEY = "raydium_cache";
const CACHE_TTL = 300;
const PROCESSED_TRANSACTIONS = "processed_txns";
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const REQUEST_DELAY = 500;

const app = new Hono();

app.get('/', (c) => c.text('Solana Action Bot is running!'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      console.error(`Fetch error (attempt ${i + 1}):`, error);
      await delay(RETRY_DELAY);
    }
  }
  throw new Error(`Failed to fetch ${url} after ${MAX_RETRIES} retries`);
}

app.post('/create-webhook', async (c) => {
  const webhookURL = `${new URL(c.req.url).origin}/webhook`;
  const kv = c.env.KV_STORAGE;
  const cachedData = await kv.get(CACHE_KEY, { type: "json" });
  if (cachedData) return c.json({ success: true, cachedData });

  let raydiumData;
  try {
    raydiumData = await fetchWithRetry('https://api.raydium.io/v2/main/pairs');
  } catch (error) {
    return c.json({ success: false, message: 'Failed to fetch Raydium API' });
  }

  const now = Math.floor(Date.now() / 1000);
  const newTokens = Object.values(raydiumData).filter(token => token.launchTime && now - token.launchTime < 86400);
  const newTokenAddresses = [];

  for (const token of newTokens) {
    const tokenAddress = token.lpMint || token.market || token.baseMint;
    if (!tokenAddress || await kv.get(tokenAddress)) continue;
    await kv.put(tokenAddress, 'tracked', { expirationTtl: 86400 });
    newTokenAddresses.push(tokenAddress);
  }

  if (newTokenAddresses.length === 0) return c.json({ success: false, message: 'No new tokens found' });

  try {
    await delay(REQUEST_DELAY);
    const heliusData = await fetchWithRetry(
      `https://api.helius.xyz/v0/webhooks?api-key=${c.env.HELIUS_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookURL, transactionTypes: ['SWAP'], accountAddresses: newTokenAddresses, webhookType: 'enhanced', authHeader: c.env.AUTH_TOKEN })
      }
    );
    await kv.put(CACHE_KEY, JSON.stringify(newTokens), { expirationTtl: CACHE_TTL });
    return c.json({ success: true, webhook: heliusData, monitoredTokens: newTokens });
  } catch (error) {
    return c.json({ success: false, message: 'Failed to create webhook' });
  }
});

async function sendTelegramMessage(message, env) {
  await delay(REQUEST_DELAY);
  try {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'Markdown' })
    });
    return await response.json();
  } catch (error) {
    console.error('Error sending Telegram message:', error);
  }
}

app.post('/webhook', async (c) => {
  if (c.req.header('Authorization') !== c.env.AUTH_TOKEN) return c.text('Unauthorized', 401);
  let data;
  try {
    data = await c.req.json();
  } catch (error) {
    return c.text('Error processing webhook', 400);
  }

  if (!Array.isArray(data) || data.length === 0) return c.text('No transactions to process', 200);
  const kv = c.env.KV_STORAGE;

  for (const transaction of data) {
    if (transaction.type !== 'SWAP' || transaction.platform !== 'Raydium') continue;
    const swapEvent = transaction.events?.swap;
    if (!swapEvent || swapEvent.inAmount <= 0) continue;
    const { tokenAddress = 'Unknown Address' } = swapEvent;
    if (await kv.get(`${PROCESSED_TRANSACTIONS}_${transaction.signature}`)) continue;

    const message = `🚀 *TOKEN ALERT! 🚀*\n\n🆔 *Token Address*: \`${tokenAddress}\`\n🔍 [DexScreener](https://dexscreener.com/solana/${tokenAddress})`;
    await sendTelegramMessage(message, c.env);
    await kv.put(`${PROCESSED_TRANSACTIONS}_${transaction.signature}`, 'processed', { expirationTtl: 3600 });
  }
  return c.text('Webhook processed');
});

export default app;