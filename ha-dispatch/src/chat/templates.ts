/**
 * Capability templates.
 *
 * A template is a coarse area of automation the assistant can offer to
 * help with. Each template has match keywords (used to filter to the
 * templates that are relevant to *this* user's setup) and a few starter
 * ideas (used to seed the assistant's suggestions when the user picks
 * the template).
 *
 * Templates are deliberately generic — we want the same set to feel
 * useful to most HA users, regardless of their hardware.
 */

import type { CapabilityTemplate } from './types.js'

export const CAPABILITY_TEMPLATES: CapabilityTemplate[] = [
  {
    id: 'lights',
    name: 'Lights',
    icon: 'mdi:lightbulb-on',
    blurb: 'Automate lighting based on time of day, presence, sunlight, or scenes.',
    matchKeywords: ['light.', 'binary_sensor.*motion', 'binary_sensor.*occupancy', 'sun.sun', 'person.', 'scene.'],
    starterIdeas: [
      'Turn off all lights when everyone leaves the house',
      'Slow sunrise wake-up in the bedroom on weekdays',
      'Outdoor lights on at sunset, off at midnight',
      'Motion-triggered hallway lights at low brightness after 22:00',
    ],
  },
  {
    id: 'energy',
    name: 'Energy',
    icon: 'mdi:flash',
    blurb: 'Optimize solar production, home battery, and EV charging against electricity prices.',
    matchKeywords: [
      'sensor.*solar',
      'sensor.*pv',
      'sensor.*inverter',
      'sensor.*battery',
      'sensor.*grid',
      'switch.*charge',
      'sensor.*model_y',
      'sensor.*tesla',
    ],
    starterIdeas: [
      'Charge the EV during the cheapest electricity hours overnight',
      'Use surplus solar to top up the home battery before exporting to grid',
      'Notify when daily solar production beats the previous record',
      'Pre-cool / pre-heat the house when prices drop below a threshold',
    ],
  },
  {
    id: 'security',
    name: 'Security',
    icon: 'mdi:shield-home',
    blurb: 'Lock doors, arm alarms, and get alerted on anomalies.',
    matchKeywords: ['lock.', 'alarm_control_panel.', 'binary_sensor.*door', 'binary_sensor.*window', 'binary_sensor.*motion', 'camera.', 'person.'],
    starterIdeas: [
      'Auto-lock all doors at 23:00 if any are still unlocked',
      'Arm the alarm when everyone leaves and disarm when someone comes home',
      'Notify me if a door has been open for more than 10 minutes',
      'Send a snapshot when motion is detected at the front door at night',
    ],
  },
  {
    id: 'water',
    name: 'Water & Irrigation',
    icon: 'mdi:water',
    blurb: 'Watch water usage, schedule irrigation, and catch leaks early.',
    matchKeywords: ['sensor.*water', 'sensor.*flow', 'switch.*valve', 'switch.*irrigation', 'switch.*sprinkler', 'sensor.*irrigation'],
    starterIdeas: [
      'Run the sprinklers only if it has not rained in the last 24h',
      'Alert me if water flow is detected for more than 15 minutes straight',
      'Show me daily water usage trends and flag anomalies',
      'Skip irrigation if the soil moisture sensor is above a threshold',
    ],
  },
  {
    id: 'climate',
    name: 'Climate',
    icon: 'mdi:thermometer',
    blurb: 'Heating, cooling, and ventilation tuned to schedule, weather, and presence.',
    matchKeywords: ['climate.', 'sensor.*temperature', 'sensor.*humidity', 'fan.', 'cover.*shade', 'cover.*blind'],
    starterIdeas: [
      'Lower the heating set point when nobody is home',
      'Open blinds in the morning, close at sunset',
      'Boost ventilation when CO2 rises above a threshold',
      'Pre-warm the bathroom 30 min before the first alarm',
    ],
  },
  {
    id: 'notifications',
    name: 'Notifications',
    icon: 'mdi:bell-ring',
    blurb: 'Smart, low-noise notifications about things that matter.',
    matchKeywords: ['notify.', 'mobile_app_', 'person.'],
    starterIdeas: [
      'A morning briefing with weather, calendar, and overnight events',
      'Alert when the dishwasher / washing machine cycle finishes',
      'Reminder if a window is open while it starts to rain',
      'Gentle nudge when someone has been on a long phone call',
    ],
  },
]

/** Return the templates whose match keywords show up in the entity inventory. */
export function applicableTemplates(entityIds: string[]): CapabilityTemplate[] {
  const blob = entityIds.join('\n')
  return CAPABILITY_TEMPLATES.filter((t) => t.matchKeywords.some((kw) => new RegExp(kw, 'i').test(blob)))
}
