# reference — frozen extraction inputs

Captures taken during Stage 1 (extraction) against **purplemux 0.3.2** on the build host,
used as the fixed ground truth for the 3-agent panel:

- `api-guide.txt` — output of `purplemux api-guide` (the server's own HTTP API reference)
- `help.txt` — output of `purplemux help`
- `runtime-env.txt` — captured `PMUX_PORT` and the local install path

Source-line citations in `../01-cli-features.md` and the panel drafts (e.g. `cli.js:21`,
`purplemux.js:14`) refer to purplemux's **own** `bin/cli.js` / `bin/purplemux.js` in the
installed [`purplemux`](https://github.com/subicura/purplemux) package — those upstream files
are intentionally **not** vendored here.
