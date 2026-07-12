# Scheduled Task prompts

> Deprecated for new editions. These prompts belong to the paused model-unverified Web Scheduled pipeline. Use [the Sol Ultra automation prompt](SOL_ULTRA_AUTOMATION_PROMPT.md).

Sites project ID: `appgprj_6a5078a54f3c8191bcb0e5827b71fb89`

Create one task per category and one publisher task. Each run must use the existing Sites project and its managed source repository; it must not create another Site.

## Category task template

Replace `CATEGORY` before creating each task.

```text
Update the CATEGORY staging report for Daily arXiv in the existing ChatGPT Sites project appgprj_6a5078a54f3c8191bcb0e5827b71fb89.

Use the Sites tools to obtain a short-lived credential for that project's managed source repository and work in a fresh temporary checkout. Read docs/SCHEDULED_WORKFLOW.md and follow it exactly. Never create a new Site and never deploy from this category task.

Read https://arxiv.org/list/CATEGORY/new. Process only New submissions for the displayed announcement date. Exclude cross submissions and replacements, require primary category CATEGORY and v1, and deduplicate base arXiv IDs. If there is no new announcement, make no report.

For every eligible paper, first use title, complete author list, abstract, primary category, comments, and arXiv URL to assign provisional integer scores from 0 to 25 without using author reputation: broadImpact, categoryImpact, originality, and technicalStrength. totalScore is their sum out of 100.

Sort the provisional ranking, then download and inspect the complete arXiv PDF for the provisional top ten. Review the introduction, setup and assumptions, methods or derivations, principal results, validation or comparisons, conclusion, limitations, and relevant appendices. Reassess all four scores from the paper content. If a reviewed paper falls below an unreviewed candidate, review that candidate and repeat until every final top-ten paper has been reviewed in full. For reviewed papers set evaluationBasis to full_text_major_sections, fullTextEvaluated to true, and write a concrete fullTextReviewStatus stating the sections checked and any checks not independently reproduced. For all other papers use title_authors_abstract and false.

Produce titleJa, paperType, exactly three Japanese abstractLines, curiosity, concept, conclusion, and assessment. Assessment explains all four content scores and must not mention author fame. Do not generate eminentAuthors; the deterministic registry merger adds non-scoring badges later. Prefer careful, deliberate reasoning and accuracy over speed.

Write strict JSON to data/reports/YYYY-MM-DD-CATEGORY.json with schemaVersion 1.2, slug, label, totalNew, crosslistsExcluded, evaluatedCount, fullTextEvaluatedCount, papers, and audit containing listingUrl, announcementDate, evaluation policy, generatedAtJst, and source URLs. Verify count, unique IDs, primary category, required fields, 0..25 ranges, total arithmetic, and that every final top-ten paper is full-text reviewed. Commit and push only that report to the managed source branch. At the afternoon run, preserve a valid report when the eligible base-ID set is unchanged.
```

## Publisher task

```text
Publish a complete Daily arXiv edition in the existing ChatGPT Sites project appgprj_6a5078a54f3c8191bcb0e5827b71fb89.

Use the Sites tools to obtain the managed source repository credential and use a fresh temporary checkout. Read docs/SCHEDULED_WORKFLOW.md. Never create a new Site.

Find the latest announcement date having valid schema-1.2 reports for hep-th, gr-qc, and quant-ph. If a report is missing or invalid, do not deploy and report the exact problem. Never replace the previous public edition with partial data.

Run node scripts/merge_category_reports.mjs YYYY-MM-DD, npm run test:v2, npm run typecheck, and npm run build. Confirm that public/data/YYYY-MM-DD.json, current.json, and index.json were produced, every category's final top ten has a documented full-text review, all totals are out of 100, and author badges are non-scoring registry matches. Commit and push the validated source, save a Sites version from that exact commit/build, and deploy that saved version to the existing public Site. Report the deployment status and public URL.
```
