import { CheckGroupV2, EmailAlertChannel } from 'checkly/constructs'

/** The site checks run against: production, or a preview passed in as ENVIRONMENT_URL by
 *  `checkly test`. */
export const SITE = process.env.ENVIRONMENT_URL ?? 'https://28games.tompiarulli.com'

export const email = new EmailAlertChannel('email-tom', {
  address: 'tom@tompiarulli.com',
  sendFailure: true,
  sendRecovery: true,
  sslExpiry: true,
})

/** Every check for the site, so one README badge (the group's) covers them all. */
export const group = new CheckGroupV2('site', {
  name: '2028 Games Session Guide',
})
