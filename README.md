# Daily arXiv

`hep-th`、`gr-qc`、`quant-ph`の新着論文を毎日評価し、研究室の共用ディスプレイへ公開する静的ダッシュボードです。

- 公開ページ: https://hiroki-takeda.github.io/daily-arxiv-data/
- データ生成: ChatGPTデスクトップのScheduled Task
- 評価設定: `GPT-5.6-Sol` / `Ultra`
- 配信: GitHub Pages
- APIキー: 不使用

## 自動更新の流れ

```text
平日11:30・16:30 JST
  → 隔離されたScheduled Worktree
  → arXivのNew submissionsを確認
  → primary-category v1を全件一次評価
  → 各カテゴリの最終上位10件をv1 PDFで全文確認
  → schema 1.3を機械検証
  → 固定publisherが6ファイルだけcommit/push
  → GitHub Actionsが再検証してPagesへ公開
  → 共用PCが5分以内に新データを取得
```

午前の公開に成功していれば午後は無変更で終了します。新着発表がない日、既に公開済みの日、3カテゴリの発表日が揃わない場合は前回正常版を維持します。検証失敗時も`current.json`は変更されません。

## 初回設定

ChatGPTデスクトップでScheduled Taskを一度だけ設定します。Macは実行時に電源オン、スリープ解除、ChatGPTアプリ起動中である必要があります。詳しい設定、時刻、貼り付けるプロンプトは[自動運用ガイド](docs/AUTOMATION.md)を参照してください。

## 検証

依存パッケージはありません。Node.js 22以降で実行します。

```bash
npm ci
npm test
npm run validate
```

日次タスクは`.automation/staging/<run-id>/`に3レポートだけを書き、最後に次を呼びます。

```bash
node scripts/publish-edition.mjs YYYY-MM-DD .automation/staging/<run-id>
```

publisherは対象リポジトリ、`origin/main`、作業ツリー、秘密情報、PDF、nested `.git`、全JSON、変更ファイル6件を再検証し、force pushを行いません。

## 保存データ

```text
data/reports/YYYY-MM-DD-{hep-th,gr-qc,quant-ph}.json
public/data/YYYY-MM-DD.json
public/data/current.json
public/data/index.json
```

arXiv PDFは一時領域でだけ確認し、リポジトリへ保存しません。2026-07-10のschema 1.2版は初回公開履歴として保持し、今後の版はschema 1.3で保存します。

## 運用資料

- [自動運用ガイド](docs/AUTOMATION.md)
- [Scheduled Task実行仕様](docs/SCHEDULED_TASK_PROMPT.md)
