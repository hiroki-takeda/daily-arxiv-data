# Daily arXiv Scheduled Task 実行仕様

この文書は各Scheduled runの権威ある実行仕様です。日次runではアプリやパイプラインのコードを変更せず、評価データの作成と固定publisherの実行だけを行ってください。

## 1. モデルと実行環境

このタスクのScheduled設定が`GPT-5.6-Sol`、`Ultra`、Dedicated worktreeであることを前提とします。設定を確認できない、別モデルが明示されている、またはUltraでない場合は次だけを報告して停止します。

```text
ACTION_REQUIRED: MODEL_CONFIGURATION
current.json unchanged; no push
```

`High`、`Max`、別モデルへの降格は禁止です。

最初に次を実行します。

```bash
node scripts/prepare-worktree.mjs
npm test
npm run validate
```

いずれかが失敗したら、ファイルを変更せず`ACTION_REQUIRED: PREFLIGHT_FAILED`として終了します。

## 2. 新しい発表の判定

1. `public/data/index.json`の`latestDate`を読みます。
2. 公式ページを取得します。

   ```text
   https://arxiv.org/list/hep-th/new
   https://arxiv.org/list/gr-qc/new
   https://arxiv.org/list/quant-ph/new
   ```

3. 3ページのannouncement dateが一致することを確認します。
4. ページ内の`New submissions`だけを対象にします。`Cross submissions`と`Replacements`は除外します。
5. primary categoryが対象カテゴリで、初回投稿`v1`のものだけを残します。
6. バージョンを除いたarXiv IDを3カテゴリ全体で重複排除します。

取得不能、セクション判別不能、発表日不一致なら`ACTION_REQUIRED: SOURCE_INCOMPLETE`として終了します。PCの当日の日付を発表日の代用にしてはいけません。

発表日が`latestDate`以下なら`ALREADY_PUBLISHED`または`NO_NEW_ANNOUNCEMENT`として無変更で終了します。全3カテゴリの対象が0件なら偽の空版を作らず`NO_ELIGIBLE_PAPERS`で終了します。

## 3. 評価

対象全件について、タイトル、完全な著者一覧、アブストラクト、primary category、commentsを読みます。著者の知名度、所属、受賞、引用数、キャリア段階を採点に使いません。

以下を0〜25の整数で評価します。

- `broadImpact`: 物理学全体への影響
- `categoryImpact`: カテゴリ内の重要度
- `originality`: 独創性
- `technicalStrength`: 方法・結果の説得力

合計は4項目の単純和、100点満点です。暫定順位を決め、各カテゴリの暫定上位10件について必ず`v1` PDF全体を確認します。導入、前提、導出または手法、主結果、検証・比較、結論、限界、関連付録を確認して再評価します。

全文確認後に順位が動き、未確認論文が最終上位10件へ入り得る場合はその論文も確認します。最終上位10件がすべて全文確認済みになるまで繰り返します。PDFは`/tmp`配下だけへ置き、リポジトリ内へ保存しません。

採点確定後にだけ`data/distinguished-authors.json`を適用します。著名著者情報はpublisherが決定的に付加するため、レポートへ`eminentAuthors`を書きません。

## 4. schema 1.3レポート

1回のrunにつき一意な`runId`を1つ作り、3レポートで共有します。例:

```text
daily-arxiv-2026-07-13-20260713T023000Z
```

実行情報は次の値に固定します。

```json
{
  "modelId": "gpt-5.6-sol",
  "modelDisplayName": "GPT-5.6-Sol",
  "reasoningEffort": "ultra",
  "modelSelectionVerified": true,
  "runId": "一意なrunId"
}
```

各論文には少なくとも次を正確に含めます。未知の追加フィールドは禁止です。

```json
{
  "rank": 1,
  "arxivId": "2607.12345",
  "arxivVersion": "v1",
  "submissionType": "new",
  "url": "https://arxiv.org/abs/2607.12345",
  "title": "original title",
  "titleJa": "日本語タイトル",
  "authors": ["complete author names"],
  "primaryCategory": "hep-th",
  "paperType": "理論",
  "scores": {
    "broadImpact": 0,
    "categoryImpact": 0,
    "originality": 0,
    "technicalStrength": 0
  },
  "totalScore": 0,
  "abstractLines": ["1行目", "2行目", "3行目"],
  "curiosity": "問い",
  "concept": "方法・概念",
  "conclusion": "結論",
  "assessment": "4項目の根拠",
  "evaluationBasis": "full_text_major_sections",
  "fullTextEvaluated": true,
  "fullTextReviewStatus": "確認した節と、独立再現していない事項",
  "sourceUrls": [
    "https://arxiv.org/abs/2607.12345v1",
    "https://arxiv.org/pdf/2607.12345v1"
  ]
}
```

上位外でPDF未確認の場合は`evaluationBasis`を`title_authors_abstract`、`fullTextEvaluated`を`false`とし、`fullTextReviewStatus`を含めません。`sourceUrls`には少なくともversion固定のabstract URLを含めます。

レポートのトップレベルは次のフィールドだけです。

```text
schemaVersion, reportDate, evaluationRun, slug, label,
totalNew, crosslistsExcluded, evaluatedCount,
fullTextEvaluatedCount, papers, audit
```

`audit`には次を含めます。

```text
listingUrl, announcementDate, selectionRule, sourceCounts,
evaluationPolicy, scoreRubric, fullTextPolicy,
fullTextEvaluatedCount, authorPolicy, rankingTieBreak,
generatedAtJst
```

`sourceCounts`は`newPrimary`、`crosslistsExcluded`、`titleAuthorAbstractEvaluated`の3整数だけです。

3ファイルだけを次へ書きます。

```text
.automation/staging/<runId>/YYYY-MM-DD-hep-th.json
.automation/staging/<runId>/YYYY-MM-DD-gr-qc.json
.automation/staging/<runId>/YYYY-MM-DD-quant-ph.json
```

## 5. 検証と公開

stagingには上記3 JSON以外を置きません。次を実行します。

```bash
npm test
npm run validate
node scripts/publish-edition.mjs YYYY-MM-DD .automation/staging/<runId>
```

publisherだけが次の6ファイルを生成・stage・commit・pushします。

```text
data/reports/YYYY-MM-DD-hep-th.json
data/reports/YYYY-MM-DD-gr-qc.json
data/reports/YYYY-MM-DD-quant-ph.json
public/data/YYYY-MM-DD.json
public/data/current.json
public/data/index.json
```

日次runから`git add`、`git commit`、`git push`を直接実行しません。publisherを迂回しません。force push、既存の日付別ファイルの上書き、コード・文書・ワークフロー変更は禁止です。

## 6. 報告

成功時:

```text
PUBLISHED
date, model, reasoning, runId
category counts and full-text counts
commit and public URL
```

正常no-op時:

```text
ALREADY_PUBLISHED | NO_NEW_ANNOUNCEMENT | NO_ELIGIBLE_PAPERS
```

失敗時:

```text
ACTION_REQUIRED: <CODE>
失敗したsourceまたはcommand
current.json unchanged; no push
```
