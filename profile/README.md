<div align="center">
  <a href="https://github.com/worxbend">
    <img src="./assets/banner.png" alt="Worxbend" width="100%" />
  </a>
</div>

<br />

<div align="center">
  <a href="https://github.com/vshymanskyy/StandWithUkraine/blob/main/docs/README.md">
    <img src="https://raw.githubusercontent.com/vshymanskyy/StandWithUkraine/main/badges/StandWithUkraine.svg" alt="Stand With Ukraine" />
  </a>
  <a href="https://worxbend.github.io/.github/">
    <img src="https://img.shields.io/badge/browse_every_repo-worxbend.github.io-6f42c1?style=for-the-badge&logo=githubpages&logoColor=white" alt="Browse every repository at worxbend.github.io" />
  </a>
  <a href="http://about.worxbend.com">
    <img src="https://img.shields.io/badge/about-worxbend.com-00b894?style=for-the-badge&logo=firefoxbrowser&logoColor=white" alt="about.worxbend.com" />
  </a>
  <a href="https://www.twitch.tv/worxbend">
    <img src="https://img.shields.io/badge/Twitch-worxbend-9146FF?style=for-the-badge&logo=twitch&logoColor=white" alt="Twitch worxbend" />
  </a>
</div>

<br />

<table>
  <tr>
    <td width="150" align="center" valign="middle">
      <img src="./assets/logo.png" alt="Worxbend logo" width="112" />
    </td>
    <td valign="middle">
      <p>
        <strong>Learning projects, practical Linux tools, and experiments that help me understand systems by building them.</strong>
      </p>
      <p>
        A working shelf rather than a product catalogue. Review before running, fork what helps, and expect
        project-specific assumptions. Everything below is a summary — the
        <a href="https://worxbend.github.io/.github/"><strong>project site</strong></a> lists every repository
        across all my accounts and lets you search it.
      </p>
    </td>
  </tr>
</table>

## Start here

The work I would show first, by area. Each area opens up further down.

| | Project | What it is |
| --- | --- | --- |
| **Scala libraries** | [worxbend/worxbend → `libs/commons/pretty-printo`](https://github.com/worxbend/worxbend/tree/main/libs/commons/pretty-printo) | Turns any Scala 3 value into a readable string, with fields you can mark `@Excluded` or `@Redacted`. It prints a field's *declared type* without ever reading the field, so a secret never reaches the output. |
| | [worxbend/worxbend → `libs/commons/reveal`](https://github.com/worxbend/worxbend/tree/main/libs/commons/reveal) | The same idea rebuilt as a compile-time macro: `derives PrettyPrintable`, no reflection, no per-call work, and no runtime dependencies at all. Handles enums, sealed traits and opaque types. |
| **OBS & streaming** | [worxbend/obs-stats](https://github.com/worxbend/obs-stats) | A live dashboard for OBS Studio drawn inside a terminal — processor use, frame pacing, encoder health, scenes and audio. |
| | [worxbend/obsctl](https://github.com/worxbend/obsctl) · [worxbend/obsctl-rs](https://github.com/worxbend/obsctl-rs) | Drive OBS Studio from the keyboard or a script instead of the mouse. The same tool written twice, once in Crystal and once in Rust. |
| **Air quality** | [worxbend/airgradient-desktop](https://github.com/worxbend/airgradient-desktop) · [·-android](https://github.com/worxbend/airgradient-android) · [·-cli](https://github.com/worxbend/airgradient-cli) · [·-papr](https://github.com/worxbend/airgradient-papr) | One AirGradient air-quality sensor, read five different ways — desktop, phone, terminal, e-paper and a GNOME panel icon. All over the local network, no cloud account. |
| **Linux setup** | [worxbend/fluxion.cr](https://github.com/worxbend/fluxion.cr) · [w0rxbend/system-bootstrap](https://github.com/w0rxbend/system-bootstrap) | Take a machine that was wiped an hour ago back to a working development setup, from files kept in Git. |
| **Hardware** | [w0rxbend/spycam](https://github.com/w0rxbend/spycam) + [w0rxbend/instachron](https://github.com/w0rxbend/instachron) | Two halves of one camera link: firmware on an ESP32-CAM board pushes JPEG frames over a raw network socket, and a small Go server catches them. |

> **Jargon, once:** **OBS Studio** is the open-source program that captures a screen or camera and sends it to a
> streaming service. A **TUI** is a full-screen interface drawn inside a terminal window. **TCP** is a raw network
> socket — a plain byte-by-byte connection between two programs, with no HTTP or JSON on top. The **JVM** is the
> Java Virtual Machine, which Scala, Java, Kotlin and Flix all compile down to.

<details>
<summary><h2>🎛️ OBS and streaming tools</h2></summary>

Everything that runs while a live stream is on air. Most of these talk to OBS Studio over
**obs-websocket**, the remote-control protocol OBS exposes so other programs can drive it.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/scenedeck](https://github.com/worxbend/scenedeck) | A normal desktop window for Linux that switches scenes, toggles sources and starts or stops the stream. Also on [Snapcraft](https://snapcraft.io/scenedeck). | Rust, GTK4 |
| [worxbend/obs-stats](https://github.com/worxbend/obs-stats) | A terminal dashboard in the style of the system monitor btop, showing OBS health live. | Rust, Ratatui |
| [worxbend/obsctl](https://github.com/worxbend/obsctl) | Command line plus terminal dashboard, so scenes, audio and profiles can be scripted. A small background daemon keeps the connection warm. | Crystal |
| [worxbend/obsctl-rs](https://github.com/worxbend/obsctl-rs) | The same controller rewritten in Rust, keyboard-driven and full screen. | Rust, Ratatui |
| [worxbend/multistream-manager](https://github.com/worxbend/multistream-manager) | Prepares a Twitch stream and a YouTube broadcast from one form, so a single Start Streaming press goes live on both. | Rust |
| [worxbend/twi](https://github.com/worxbend/twi) | Twitch chat in a terminal instead of a browser: several channels at once over IRC, 13 themes. | Go |
| [worxbend/yc](https://github.com/worxbend/yc) | YouTube live chat in a terminal, showing how much of the daily API allowance is left. 58 themes. | Go |
| [worxbend/streaming-tools-site](https://github.com/worxbend/streaming-tools-site) | An interactive map of how these tools connect to OBS, Twitch and YouTube. [obs.worxbend.com](https://obs.worxbend.com) | JavaScript, PixiJS |
| [w0rxbend/obs-effects](https://github.com/w0rxbend/obs-effects) | Animated overlays with transparent backgrounds, added to OBS as browser sources. [obs-effects.worxbend.com](https://obs-effects.worxbend.com) | TypeScript, PixiJS 8 |
| [w0rxbend/twitch-voxer](https://github.com/w0rxbend/twitch-voxer) | Reads Twitch chat aloud, detecting Ukrainian or English and giving every chatter a consistent voice. | Python |
| [w0rxbend/twitch-vizer](https://github.com/w0rxbend/twitch-vizer) | On-screen alerts for follows, subscriptions, cheers and raids, fed by Twitch's push feed of channel events. | Python, TypeScript |
| [w0rxbend/twitch-musicplayer](https://github.com/w0rxbend/twitch-musicplayer) | Background music for a stream: a Go service serves the library, a browser front end plays it and draws a visualiser. | Go, TypeScript |
| [w0rxbend/chat-brawl](https://github.com/w0rxbend/chat-brawl) | An overlay where everyone who types in chat joins an on-screen fighting arena. | TypeScript, PixiJS |

</details>

<details>
<summary><h2>⬡ Scala, the JVM and libraries</h2></summary>

The library-shaped work. The two `pretty-printo` and `reveal` libraries live inside the
[worxbend monorepo](https://github.com/worxbend/worxbend) rather than in repositories of their own — it is
built with [Mill](https://mill-build.org/), and `libs/` is where the reusable pieces go.

| Project | What it does | Built with |
| --- | --- | --- |
| [`libs/commons/pretty-printo`](https://github.com/worxbend/worxbend/tree/main/libs/commons/pretty-printo) | Renders any value as a configurable string. Fields can be annotated `@Excluded` or `@Redacted`, and because the printer knows each field's declared type it never has to read the value to describe it — which is what makes redaction and `null` safe. | Scala 3, Magnolia |
| [`libs/commons/reveal`](https://github.com/worxbend/worxbend/tree/main/libs/commons/reveal) | The successor, derived entirely at compile time by a macro. Every decision — which fields are omitted, which are redacted, how a type is spelled — is made once during expansion, so there is no reflection and no runtime dependency. Covers enums, sealed families and opaque types. | Scala 3 macros |
| [w0rxbend/scalacv](https://github.com/w0rxbend/scalacv) | A Scala 3 API over OpenCV 4.13, the open-source computer-vision toolkit, with a typed pipeline that releases native memory exactly once. [Docs](https://w0rxbend.github.io/scalacv) | Scala 3, OpenCV |
| [worxbend/gitea-scala-client](https://github.com/worxbend/gitea-scala-client) | A typed client for Gitea, a Git hosting service people run on their own servers, checked against its OpenAPI contract. [Site](https://worxbend.github.io/gitea-scala-client/) | Scala 3, ZIO 2 |
| [worxbend/codeberg4s](https://github.com/worxbend/codeberg4s) | A client for the Codeberg and Forgejo API that returns plain `Future` values instead of pulling an effect system into your project. | Scala 3, sttp |
| [w0rxbend/shield](https://github.com/w0rxbend/shield) | A self-hostable authentication server whose HTTP interface is deliberately compatible with SuperTokens clients. | Scala 3, ZIO |
| [w0rxbend/compression-flix](https://github.com/w0rxbend/compression-flix) | Lichess's chess clock and move compression ported from Scala to Flix, byte-for-byte identical — one differing bit would invalidate every stored game. | Flix |
| [w0rxbend/scalachess-flix](https://github.com/w0rxbend/scalachess-flix) | Lichess's chess-rules library rewritten in Flix and checked against the same published fixtures. Not a drop-in replacement. | Flix |
| [w0rxbend/data-engineering](https://github.com/w0rxbend/data-engineering) | A sandbox around Apache Kafka, Kafka Connect and Apache Flink, with a custom partitioner for the S3 sink. | Scala, Kafka |
| [worxbend/playground](https://github.com/worxbend/playground) | The same event-streaming service written three times on three different web frameworks, as a side-by-side comparison. | Scala 3, Kafka |
| [worxbend/worxbend](https://github.com/worxbend/worxbend) | The monorepo itself: small Scala apps, the libraries above, deployment recipes and notes. | Scala, Mill |

</details>

<details>
<summary><h2>🛠️ Linux tooling and provisioning</h2></summary>

Provisioning means taking a machine that was wiped an hour ago and getting it back to a working development
setup without doing it by hand. The same idea is deliberately implemented more than once in different
languages — reimplementing something you already understand is a good way to learn a new one.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/fluxion.cr](https://github.com/worxbend/fluxion.cr) | Sets up a Linux workstation from one YAML file — packages, Flatpaks, dotfiles, fonts, binaries — and shows you a preview of the changes before applying any of them. Runs as a plain command or a full-screen terminal interface. [Site](https://worxbend.github.io/fluxion.cr/) | Crystal |
| [w0rxbend/system-bootstrap](https://github.com/w0rxbend/system-bootstrap) | My actual machine setup, covering Fedora, Arch Linux and openSUSE: packages, binaries, dotfiles, Nerd Fonts, terminals, Neovim, and GNOME, COSMIC or Sway. | Shell, Lua |
| [worxbend/fluxion](https://github.com/worxbend/fluxion) | The original of the same idea, on the JVM. Records what it installed so a second run skips finished work. [Site](https://worxbend.github.io/fluxion/) | Java |
| [worxbend/binstaller](https://github.com/worxbend/binstaller) | Puts the same prebuilt binaries on every machine from one profile, checking each download against its SHA-256 fingerprint and writing a lock file. [Site](https://worxbend.github.io/binstaller/) | Scala 3, GraalVM |
| [worxbend/nerd-fonts-installer](https://github.com/worxbend/nerd-fonts-installer) | Installs Nerd Fonts — programming typefaces patched with extra icon glyphs — from one config file, with an interactive picker. [Site](https://worxbend.github.io/nerd-fonts-installer/) | Go |
| [worxbend/dotbot-go](https://github.com/worxbend/dotbot-go) · [worxbend/dotbot-scala](https://github.com/worxbend/dotbot-scala) | Dotbot, which installs personal config files from a declarative spec, rewritten twice. The Scala one compiles to a standalone binary so the target machine needs no Java. | Go · Scala 3 |
| [w0rxbend/infrastruct](https://github.com/w0rxbend/infrastruct) | A homelab of ARM machines described entirely in files kept in Git: inventory, Ansible, K3s with Flux CD, Docker stacks and encrypted secrets. | Python, Ansible |
| [w0rxbend/ops-dashboard](https://github.com/w0rxbend/ops-dashboard) | Keeps an eye on that homelab — a browser dashboard over exporters, VictoriaMetrics, Grafana and an uptime checker. | TypeScript, SolidJS |

</details>

<details>
<summary><h2>🌬️ IoT: air quality and TCP cameras</h2></summary>

Small Wi-Fi microcontroller boards running firmware I wrote, usually paired with a server on the network
that I also wrote.

### The ESP32-CAM link — one system, three repositories

[`spycam`](https://github.com/w0rxbend/spycam) is the **camera half**: firmware for the ESP32-CAM, a small
Wi-Fi board with a camera attached, which captures JPEG images and pushes the newest one over a long-lived
raw TCP socket, dropping stale frames and reconnecting when the network drops.
[`instachron`](https://github.com/w0rxbend/instachron) is the **server half**: a Go service that listens on
that socket, stores the frames, and republishes them over HTTP with restreaming, optional detection and
upscaling, and a timelapse recorder. [`spycam-s3`](https://github.com/w0rxbend/spycam-s3) is the same camera
half rebuilt for newer ESP32-S3 boards, stamping a camera identifier into every frame so several boards can
feed one server at once.

### AirGradient

**AirGradient** makes open-source indoor air-quality monitors measuring carbon dioxide, fine particles,
temperature and humidity. Every client here reads the device over the local network, so none of them needs a
cloud account or the vendor's phone app.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/airgradient-desktop](https://github.com/worxbend/airgradient-desktop) | A Linux desktop window showing live readings from a monitor found on the network. | Rust, GTK4 |
| [worxbend/airgradient-android](https://github.com/worxbend/airgradient-android) | A native Android app with a dashboard and notifications when readings pass a chosen severity. | Kotlin, Compose |
| [worxbend/airgradient-cli](https://github.com/worxbend/airgradient-cli) | Reuses the desktop app's config file, fetches the current measurements once and prints them compactly. | Rust |
| [worxbend/airgradient-papr](https://github.com/worxbend/airgradient-papr) | Firmware for a board with an electronic-paper screen — the low-power display used in e-readers — as a portable readout, alongside weather and forecast. | C++, ESP32 |
| [worxbend/airgradient-gnome-extension](https://github.com/worxbend/airgradient-gnome-extension) | One icon in the GNOME top bar, coloured by current air quality, opening a popup of gauges. | JavaScript |
| [worxbend/airgradient-observability](https://github.com/worxbend/airgradient-observability) | A self-hosted metrics stack: a collector reads the sensor, forwards samples to VictoriaMetrics and serves Grafana dashboards. | TypeScript, Go |
| [worxbend/tv-dashboard](https://github.com/worxbend/tv-dashboard) | An always-on dashboard filling a television: air quality, weather, indoor climate, agenda and system status. | TypeScript, SolidJS |
| [w0rxbend/neoncore](https://github.com/w0rxbend/neoncore) | Firmware driving a panel of addressable LEDs as a remote air-quality indicator, readable across the room without a legend. | C++, ESP32 |

### Other boards

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/frostfire](https://github.com/worxbend/frostfire) | ESP32 firmware that briefly closes a relay across a computer's power-button header, so the machine can be switched on remotely. Fixed-length pulses, relay off at boot, token required. | C++ |
| [worxbend/frostfire-backend](https://github.com/worxbend/frostfire-backend) | The guarded web service in front of that relay, with a safety policy checking every request before it reaches the hardware. | Python, FastAPI |
| [w0rxbend/led-matrix-controller](https://github.com/w0rxbend/led-matrix-controller) | ESP8266 firmware driving an 8x8 LED panel over a TCP server that accepts compact binary commands, falling back to its own access point when unconfigured. | C++ |
| [w0rxbend/echo](https://github.com/w0rxbend/echo) | Sits between webhooks and those panels: post an event, rules pick an animation, echo pushes it over TCP with automatic reconnection. | Go |

</details>

<br />

<div align="center">
  <a href="https://worxbend.github.io/.github/">
    <img src="https://img.shields.io/badge/Project_site-worxbend.github.io-6f42c1?style=for-the-badge&logo=githubpages&logoColor=white" alt="Project site" />
  </a>
  <a href="https://github.com/worxbend">
    <img src="https://img.shields.io/badge/GitHub-worxbend-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub worxbend" />
  </a>
  <a href="https://github.com/w0rxbend">
    <img src="https://img.shields.io/badge/GitHub-w0rxbend-181717?style=for-the-badge&logo=github&logoColor=white" alt="GitHub w0rxbend" />
  </a>
  <a href="http://about.worxbend.com">
    <img src="https://img.shields.io/badge/About-about.worxbend.com-0aa36e?style=for-the-badge&logo=readme&logoColor=white" alt="About Worxbend" />
  </a>
</div>

<p align="center">
  <sub>Issues and small pull requests are welcome when they match a project's direction — especially for Linux
  usability, packaging, docs and clear bugs. Most repositories here are personal tools first.</sub>
</p>
