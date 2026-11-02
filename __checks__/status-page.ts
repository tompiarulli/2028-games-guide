import { StatusPageV3, StatusPageV3AutomationRule, StatusPageV3Component } from 'checkly/constructs'

// A public status page for the README to link to; checks tagged '28games' report into it.
const page = new StatusPageV3('status', {
  name: '2028 Games Session Guide',
  url: '28games',
  defaultTheme: 'AUTO',
})

const website = new StatusPageV3Component('website', {
  statusPage: page,
  name: 'Website',
  displayOrder: 0,
})

// A failing check tagged '28games' opens an incident on the page.
new StatusPageV3AutomationRule('website-down', {
  statusPage: page,
  name: 'Website down',
  firstUpdate: "The site isn't loading right now. Looking into it.",
  lastUpdate: 'The site is back up.',
  tags: ['28games'],
  components: [{ component: website, targetImpact: 'MAJOR_OUTAGE' }],
})
