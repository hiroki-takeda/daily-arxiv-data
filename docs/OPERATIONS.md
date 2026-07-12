# Daily arXiv operations

## Where the site lives

The production page is hosted by ChatGPT Sites, not GitHub:

- public URL: `https://daily-arxiv-lab.arrow7989.chatgpt.site`
- Sites project: `appgprj_6a5078a54f3c8191bcb0e5827b71fb89`
- management: `https://chatgpt.com/sites`

The Sites managed source repository is an implementation detail. The shared display needs only the public URL and no ChatGPT login.

## Production path

```text
ChatGPT Pro Scheduled Tasks
  -> three schema-1.2 category reports in the Sites managed source
  -> publisher validates, merges, builds, and deploys the same Site
  -> display reloads at 11:15 and 15:15 JST
```

No OpenAI API, OpenAlex key, or GitHub repository is used. Each category task performs an abstract-only first pass and then reviews the complete PDFs required to make every final top-ten paper full-text evaluated.

## Initial rollout

1. Deploy the rubric-v2 code manually once.
2. Create the three category tasks and publisher task from `docs/SCHEDULED_PROMPTS.md`.
3. Inspect the first several 11:00 and 15:00 runs because unattended Scheduled-to-Sites deployment is a pilot path.
4. Check counts, cross-list exclusion, totals, rankings, and that badges do not affect scores.

## Failure behavior

- Missing/invalid category: no deployment.
- arXiv or Sites failure: keep the last successful edition.
- 15:00 run: retry the missing/changed report.
- No announcement day: keep the previous edition and do not create zero-paper data.
- Ambiguous badge identity: no badge; no score changes.
- A paper missing any of the four content scores is not filled with a neutral value and must not enter the ranking.

## Distinguished-author registry

`data/distinguished-authors.json` is versioned and non-exhaustive. Add an entry only with exact identity evidence and an official biography or award page. The registry creates a visible named badge but is not read by the scoring prompt and never changes the total.

## Monitoring

Check weekly:

- Scheduled tasks remain active and have recent successful runs;
- `generatedAtJst` and `lastSuccessfulAtJst`;
- all three `totalNew == evaluatedCount`;
- totals are four integers in `0..25` and at most 100;
- every final top-ten paper is marked full-text evaluated with a concrete review status;
- the current Sites deployment succeeded.

Scheduled Tasks do not provide a service-level guarantee and unattended tasks can pause, so the public dashboard always preserves the previous successful edition.
