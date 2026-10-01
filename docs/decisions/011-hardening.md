# §16 #11 — Hardening

**Decided:** 2026-07-11 (production readiness). Cited as `ARCH.md §16 #11`; "§N" is a section of [ARCH.md](../../ARCH.md), "#N" another decision here.

Hardening: `secureHeaders()` (no CSP — inline onsubmit confirms), `robots.txt`
disallow-all (share pages already carry noindex), logo + PWA manifest + icons so the
app installs to phone home screens (relevant: the barcode scanner).
