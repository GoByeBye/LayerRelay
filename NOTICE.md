# Copyright and third-party notices

Copyright (C) 2026 GoByeBye and contributors.

LayerRelay is licensed as a combined work under the GNU Affero General
Public License, version 3 or any later version (`AGPL-3.0-or-later`). The full
version 3 text is in [LICENSE](LICENSE). This software is provided without
warranty, as described by that license.

## AI-assisted development

Development of this project has included substantial assistance from AI coding
tools, including OpenAI Codex and Anthropic Claude. That assistance has included
implementation, refactoring, tests, documentation, and release-preparation work.

The maintainer decides what is accepted into the repository and is responsible
for reviewing, testing, and verifying the provenance of accepted changes. This
disclosure is informational: it does not change the project's
`AGPL-3.0-or-later` license or any third-party rights and notices below. An AI
disclosure is not a substitute for documenting the source and license of copied,
adapted, generated, or vendored material.

## FilamentColors.xyz data

The optional filament picker queries the public
[`FilamentColors.xyz`](https://filamentcolors.xyz/) API and normalizes a small
subset of its swatch data for display. FilamentColors.xyz is created and
maintained by Joe Kaufeld. Its production images, text, and data are licensed
under the [Creative Commons Attribution 4.0 International license](https://creativecommons.org/licenses/by/4.0/).

LayerRelay uses only the manufacturer, material, colour name, measured hex
colour, stable swatch identifier, and detail-page slug returned for an explicit
search. It does not redistribute the upstream image library or purchase links.
Picker text is sent by the LayerRelay server to the FilamentColors.xyz API as a
search query. Normalized suggestions and their bounded search terms are cached
locally, may be unavailable, and are never required for manual tool
configuration. Upstream data is normalized into LayerRelay's existing tool-slot
shape; FilamentColors.xyz does not endorse LayerRelay.

## Prusa libbgcode provenance

`bgcode.js` is a JavaScript/Node.js adaptation of parts of
[`prusa3d/libbgcode`](https://github.com/prusa3d/libbgcode), including the
binary G-code specification, Heatshrink decoding behavior, and
`MeatPack::unbinarize` behavior. It entered this codebase on 2026-07-04 and has
since been modified for JavaScript buffer handling, error handling, and this
application's metadata needs.

The provenance audit compared the local port with immutable upstream revision
[`6f4ad7ce6b0e638b760199d6611039a610a5a479`](https://github.com/prusa3d/libbgcode/tree/6f4ad7ce6b0e638b760199d6611039a610a5a479),
in particular:

- [`doc/specifications.md`](https://github.com/prusa3d/libbgcode/blob/6f4ad7ce6b0e638b760199d6611039a610a5a479/doc/specifications.md)
- [`src/LibBGCode/binarize/meatpack.cpp`](https://github.com/prusa3d/libbgcode/blob/6f4ad7ce6b0e638b760199d6611039a610a5a479/src/LibBGCode/binarize/meatpack.cpp)
- [`src/LibBGCode/binarize/meatpack.hpp`](https://github.com/prusa3d/libbgcode/blob/6f4ad7ce6b0e638b760199d6611039a610a5a479/src/LibBGCode/binarize/meatpack.hpp)

That upstream revision is distributed under GNU AGPL version 3 or later.
libbgcode's authors and contributors retain their respective copyrights.

## MeatPack — BSD 3-Clause notice

libbgcode identifies its MeatPack implementation as an adaptation of Scott
Mudge's MeatPack work. The local JavaScript decoder follows that implementation
through libbgcode. Source audited at
[`cc3af5a5ed8eee8775425366df426cf7baca6f61`](https://github.com/scottmudge/OctoPrint-MeatPack/tree/cc3af5a5ed8eee8775425366df426cf7baca6f61).

Copyright (c) 2025 Scott Mudge

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software without
   specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS “AS IS” AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON
ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## heatshrink — ISC notice

libbgcode credits Scott Vokes' heatshrink implementation. The local decoder's
early history does not establish whether it was independently implemented from
the format or adapted from that implementation, so this notice is retained
conservatively. Source audited at
[`7d419e1fa4830d0b919b9b6a91fe2fb786cf3280`](https://github.com/atomicobject/heatshrink/tree/7d419e1fa4830d0b919b9b6a91fe2fb786cf3280).

Copyright (c) 2013-2015, Scott Vokes <vokes.s@gmail.com>
All rights reserved.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

## Runtime dependencies

The locked production dependency graph was inventoried during the 2026-07-19
release audit. Its packages declare MIT, ISC, or BSD-3-Clause licenses, all
compatible with distribution of this combined work under the GNU AGPL. Their
declared license metadata and any bundled license files remain included with
installed dependencies.
