# Single Codex automation prompt

Configure the scheduled task itself to use **5.6 Sol** with **Ultra** reasoning. Do not rely on this prompt to select the model.

```text
Produce and publish the next complete Daily arXiv edition from the personal Daily arXiv repository.

Before doing any research, verify that this task is explicitly configured for model gpt-5.6-sol with Ultra reasoning. If that configuration cannot be verified, stop without changing current.json or publishing anything and report MODEL_POLICY_BLOCKED.

Read data/model-policy.json and docs/SOL_ULTRA_PIPELINE.md and follow them exactly. Create one runId for this execution and use it in all three category reports. Use parallel subagents for hep-th, gr-qc, and quant-ph when Ultra makes them available, but apply the same frozen rubric and deterministic validation to all categories.

For each category, process only primary-category v1 papers in the official arXiv New submissions section. Exclude cross submissions, replacements, and duplicate base IDs. Evaluate all eligible papers from title, complete authors, abstract, category, and comments without using author reputation. Score broadImpact, categoryImpact, originality, and technicalStrength as integers from 0 to 25.

Read the complete arXiv PDFs needed to ensure that every final top-ten paper in every category has a documented full-text review. Re-score reviewed candidates from the complete paper. If ranking movement could place an unreviewed paper in the final top ten, review it and repeat until the final set is stable. State what sections were checked and what calculations or experiments were not independently reproduced.

Write schema-1.3 reports for all three categories with the same verified evaluationRun metadata. Run the qualified merger, model-policy test, typecheck, and build. If any validation fails, preserve the previous current.json and do not push a partial edition.

On success, commit the dated JSON, current.json, and index.json and push them to the configured public GitHub repository. Never commit credentials or downloaded PDFs. Report the model, runId, paper counts, full-text counts, commit, and public data URL.
```
