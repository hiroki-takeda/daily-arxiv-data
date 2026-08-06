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
  → macOS launchdが隔離したpublisher control worktreeの固定ランナーを起動
  → ホストが公式3一覧の日付・New ID集合・件数を固定
  → 未公開日が複数あれば公式pastweekから最古の1日を選び、確認済みの後続日も順序付き耐久キューへ先に保存
  → 公開済みならCodexを呼ばず終了
  → バッチ末尾の版固定PDF・e-printをHEAD確認。PDF未配信ならCodexを呼ばず16:30へ延期し、e-printだけ不調ならPDF fallbackを有効にして続行
  → quant-ph → gr-qc → hep-thの順に、未完了カテゴリだけを処理
  → fresh generationなら、ホストが全IDの公式版固定absを1件ずつ礼儀正しく取得し、原題・自然順全著者・abstract・comments・primary categoryを厳格検証。全件揃わなければCodexを起動せず延期または安全停止
  → 最初のモデル起動直前に専用worktreeをorigin/mainへ同期し、GPT-5.6-Sol / Highで実行
  → 各カテゴリのNew submissionsを、そのホスト検証済みmetadataだけから全件一次評価
  → 各カテゴリの暫定上位12件までをv1 PDFと公式e-print本文で確認し、最終上位10件を全文確認済みにする
  → 候補本文が取得不能なら全abstract評価済み暫定reportと候補ID集合を単一の原子的checkpointへ保護し、15分→4時間→18時間→36時間→72時間の公式source事前確認待ちではモデルを起動しない。待機後は全abstract評価を繰り返さず、e-print先取りまたは安全条件を満たす版固定公式PDF経路から固定候補の全文確認だけを再開
  → 1カテゴリずつ、最大4回の番号付き構造監査（最大3回の一括修正）で全論文の必須キー、得点分布、合計・順位、上位10件の全文確認状態を確定し、その後は最大5回の番号付き言語監査（最大4回のwhole-field一括修正）で文章だけを整え、validatorを通して保護checkpointへ保存
  → 中断時は完成済みカテゴリを再利用し、厳格検証できた失敗ドラフトは同じruntimeの次回runで修復だけを再開。同じjob・カテゴリの修復系列で終端失敗が4回に達した場合は、途中で有効な後継ドラフトのSHA-256が変わっていても回数をリセットせず、最新ドラフトを保護したまま72時間上限のbackoff後に未完了カテゴリを新規評価
  → 3カテゴリが揃ったらApplication Support内のホスト専用stagingへ安全に結合し、公式ID集合と再照合
  → liveな選択日は公式snapshot、範囲外へ落ちた明示的復旧日は封印済みsource provenanceを、現在の公式head・耐久planと再検証できる場合だけ固定publisherが6ファイルをcommit・push
  → 公開処理だけが失敗した場合は、次回runでCodexを呼ばずcommit・pushだけを再試行
  → GitHub Actionsが再検証してPagesへ公開
  → push時のGitHub障害に備え、毎日09:17・21:17 JSTにも最新mainをクラウド側で再検証・再配信（進行中の配信は後続runで中断しない）
  → 共用PCが5分以内に新データを取得
```

午前の公開に成功していれば午後は無変更で終了します。公式一覧だけが先に更新され、版固定PDFがまだ配信されていない場合は`AUTOMATION_DEFERRED`で正常終了し、Solの利用枠を消費せず16:30に再確認します。PDFが利用可能でe-printだけが不調なら、取得helperが型付きで通信・配信不能を報告した場合、または安全な抽出形式非対応の場合だけPDF fallbackを有効にして評価を続けます。archive path、容量、権限、disk、予期しないredirect、validation等の異常は、エラー文に通信障害らしい語が含まれてもfallbackせず安全停止します。カテゴリ途中で失敗しても、それ以前にホスト検証済みのcheckpointは保護されるため、同じ日付の全カテゴリを最初から評価し直しません。本文取得で止まったカテゴリも、snapshot・runtime・runId・暫定上位候補へ結び付けた全abstract評価済みdraftとsource receiptを単一の原子的envelopeへ保存するため、cooldown後は同じ固定候補の全文確認から続けます。初回screening後に部分的な全文再採点で候補の現在順位が下がっても、候補ID集合を入れ替えません。`source_resume`の通常失敗や孤立した開始記録にも18→36→72時間上限のbackoffを適用し、無制限にモデルを再起動しません。receiptと不正reportが混在したrunは通常draftとして救済しません。その他のdraftなしgeneration失敗にも同じbackoffを適用します。厳格検証できた通常失敗ドラフトの修復は新規評価ではないため、4回まではgeneration backoffを適用せず直ちに再開します。同じjob・カテゴリの修復系列で4回の終端失敗に達した場合は、各失敗で別SHA-256の後継ドラフトが保護されていても永久停止せず、最新ドラフトを削除・上書きせず保持し、失敗履歴から計算した最大72時間のbackoff後にカテゴリ全体を新規生成します。新着発表がない日、既に公開済みの日、3カテゴリの発表日が揃わない場合は前回正常版を維持します。検証失敗時も`current.json`は変更されません。

ChatGPTデスクトップ、ブラウザ、共用表示PCは実行ホストではありません。自動処理用Macは電源オンかつユーザーがログイン済みである必要がありますが、画面は消えていて構いません。予定時刻にスリープ中なら次の起床時に1 runだけ進み、複数日を同時実行しません。ログイン時にも追いつき確認が走り、active authorizationやcheckpointがあれば同じ日から再開します。完全にシャットダウンまたはログアウトしている間は動きません。

次回ログイン時は、arXiv公式`pastweek`の直近5発表日に公開済み日が残っていれば、抜けた日のうち最古の1日を復元します。選択時の公式ID・件数・発表日列に加え、その時点で完全確認できた後続の非空snapshotも順序付きdurable authorizationとして保存します。最古の日が評価途中でpastweek範囲外へ落ちても同じcheckpointを再開し、公開後は次の保存済み日が自動でactivateされるため、backoff中に後続日がlive windowから落ちても失いません。1回に1日だけ処理し、その後の11:30・16:30 runまたは次回ログイン時に次の日へ進むため、中間日を飛ばしません。

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

登録後は、モデルが一度も書けない`daily-arxiv-data-publisher` control worktree、公開専用の`daily-arxiv-data-publication[-run-<runId>]` worktree、モデル専用の`daily-arxiv-data-agent` worktree、`~/Library/Application Support/Daily arXiv/`の固定Codex runtime・ロック・ログ・ホストstaging・日付別checkpoint・durable authorizationを使います。publisher controlはreview済みruntime commitからswitch・reset・commitせず、origin/mainがそのfast-forward先でautomation runtime差分がないことだけを確認します。公開データはpublication worktreeから読みます。publication候補はcleanでHEADが最新origin/mainと完全一致する場合だけ再利用します。中断でdirty、staged、local-aheadになった候補はreset・削除せず証拠として残し、次回は新しいrun固有pathを使います。checkpointは`jobs/<日付>-<snapshot fingerprint>/<runtime fingerprint>/`へ検証済みカテゴリ、厳格検証済みの失敗ドラフト、本文取得blocker、追記専用の試行・公開履歴を保存し、公開後も小さな監査記録として残します。失敗ドラフトは`drafts/`から同じruntimeだけへ復元され、新規調査・再取得・再採点をせず、決定的な3キーと既存根拠に沿う日本語だけを修復します。公開成功時に消すのは、そのrun自身が作った一時PDF・source・staging・Codexログだけです。失敗資料、authorization、既存フォルダ、旧Codex runtimeは残し、モデルがagent worktreeを汚した場合も証拠として保存して次回は新しいrun固有worktreeへ切り替えます。

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

arXiv PDFは一時領域でだけ確認し、リポジトリへ保存しません。2026-07-10版と2026-07-13版を含む保存済みの公開版は、schema 1.4 / Daily arXiv rubric 3.0へ統一済みです。一度公開した日付付きレポートと公開版は、以後の日次runでは上書きしません。schema 1.4では各論文に4軸それぞれの論文固有な`scoreReasons`を持たせ、`assessment`は全体としての優れた点と評価を抑える主要な限界だけをまとめます。

ダッシュボードは上位10件を高密度の一覧で表示し、選択した論文だけ全評価を展開します。11位以下も同じ操作で全情報へアクセスできます。Pagesの配信成果物には、`public/`に加えて検証済みの`data/reports/*.json`だけを`data/reports/`として同梱します。

## 運用資料

- [自動運用ガイド](docs/AUTOMATION.md)
- [日次run実行仕様](docs/SCHEDULED_TASK_PROMPT.md)
