These public test vectors are copied from `minisign-verify` 0.2.5,
`src/lib.rs`, tests `verify` and `verify_prehashed`:

- Upstream: https://github.com/jedisct1/rust-minisign-verify
- Published crate: https://crates.io/crates/minisign-verify/0.2.5
- Published crate SHA-256: `22f9645cb765ea72b8111f36c522475d2daa0d22c957a9826437e97534bc4e9e`
- Crate VCS metadata: commit `3a91d03f86a8462a1af953c2854687d3f953d541`
  (the published crate records `dirty: true`, so the published crate is the
  authoritative source for these exact vectors).

The signed message is the four ASCII bytes `test`, without a newline.
`public-key.minisign` contains the public key from `verify`; the other files
contain the legacy and prehashed signatures respectively. Rust source string
continuations are joined, and `\t` escapes become literal tabs. Tests apply
Tauri's outer base64 wrapper themselves. No private key is included or needed.

Copyright (c) 2019-2025 Frank Denis

Permission is hereby granted, free of charge, to any
person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the
Software without restriction, including without
limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software
is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice
shall be included in all copies or substantial portions
of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT
SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION
OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR
IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
