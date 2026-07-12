# Daily arXiv repository rules

## Production path

The only production path is:

```text
Codex desktop Scheduled Task
→ isolated worktree staging reports
→ scripts/publish-edition.mjs
→ origin/main
→ validated GitHub Pages deployment
```

Do not restore or create alternate ChatGPT Sites, Next.js, Vinext, Vite, Cloudflare, API-key, or direct-deploy paths.

## Daily scheduled runs

- Read `docs/SCHEDULED_TASK_PROMPT.md` completely and follow it exactly.
- Require explicitly configured `gpt-5.6-sol` with `ultra` reasoning. Never downgrade.
- Run only in a dedicated Scheduled-task worktree.
- Start with `node scripts/prepare-worktree.mjs`.
- Write candidate reports only under `.automation/staging/<runId>/`.
- Download arXiv PDFs only under `/tmp`; never store or stage a PDF.
- Do not change application code, scripts, docs, workflows, policies, or historical editions during a daily run.
- Do not run `git add`, `git commit`, or `git push` directly. Invoke the fixed publisher.
- Treat no announcement or an already-published date as a successful no-op.
- On uncertainty or failed validation, preserve `current.json` and do not publish.

## Repository safety

- Never add credentials, API keys, tokens, private keys, `.env` files, PDFs, symlinks, or nested `.git` directories.
- Never use `git add -A`, force push, force checkout, or `git reset --hard`.
- Dated reports and dated public editions are immutable.
- Author identity and reputation never affect scores. Registry badges are deterministic and non-scoring.
- Production reports use schema 1.3 and primary-category New submission `v1` records only.

## Verification

For infrastructure changes, run:

```bash
npm ci
npm test
npm run validate
git diff --check
```

Keep the package dependency-free unless the user explicitly approves a new dependency.
