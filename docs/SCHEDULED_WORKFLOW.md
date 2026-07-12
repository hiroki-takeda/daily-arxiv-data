# Daily arXiv Scheduled workflow v2

> Deprecated for new editions: ChatGPT Web Scheduled Tasks do not expose verifiable model selection. Use [Daily arXiv v3](SOL_ULTRA_PIPELINE.md) instead.

## Goal

Run without an OpenAI API key, an OpenAlex key, or a GitHub repository. ChatGPT Pro Scheduled Tasks evaluate arXiv metadata and update the existing public ChatGPT Site.

```text
Scheduled category tasks
  -> ChatGPT Sites managed source repository
  -> data/reports/YYYY-MM-DD-{category}.json
Scheduled publisher task
  -> validate + merge + build + deploy the Sites project
Shared display
  -> https://daily-arxiv-lab.arrow7989.chatgpt.site
```

The display computer only opens the public URL. It does not need a ChatGPT login.

This direct Scheduled-to-Sites path is a production pilot: Scheduled Tasks can use tools available to their conversation, and Sites has a managed source repository, but OpenAI does not currently publish an end-to-end tutorial for unattended Scheduled-to-Sites deployment. Review the first several runs.

## Schedule in JST

The visible editions are targeted for 11:00 and 15:00.

- 09:15 and 13:15: `hep-th` report
- 09:25 and 13:25: `gr-qc` report
- 09:35 and 13:35: `quant-ph` report
- 11:00 and 15:00: validate, merge, and deploy only when all three reports are complete
- 11:15 and 15:15: the display reloads the public edition

The afternoon run repairs a failed morning report and incorporates a changed arXiv listing. If the eligible base-ID set is unchanged, preserve the scores and only verify publication.

On weekends, holidays, and arXiv no-announcement days, do not create a fake empty edition. Keep the previous successful announcement date live.

## Paper selection

1. Use `https://arxiv.org/list/{category}/new`.
2. Keep only `New submissions`; exclude `Cross submissions` and `Replacements`.
3. Require primary category equal to the target category and version `v1`.
4. Remove the version suffix and deduplicate base arXiv IDs across the three categories.
5. Use title, complete author list, abstract, primary category, comments, and arXiv URL for the first-pass evaluation.

## Content evaluation: four components, 100 points

Freeze the four content scores before any author-distinction lookup. Author names, affiliations, fame, prizes, and career stage must not influence scores.

- `broadImpact`, 0-25: likely importance and reach across physics.
- `categoryImpact`, 0-25: likely importance within the primary category.
- `originality`, 0-25: non-triviality and conceptual or technical novelty.
- `technicalStrength`, 0-25: concreteness of the method and result, and strength of derivation, comparison, validation, uncertainty treatment, or robustness stated in the abstract.

For the first pass, `technicalStrength` assesses only what the abstract substantiates. Type-specific anchors are allowed: analytical checks for theory, systematics/statistics for experiment and observation, robustness/comparisons for analysis, and coverage/new synthesis for reviews.

## Full-text finalization of the top ten

After the abstract-only first pass, inspect the complete arXiv PDF for the provisional top ten. Review the introduction, assumptions and setup, derivations or methods, principal results, checks or comparisons, conclusion, stated limitations, and relevant appendices. Then reassess all four components from the paper content.

If a reviewed paper falls below an unreviewed candidate, review that candidate too and repeat until every paper in the final top ten has a documented full-text review. It is acceptable to review more than ten papers; it is not acceptable to publish an abstract-only paper in the final top ten.

- final top ten: `evaluationBasis: full_text_major_sections`, `fullTextEvaluated: true`, and a concrete `fullTextReviewStatus`;
- all remaining papers: `evaluationBasis: title_authors_abstract`, `fullTextEvaluated: false`;
- reading the paper does not mean independently reproducing every equation or experiment; the review status states what was and was not independently checked.

Each detailed record includes a Japanese title, exactly three abstract-summary lines, Curiosity, Concept, Conclusion, and Assessment. Unsupported statements must be identified as evaluator inference.

## Distinguished-author badge: non-scoring

Author reputation is not a fifth score and never changes rank, totals, or assessment. After scoring, `scripts/merge_category_reports.mjs` matches exact author names against `data/distinguished-authors.json` and adds a named `著名著者` badge with official evidence.

The registry is intentionally narrow and non-exhaustive:

- require exact full-name identity and an official award, academy, or institutional biography;
- use official awarding-body or institutional pages; Wikipedia alone is not evidence;
- ambiguous, initial-only, or conflicting identities receive no badge;
- no badge does not mean that an author is not eminent;
- h-index and citation-count scraping are not used.

Registry updates are reviewed separately from daily ranking. Daily tasks must not invent badge entries.

## Ranking and publication

```text
totalScore = broadImpact + categoryImpact + originality + technicalStrength
```

Rank independently within each category. Tie-break in this order: broad impact, originality, technical strength, category impact, then base arXiv ID. Publish the top ten as detailed records and all remaining papers as the compact list.

Publish only if:

- all announced primary papers are present;
- no base arXiv ID is duplicated;
- every score is an integer from 0 to 25;
- every total equals the four components;
- every final top-ten paper has `evaluationBasis: full_text_major_sections`, `fullTextEvaluated: true`, and a non-empty review status;
- every other paper has a valid abstract-only or documented full-text basis;
- all three reports use schema `1.2` and the same announcement date.

If anything fails, do not deploy a partial edition. The previous successful public edition remains live.

## Credentials and billing

- OpenAI API key: not used.
- OpenAlex API key: not used.
- GitHub account or repository: not required for this pilot.
- The Scheduled runs use the user's ChatGPT Pro plan and its task limits, not API billing.
- ChatGPT Tasks cannot use a Pro model. Select the highest-quality supported non-Pro model available; the preferred setting is `5.6 Sol` with `High` reasoning when the task editor exposes it.
