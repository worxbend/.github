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
        <strong>I learn systems by building them. Linux tools, firmware, libraries, and a lot of things written twice.</strong>
      </p>
      <p>
        Read the code before you run it. Everything here is a summary — the
        <a href="https://worxbend.github.io/.github/"><strong>project site</strong></a> has every repo,
        searchable.
      </p>
    </td>
  </tr>
</table>

## Start here

Six things worth opening first. Everything else is grouped below.

| | Project | What it is |
| --- | --- | --- |
| **Scala libraries** | [worxbend/worxbend → `libs/commons/pretty-printo`](https://github.com/worxbend/worxbend/tree/main/libs/commons/pretty-printo) | Pretty-prints any Scala 3 value. Mark a field `@Excluded` or `@Redacted` and it prints the *declared type* without ever reading the value — the secret never enters the output path. |
| | [worxbend/worxbend → `libs/commons/reveal`](https://github.com/worxbend/worxbend/tree/main/libs/commons/reveal) | Same idea, `derives PrettyPrintable`, all resolved at compile time. Zero reflection, zero per-call cost, zero runtime deps. Enums, sealed traits, opaque types. |
| **OBS & streaming** | [worxbend/obs-stats](https://github.com/worxbend/obs-stats) | btop for OBS. CPU, frame pacing, encoder health, scenes, audio — live, in a terminal. |
| | [worxbend/obsctl](https://github.com/worxbend/obsctl) · [worxbend/obsctl-rs](https://github.com/worxbend/obsctl-rs) | Script OBS from the shell. Written twice: Crystal, then Rust. |
| **Air quality** | [worxbend/airgradient-desktop](https://github.com/worxbend/airgradient-desktop) · [·-android](https://github.com/worxbend/airgradient-android) · [·-cli](https://github.com/worxbend/airgradient-cli) · [·-papr](https://github.com/worxbend/airgradient-papr) | One sensor, read five ways: GTK, Android, CLI, e-paper, GNOME applet. LAN only, no cloud account. |
| **Linux setup** | [worxbend/fluxion.cr](https://github.com/worxbend/fluxion.cr) · [w0rxbend/system-bootstrap](https://github.com/w0rxbend/system-bootstrap) | Wiped disk to working dev machine, driven from Git. |
| **Hardware** | [w0rxbend/spycam](https://github.com/w0rxbend/spycam) + [w0rxbend/instachron](https://github.com/w0rxbend/instachron) | Two halves of one link. ESP32-CAM pushes JPEG frames over a raw TCP socket; a Go server catches them. |

<details>
<summary><h2>🎛️ OBS and streaming tools</h2></summary>

Everything that runs while the stream is live. Most of it drives OBS over **obs-websocket**.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/scenedeck](https://github.com/worxbend/scenedeck) | Desktop window for Linux: switch scenes, toggle sources, start and stop the stream. Shipped on [Snapcraft](https://snapcraft.io/scenedeck). | Rust, GTK4 |
| [worxbend/obs-stats](https://github.com/worxbend/obs-stats) | btop for OBS health, live in a terminal. | Rust, Ratatui |
| [worxbend/obsctl](https://github.com/worxbend/obsctl) | CLI plus TUI for scenes, audio and profiles. A daemon keeps the socket warm so commands are instant. | Crystal |
| [worxbend/obsctl-rs](https://github.com/worxbend/obsctl-rs) | Same controller, rewritten in Rust. Keyboard-driven, full screen. | Rust, Ratatui |
| [worxbend/multistream-manager](https://github.com/worxbend/multistream-manager) | Fill one form, press Start Streaming once, go live on Twitch and YouTube together. | Rust |
| [worxbend/twi](https://github.com/worxbend/twi) | Twitch chat over IRC in a terminal. Multiple channels, 13 themes. | Go |
| [worxbend/yc](https://github.com/worxbend/yc) | YouTube live chat in a terminal, with the daily API quota on screen. 58 themes. | Go |
| [worxbend/streaming-tools-site](https://github.com/worxbend/streaming-tools-site) | Interactive map of how these tools wire into OBS, Twitch and YouTube. [obs.worxbend.com](https://obs.worxbend.com) | JavaScript, PixiJS |
| [w0rxbend/obs-effects](https://github.com/w0rxbend/obs-effects) | Animated transparent overlays, dropped into OBS as browser sources. [obs-effects.worxbend.com](https://obs-effects.worxbend.com) | TypeScript, PixiJS 8 |
| [w0rxbend/twitch-voxer](https://github.com/w0rxbend/twitch-voxer) | Reads chat aloud. Detects Ukrainian or English, pins one voice per chatter. | Python |
| [w0rxbend/twitch-vizer](https://github.com/w0rxbend/twitch-vizer) | Alerts for follows, subs, cheers and raids, off Twitch EventSub. | Python, TypeScript |
| [w0rxbend/twitch-musicplayer](https://github.com/w0rxbend/twitch-musicplayer) | Go service serves the library, browser front end plays it and draws the visualiser. | Go, TypeScript |
| [w0rxbend/chat-brawl](https://github.com/w0rxbend/chat-brawl) | Type in chat, spawn into an on-screen fighting arena. | TypeScript, PixiJS |

</details>

<details>
<summary><h2>⬡ Scala, the JVM and libraries</h2></summary>

`pretty-printo` and `reveal` live in the [worxbend monorepo](https://github.com/worxbend/worxbend), not in
their own repos. Mill build, reusable pieces under `libs/`.

| Project | What it does | Built with |
| --- | --- | --- |
| [`libs/commons/pretty-printo`](https://github.com/worxbend/worxbend/tree/main/libs/commons/pretty-printo) | Configurable string rendering for any value. `@Excluded` and `@Redacted` fields are described from their declared type, so the printer never touches the value — which is what makes redaction and `null` safe. | Scala 3, Magnolia |
| [`libs/commons/reveal`](https://github.com/worxbend/worxbend/tree/main/libs/commons/reveal) | The successor, derived by macro. Omissions, redactions and type spellings are all decided during expansion. No reflection, no runtime deps. Enums, sealed families, opaque types. | Scala 3 macros |
| [w0rxbend/scalacv](https://github.com/w0rxbend/scalacv) | Scala 3 API over OpenCV 4.13. Typed pipeline that frees native memory exactly once. [Docs](https://w0rxbend.github.io/scalacv) | Scala 3, OpenCV |
| [worxbend/gitea-scala-client](https://github.com/worxbend/gitea-scala-client) | Typed Gitea client, verified against the OpenAPI contract. [Site](https://worxbend.github.io/gitea-scala-client/) | Scala 3, ZIO 2 |
| [worxbend/codeberg4s](https://github.com/worxbend/codeberg4s) | Codeberg and Forgejo client returning plain `Future`. No effect system dragged into your build. | Scala 3, sttp |
| [w0rxbend/shield](https://github.com/w0rxbend/shield) | Self-hostable auth server, wire-compatible with SuperTokens clients. | Scala 3, ZIO |
| [w0rxbend/compression-flix](https://github.com/w0rxbend/compression-flix) | Lichess clock and move compression ported to Flix, byte-for-byte. One differing bit would invalidate every stored game. | Flix |
| [w0rxbend/scalachess-flix](https://github.com/w0rxbend/scalachess-flix) | Lichess chess rules in Flix, checked against the upstream fixtures. Not a drop-in replacement. | Flix |
| [w0rxbend/data-engineering](https://github.com/w0rxbend/data-engineering) | Kafka, Kafka Connect and Flink sandbox, with a custom partitioner for the S3 sink. | Scala, Kafka |
| [worxbend/playground](https://github.com/worxbend/playground) | One event-streaming service, three web frameworks, side by side. | Scala 3, Kafka |
| [worxbend/worxbend](https://github.com/worxbend/worxbend) | The monorepo: small Scala apps, the libraries above, deploy recipes, notes. | Scala, Mill |

</details>

<details>
<summary><h2>🛠️ Linux tooling and provisioning</h2></summary>

Wiped disk to working dev machine, no manual steps. The same tool shows up here four times in four
languages on purpose: reimplementing something you already understand is a good way to learn a new one.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/fluxion.cr](https://github.com/worxbend/fluxion.cr) | One YAML file: packages, Flatpaks, dotfiles, fonts, binaries. Diffs the plan before it touches anything. CLI or TUI. [Site](https://worxbend.github.io/fluxion.cr/) | Crystal |
| [w0rxbend/system-bootstrap](https://github.com/w0rxbend/system-bootstrap) | My real setup: Fedora, Arch and openSUSE. Packages, binaries, dotfiles, Nerd Fonts, terminals, Neovim, GNOME/COSMIC/Sway. | Shell, Lua |
| [worxbend/fluxion](https://github.com/worxbend/fluxion) | The original, on the JVM. Records what it installed so the second run skips finished work. [Site](https://worxbend.github.io/fluxion/) | Java |
| [worxbend/binstaller](https://github.com/worxbend/binstaller) | Same prebuilt binaries on every machine from one profile. SHA-256 checked, lock file written. [Site](https://worxbend.github.io/binstaller/) | Scala 3, GraalVM |
| [worxbend/nerd-fonts-installer](https://github.com/worxbend/nerd-fonts-installer) | Nerd Fonts from one config file, with an interactive picker. [Site](https://worxbend.github.io/nerd-fonts-installer/) | Go |
| [worxbend/dotbot-go](https://github.com/worxbend/dotbot-go) · [worxbend/dotbot-scala](https://github.com/worxbend/dotbot-scala) | Dotbot rewritten twice. The Scala one compiles to a static binary, so the target box needs no JVM. | Go · Scala 3 |
| [w0rxbend/infrastruct](https://github.com/w0rxbend/infrastruct) | An ARM homelab as files in Git: inventory, Ansible, K3s with Flux CD, Docker stacks, encrypted secrets. | Python, Ansible |
| [w0rxbend/ops-dashboard](https://github.com/w0rxbend/ops-dashboard) | Watches that homelab. Exporters, VictoriaMetrics, Grafana, uptime checks, one browser dashboard. | TypeScript, SolidJS |

</details>

<details>
<summary><h2>🌬️ IoT: air quality and TCP cameras</h2></summary>

Firmware on small Wi-Fi boards, usually shipped with the server on the other end of the socket.

### The ESP32-CAM link — three repos, one system

[`spycam`](https://github.com/w0rxbend/spycam) is the camera half: ESP32-CAM firmware that captures JPEGs and
pushes the newest one over a long-lived raw TCP socket, dropping stale frames and reconnecting on its own.
[`instachron`](https://github.com/w0rxbend/instachron) is the server half: a Go service that listens on that
socket, stores frames, and republishes them over HTTP with restreaming, optional detection and upscaling, and
a timelapse recorder. [`spycam-s3`](https://github.com/w0rxbend/spycam-s3) is the camera half rebuilt for
ESP32-S3, stamping a camera ID into every frame so several boards feed one server.

### AirGradient

CO₂, PM2.5, temperature and humidity off an open-source indoor monitor. Every client below reads the device
over LAN. No cloud account, no vendor app.

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/airgradient-desktop](https://github.com/worxbend/airgradient-desktop) | Linux desktop window, live readings, monitor discovered on the network. | Rust, GTK4 |
| [worxbend/airgradient-android](https://github.com/worxbend/airgradient-android) | Native Android app. Dashboard plus notifications past a severity threshold. | Kotlin, Compose |
| [worxbend/airgradient-cli](https://github.com/worxbend/airgradient-cli) | Reads the desktop app's config, fetches once, prints compact. | Rust |
| [worxbend/airgradient-papr](https://github.com/worxbend/airgradient-papr) | E-paper firmware. Portable readout with weather and forecast. | C++, ESP32 |
| [worxbend/airgradient-gnome-extension](https://github.com/worxbend/airgradient-gnome-extension) | One icon in the GNOME top bar, coloured by air quality, gauges in the popup. | JavaScript |
| [worxbend/airgradient-observability](https://github.com/worxbend/airgradient-observability) | Self-hosted metrics: collector scrapes the sensor into VictoriaMetrics, Grafana on top. | TypeScript, Go |
| [worxbend/tv-dashboard](https://github.com/worxbend/tv-dashboard) | Always-on TV dashboard: air quality, weather, indoor climate, agenda, system status. | TypeScript, SolidJS |
| [w0rxbend/neoncore](https://github.com/w0rxbend/neoncore) | Addressable LED panel as an air-quality indicator. Readable across the room, no legend needed. | C++, ESP32 |

### Other boards

| Project | What it does | Built with |
| --- | --- | --- |
| [worxbend/frostfire](https://github.com/worxbend/frostfire) | ESP32 across a PC power-button header. Remote power-on. Fixed-length pulses, relay off at boot, token required. | C++ |
| [worxbend/frostfire-backend](https://github.com/worxbend/frostfire-backend) | The guarded service in front of that relay. Every request hits a safety policy before it reaches hardware. | Python, FastAPI |
| [w0rxbend/led-matrix-controller](https://github.com/w0rxbend/led-matrix-controller) | ESP8266 driving an 8x8 panel. Binary command protocol over TCP, falls back to its own AP when unconfigured. | C++ |
| [w0rxbend/echo](https://github.com/w0rxbend/echo) | Webhook to LED panel. Post an event, rules pick an animation, echo pushes it over TCP and reconnects itself. | Go |

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
  <sub>Issues and small PRs welcome, especially for Linux usability, packaging, docs and clear bugs. These are
  personal tools first, so anything that changes a project's direction will probably get a no.</sub>
</p>
