# Third-Party Licenses

Plisto's own source code is licensed under the **GNU Affero General Public
License v3.0** (see [`LICENSE`](./LICENSE)). The Plisto **name and logo** are
reserved (see [`NOTICE`](./NOTICE)).

Plisto is built with third-party open-source components — Rust crates and
JavaScript packages — each licensed under its own terms. This file lists the
components Plisto depends on and the licenses that apply to them.

## Compatibility summary

Every third-party component Plisto uses is under a **permissive or
AGPL-compatible** license — predominantly MIT and Apache-2.0, with some
BSD-2/3-Clause, ISC, Zlib, Unicode-3.0, Unlicense, 0BSD, CC0-1.0, and MPL-2.0.
**No dependency is under a license that conflicts with distributing Plisto
under the AGPL-3.0** (there are no GPL/AGPL-incompatible or proprietary
dependencies). MPL-2.0 (used by `symphonia`) is a file-level weak copyleft that
is explicitly compatible with the GPL/AGPL family.

The authoritative, exact dependency inventory lives in the lock files, which are
committed to the repository:

- Rust: [`src-tauri/Cargo.lock`](./src-tauri/Cargo.lock)
- JavaScript: `package-lock.json`

To regenerate a complete, machine-verified per-package license bundle (including
every transitive dependency's own copyright notice and license text), run:

```bash
# Rust — https://github.com/EmbarkStudios/cargo-about
cargo install cargo-about
cargo about generate --manifest-path src-tauri/Cargo.toml about.hbs > THIRD_PARTY_RUST.html

# JavaScript — https://github.com/davglass/license-checker
npx license-checker --production --summary
```

---

## Direct Rust dependencies

These are the crates Plisto declares directly (see `src-tauri/Cargo.toml`). They
in turn pull a transitive tree of **≈584 crates**, all under the licenses noted
in the summary above.

| Crate | Version | License (SPDX) |
| --- | --- | --- |
| blake3 | 1.8.6 | CC0-1.0 OR Apache-2.0 OR Apache-2.0 WITH LLVM-exception |
| crossbeam-channel | 0.5.16 | MIT OR Apache-2.0 |
| dunce | 1.0.5 | CC0-1.0 OR MIT-0 OR Apache-2.0 |
| image | 0.25.10 | MIT OR Apache-2.0 |
| lofty | 0.25.0 | MIT OR Apache-2.0 |
| mp4 | 0.14.0 | MIT |
| ogg | 0.9.2 | BSD-3-Clause |
| opus-rs | 0.1.32 | BSD-3-Clause |
| rayon | 1.12.0 | MIT OR Apache-2.0 |
| regex | 1.13.1 | MIT OR Apache-2.0 |
| rodio | 0.20.1 | MIT OR Apache-2.0 |
| rusqlite | 0.40.2 | MIT |
| serde | 1.0.229 | MIT OR Apache-2.0 |
| serde_json | 1.0.151 | MIT OR Apache-2.0 |
| symphonia | 0.5.5 | MPL-2.0 |
| tauri | 2.11.5 | Apache-2.0 OR MIT |
| tauri-plugin-dialog | 2.7.2 | Apache-2.0 OR MIT |
| tauri-plugin-notification | 2.3.3 | Apache-2.0 OR MIT |
| tauri-plugin-opener | 2.5.4 | Apache-2.0 OR MIT |
| unicode-normalization | 0.1.25 | MIT OR Apache-2.0 |
| walkdir | 2.5.0 | Unlicense OR MIT |
| windows | 0.54.0 | MIT OR Apache-2.0 |
| windows-core | 0.54.0 | MIT OR Apache-2.0 |

## Direct JavaScript dependencies

Declared in `package.json`. Runtime dependencies plus the build/dev toolchain.

| Package | Version | License (SPDX) |
| --- | --- | --- |
| @dnd-kit/core | 6.3.1 | MIT |
| @dnd-kit/sortable | 10.0.0 | MIT |
| @dnd-kit/utilities | 3.2.2 | MIT |
| @tanstack/react-table | 8.21.3 | MIT |
| @tanstack/react-virtual | 3.14.9 | MIT |
| @tauri-apps/api | 2.11.1 | Apache-2.0 OR MIT |
| @tauri-apps/plugin-dialog | 2.7.2 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-notification | 2.3.3 | MIT OR Apache-2.0 |
| @tauri-apps/plugin-opener | 2.5.4 | MIT OR Apache-2.0 |
| lucide-react | 1.31.0 | ISC |
| react | 19.2.8 | MIT |
| react-dom | 19.2.8 | MIT |
| zustand | 5.0.15 | MIT |
| @tauri-apps/cli (dev) | 2.11.4 | Apache-2.0 OR MIT |
| @types/react (dev) | 19.2.18 | MIT |
| @types/react-dom (dev) | 19.2.4 | MIT |
| @vitejs/plugin-react (dev) | 4.7.0 | MIT |
| typescript (dev) | 5.8.3 | Apache-2.0 |
| vite (dev) | 7.3.6 | MIT |
| vitest (dev) | 4.1.10 | MIT |

## Full dependency tree — license breakdown

The complete Rust build resolves **≈584 crates**. Their declared SPDX licenses
break down as follows (a single crate is often offered under several licenses;
you may pick any one):

```
268  MIT OR Apache-2.0
125  MIT
 51  Apache-2.0 OR MIT
 25  MIT/Apache-2.0
 18  MPL-2.0
 18  Unicode-3.0
 17  Zlib OR Apache-2.0 OR MIT
 10  Unlicense OR MIT
  6  Apache-2.0
  5  BSD-3-Clause
  5  Apache-2.0/MIT
  5  Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT
  … (remaining rows are further permissive combinations of the above)
```

Every remaining entry is another combination of MIT / Apache-2.0 / BSD /
ISC / Zlib / Unicode-3.0 / Unlicense / 0BSD / CC0-1.0. **No copyleft-incompatible
or proprietary licenses appear in the tree.**

---

## License texts

The full texts of the longer standard licenses referenced above are the canonical
SPDX texts, available at the URLs given (they are reproduced verbatim in a
complete `cargo about` bundle; include them alongside any binary distribution):

- **Apache-2.0** — https://www.apache.org/licenses/LICENSE-2.0.txt
- **MPL-2.0** — https://www.mozilla.org/en-US/MPL/2.0/
- **Unicode-3.0** — https://spdx.org/licenses/Unicode-3.0.html
- **CC0-1.0** — https://creativecommons.org/publicdomain/zero/1.0/legalcode
- **Unlicense** — https://unlicense.org/

The shorter permissive licenses are reproduced below. In each, the bracketed
copyright line stands for the individual copyright notice carried by each
respective package (see that package's own source for the exact holder and year).

### MIT License

```
Copyright (c) <year> <copyright holders>

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

### BSD 3-Clause License

```
Copyright (c) <year> <owner>. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### BSD 2-Clause License

```
Copyright (c) <year> <owner>. All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ISC License

```
Copyright (c) <year> <owner>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

### Zlib License

```
This software is provided 'as-is', without any express or implied warranty. In
no event will the authors be held liable for any damages arising from the use of
this software.

Permission is granted to anyone to use this software for any purpose, including
commercial applications, and to alter it and redistribute it freely, subject to
the following restrictions:

1. The origin of this software must not be misrepresented; you must not claim
   that you wrote the original software. If you use this software in a product,
   an acknowledgment in the product documentation would be appreciated but is
   not required.

2. Altered source versions must be plainly marked as such, and must not be
   misrepresented as being the original software.

3. This notice may not be removed or altered from any source distribution.
```

### BSD Zero Clause License (0BSD)

```
Copyright (c) <year> <owner>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.
```

---

*This document was compiled from the project's declared dependencies and their
SPDX license metadata. For a byte-exact per-crate manifest that captures every
transitive package's individual copyright line, generate the bundle with
`cargo about` / `license-checker` as shown above before shipping a binary
release.*
