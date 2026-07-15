# Daily arXiv

`quant-ph`、`gr-qc`、`hep-th`の新着論文を毎日評価し、研究室の共用ディスプレイへ公開する静的ダッシュボードです。

- 公開ページ（本体）: https://hiroki-takeda.github.io/daily-arxiv-data/
- GitHubリポジトリ（管理用）: https://github.com/hiroki-takeda/daily-arxiv-data
- データ生成: macOS `launchd` + Codex CLI（ChatGPTアカウント認証）
- 評価設定: `GPT-5.6-Sol` / `High`
- 評価基準: [Daily arXiv rubric 3.0](docs/SCHEDULED_TASK_PROMPT.md)（意義と波及、分野内の前進、独創性、厳密性・信頼性）
- 配信: GitHub Pages
- OpenAI APIキー・API課金: 不使用

## 自動更新の流れ

```text
平日11:30・16:30 JST
  → macOS launchdが隔離したpublisher worktreeの固定ランナーを起動
  → ホストが公式3一覧の日付・New ID集合・件数を固定
  → 未公開日が複数あれば公式pastweekから最古の1日を選ぶ
  → 公開済みならCodexを呼ばず終了
  → モデル専用の別worktreeをorigin/mainへ同期
  → Codex CLIをGPT-5.6-Sol / Highで実行
  → arXivのNew submissionsを全件一次評価
  → 各カテゴリの暫定上位12件までをv1 PDFと公式e-print本文で確認し、最終上位10件を全文確認済みにする
  → 候補JSONを指定run固有/tmpへ出力
  → Application Support内のホスト専用stagingへ安全にコピーし、公式ID集合と再照合
  → 選択日の公式snapshotがrun中も同一な場合だけ固定publisherが6ファイルをcommit・push
  → GitHub Actionsが再検証してPagesへ公開
  → 共用PCが5分以内に新データを取得
```

午前の公開に成功していれば午後は無変更で終了します。新着発表がない日、既に公開済みの日、3カテゴリの発表日が揃わない場合は前回正常版を維持します。検証失敗時も`current.json`は変更されません。

ChatGPTデスクトップ、ブラウザ、共用表示PCは実行ホストではありません。自動処理用Macは電源オンかつユーザーがログイン済みである必要がありますが、画面は消えていて構いません。スリープ中の時刻は次の起床時に実行されます。完全にシャットダウンしている間は動きません。

次回ログイン時は、arXiv公式`pastweek`の直近5発表日に公開済み日が残っていれば、抜けた日のうち最古の1日を復元します。1回に1日だけ処理し、その後の11:30・16:30 runで次の日へ進むため、中間日を飛ばしません。停止が長く公開済み日が公式範囲外になった場合は、最新日へ飛ばず`ACTION_REQUIRED`で安全停止します。

## 一度だけ行う設定

Node.js 22以降とChatGPTログイン済みCodex CLIを使います。APIキーは不要です。コードが`origin/main`へpushされ、main checkoutがcleanになった後に、repo・serviceを変更しない事前診断を実行します（権限確認用の小さなファイルだけは`/tmp`へ作ります）。

```bash
node scripts/configure-macos-schedule.mjs check
node scripts/run-local-automation.mjs --check
```

実ジョブの登録は、コードが`origin/main`へ公開された後に一度だけ行います。

```bash
node scripts/configure-macos-schedule.mjs install
```

`install`は既存の同名plistを上書き・削除しません。登録直後には最新の未公開分を調べる追いつき確認が1回走り、必要ならそのまま評価・pushします。詳しい確認方法、ログ、停止時の扱いは[自動運用ガイド](docs/AUTOMATION.md)を参照してください。

登録後は、モデルが一度も書けない`daily-arxiv-data-publisher` worktree、モデル専用の`daily-arxiv-data-agent` worktree、`~/Library/Application Support/Daily arXiv/`のロック・ログ・ホストstagingを使います。公開成功時は、そのrun自身が作った一時PDF・staging・Codexログだけを消します。失敗資料と既存フォルダは残し、モデルがagent worktreeを汚した場合も証拠として保存して次回は新しいrun固有worktreeへ切り替えます。

## 検証

依存パッケージはありません。Node.js 22以降で実行します。全文テキストは同梱helperが公式v1 e-printからrun固有`/tmp`へbounded抽出するため、Homebrew、Poppler、Python packageは不要です。

```bash
npm ci
npm test
npm run validate
git diff --check
```

日次Codex runには、ホストから指定されたrun固有`/tmp`へ3レポートだけを書くよう要求します。Codex自身は`git add`、`commit`、`push`を行いません。シェルの外向き通信とWeb検索は`arxiv.org` / `export.arxiv.org`だけに制限し、リポジトリ、ChatGPT認証保存領域、publisher、ホスト制御領域への書込みを拒否します。現在のmacOS版Codexでは共通ツール用system tempがscratchとして書込み可能なため、`/tmp`全体を非信頼領域として扱い、公開用のホストstaging・lock・ログ・秘密情報は置きません。モデルが終了した後、別のpublisher worktreeにあるホスト側ランナーだけが次を呼びます。

```bash
node scripts/publish-edition.mjs YYYY-MM-DD /tmp/.../staging
```

publisherは対象リポジトリ、`origin/main`、作業ツリー、秘密情報、PDF、nested `.git`、全JSON、変更ファイル6件を再検証し、force pushを行いません。

## 保存データ

```text
data/reports/YYYY-MM-DD-{quant-ph,gr-qc,hep-th}.json
public/data/YYYY-MM-DD.json
public/data/current.json
public/data/index.json
```

arXiv PDFは一時領域でだけ確認し、リポジトリへ保存しません。2026-07-10版と2026-07-13版を含む保存済みの公開版は、schema 1.4 / Daily arXiv rubric 3.0へ統一済みです。一度公開した日付付きレポートと公開版は、以後の日次runでは上書きしません。schema 1.4では各論文に4軸それぞれの論文固有な`scoreReasons`を持たせ、`assessment`は全体としての優れた点と評価を抑える主要な限界だけをまとめます。

ダッシュボードは上位10件を高密度の一覧で表示し、選択した論文だけ全評価を展開します。11位以下も同じ操作で全情報へアクセスできます。Pagesの配信成果物には、`public/`に加えて検証済みの`data/reports/*.json`だけを`data/reports/`として同梱します。

## 運用資料

- [自動運用ガイド](docs/AUTOMATION.md)
- [日次run実行仕様](docs/SCHEDULED_TASK_PROMPT.md)
