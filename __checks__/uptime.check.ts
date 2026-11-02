import { Frequency, UrlAssertionBuilder, UrlMonitor } from 'checkly/constructs'

import { SITE, email, group } from './site'

// Cheap and frequent: is the home page up, and quick? URL monitors only assert the
// status code; the smoke tests check the CSP header.
new UrlMonitor('home-uptime', {
  name: 'Home page is up',
  frequency: Frequency.EVERY_5M,
  degradedResponseTime: 1000,
  maxResponseTime: 3000,
  group,
  alertChannels: [email],
  request: {
    url: SITE,
    followRedirects: true,
    assertions: [UrlAssertionBuilder.statusCode().equals(200)],
  },
})
