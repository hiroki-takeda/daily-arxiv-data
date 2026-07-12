# Pro-reference qualification prompt

Run this once in a separate chat with GPT-5.5 Pro or a newer Pro model explicitly selected. Do not include any existing Daily arXiv scores in the chat.

```text
Create the blind Pro-reference evaluation for the 30 papers in data/benchmark/qualification-set.json.

For every paper, read the complete arXiv PDF. Evaluate only the paper content; author identity, affiliation, fame, awards, citations, and career stage must not affect scores. Score broadImpact, categoryImpact, originality, and technicalStrength as integers from 0 to 25. Explain each component briefly and record the main limitation or uncertainty. Rank independently within hep-th, gr-qc, and quant-ph using totalScore, then broadImpact, originality, technicalStrength, categoryImpact, and arXiv ID.

Return strict JSON without seeing or using any previous Daily arXiv evaluation. Include the exact model display name selected in this chat and mark modelSelectionVerified=true only if it is visible in the UI. Save the result as pro-reference.json.
```

Run the Sol Ultra side separately from `docs/SOL_ULTRA_AUTOMATION_PROMPT.md`. Compare the two blind outputs using the thresholds in `data/model-policy.json`. A domain expert should inspect the largest score and rank disagreements before changing `qualificationStatus` to `qualified`.
