# Daily arXiv v3: qualified-model pipeline

## Non-negotiable publication policy

Only a run explicitly configured as `gpt-5.6-sol` with `ultra` reasoning may publish a new edition, and only after that model has passed the one-time Pro-reference benchmark in `data/model-policy.json`. Every category report must use schema `1.3` and contain the same verified `evaluationRun` object. The merger rejects missing, different, unqualified, or unverified model metadata.

OpenAI describes 5.6 Sol as the flagship GPT-5.6 model with the strongest capability for complex research work, while Ultra is the maximum reasoning mode with automatic task delegation. OpenAI does not publish an exact numerical equivalence between 5.6 Sol Ultra and GPT-5.5 Pro. The model choice is therefore a product-hierarchy qualification, not a benchmark guarantee.

Before enabling automatic publication, evaluate at least 30 representative papers independently with a Pro reference and with Sol Ultra using the same blinded rubric. Set `qualificationStatus` to `qualified` only if every threshold in `data/model-policy.json` passes and a domain expert spot-checks the largest disagreements.

## Architecture

```text
One personal Codex automation: 5.6 Sol / Ultra
  -> evaluate hep-th, gr-qc, quant-ph
  -> abstract-screen every new primary paper
  -> full-text review until every final top ten is reviewed
  -> deterministic validation and merge
  -> commit dated JSON, current.json, and index.json
  -> push to a public GitHub repository
GitHub Pages
  -> serves immutable dated JSON and the current pointer
ChatGPT Site display
  -> fetches GitHub Pages JSON
Shared laboratory display
  -> opens the public Site without a ChatGPT login
```

The evaluator and public display are deliberately decoupled. A failed run never overwrites `current.json`; the previous successful edition remains visible.

## Evaluation run metadata

Each category report must contain:

```json
{
  "schemaVersion": "1.3",
  "evaluationRun": {
    "modelId": "gpt-5.6-sol",
    "modelDisplayName": "5.6 Sol Ultra",
    "reasoningEffort": "ultra",
    "modelSelectionVerified": true,
    "runId": "a unique identifier shared by all three category reports"
  }
}
```

The automation must not infer or invent these values. It may set `modelSelectionVerified: true` only when the scheduled task configuration explicitly selects 5.6 Sol and Ultra.

## Ranking protocol

1. Read the official arXiv new listings for `hep-th`, `gr-qc`, and `quant-ph`.
2. Keep primary-category `v1` New submissions only; exclude cross submissions, replacements, and duplicate base IDs.
3. Use title, complete authors, abstract, category, and comments for an initial blind content score.
4. Author identity, affiliation, fame, prizes, citations, and career stage never affect the four scores.
5. Rank provisionally using the four 25-point content scores.
6. Read the complete PDFs of the provisional top ten in each category.
7. Re-score from the introduction, assumptions, derivation or methods, results, validation, conclusion, limitations, and relevant appendices.
8. If a reviewed paper falls below an unreviewed candidate, review that candidate too. Repeat until every final top-ten paper is full-text reviewed.
9. Add verified distinguished-author badges only after scores are frozen. Badges never affect rank.

## Publication gate

Run:

```bash
node scripts/merge_category_reports.mjs YYYY-MM-DD --require-model-policy
npm run test:model-policy
npm run typecheck
npm run build
```

Publish only when all commands succeed and the generated dashboard has schema `1.3` with the verified Sol Ultra metadata. Commit the dated file before replacing `current.json`.

## Storage layout

```text
public/data/YYYY-MM-DD.json
public/data/current.json
public/data/index.json
```

Do not upload arXiv PDFs. Store only derived summaries, evaluations, review-status text, and arXiv links.
