/**
 * Solcast solar forecast API integration.
 *
 * Free hobby tier: 10 API calls/day, hourly forecasts.
 * https://docs.solcast.com.au/
 */

export interface SolarForecastHour {
  timestamp: string
  pvEstimate: number    // kW estimated
  pvEstimate10: number  // 10th percentile (pessimistic)
  pvEstimate90: number  // 90th percentile (optimistic)
  cloudOpacity: number  // 0-100%
}

export interface SolarForecast {
  hours: SolarForecastHour[]
  totalTodayKwh: number
  peakHour: SolarForecastHour | null
}

const SOLCAST_BASE = 'https://api.solcast.com.au'

export async function fetchSolarForecast(opts: {
  apiKey: string
  resourceId?: string
  latitude?: number
  longitude?: number
  capacity?: number // kWp
}): Promise<SolarForecast> {
  let url: string
  const headers = { Authorization: `Bearer ${opts.apiKey}` }

  if (opts.resourceId) {
    // Rooftop site (pre-configured in Solcast dashboard)
    url = `${SOLCAST_BASE}/rooftop_sites/${opts.resourceId}/forecasts?format=json`
  } else {
    // World API (lat/lng based)
    url = `${SOLCAST_BASE}/world_pv_power/forecasts?latitude=${opts.latitude}&longitude=${opts.longitude}&capacity=${opts.capacity ?? 1}&format=json`
  }

  const res = await fetch(url, { headers })
  if (!res.ok) {
    throw new Error(`Solcast API error: ${res.status} ${res.statusText}`)
  }

  const data = (await res.json()) as {
    forecasts: Array<{
      period_end: string
      pv_estimate: number
      pv_estimate10: number
      pv_estimate90: number
      cloud_opacity?: number
    }>
  }

  const hours: SolarForecastHour[] = data.forecasts.map((f) => ({
    timestamp: f.period_end,
    pvEstimate: f.pv_estimate,
    pvEstimate10: f.pv_estimate10,
    pvEstimate90: f.pv_estimate90,
    cloudOpacity: f.cloud_opacity ?? 0,
  }))

  // Calculate today's total
  const today = new Date().toISOString().split('T')[0]
  const todayHours = hours.filter((h) => h.timestamp.startsWith(today))
  const totalTodayKwh = todayHours.reduce((sum, h) => sum + h.pvEstimate * 0.5, 0) // 30-min periods

  // Find peak hour
  const peakHour = hours.reduce<SolarForecastHour | null>(
    (best, h) => (!best || h.pvEstimate > best.pvEstimate ? h : best),
    null,
  )

  return { hours, totalTodayKwh, peakHour }
}
