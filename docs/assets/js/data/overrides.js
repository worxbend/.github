/**
 * The prose half of the catalogue — how each project is described, in plain language.
 *
 * There are three files behind the catalogue and they are deliberately kept apart:
 *
 *   catalog.config.js  which projects appear, and in which section
 *   overrides.js       this file: how each one is described
 *   core/github.js     what is currently true about them, fetched live from GitHub
 *
 * GitHub descriptions are written for people who already know the tools. These are written for
 * someone who does not: abbreviations are expanded where they first appear, and a description says
 * what a thing *is* before it says what it is called.
 *
 * Nothing here is generated and nothing here is overwritten. Both fields are optional, and a
 * project with no entry still appears on the site — it falls back to its own GitHub description,
 * and its card is marked as not yet written about.
 *
 *   tagline   one short line under the project name, ideally 60 characters or fewer
 *   desc      the paragraph on the card, for a reader with no prior context
 *
 * Keys are `owner/repository`, exactly as GitHub spells them, because that pair is the only
 * identifier that cannot collide or change. An entry whose repository is not selected in
 * catalog.config.js is simply unused — it costs nothing, but it will not appear anywhere.
 */
export const COPY = {
  'worxbend/airgradient-android': {
    tagline: 'Android app for a local AirGradient sensor',
    desc:
      'A native Android application written in Kotlin with Jetpack Compose (Google’s current toolkit for building Android screens) that reads measurements straight from an AirGradient air-quality device on the same network, with no cloud service in between. It shows a dashboard, remembers settings on the phone, and can raise notifications when readings pass a chosen severity.',
  },
  'worxbend/airgradient-cli': {
    tagline: 'Command-line reader for an AirGradient sensor',
    desc:
      'A small Rust command-line companion for an AirGradient indoor air-quality device. By default it reuses the configuration file written by the desktop application, fetches the current measurements once and prints them compactly in the terminal.',
  },
  'worxbend/airgradient-desktop': {
    tagline: 'GTK4 desktop dashboard for AirGradient readings',
    desc:
      'A Linux desktop window that shows live readings from an AirGradient indoor air-quality monitor found on the local network. It is written in Rust using GTK4 and libadwaita, the user-interface toolkit behind modern GNOME applications.',
  },
  'worxbend/airgradient-gnome-extension': {
    tagline: 'GNOME panel indicator for AirGradient readings',
    desc:
      'An extension for GNOME Shell (the desktop environment shipped by Fedora and Ubuntu) that places a single icon in the top bar, coloured by the current air quality. Clicking it opens a compact popup with gauges for carbon dioxide, particles and the other AirGradient readings, using the same configuration file as airgradient-desktop.',
  },
  'worxbend/airgradient-observability': {
    tagline: 'Self-hosted metrics stack for an AirGradient ONE',
    desc:
      'A self-hosted monitoring setup for an AirGradient ONE air-quality sensor. A collector on the home network reads the sensor’s Prometheus metrics endpoint, forwards the samples to VictoriaMetrics (a database for time-stamped measurements) on a cloud virtual machine, and serves them through Grafana dashboards and a small Go web interface.',
  },
  'worxbend/airgradient-papr': {
    tagline: 'E-paper air-quality display for AirGradient ONE',
    desc:
      'Firmware for a LILYGO T5-4.7 board with an electronic-paper screen (the same low-power display technology used in e-readers) that turns it into a portable readout for an AirGradient ONE indoor air-quality sensor, alongside weather, forecast and currency figures. Readings are fetched over the local network, so no cloud account or phone app is involved.',
  },
  'worxbend/binstaller': {
    tagline: 'Reproducible installer for prebuilt binaries',
    desc:
      'A command-line tool that puts the same set of prebuilt program binaries on every machine from one YAML profile, checking each download against its SHA-256 fingerprint and writing a lock file so later runs install the same versions. It is written in Scala 3 and compiled ahead of time into a native executable with GraalVM, and it can print a dry-run plan before changing anything.',
  },
  'worxbend/codeberg4s': {
    tagline: 'Scala 3 client for the Codeberg and Forgejo API',
    desc:
      'A Scala 3 library for calling version 1 of the REST API — the web interface other programs talk to over HTTP — of Codeberg and any Forgejo or Gitea-compatible Git host. It hands back plain Scala Future values rather than pulling an effect system into your project, offers both exception-based and Either-based error handling, and returns paged results that cannot silently truncate. It is pre-release and not yet published to Maven Central.',
  },
  'worxbend/dotbot-go': {
    tagline: 'Go port of the Dotbot dotfile manager',
    desc:
      'A rewrite in Go of Dotbot, a tool that installs personal configuration files — dotfiles — from a declarative configuration. It creates and cleans up symbolic links, makes the directories they need and runs the shell commands listed in the config.',
  },
  'worxbend/dotbot-scala': {
    tagline: 'Scala 3 port of the Dotbot dotfile manager',
    desc:
      'A rewrite in Scala 3 of Dotbot, a tool that installs personal configuration files — dotfiles — from a declarative configuration. It is compiled with GraalVM into a standalone native program, so running it does not require a Java installation on the target machine.',
  },
  'worxbend/fluxion': {
    tagline: 'YAML-driven workstation bootstrapper in Java',
    desc:
      'A Java tool that sets up a Linux workstation from one declarative YAML file: system packages, Flatpak applications and the remotes they come from, scripts, dotfiles, shell tooling, Nerd Fonts and prebuilt binaries. It records what it has already installed, so running it again skips finished work instead of redoing it.',
  },
  'worxbend/fluxion.cr': {
    tagline: 'YAML-driven workstation bootstrapper in Crystal',
    desc:
      'A tool written in the Crystal language that turns a fresh Linux machine into a configured one from a single YAML file, with a preview of the planned changes before anything is applied. It can be driven either as a plain command or through a full-screen terminal interface.',
  },
  'worxbend/frostfire': {
    tagline: 'ESP32 firmware for pressing a PC power button',
    desc:
      'Firmware for an ESP32 microcontroller board that briefly closes a relay wired across a computer’s power-button header, so the machine can be switched on or off remotely. Every command is a fixed-length pulse, the relay returns to off after each pulse and at boot, and any state-changing request needs a token — it is written for a trusted home network only.',
  },
  'worxbend/frostfire-backend': {
    tagline: 'HTTP service for the Frostfire relay board',
    desc:
      'An asynchronous Python service built with FastAPI that puts a guarded web interface in front of the Frostfire ESP32 relay, which presses a computer’s power button. The code is split into API, application, domain and infrastructure layers, and a safety policy checks every request before it reaches the hardware.',
  },
  'worxbend/gitea-scala-client': {
    tagline: 'Scala 3 client for the Gitea hosting API',
    desc:
      'A Scala 3 library for talking to Gitea, a lightweight Git hosting service people run on their own servers, through its web API. It is built on ZIO 2 (a toolkit for asynchronous Scala programs), the sttp HTTP client and zio-json, and its typed endpoints were checked against Gitea’s 1.26.2 OpenAPI contract.',
  },
  'worxbend/multistream-manager': {
    tagline: 'Terminal setup for Twitch and YouTube streams',
    desc:
      'A full-screen terminal interface that prepares a Twitch stream and a YouTube broadcast from one form — title, category and ingest keys — so a single Start Streaming press in OBS Studio goes live on both services at once. It is written in Rust and shows live status and viewer counts for each side.',
  },
  'worxbend/nerd-fonts-installer': {
    tagline: 'Config-driven installer for Nerd Fonts',
    desc:
      'A Go command-line tool that installs Nerd Fonts — programming typefaces patched to include extra icon symbols — on Linux and macOS from a single configuration file, so every machine ends up with the same set. Downloads are verified against published checksums, and an interactive terminal picker helps choose families.',
  },
  'worxbend/obs-stats': {
    tagline: 'Terminal dashboard for OBS Studio health',
    desc:
      'A full-screen dashboard drawn inside a terminal window, in the style of the system monitor btop, showing a running OBS Studio’s processor use, frame pacing, encoder health, outputs, scenes and audio as they change. Written in Rust, it reads everything through obs-websocket 5.x, the remote-control protocol OBS exposes.',
  },
  'worxbend/obsctl': {
    tagline: 'Terminal OBS Studio controller in Crystal',
    desc:
      'A command-line tool plus a terminal dashboard for driving OBS Studio (the open-source live-streaming and recording program) through obs-websocket 5.x, so scenes, audio and profiles can be changed or scripted without touching the mouse. It is written in Crystal, and a small background daemon keeps the connection to OBS warm between commands.',
  },
  'worxbend/obsctl-rs': {
    tagline: 'Terminal OBS Studio controller in Rust',
    desc:
      'A program that drives a local copy of OBS Studio (the open-source live-streaming and recording program) from the keyboard, over obs-websocket 5.x, the protocol OBS exposes for remote control. It is written in Rust and its full-screen text interface (a TUI) is built with Ratatui.',
  },
  'worxbend/scenedeck': {
    tagline: 'Desktop OBS Studio controller for Linux',
    desc:
      'A desktop application for Linux that controls OBS Studio (the open-source live-streaming and recording program) from a normal window — switching scenes, toggling sources and starting or stopping the stream. It is written in Rust with GTK4 and libadwaita, the toolkit behind modern GNOME applications, and talks to OBS over the obs-websocket protocol.',
  },
  'worxbend/streaming-tools-site': {
    tagline: 'Interactive map of the worxbend streaming tools',
    desc:
      'A static website — plain HTML, CSS and JavaScript with no build step or framework — that draws an interactive map of how the worxbend streaming tools fit together: which of them reach OBS Studio over the obs-websocket protocol, and which talk to Twitch and YouTube directly. Its one third-party dependency, the PixiJS graphics library, is loaded lazily at runtime.',
  },
  'worxbend/tv-dashboard': {
    tagline: 'Full-screen home dashboard for a 1080p television',
    desc:
      'An always-on dashboard laid out to fill a 1920x1080 television: air-quality figures from an AirGradient sensor, outdoor weather and forecast, indoor climate, the day’s agenda and system status, arranged in seven cards. The screen is built with SolidJS and fed by a small Hono web service that gathers the data from Open-Meteo and local sources.',
  },
  'worxbend/twi': {
    tagline: 'Terminal Twitch chat client in Go',
    desc:
      'A keyboard-first Twitch chat client that runs in a terminal window instead of a browser. Written in Go, it reads and sends messages across several channels over IRC (the long-standing chat protocol Twitch still speaks), ships 13 colour themes, and keeps OAuth login tokens out of its log output.',
  },
  'worxbend/worxbend': {
    tagline: 'Monorepo of Scala tools, libraries and notes',
    desc:
      'One repository holding many small Scala and JVM projects: personal command-line tools, reusable libraries, Docker Compose recipes for self-hosted services and technical notes, all built with the Mill build tool. It is a learning workspace rather than a finished product.',
  },
  'worxbend/yc': {
    tagline: 'Terminal YouTube live chat client in Go',
    desc:
      'A keyboard-driven program that shows a YouTube live chat inside a terminal window rather than a browser tab. Written in Go, it displays how much of the YouTube Data API’s daily request allowance (its quota) has been spent, and includes 58 colour themes.',
  },
  'w0rxbend/chat-brawl': {
    tagline: 'Chat-driven brawler arena overlay for OBS Studio',
    desc:
      'A browser overlay for OBS Studio (the open-source live-streaming program) in which every Twitch viewer who types in chat automatically joins an on-screen fighting arena as a small character. Chat commands cover attacking, fleeing, character classes, teams, duels and betting, and the whole simulation is drawn in the browser with PixiJS.',
  },
  'w0rxbend/codefolio': {
    tagline: 'GTK4 desktop viewer for a GitHub profile',
    desc:
      'A native Linux desktop application, named Codeflio in its README, written in Rust with GTK4 and Relm4 (a toolkit and framework for building desktop windows). It shows your GitHub profile, contribution activity, repositories, organisations and aggregate development statistics, signs in through GitHub device authorization, and caches data locally so views open without waiting on the network.',
  },
  'w0rxbend/compression-flix': {
    tagline: 'Flix port of the Lichess compression library',
    desc:
      'A port of lichess.org’s compression library — the code that packs chess clock times and moves into a compact storage format — from Scala to Flix, a functional programming language that runs on the Java Virtual Machine. The port produces byte-for-byte identical output to the original, because a single differing bit would invalidate every game already stored on disk, and it ships Scala facades so existing callers can use it.',
  },
  'w0rxbend/echo': {
    tagline: 'HTTP proxy turning webhook events into LED art',
    desc:
      'A Go service that sits between webhook sources — home automation, monitoring stacks, automation tools — and an ESP8266-driven 8x8 LED matrix. You post a JSON event, configured rules decide which animation plays, and echo pushes it to one or more panels over TCP with automatic reconnection, while exposing Prometheus metrics and an interactive Swagger API page.',
  },
  'w0rxbend/echoctl': {
    tagline: 'Command-line client for the echo LED proxy',
    desc:
      'A command-line tool written in Scala 3 for driving echo, the LED matrix proxy. It deliberately talks only to echo’s HTTP API — health checks, device lists, animations, firmware presets, brightness and colour, the idle background and the playback queue — and never to the panel’s raw firmware protocol.',
  },
  'w0rxbend/FreeCAD-Projects': {
    tagline: 'Printable parts for the hardware in this catalogue',
    desc:
      'Models drawn in FreeCAD, the open-source computer-aided design program, and printed on a home 3D printer. The parts exist to hold the hardware the rest of this catalogue runs on: a housing for an ESP32 printer camera, a mount for a Raspberry Pi Zero webcam, holders for Ubiquiti networking gear, and a handful of one-off brackets and covers.',
  },
  'w0rxbend/infrastruct': {
    tagline: 'Infrastructure-as-code for an ARM homelab',
    desc:
      'The single source of truth for a self-hosted homelab of Raspberry Pi, Rock64 and similar ARM machines, where the whole setup is described in files kept in Git rather than configured by hand. It covers host inventory, Ansible automation for users, SSH, packages and firewall, K3s (a lightweight Kubernetes distribution) managed with Flux CD, Docker Compose and Docker Swarm stacks, and a policy for encrypted secrets.',
  },
  'w0rxbend/instachron': {
    tagline: 'TCP frame server for the spycam ESP32 cameras',
    desc:
      'A Go service that listens on a raw TCP socket (a plain network connection with no HTTP, JSON or text framing on top) and receives JPEG camera frames pushed by the spycam and spycam-s3 firmware. It is the server half of that camera link: once frames arrive it republishes them through an HTTP interface, restreaming proxies, optional detection and upscaling, and a timelapse recorder.',
  },
  'w0rxbend/led-matrix-controller': {
    tagline: 'ESP8266 firmware for a WS2812B 8x8 LED matrix',
    desc:
      'Firmware for an ESP8266 NodeMCU, a small Wi-Fi microcontroller board, that drives an 8x8 panel of WS2812B addressable LEDs. It runs a TCP server (a plain network socket, port 7777) accepting compact binary commands to set single pixels, fill the panel, change brightness or push a whole frame, and it falls back to its own Wi-Fi access point when no credentials are configured.',
  },
  'w0rxbend/neoncore': {
    tagline: 'ESP32 LED indicator for AirGradient air quality',
    desc:
      'Firmware for an ESP32 microcontroller driving a 4x4 panel of WS2812B addressable LEDs, used as a remote display for an AirGradient ONE air-quality monitor. A scraper reads the monitor’s local network interface and pushes a status over Wi-Fi TCP, and the panel shows one of thirteen colour-and-animation states so the reading can be read across the room without a legend.',
  },
  'w0rxbend/obs-effects': {
    tagline: 'Animated browser-source overlays for OBS Studio',
    desc:
      'A collection of animated overlay screens — webcam borders, backgrounds and full-scene effects — drawn on the graphics card with PixiJS 8, a WebGL rendering library. Each screen is a separate web page with a transparent background that you add to OBS Studio (the open-source live-streaming and recording program) as a browser source.',
  },
  'w0rxbend/ops-dashboard': {
    tagline: 'Monitoring dashboard and metrics stack for a homelab',
    desc:
      'A workspace for keeping an eye on a self-hosted homelab, with a browser dashboard built in SolidJS, a small TypeScript backend, and a Docker Compose stack of monitoring services. The stack runs exporters that publish host and container metrics, VictoriaMetrics for storing them, Grafana for charts, and the Gatus uptime checker.',
  },
  'w0rxbend/scalachess-flix': {
    tagline: 'Flix port of the scalachess rules library',
    desc:
      'An experimental rewrite of lichess.org’s scalachess chess-rules library in Flix, a functional programming language on the Java Virtual Machine. It covers 96 percent of the original hand-written core — move generation, FEN and PGN notation, clocks, ratings, opening data and ten chess variants — checked against the same published move-count fixtures the Scala test-kit uses, but the README is explicit that it is not a drop-in replacement.',
  },
  'w0rxbend/scalacv': {
    tagline: 'Scala 3 binding for the OpenCV vision library',
    desc:
      'A Scala 3 binding for OpenCV 4.13, the open-source computer-vision library for working with images and video. It gives you a typed, resource-safe image pipeline on top of the complete Java bindings, so native memory is released exactly once, and it adds layers for detection, pose estimation, camera calibration and 2D drawing.',
  },
  'w0rxbend/spycam': {
    tagline: 'ESP32-CAM firmware feeding the instachron server',
    desc:
      'Firmware for the ESP32-CAM, a small Wi-Fi microcontroller board with a camera attached, that captures JPEG images and pushes the newest one over a long-lived raw TCP connection (a plain network socket with no HTTP or text framing). It is the client half of a camera link whose server is instachron, and it drops stale frames and reconnects with backoff whenever the network or the server goes away.',
  },
  'w0rxbend/spycam-s3': {
    tagline: 'ESP32-S3-CAM firmware feeding instachron',
    desc:
      'The same camera client as spycam rebuilt for ESP32-S3 camera boards, a newer generation of the Wi-Fi microcontroller, with a pin map for the GOOUUU OV2640 layout. It adds a camera identifier to every frame header so several boards can feed the instachron TCP frame server at once, which is the receiving half of the camera link.',
  },
  'w0rxbend/system-bootstrap': {
    tagline: 'Dotfiles and workstation bootstrap for Linux',
    desc:
      'A multi-distribution bootstrap for a Linux development machine, covering Fedora, Arch Linux and openSUSE. Shell scripts install packages and standalone binaries, link configuration files with Dotbot, add Nerd Fonts, and set up terminals, Neovim and desktop environments such as GNOME, COSMIC and Sway.',
  },
  'w0rxbend/twitch-musicplayer': {
    tagline: 'Music player and visualiser for live streams',
    desc:
      'A two-part project for playing background music on a live stream: a Go backend that indexes MP3 files, serves them over HTTP and coordinates playback over WebSockets (a two-way browser connection), and a browser front end that plays the audio and draws a visualiser with PixiJS and WebGL. Playback history is kept in SQLite, a small database that lives in a single file.',
  },
  'w0rxbend/twitch-vizer': {
    tagline: 'Chat and event overlays for OBS Studio',
    desc:
      'A self-hosted overlay system with two halves: a Python backend that subscribes to Twitch EventSub (Twitch’s push feed of chat and channel events) and rebroadcasts it over WebSocket, and TypeScript browser scenes rendered with PixiJS. The scenes display chat messages with emotes and emoji plus follows, subscriptions, gift subs, cheers and raids inside OBS Studio, the open-source live-streaming program.',
  },
  'w0rxbend/twitch-voxer': {
    tagline: 'Text-to-speech bot that reads Twitch chat aloud',
    desc:
      'A self-hosted bot that turns each Twitch chat message into synthesised speech and pushes the audio over a WebSocket (a two-way browser connection) to a browser source in OBS Studio, the open-source live-streaming and recording program. It detects Ukrainian or English, gives every chatter a voice that stays the same across sessions, expands abbreviations, skips known bots, and posts scheduled messages to chat.',
  },
  'w0rxbend/Zephyr': {
    tagline: 'Desktop manager for the SDKMAN toolchain installer',
    desc:
      'A desktop application built with Kotlin Multiplatform and Compose Desktop that wraps SDKMAN, the command-line tool for installing and switching between Java Development Kits and other software development kits. Its main purpose is to gather local-only versions — builds still on disk but no longer listed upstream — from every candidate into one screen so they can be cleaned up safely; Linux releases are published as AppImage, Snap and Flatpak.',
  },
  'oleksandr-balyshyn/deskctl': {
    tagline: 'GTK4 desktop controller for a standing desk',
    desc:
      'A native Linux desktop application for raising and lowering a standing desk, written in Rust with GTK4 and Relm4 (a toolkit and a framework for building desktop windows). It draws an animated side view of the desk, offers hold-to-move buttons and sit/stand presets, and can schedule automatic changes by time of day. The desk itself is driven by an ESP32 board, which the application reaches through a small proxy server rather than directly; that link is currently mocked while the proxy is being built.',
  },
  'oleksandr-balyshyn/glyphora': {
    tagline: 'Terminal user-interface toolkit for Scala 3',
    desc:
      'A library for building full-screen terminal applications in Scala 3, the way a browser framework builds a web page: state is held in reactive signals, and the screen redraws itself when a signal changes. It ships more than fifty widgets, keyboard and mouse handling, composable animation and a headless mode so an interface can be tested without a terminal, and it compiles ahead of time with GraalVM native-image using no runtime reflection.',
  },
};
