/**
 * PVPC (Precio Voluntario para el Pequeño Consumidor) price fetcher.
 *
 * Fetches hourly electricity prices from the Spanish grid operator (REE)
 * via their ESIOS API. PVPC prices are published day-ahead via OMIE.
 *
 * API docs: https://api.esios.ree.es/
 */

export interface HourlyPrice {
  timestamp: string   // ISO 8601
  hour: number        // 0-23
  price: number       // EUR/kWh
  currency: string
}

export interface PVPCPrices {
  today: HourlyPrice[]
  tomorrow: HourlyPrice[]  // Available after ~20:30
  current: HourlyPrice | null
  cheapestWindow: { start: number; end: number; avgPrice: number } | null
  expensiveWindow: { start: number; end: number; avgPrice: number } | null
}

const ESIOS_BASE = 'https://api.esios.ree.es'
// PVPC indicator IDs
const PVPC_INDICATOR = '1001'  // PVPC T2.0TD (2.0TD tariff)

export async function fetchPVPCPrices(token?: string): Promise<PVPCPrices> {
  const now = new Date()
  const today = formatDate(now)
  const tomorrow = formatDate(new Date(now.getTime() + 86400000))

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  }
  if (token) {
    headers['Authorization'] = `Token token="${token}"`
  }

  // Fetch today's prices
  const todayPrices = await fetchDayPrices(today, headers)

  // Try tomorrow's prices (available after ~20:30 CET)
  let tomorrowPrices: HourlyPrice[] = []
  try {
    tomorrowPrices = await fetchDayPrices(tomorrow, headers)
  } catch {
    // Tomorrow's prices not yet available — that's expected before 20:30
  }

  // Find current hour's price
  const currentHour = now.getHours()
  const current = todayPrices.find((p) => p.hour === currentHour) ?? null

  // Find cheapest and most expensive 3-hour windows
  const allPrices = [...todayPrices, ...tomorrowPrices]
  const cheapestWindow = findBestWindow(allPrices, 3, 'cheapest')
  const expensiveWindow = findBestWindow(allPrices, 3, 'expensive')

  return {
    today: todayPrices,
    tomorrow: tomorrowPrices,
    current,
    cheapestWindow,
    expensiveWindow,
  }
}

async function fetchDayPrices(date: string, headers: Record<string, string>): Promise<HourlyPrice[]> {
  const url = `${ESIOS_BASE}/indicators/${PVPC_INDICATOR}?start_date=${date}T00:00&end_date=${date}T23:59`

  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`ESIOS API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    indicator: {
      values: Array<{
        datetime: string
        value: number
      }>
    }
  }

  return data.indicator.values.map((v) => {
    const dt = new Date(v.datetime)
    return {
      timestamp: v.datetime,
      hour: dt.getHours(),
      price: v.value / 1000, // ESIOS returns EUR/MWh, convert to EUR/kWh
      currency: 'EUR',
    }
  })
}

function findBestWindow(
  prices: HourlyPrice[],
  windowSize: number,
  type: 'cheapest' | 'expensive',
): { start: number; end: number; avgPrice: number } | null {
  if (prices.length < windowSize) return null

  let bestStart = 0
  let bestAvg = type === 'cheapest' ? Infinity : -Infinity

  for (let i = 0; i <= prices.length - windowSize; i++) {
    const window = prices.slice(i, i + windowSize)
    const avg = window.reduce((sum, p) => sum + p.price, 0) / windowSize

    if (type === 'cheapest' ? avg < bestAvg : avg > bestAvg) {
      bestAvg = avg
      bestStart = i
    }
  }

  return {
    start: prices[bestStart].hour,
    end: prices[bestStart + windowSize - 1].hour,
    avgPrice: bestAvg,
  }
}

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}
