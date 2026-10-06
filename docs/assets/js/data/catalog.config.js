/**
 * catalog.config.js — the list of what this site shows.
 *
 * This file is the switchboard. Every project on the page is named here, by hand, and nothing that
 * is not named here can appear. If you want a repository on the site, add one line. If you want it
 * gone, delete that line. Nothing else needs editing and nothing needs rebuilding — the page reads
 * this file directly in the browser.
 *
 * Why it works this way
 * ---------------------
 * The site used to show every public repository that had been pushed to in the last six months.
 * That is a rule about *activity*, and activity is a poor stand-in for *intent*: a sandbox poked at
 * last week outranked a finished tool that has been stable for a year, and every throwaway
 * experiment turned up on the front page the moment it was touched. Selecting by hand costs one
 * line per project and says exactly what was meant — these are the projects worth looking at.
 *
 * What is still automatic
 * -----------------------
 * Everything factual. Stars, primary language, topics, the last push date, the description and the
 * homepage link are fetched live from GitHub's public API in the visitor's own browser, with no
 * account, no token and no build step (see core/github.js). This file decides *which* repositories
 * are shown and *how they are grouped*; GitHub decides what is true about them. A repository listed
 * here that GitHub does not return — renamed, made private, deleted — is skipped quietly on the
 * page and reported in the browser console so the mistake is findable.
 *
 * How to edit it
 * --------------
 *   - Add a project ....... put `'owner/repository'` in the `repos` array of the section it belongs
 *                           to. Spelling must match GitHub exactly apart from letter case.
 *   - Remove a project .... delete its line.
 *   - Move a project ...... cut the line from one section and paste it into another. A project
 *                           belongs to exactly one section; the first section that lists it wins.
 *   - Add a section ....... add an object to SECTIONS. The heading cards, the filter chips, the
 *                           command palette and the constellation all read this array, so nothing
 *                           else needs touching.
 *   - Feature a project ... add it to FEATURED below. Featured projects sort to the top of the
 *                           catalogue and are marked on their card.
 *
 * The plain-language descriptions live separately, in overrides.js, because prose and selection
 * change at different times and for different reasons.
 */

/**
 * The sections of the catalogue, in the order they appear on the page.
 *
 * `id` ends up in the address bar (`#/c/linux`) and in the local telemetry, so treat it as fixed
 * once it has been published. `glyph` is the decorative mark on the section card. `blurb` is read
 * by a person who has never seen any of this before, so it says what the things *are* rather than
 * what they are called.
 */
export const SECTIONS = [
  {
    id: 'streaming',
    name: 'Streaming & OBS',
    glyph: '◈',
    blurb:
      'Desktop and Android OBS controllers, streaming dashboards and configurable browser overlays. Chat tools for Twitch and YouTube, plus a dedicated desk display for your channel’s live figures.',
    repos: [
      'worxbend/obsctl',
      'worxbend/obsctl-rs',
      'worxbend/obs-stats',
      'worxbend/scenedeck',
      'worxbend/scenedeck-android',
      'worxbend/multistream-manager',
      'worxbend/twi',
      'worxbend/yc',
      'worxbend/streaming-tools-site',
      'worxbend/twitch-screen',
      'w0rxbend/obs-effects',
      'worxbend/obs-effects-v2',
      'w0rxbend/twitch-vizer',
      'worxbend/twitch-voxer',
      'worxbend/twitch-musicplayer',
    ],
  },
  {
    id: 'air',
    name: 'Air Quality',
    glyph: '◇',
    blurb:
      'Keep an eye on your air through desktop, phone, terminal and hardware displays. AirGradient clients that connect over your local network, without a cloud account.',
    repos: [
      'worxbend/airgradient-desktop',
      'worxbend/airgradient-android',
      'worxbend/airgradient-cli',
      'worxbend/airgradient-gnome-extension',
      'worxbend/airgradient-dms-widget',
      'worxbend/airgradient-papr',
      'worxbend/airgradient-observability',
      'worxbend/tv-dashboard',
      'worxbend/neoncore',
    ],
  },
  {
    id: 'iot',
    name: 'IoT & Edge',
    glyph: '◆',
    blurb:
      'C++ firmware for ESP32 cameras, pan-and-tilt rigs, relays and LED panels, paired with the services and controls on the other end of the network.',
    repos: [
      'worxbend/spycam',
      'worxbend/spycam-s3',
      'worxbend/instachron',
      'worxbend/led-matrix-controller',
      'w0rxbend/echo',
      'worxbend/echoctl',
      'worxbend/frostfire',
      'worxbend/frostfire-backend',
      'worxbend/camx',
    ],
  },
  {
    id: 'linux',
    name: 'Linux & Provisioning',
    glyph: '▣',
    blurb:
      'Bring Linux machines and homelabs to a known state with version-controlled packages, dotfiles, fonts and monitoring. Practical desktop tools complete the setup.',
    repos: [
      'worxbend/fluxion.cr',
      'worxbend/fluxion',
      'worxbend/binstaller',
      'worxbend/dotbot-go',
      'worxbend/dotbot-scala',
      'worxbend/nerd-fonts-installer',
      'worxbend/nerd-fonts-installer-scala',
      'w0rxbend/system-bootstrap',
      'w0rxbend/infrastruct',
      'w0rxbend/ops-dashboard',
      'oleksandr-balyshyn/deskctl',
    ],
  },
  {
    id: 'scala',
    name: 'Scala & JVM',
    glyph: '⬡',
    blurb:
      'Scala and JVM libraries for terminals, OBS Studio, Git hosting and computer vision. Explore Kafka tooling, services and ports of existing libraries to Flix.',
    repos: [
      'worxbend/worxbend',
      'worxbend/glyphora',
      'worxbend/scalacv',
      'worxbend/codeberg4s',
      'worxbend/gitea-scala-client',
      'worxbend/obs-websocket-client',
      'w0rxbend/compression-flix',
      'w0rxbend/scalachess-flix',
      'worxbend/kui',
      'worxbend/Zephyr',
    ],
  },
  {
    id: 'cad',
    name: 'CAD & 3D printing',
    glyph: '⬢',
    blurb:
      'Printable hardware in FreeCAD and parametric Python: camera housings, board mounts, a hand-wired macropad and compact lighting. Inspect the models and check component fit before printing.',
    repos: [
      'w0rxbend/FreeCAD-Projects',
      'worxbend/macropad-nyxilab',
      'worxbend/plastic-lighthouse',
    ],
  },
];

/**
 * The short tour: projects that sort to the top of the catalogue and carry a "featured" mark.
 *
 * Chosen so a first-time visitor sees the range of the work rather than six variations on the same
 * idea — a desktop application, a terminal application, a phone application, camera firmware, a
 * library and a set of shell scripts. That is a spread of *kinds* of thing, which is why two come
 * from the streaming section and none from CAD; the rule is "no two alike", not "one per section".
 * Order does not matter here — featured projects are sorted among themselves by stars and then by
 * how recently they were pushed.
 */
export const FEATURED = [
  'worxbend/scenedeck',
  'worxbend/twi',
  'worxbend/airgradient-android',
  'worxbend/spycam',
  'worxbend/scalacv',
  'w0rxbend/system-bootstrap',
];
