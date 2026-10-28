# Third-Party Licenses and Acknowledgements

This project includes assets and code from third-party sources. Their
respective licenses and attribution are listed below. The main project
itself is licensed under Apache 2.0 (see `LICENSE`).

---

## Meteocons (Weather Icons)

- **Files**: `client/public/weather-icons/*.svg`
- **Author**: Bas Milius
- **Source**: https://github.com/basmilius/meteocons
- **License**: MIT
- **Last synced**: 2026-04-10 — refresh occasionally to pick up upstream
  fixes. Procedure documented in `client/public/weather-icons/README.md`.

```
MIT License

Copyright (c) 2020-2024 Bas Milius

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Carbon Design System (favicon + UI components)

- **Files**: `client/public/brain.svg` (favicon — derived from the
  `ChartMultitype` icon), and the broader `@carbon/react` /
  `@carbon/icons-react` components used throughout the SPA.
- **Author**: IBM Corporation
- **Source**: https://github.com/carbon-design-system/carbon
- **License**: Apache 2.0

The favicon is the `ChartMultitype` glyph from `@carbon/icons-react`
exported as a standalone SVG. Carbon icons ship Apache 2.0, the same
license as this project, so redistribution requires no additional
notice beyond this acknowledgement.

---

## AG Grid (data grid component)

- **Packages**: `ag-grid-community`, `ag-grid-react` (Community Edition)
- **Author**: AG Grid Ltd.
- **Source**: https://github.com/ag-grid/ag-grid
- **License**: MIT

Used for the dataview component and component data-grid views
(`client/src/chart-spec/views/DataViewGrid.jsx`,
`client/src/components/ComponentDataGridModal.jsx`). This project uses the
**Community Edition** only — no AG Grid Enterprise packages or license key
are present, so there is no commercial obligation.

```
MIT License

Copyright (c) 2015-2026 AG GRID LTD

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Caddy (web server, client container)

- **Image**: `caddy:2-alpine` (`client/Dockerfile`)
- **Author**: Matthew Holt and The Caddy Authors
- **Source**: https://github.com/caddyserver/caddy
- **License**: Apache 2.0

Serves the built React client and reverse-proxies `/api/*` to the Go server.
Unlike the other entries here, Caddy is not vendored into the source tree —
it is the base image the published `outpost-client` container is built FROM,
so the binary is redistributed as part of that image. Its configuration lives
at `client/Caddyfile`.

```
Copyright 2015 Matthew Holt and The Caddy Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

---

## Alpine Linux (server container base)

- **Image**: `alpine:3.19` (`server-go/Dockerfile`, runtime stage)
- **Source**: https://alpinelinux.org — https://gitlab.alpinelinux.org/alpine
- **Licenses**: mixed — see the per-component table below

Like Caddy above, Alpine is not vendored into this source tree: it is the base
image the published `outpost-server` container is built FROM, so its userland
is redistributed inside that image. The Dockerfile additionally installs
`ca-certificates` and `tzdata`.

**This entry exists because the mix includes GPLv2**, which carries different
obligations from the permissive licenses elsewhere in this file. Licenses below
were read from the image itself (`apk info --license`) rather than from
documentation, so they reflect exactly what ships:

| Component | Version | License |
|---|---|---|
| BusyBox | 1.36.1 | **GPL-2.0-only** |
| alpine-baselayout | 3.4.3 | **GPL-2.0-only** |
| apk-tools | 2.14.4 | **GPL-2.0-only** |
| ssl_client | 1.36.1 | **GPL-2.0-only** |
| musl libc | 1.2.4 | MIT |
| ca-certificates | 20250911 | MPL-2.0 AND MIT |
| tzdata | 2025b | Public Domain |

The GPLv2 components are redistributed **unmodified**, as stock upstream
packages pulled from Alpine's repositories at build time. No Outpost code is
linked against or derived from them — the Go server is a statically compiled
binary copied into the image, and it does not link musl or any GPL component.
GPLv2's source-availability obligation is met by Alpine's own published
sources at the URL above.

### Build-stage images (deliberately not listed)

`node:20-alpine` and `golang:1.26.5-alpine` appear in these Dockerfiles but are
**not** covered here: they are multi-stage build stages, discarded before the
final image is assembled, so nothing from them is redistributed. Only the
runtime bases (Caddy, Alpine) ship.
