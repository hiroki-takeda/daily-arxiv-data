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
平日11:30・16:30 JST、ユーザーログイン時、毎時の追いつき確認
  → macOS launchdが隔離したpublisher control worktreeの固定ランナーを起動
  → ホストlockで同時実行を防止し、既発表・公開済みならCodexを呼ばずNO_CHANGE
  → ホストが公式3一覧の日付・New ID集合・件数を固定
  → 未公開日が複数あれば公式pastweekから最古の1日を選び、確認済みの後続日も順序付き耐久キューへ先に保存
  → quant-ph → gr-qc → hep-thの順に、未完了カテゴリだけを処理
  → fresh generationなら、ホストが全IDの公式版固定absを1件ずつ礼儀正しく取得し、原題・自然順全著者・abstract・comments・primary categoryを厳格検証。全件揃わなければCodexを起動せず延期または安全停止
  → 最初のモデル起動直前に専用worktreeをorigin/mainへ同期し、GPT-5.6-Sol / Highで実行
  → 各カテゴリのNew submissionsを、そのホスト検証済みmetadataだけから全件一次評価
  → 各カテゴリ最大12件についてv1 PDFまたは公式e-print本文を確認。個別本文を取得・解析できない論文は中断要因にせず、タイトル・著者・要旨評価のまま掲載して次へ進む（全文評価件数はカテゴリごとの実数0〜12件）
  → 1カテゴリにつき単一のself-checkと固定validatorを1回実行。日付・schema・ID集合・件数・得点合計・順位・根拠種別・URLを厳格検証し、英単語や文章多様性などの品質診断だけでは公開を止めない
  → 中断時は完成済みカテゴリを再利用し、通常失敗は1時間→4時間→12時間→24時間上限のbackoff後に未完了カテゴリだけを再試行
  → 3カテゴリが揃ったらApplication Support内のホスト専用stagingへ安全に結合し、公式ID集合と再照合
  → liveな選択日は公式snapshot、範囲外へ落ちた明示的復旧日は封印済みsource provenanceを、現在の公式head・耐久planと再検証できる場合だけ固定publisherが6ファイルをcommit・push
  → 公開処理だけが失敗した場合は、次回runでCodexを呼ばずcommit・pushだけを再試行
  → GitHub Actionsが再検証してPagesへ公開
  → push時のGitHub障害に備え、毎日09:17・21:17 JSTにも最新mainをクラウド側で再検証・再配信（進行中の配信は後続runで中断しない）
  → 共用PCが5分以内に新データを取得
```

午前の公開に成功していれば、午後と毎時確認は無変更で終了します。起動前の本文配信一括確認や候補source事前確認を公開条件にはしません。個別のe-print・PDF取得または本文解析に失敗しても、その論文を`title_authors_abstract`の要旨評価として残し、同じカテゴリの次の論文へ進みます。本文確認済みだけを`full_text_major_sections`とし、版固定PDF URLと確認範囲を必須にします。archive path、容量、権限、disk、予期しないredirect、schema、日付、公式ID集合、件数、得点合計等の決定的異常は引き続き安全停止します。カテゴリ途中で別の失敗が起きても、それ以前にホスト検証済みのcheckpointを再利用し、通常再試行は1時間→4時間→12時間→24時間上限で行います。旧runtimeが既に保存したsource draft／receiptは削除せず、検証可能な既存checkpointを復旧する読み取り互換用途に限って扱います。fresh運用では新しい待機用source draftを作らず、PDF待ちの延期やsource prefetchには使いません。source/PDF専用コマンドの失敗でモデル実行自体が終了しそうな場合に限り、完成済み要旨レポートへ結び付けた一時receiptで分類し、ホスト検証後に即checkpoint化してそのrun自身のreceiptを消費します。新着発表がない日、既に公開済みの日、3カテゴリの発表日が揃わない場合は前回正常版を維持します。検証失敗時も`current.json`は変更されません。

ChatGPTデスクトップ、ブラウザ、共用表示PCは実行ホストではありません。自動処理用Macは電源オンかつユーザーがログイン済みである必要がありますが、画面は消えていて構いません。予定時刻にスリープ中なら次の起床時に1 runだけ進みます。11:30・16:30、ログイン時、毎時確認が重なってもホストlockにより同時実行せず、既発表・公開済みならno-opです。完全にシャットダウンまたはログアウトしている間は動きません。

次回ログイン時は、arXiv公式`pastweek`の直近5発表日に公開済み日が残っていれば、抜けた日のうち最古の1日を復元します。選択時の公式ID・件数・発表日列に加え、その時点で完全確認できた後続の非空snapshotも順序付きdurable authorizationとして保存します。最古の日が評価途中でpastweek範囲外へ落ちても同じcheckpointを再開し、公開後は次の保存済み日が自動でactivateされるため、backoff中に後続日がlive windowから落ちても失いません。1回に1日だけ処理し、その後の毎時確認、11:30・16:30 run、または次回ログイン時に次の日へ進むため、中間日を飛ばしません。

通常の自動選択と、targetが現在のpastweek内にある`--recover-checkpoint`の条件は緩めません。最初の選択前から停止が長く、公開済み日が公式範囲外になった場合は、最新日へ飛ばず`ACTION_REQUIRED`で安全停止します。保護済みのsnapshot-only checkpointがpastweekからちょうど1発表日だけ外れた例外に限り、人が固定値を確認した一回限りの`--recover-aged-checkpoint`で、中間日を推測せず明示的に復旧できます。詳細は[自動運用ガイド](docs/AUTOMATION.md)を参照してください。

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

`install`は既存の同名plistを上書き・削除しません。登録時に検証したCodex実行ファイルは`~/Library/Application Support/Daily arXiv/runtimes/codex/<SHA-256>/codex`へ内容アドレス付きで安全に複製し、定時runはVS Code拡張の更新・削除に影響されないその実体を使います。登録直後には最新の未公開分を調べる追いつき確認が1回走り、必要ならそのまま評価・pushします。詳しい確認方法、ログ、停止時の扱いは[自動運用ガイド](docs/AUTOMATION.md)を参照してください。

登録後は、モデルが一度も書けない`daily-arxiv-data-publisher` control worktree、公開専用の`daily-arxiv-data-publication[-run-<runId>]` worktree、モデル専用の`daily-arxiv-data-agent` worktree、`~/Library/Application Support/Daily arXiv/`の固定Codex runtime・ロック・ログ・ホストstaging・日付別checkpoint・durable authorizationを使います。publisher controlはreview済みruntime commitからswitch・reset・commitせず、origin/mainがそのfast-forward先でautomation runtime差分がないことだけを確認します。公開データはpublication worktreeから読みます。publication候補はcleanでHEADが最新origin/mainと完全一致する場合だけ再利用します。中断でdirty、staged、local-aheadになった候補はreset・削除せず証拠として残し、次回は新しいrun固有pathを使います。checkpointは`jobs/<日付>-<snapshot fingerprint>/<runtime fingerprint>/`へ検証済みカテゴリ、厳格検証済みの失敗ドラフト、追記専用の試行・公開履歴を保存し、公開後も小さな監査記録として残します。旧source draft／receiptは互換復旧以外のfresh経路では永続化しません。source/PDF専用の終端失敗を分類する一時receiptは、対応論文が要旨評価であることと完成reportをホストが再検証し、checkpoint取込成功後に同じrun内で消費します。失敗ドラフトは`drafts/`から同じruntimeだけへ復元され、新規調査・再取得・再採点をせず、決定的な3キーと既存根拠に沿う日本語だけを修復します。公開成功時に消すのは、そのrun自身が作った一時PDF・source・staging・Codexログだけです。失敗資料、authorization、既存フォルダ、旧Codex runtimeは残し、モデルがagent worktreeを汚した場合も証拠として保存して次回は新しいrun固有worktreeへ切り替えます。

## 検証

依存パッケージはありません。Node.js 22以降で実行します。全文テキストは同梱helperが公式v1 e-printからrun固有`/tmp`へbounded抽出するため、Homebrew、Poppler、Python packageは不要です。

```bash
npm ci
npm test
npm run validate
git diff --check
```

各Codexカテゴリrunには、ホストから指定されたrun固有`/tmp`のカテゴリ専用stagingへ1レポートだけを書くよう要求します。Codex自身は`git add`、`commit`、`push`を行いません。モデルのシェル通信は上位候補の版固定本文確認に必要な`arxiv.org`だけに制限し、Web検索は無効にします。全abstract一次評価のmetadataはホスト入力だけを使い、`export.arxiv.org`、`/api/query`、全件absの再取得による補完は禁止します。リポジトリ、ChatGPT認証保存領域、publisher、checkpointを含むホスト制御領域への書込みを拒否します。現在のmacOS版Codexでは共通ツール用system tempがscratchとして書込み可能なため、`/tmp`全体を非信頼領域として扱い、公開用のホストstaging・lock・ログ・秘密情報は置きません。モデル終了後にホストが公式metadataから原題・全著者・primary category・版・投稿種別・canonical URLだけを決定的に再注入し、ID集合とレポート全体を独立検証してcheckpointへ取り込みます。順位・点数・評価根拠・文章はこの再注入で変更しません。3カテゴリが揃った後だけ、固定publisher controlから準備した隔離publication worktree内でホスト側ランナーが次を呼びます。

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

arXiv PDFは一時領域でだけ確認し、リポジトリへ保存しません。2026-07-10版と2026-07-13版を含む保存済みの公開版は、schema 1.4 / Daily arXiv rubric 3.0へ統一済みです。一度公開した日付付きレポートと公開版は、以後の日次runでは上書きしません。schema 1.4では各論文に4軸それぞれの論文固有な`scoreReasons`を持たせ、`assessment`は全体としての優れた点と評価を抑える主要な限界だけをまとめます。全文確認件数はカテゴリごとの実数0〜12件で、未確認論文は`title_authors_abstract`と明示します。

ダッシュボードは上位10件を高密度の一覧で表示し、選択した論文だけ全評価を展開します。11位以下も同じ操作で全情報へアクセスできます。Pagesの配信成果物には、`public/`に加えて検証済みの`data/reports/*.json`だけを`data/reports/`として同梱します。

## 運用資料

- [自動運用ガイド](docs/AUTOMATION.md)
- [日次run実行仕様](docs/SCHEDULED_TASK_PROMPT.md)
