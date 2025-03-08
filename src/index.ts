import { Hono } from "hono";
import { Cron } from 'croner'

interface Env {
  TELEGRAM_BOT_TOKEN: string
  CMC_API_KEY: string
  BINANCE_API_KEY: string
  BINANCE_API_SECRET: string
  TELEGRAM_CHANNEL_ID: string
  TELEGRAM_CHANNEL_ID: string
  MORALIS_API_KEY: string
  TRACKED_TOKENS: KVNamespace
}

interface CacheData {
  data: any
  lastUpdated: number
}

interface Token {
  id: string
  name: string
  symbol: string
  price_usd: number
  volume_24h_usd: number
  market_cap_usd: number
  created_at: string
}

interface SolanaToken {
  address: string
  name: string
  symbol: string
  priceUsd: number
  marketCap: number
  volume24h: number
  liquidity: number
  timestamp: number
}

interface HeliusToken {
  id: string
  name: string
  symbol: string
  price_info?: {
    price_per_token: number
    total_price: number
  }
  token_info?: {
    supply: number
  }
  volume_24h?: number
  liquidity?: number
  created_at: string
}

interface ExchangeData {
  id: number
  name: string
  slug: string
  num_market_pairs: number
  volume_24h: number
  volume_7d: number
  volume_30d: number
  percent_volume_change: number
  liquidity: number
  last_updated: string
}

const app = new Hono<{ Bindings: Env }>()

let cache: {
  global?: CacheData
  ticker: Record<string, CacheData>
  coinPaprika: CacheData 
} = { ticker: {}, coinPaprika: { data: null, lastUpdated: 0 } }

// Initialize scheduled handler for Cloudflare
app.get('/cron', async (c) => {
  await checkNewTokens(c.env)
  return c.text('Cron job executed')
})

// Add scheduled event handler (Cloudflare-specific)
app.use('*', async (c, next) => {
  if (c.req.raw.scheduled) {
    await checkNewTokens(c.env)
    return c.text('Scheduled check completed')
  }
  await next()
})

async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
  ctx.waitUntil(checkNewTokens(env))
}

async function checkNewTokens(env: Env) {
  try {
    const response = await fetch('https://mainnet.helius-rpc.com', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${env.HELIUS_API_KEY}`
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'solana-tracker',
        method: 'searchAssets',
        params: {
          conditionType: 'all',
          conditions: [],
          sortBy: {
            sortBy: 'volume_24h',
            sortDirection: 'desc'
          },
          limit: 100,
          page: 1
        }
      })
    })

    if (!response.ok) {
      const errorBody = await response.text()
      throw new Error(`Helius API Error: ${response.status} - ${errorBody}`)
    }

    const { result } = await response.json()
    const tokens: HeliusToken[] = result.items

    for (const token of tokens) {
      const marketCap = token.token_info?.supply && token.price_info?.price_per_token 
        ? token.token_info.supply * token.price_info.price_per_token
        : 0

      if (marketCap >= 100000) {
        const isTracked = await env.TRACKED_TOKENS.get(token.id)
        
        if (!isTracked) {
          await sendAlert(env, {
            address: token.id,
            name: token.name,
            symbol: token.symbol,
            priceUsd: token.price_info?.price_per_token || 0,
            marketCap,
            volume24h: token.volume_24h || 0,
            liquidity: token.liquidity || 0,
            timestamp: new Date(token.created_at).getTime()
          })
          await env.TRACKED_TOKENS.put(token.id, 'tracked')
        }
      }
    }
  } catch (error) {
    console.error('Token check error:', error instanceof Error ? error.message : error)
  }
}

// Alert formatting
async function sendAlert(env: Env, token: HeliusToken) {
  const message = `
🚨 <b>New Solana Token Alert</b> 🚨

📈 ${token.name} (${token.symbol})
💰 Price: $${token.priceUsd.toFixed(6)}
📊 Market Cap: $${token.marketCap.toLocaleString()}
💧 Liquidity: $${token.liquidity.toLocaleString()}
📈 24h Volume: $${token.volume24h.toLocaleString()}
🆕 Created: ${new Date(token.timestamp * 1000).toLocaleDateString()}

🔗 <a href="https://jup.ag/swap/SOL-${token.symbol}_${token.address}">Trade on Jupiter</a>
🔗 <a href="https://solscan.io/token/${token.address}">View on Solscan</a>
  `.trim()

  await sendTelegramMessage(env, message)
}

// Webhook setup endpoint
app.get('/setup-webhook', async (c) => {
  const webhookUrl = `https://${c.req.host}/webhook`;
  const setup = await fetch(
    `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        url: webhookUrl,
        allowed_updates: ["message"],
        drop_pending_updates: true
      })
    }
  );
  return c.json(await setup.json());
});

app.get('/webhook-info', async (c) => {
  const info = await fetch(
    `https://api.telegram.org/bot${c.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`
  );
  return c.json(await info.json());
});

// Test endpoint in worker
app.get('/test-binance', async (c) => {
  const test = await fetch('https://api.binance.com/api/v3/ticker/price');
  return c.text(`Status: ${test.status}`);
});

app.get('/list-exchanges', async (c) => {
  const response = await fetch('https://pro-api.coinmarketcap.com/v1/exchange/map?limit=100', {
    headers: { 'X-CMC_PRO_API_KEY': c.env.CMC_API_KEY }
  })
  return c.json(await response.json())
})

app.post('/webhook', async (c) => {
  const update = await c.req.json()
  await handleUpdate(update, c.env)
  return c.text('OK')
})


async function handleUpdate(update: any, env: Env) {
  if (!update.message?.text) return
  
  const msg = update.message
  const text = msg.text
  const chatId = msg.chat.id

  console.log(`Processing command: ${text} from ${chatId}`);

  // Add basic command validation
  if (!text.startsWith('/')) {
    await sendMessage(chatId, 'Unrecognized command. Type /start for help.', env)
    return
  }

  try {
     if (text.startsWith('/start')) {
      console.log('Handling /start command');
      const message = startMessage();
      await sendMessage(chatId, message, env);
      console.log('Start message sent');
    }
    
    if (text.startsWith('/info')) {
      await handleInfoCommand(text, chatId, env)
    } else if (text.startsWith('/global')) {
      await handleGlobalCommand(text, chatId, env)
    } else if (text.startsWith('/ticker')) {
      await handleTickerCommand(text, chatId, env)
      } else if (text.startsWith('/alert')) {
      await checkNewTokens(env)
    }
  } catch (error) {
    console.error('Update handling error:', error)
    // Attempt error response if possible
    if (update?.message?.chat?.id) {
      await sendMessage(update.message.chat.id, '⚠️ Bot encountered an error. Please try again.', env)
    }
  }
}

async function handleInfoCommand(text: string, chatId: number, env: Env) {
  const input = text.split(' ')[1]
  if (!input) return await sendMessage(chatId, 'Please provide a symbol or rank', env)

  if (isNaN(Number(input))) {
    const symbol = input.toUpperCase()
    if (cache.ticker[symbol] && Date.now() - cache.ticker[symbol].lastUpdated < 300000) {
      return await sendMessage(chatId, formatCMCInfo(cache.ticker[symbol].data), env)
    }
    
    const data = await fetchCMCQuote(symbol, env.CMC_API_KEY)
    cache.ticker[symbol] = { data, lastUpdated: Date.now() }
    await sendMessage(chatId, formatCMCInfo(data), env)
  } else {
    const rank = parseInt(input)
    if (rank < 1) return await sendMessage(chatId, 'Rank must be greater than 0', env)
    
    const data = await fetchCMCRanking(rank, env.CMC_API_KEY)
    await sendMessage(chatId, formatCMCInfo(data), env)
  }
}

async function fetchCMCQuote(symbol: string, apiKey: string) {
  const response = await fetch(
    `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?symbol=${symbol}`,
    { headers: { 'X-CMC_PRO_API_KEY': apiKey } }
  )
  
  if (!response.ok) throw new Error('CMC API request failed')
  const data = await response.json()
  return data.data[symbol][0]
}

async function fetchCMCRanking(rank: number, apiKey: string) {
  const response = await fetch(
    `https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?start=${rank}&limit=1`,
    { headers: { 'X-CMC_PRO_API_KEY': apiKey } }
  )
  
  if (!response.ok) throw new Error('CMC API request failed')
  const data = await response.json()
  return data.data[0]
}

function formatCMCGlobal(data: any) {
  try {
    return `
<b>Global Crypto Market</b>
📈 Total Cap: $${(data.quote?.USD?.total_market_cap ?? 0).toLocaleString()}
💹 24h Volume: $${(data.quote?.USD?.total_volume_24h ?? 0).toLocaleString()}
₿ BTC Dominance: ${(data.btc_dominance ?? 0).toFixed(2)}%
Ξ ETH Dominance: ${(data.eth_dominance ?? 0).toFixed(2)}%
🪙 Active Currencies: ${data.active_cryptocurrencies ?? 'N/A'}
🏦 Active Exchanges: ${data.active_exchanges ?? 'N/A'}
`.trim();
  } catch (error) {
    console.error('formatCMCGlobal error:', error);
    return 'Error formatting global market data';
  }
}

async function handleGlobalCommand(fullCommand: string, chatId: number, env: Env) {
  try {
    const [_, exchange] = (fullCommand || '').split(' ')
    
    if (exchange) {
      await sendMessage(chatId, `🔍 Searching for ${exchange}...`, env)
      const exchangeData = await fetchCMCExchangeData(exchange, env.CMC_API_KEY)
      await sendMessage(chatId, formatExchangeData(exchangeData), env)
    } else {
      if (cache.global && Date.now() - cache.global.lastUpdated < 300000) {
        return await sendMessage(chatId, formatCMCGlobal(cache.global.data), env)
      }
      
      const data = await fetchCMCGlobal(env.CMC_API_KEY)
      cache.global = { data, lastUpdated: Date.now() }
      await sendMessage(chatId, formatCMCGlobal(data), env)
    }
  } catch (error) {
    console.error('handleGlobalCommand error:', error)
    await sendMessage(chatId, 
      `⚠️ Failed to fetch exchange data. Please check the exchange name and try again.\nExample: /global binance`,
      env
    )
  }
}

async function fetchCMCExchangeData(query: string, apiKey: string): Promise<ExchangeData> {
  try {
    // 1. Verify API key format
    if (!apiKey?.startsWith('b4')) {
      throw new Error('Invalid CoinMarketCap API key format')
    }

    // 2. Use proper endpoint with required parameters
    const searchUrl = new URL('https://pro-api.coinmarketcap.com/v1/exchange/map')
    searchUrl.searchParams.set('listing_status', 'active')
    searchUrl.searchParams.set('slug', query.toLowerCase())

    const searchResponse = await fetch(searchUrl.toString(), {
      headers: {
        'X-CMC_PRO_API_KEY': apiKey,
        'Accept': 'application/json',
        'Accept-Encoding': 'deflate, gzip'
      }
    })

    // 3. Handle API errors with detailed messages
    if (!searchResponse.ok) {
      const error = await searchResponse.json()
      throw new Error(`CMC API Error: ${error.status.error_message}`)
    }

    const searchData = await searchResponse.json()

    // 4. Validate response structure
    if (!searchData.data?.[0]?.id) {
      throw new Error('Exchange not found in response data')
    }

    // 5. Get detailed metrics with proper endpoint
    const metricsResponse = await fetch(
      `https://pro-api.coinmarketcap.com/v2/exchange/metrics?id=${searchData.data[0].id}`,
      {
        headers: {
          'X-CMC_PRO_API_KEY': apiKey,
          'Accept': 'application/json'
        }
      }
    )

    if (!metricsResponse.ok) {
      const error = await metricsResponse.json()
      throw new Error(`Metrics API Error: ${error.status.error_message}`)
    }

    const metricsData = await metricsResponse.json()

    // 6. Return normalized exchange data
    return {
      id: searchData.data[0].id,
      name: searchData.data[0].name,
      slug: searchData.data[0].slug,
      num_market_pairs: searchData.data[0].num_market_pairs,
      ...metricsData.data[searchData.data[0].id].quote.USD
    }

  } catch (error) {
    console.error('Exchange data fetch error:', error)
    throw new Error(`Failed to fetch ${query} data: ${error.message}`)
  }
}

function formatExchangeData(data: ExchangeData): string {
  return `
🏦 <b>${data?.name || 'Unknown Exchange'} Overview</b>

📊 24h Volume: $${(data?.volume_24h || 0).toLocaleString()}
📈 Volume Change: ${(data?.percent_volume_change || 0).toFixed(2)}%
💧 Liquidity: ${(data?.liquidity || 0).toLocaleString()}
🔗 Markets: ${data?.num_market_pairs || 'N/A'}
🔄 Updated: ${data?.last_updated ? new Date(data.last_updated).toLocaleString() : 'Unknown'}
  `.trim()
}

async function fetchCMCGlobal(apiKey: string) {
  try {
    const response = await fetch(
      'https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest',
      { headers: { 'X-CMC_PRO_API_KEY': apiKey } }
    );
    
    if (!response.ok) {
      throw new Error(`CMC Global API failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    // Validate response structure
    if (!data?.data?.quote?.USD) {
      throw new Error('Invalid CMC Global API response structure');
    }
    
    return data.data;
  } catch (error) {
    console.error('fetchCMCGlobal error:', error);
    throw new Error('Failed to fetch global market data');
  }
}

function formatCMCInfo(info: any) {
  return `
<b>${escapeHtml(info.name)} (${escapeHtml(info.symbol)})</b>
Rank: #${info.cmc_rank}
Price: $${info.quote.USD.price.toFixed(4)}
24h Change: ${info.quote.USD.percent_change_24h.toFixed(2)}%
Market Cap: $${info.quote.USD.market_cap.toLocaleString()}
Volume (24h): $${info.quote.USD.volume_24h.toLocaleString()}
Circulating Supply: ${info.circulating_supply?.toLocaleString() ?? 'N/A'}
`.trim()
}

// Add retry mechanism to handleTickerCommand
async function handleTickerCommand(text: string, chatId: number, env: Env) {
  try {
    const input = text.split(' ')[1]
    if (!input) {
      return await sendMessage(chatId, 'Please provide a search term (e.g., /ticker BTC)', env)
    }

    const searchTerm = input.toUpperCase()
    
    if (cache.coinPaprika.data && Date.now() - cache.coinPaprika.lastUpdated < 300000) {
      return await sendMessage(chatId, formatCoinPaprikaData(searchTerm, cache.coinPaprika.data), env)
    }
    
    await sendMessage(chatId, '🔄 Fetching tickers data...', env)
    const tickers = await fetchCoinPaprikaPrices()
    cache.coinPaprika = { data: tickers, lastUpdated: Date.now() }
    await sendMessage(chatId, formatCoinPaprikaData(searchTerm, tickers), env)
    
  } catch (error) {
    console.error('handleTickerCommand error:', error)
    await sendMessage(chatId, '⚠️ Failed to fetch cryptocurrency data. Please try again later.', env)
  }
}

async function fetchCoinPaprikaPrices() {
  try {
    const response = await fetch('https://api.coinpaprika.com/v1/tickers')
    
    if (!response.ok) {
      throw new Error(`CoinPaprika API failed: ${response.status} ${await response.text()}`)
    }
    
    const data = await response.json()
    
    if (!Array.isArray(data)) {
      throw new Error('Invalid CoinPaprika response format')
    }
    
    return data
  } catch (error) {
    console.error('fetchCoinPaprikaPrices error:', error)
    throw new Error('Failed to fetch cryptocurrency prices')
  }
}

function formatCoinPaprikaData(searchTerm: string, tickers: any[]) {
  try {
    const matches = tickers.filter(t => 
      t.symbol.toUpperCase() === searchTerm ||
      t.name.toUpperCase().includes(searchTerm)
    ).slice(0, 10) // Limit to 10 results

    if (!matches.length) return `No cryptocurrencies found for "${searchTerm}"`

    return matches.map(t => {
      const price = t.quotes?.USD?.price?.toFixed(6) || 'N/A'
      const change24h = t.quotes?.USD?.percent_change_24h?.toFixed(2) || 'N/A'
      return `<b>${t.name} (${t.symbol})</b>\n` +
             `💰 Price: $${price}\n` +
             `📈 24h Change: ${change24h}%\n` +
             `🏆 Rank: #${t.rank}`
    }).join('\n\n')
    
  } catch (error) {
    console.error('formatCoinPaprikaData error:', error)
    return 'Error formatting cryptocurrency data'
  }
}


// Modified sendMessage with better error handling
async function sendMessage(chatId: number, text: string, env: Env) {
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'HTML'
        })
      }
    )

    if (!response.ok) {
      console.error('Telegram API error:', await response.text())
    }
  } catch (error) {
    console.error('Failed to send message:', error)
  }
}

// Add HTML escaping utility
function escapeHtml(unsafe: string) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function startMessage() {
  return `
<b>Crypto Signal Bot</b>

/info &lt;symbol|rank&gt; - Get coin information
/global - Overall market overview
/global &lt;exchange&gt; - Specific exchange data
/ticker &lt;ticker&gt; - Find crypto prices (CoinPaprika)

🚨 Automatically tracks new Solana tokens with:
💰 Market Cap > $100k
📈 High volume & liquidity
🚀 Price spikes

Alerts sent to this channel
  `.trim()
}

export default {
  fetch: app.fetch,
  scheduled
}
