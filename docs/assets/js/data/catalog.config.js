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
      'Controllers, dashboards and browser overlays for OBS Studio — the free program most live ' +
      'streamers use to mix their video — plus chat clients and bots for Twitch and YouTube. ' +
      'Everything here runs while a stream is on air.',
    repos: [
      'worxbend/obsctl',
      'worxbend/obsctl-rs',
      'worxbend/obs-stats',
      'worxbend/scenedeck',
      'worxbend/multistream-manager',
      'worxbend/twi',
      'worxbend/yc',
      'worxbend/streaming-tools-site',
      'w0rxbend/obs-effects',
      'w0rxbend/twitch-vizer',
      'w0rxbend/twitch-voxer',
      'w0rxbend/twitch-musicplayer',
      'w0rxbend/chat-brawl',
    ],
  },
  {
    id: 'air',
    name: 'Air Quality',
    glyph: '◇',
    blurb:
      'Ways of reading an AirGradient air-quality monitor: a desktop window, a phone app, a ' +
      'terminal, a panel icon, an e-paper screen, a wall of LEDs, a television dashboard and a ' +
      'metrics stack — all talking to the sensor on the local network rather than to a cloud ' +
      'account.',
    repos: [
      'worxbend/airgradient-desktop',
      'worxbend/airgradient-android',
      'worxbend/airgradient-cli',
      'worxbend/airgradient-gnome-extension',
      'worxbend/airgradient-papr',
      'worxbend/airgradient-observability',
      'worxbend/tv-dashboard',
      'w0rxbend/neoncore',
    ],
  },
  {
    id: 'iot',
    name: 'IoT & Edge',
    glyph: '◆',
    blurb:
      'Firmware in C++ for small Wi-Fi microcontroller boards — ESP32 cameras, relays and LED ' +
      'panels — together with the network services on the other end of the wire that receive ' +
      'their frames and send them commands.',
    repos: [
      'w0rxbend/spycam',
      'w0rxbend/spycam-s3',
      'w0rxbend/instachron',
      'w0rxbend/led-matrix-controller',
      'w0rxbend/echo',
      'w0rxbend/echoctl',
      'worxbend/frostfire',
      'worxbend/frostfire-backend',
    ],
  },
  {
    id: 'linux',
    name: 'Linux & Provisioning',
    glyph: '▣',
    blurb:
      'Tools that take a fresh Linux machine, or a homelab of them, and bring it to a known state ' +
      'from files kept in version control — packages, dotfiles, fonts, binaries and monitoring — ' +
      'plus the desktop applications that sit on top.',
    repos: [
      'worxbend/fluxion.cr',
      'worxbend/fluxion',
      'worxbend/binstaller',
      'worxbend/dotbot-go',
      'worxbend/dotbot-scala',
      'worxbend/nerd-fonts-installer',
      'w0rxbend/system-bootstrap',
      'w0rxbend/infrastruct',
      'w0rxbend/ops-dashboard',
      'w0rxbend/codefolio',
      'oleksandr-balyshyn/deskctl',
    ],
  },
  {
    id: 'scala',
    name: 'Scala & JVM',
    glyph: '⬡',
    blurb:
      'Libraries and services for the Java Virtual Machine, mostly written in Scala 3: printers ' +
      'and terminal toolkits, API clients for Git hosting, a computer-vision binding, and ports ' +
      'of existing libraries to the Flix language.',
    repos: [
      'worxbend/worxbend',
      'oleksandr-balyshyn/glyphora',
      'w0rxbend/scalacv',
      'worxbend/codeberg4s',
      'worxbend/gitea-scala-client',
      'w0rxbend/compression-flix',
      'w0rxbend/scalachess-flix',
      'w0rxbend/Zephyr',
    ],
  },
  {
    id: 'cad',
    name: 'CAD & 3D printing',
    glyph: '⬢',
    blurb:
      'Parts drawn in FreeCAD, the open-source computer-aided design program, and printed to hold ' +
      'the hardware the rest of this catalogue runs on: camera housings, single-board-computer ' +
      'mounts and bracket sets.',
    repos: [
      'w0rxbend/FreeCAD-Projects',
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
  'w0rxbend/spycam',
  'w0rxbend/scalacv',
  'w0rxbend/system-bootstrap',
];
