# Third-party notices

## BB UI components

The generated/copied UI components, hooks and helpers under `plugins/*/components/`, `plugins/*/lib/` and `plugins/*/hooks/` originate from the BB plugin registry, as identified by each plugin's `components.json`. Prompt Prewalk references `desktop-v0.43.4`; Prompt Cache, Recap, Kaban and Thread Manager reference `desktop-v0.45.0`. They include BB's icon definitions. They retain the upstream MIT license below; the repository's own copyright notice does not replace this notice.

Source licenses: [desktop-v0.43.4](https://github.com/get-bb/bb/blob/desktop-v0.43.4/LICENSE) and [desktop-v0.45.0](https://github.com/get-bb/bb/blob/desktop-v0.45.0/LICENSE). Both carry the same notice below.

```text
MIT License

Copyright (c) 2026 Michael Yong

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

## Kaban integration

`plugins/kaban` is adapted from the Kaban project's BB integration. It is MIT licensed, Copyright (c) 2026 Kaban Contributors. The original copyright and permission notice are preserved in [plugins/kaban/LICENSE](plugins/kaban/LICENSE); this repository's root license does not replace them. Package-local BB component notices are preserved in [plugins/kaban/THIRD_PARTY_NOTICES.md](plugins/kaban/THIRD_PARTY_NOTICES.md).

## Package dependencies

Dependencies referenced by the package manifests and lockfiles retain their respective licenses and notices. Their source trees and build artifacts are not vendored in this repository; installation retrieves them from the public npm registry. Distributors of built bundles must also preserve applicable dependency notices.
