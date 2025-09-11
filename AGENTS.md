# Repository Guidelines

## Project Structure & Module Organization
- CLI: `add-gl-quotes-to-tsv-files-cli.js` (entry executed via `npm link` or the published bin).
- Package config: `package.json` (ES modules, `bin` points to the CLI).
- CI/CD: `.github/workflows/` (Docker image build and push on tags).
- Container: `Dockerfile` (Node 20 base, installs published CLI globally).
- Samples/fixtures: `en_twl/`, `en_twl2/` (useful for local testing).
- No dedicated `src/` or `tests/` directories; this is a single‑file CLI.

## Build, Test, and Development Commands
- Install deps: `npm install`
- Link for local use: `npm link`
- Run locally (linked): `add-gl-quotes-to-tsv-files -w en_twl --zip`
- Run via node (no link): `node add-gl-quotes-to-tsv-files-cli.js -w en_twl --zip`
- Docker build: `docker build -t uw/add-gl-quotes .`
- Docker run example: `docker run --rm -v "$PWD":/work -w /work uw/add-gl-quotes add-gl-quotes-to-tsv-files -w en_twl --zip`

## Coding Style & Naming Conventions
- Language: Node.js ESM; prefer `async/await` and top‑level `import`.
- Indentation: 2 spaces; keep existing spacing and line width.
- Naming: files kebab‑case; variables/functions camelCase; constants UPPER_SNAKE.
- CLI flags are user‑facing API; do not rename or remove without discussion.

## Testing Guidelines
- Current: manual testing using `en_twl/` or your own TSV directory.
- Typical checks: verify `GLQuote` and `GLOccurrence` columns appear after `Occurrence`; confirm `--zip` creates `<repo>_<ref>_with_gl_quotes.zip`.
- If adding tests, place in `tests/` with `*.test.js` and a simple runner (e.g., `vitest` or `node:test`). Keep fixtures small.

## Commit & Pull Request Guidelines
- Commits: short, imperative subject (e.g., "Add verbose mode", "Fix book code"). Squash fixups when possible.
- PRs: include purpose, summary of changes, sample command(s) and output, `--verbose` logs if relevant, and linked issue(s).
- Backward compatibility: preserve existing flags and default behaviors.

## Security & Configuration Tips
- Environment: Node ≥18 (global `fetch` is used). Network access is required for DCS artifact download.
- Config sources: CLI args > GitHub Actions env > local git metadata. Avoid hardcoding secrets; none are required to run.
