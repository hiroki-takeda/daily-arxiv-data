# Daily arXiv 自動運用ガイド

## 結論

OpenAI API課金なしで現在もっとも確実な本番経路は、ChatGPTアカウントで認証したCodex CLIをmacOS標準の`launchd`から実行する方式です。APIキー、GitHub PAT、ChatGPTデスクトップ、Atlas、Chrome、共用表示PCを起動しておく必要はありません。

自動処理用Macは電源オンかつユーザーがログイン済みである必要があります。画面ロックとディスプレイスリープは問題ありません。予定時刻にシステムがスリープ中なら、`launchd`は次の起床時に1 runだけ進めます。複数日を同時実行せず、active authorizationまたはcheckpointがあれば同じ日から再開します。完全シャットダウン中やログアウト中には動きません。

次回ログイン時は、arXiv公式`pastweek`の直近5発表日に公開済み日が含まれていれば、抜けた日のうち最古の1日を復元します。1回の起動では1日だけを処理し、次の定時runで次の日へ進みます。選択済みの日は公式照合証跡をdurable authorizationとして保持するため、途中失敗中にpastweek範囲外へ落ちても同じcheckpointを再開できます。これにより中間日を飛ばさず、長時間runとChatGPT利用枠の集中を避けます。最初の選択前から公開済み日が公式範囲より古い場合は、最新日へ飛ばず安全停止します。

普段ChatGPTを使う画面は`chatgpt.com`をChrome等の通常ブラウザで開く形が長期的な基準です。デスクトップアプリはローカルフォルダを対話操作したい時だけで構いません。このDaily arXivの登録済み自動処理は、どちらの画面にも依存しません。

## 課金と利用枠

- OpenAI APIキーとAPI従量課金は使いません。
- ChatGPTログイン済みCodex CLIを使うため、契約中ChatGPTプランのCodex利用枠を消費します。
- 全abstractを一次評価し、各カテゴリの暫定上位12件だけを全文確認します。最終上位10件の全文確認を維持しつつ、全文取得を最大36件へ制限します。カテゴリは`quant-ph`、`gr-qc`、`hep-th`の順に独立実行し、検証済みcheckpointを再利用するため、利用枠、モデル、ネットワークのいずれかで失敗しても次回は失敗または未完了のカテゴリだけを再試行します。
- 公式一覧の日付が既に公開済みならCodexを起動しないため、午後runを含め利用枠を消費しません。
- 公式一覧だけが先に更新された場合は、全New IDを取得せず、当日バッチの最大arXiv IDをcanaryとして版固定PDFとe-printへ順次`HEAD`します。PDFが未配信なら`AUTOMATION_DEFERRED`で正常終了し、Codexを起動せず次の定時runへ回します。PDFが利用可能でe-printだけが不調なら`FULL_TEXT_PDF_FALLBACK_READY`として続行します。これはバッチ伝播の軽量確認であり、個別論文の可用性はモデル側でも引き続き安全確認します。
- 全abstract比較後に個別候補の本文だけが取得不能だった場合は、失敗IDと固定済み暫定候補集合をホストがsnapshotと照合してcheckpoint履歴へ残します。18時間、次は36時間、以後最大72時間のbackoff中はCodexを起動しません。待機後はまずホストが候補e-printを実GET・安全抽出します。取得helper自身が型付きで報告した通信・配信不能、または明示的に安全な抽出形式非対応の場合だけ、同じIDの版固定公式PDFを独立`HEAD`確認してPDF経路へ進めます。e-printとPDFの両方が利用不能な場合はbackoffを延長します。取得済みsourceは次のrun固有`/tmp`へ置き、モデルに同じ取得を繰り返させません。危険なarchive path、容量超過、権限、disk、redirect、validation等の予期しないエラーは、messageに`network`、`timeout`、`5xx`等の語が含まれてもPDF fallbackへ落とさず安全停止します。

## 本番構成

```text
launchd（平日11:30・16:30 JST）
  → daily-arxiv-data-publisher/scripts/run-local-automation.mjs
  → origin/mainを認証付きで確認
  → ホストがarXiv公式3一覧を取得
     日付・New ID全件・New/Cross件数をsnapshot化
  → 未公開日が複数ならpastweekから最古の完全な1日を選択
  → 公開済みならNO_CHANGE（Codex未使用）
  → v1 PDF canaryが未配信ならAUTOMATION_DEFERRED。e-printだけ不調ならPDF fallbackで続行
  → 別のdaily-arxiv-data-agent worktree
  → quant-ph → gr-qc → hep-thの固定順で未完了カテゴリだけを実行
  → 各カテゴリをCodex CLI（GPT-5.6-Sol / High）で全abstract一次評価
  → 暫定上位12件の公式v1 PDF確認 + 公式e-print TeXのbounded抽出（追加package不要）
  → 個別本文が取得不能なら候補receiptを検証保存。cooldown後はe-printを先取りし、抽出不能でも版固定PDFが確認できればPDF経路で再開
  → run固有/tmpのカテゴリ専用stagingへ正確な1 JSON（outboxは空のまま）
  → カテゴリ単位で、最大4回の番号付き構造監査（最大3回の一括修正）により全論文の必須キー・得点分布・合計・順位・全文確認状態を確定してから、文章専用の番号付き言語監査・schema・公式snapshot照合
  → Application Support内の日付・snapshot・runtime別checkpointへ検証済みレポートを保存
  → 失敗時は完成済みカテゴリを再利用し、次回runで未完了カテゴリから再開
  → 3カテゴリが揃ったら空のホスト専用stagingへ安全に結合して全体を再検証
  → pastweekを再取得し、選択した日付のID・件数が同一か確認
  → モデルが触れないpublisher control worktreeでorigin/mainを再確認
  → origin/mainと完全一致する隔離publication worktreeで固定publisher
  → 6ファイルだけcommitしてorigin/mainへpush
  → 公開失敗時はcheckpointからCodexなしでpublisherだけを再試行
  → GitHub Actions再検証
  → GitHub Pages
```

### 分離する領域

```text
/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data
  人が変更を確認してcommitするmain checkout

/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publisher
  launchdが使うpristineなpublisher control worktree
  Codex sandboxから書込不可

/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publication[-run-<runId>]
  6ファイルの生成・commit・pushだけを行う隔離publication worktree
  cleanかつorigin/mainと完全一致する候補だけを再利用

/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-agent
  モデル専用worktree
  汚れた場合は残して、次回はrun固有の新しいworktreeを使用

~/Library/Application Support/Daily arXiv/
  モデルから書込不可のlock、lock履歴、ホストstaging、Codex/launchdログ

~/Library/Application Support/Daily arXiv/runtimes/codex/<codex-sha256>/codex
  install時に検証・原子的複製した0500の固定Codex実体

~/Library/Application Support/Daily arXiv/jobs/<date>-<snapshot-fingerprint>/<runtime-fingerprint>/
  不変のjob・snapshot、検証済みカテゴリreport/receipt、追記専用の試行・公開履歴

~/Library/Application Support/Daily arXiv/recovery-authorizations/
  公式照合済み選択を無引数runへ引き継ぐdigest付き0600 authorization

~/Library/Application Support/Daily arXiv/recovery-authorization-staging/
  active公開前の同一filesystem private staging。途中終了残骸はactiveとして読まない

/tmp/daily-arxiv-automation-<uid>/run-.../
  カテゴリ別のモデル出力用staging、空のoutbox、一時HOME/TMPDIR
  macOSのsystem temp全体をモデル側から見た非信頼scratchとして扱う
```

モデル、publisher control、実際のpublicationを同じworktreeで動かしません。固定publisher controlは常にcleanなreview済みruntime commitへ留め、origin/mainがそのHEADのfast-forward先であり、両者のautomation runtime pathに差分がないことだけを確認します。control自体はswitch、reset、commitしません。公開データの読取りと書込みは、cleanかつHEADがそのorigin/mainと完全一致する隔離publication worktreeで行い、その条件を満たす候補だけを再利用します。電源断や強制終了でdirty、staged、local-aheadになったpublication worktreeはswitch、reset、clean、削除せず証拠として保存し、次回runは新しいrun固有worktreeで継続します。Codexは独立process groupで起動し、終了時には残存childも停止します。万一background processが残っても、publisher、ホストlock、ホストstaging、checkpointへ書けない構成です。ホストが信頼するstaging、lock、ログ、checkpoint、秘密情報はsystem tempへ置きません。公開成功後は、そのrunが作成したrun固有`/tmp`、Application Support内の一時ホストstaging、Codexログだけを削除します。`jobs/`の完成済みjob metadata、report digest、試行・公開記録は小さな監査記録として保持します。失敗時の調査資料、既存フォルダ、worktree、checkpointを自動削除・上書きして復旧する処理はありません。
Codexのstdout/stderrはホストが20 MiBで打ち切り、上限超過runは公開しません。モデル出力がログ領域を無制限に埋めることも防ぎます。

### 日付checkpointと再開

aged checkpoint復旧では、旧sourceの固定identity・所有者・mode・inode・link・内容digest・時刻をsource provenanceとしてauthorizationへ封印します。これは同一Mac上の運用証跡であり、第三者のタイムスタンプではありません。

1日分のjobは、announcement dateと公式snapshotのSHA-256で親ディレクトリを選び、その中を評価runtimeのSHA-256で分離した`jobs/<date>-<snapshot-fingerprint>/<runtime-fingerprint>/`に置きます。`job.json`、`snapshot.json`、共有`evaluationRunId`は初回に固定し、既存値を上書きしません。通常のpastweek選択でも明示的旧snapshot復旧でも、モデル起動前にライブの公式head・発表日列・完全snapshot列・target fingerprintを検証し、内容digestをファイル名に持つ0600のdurable authorizationを`recovery-authorizations/`へ排他的に保存します。作成途中の内容は同一filesystem上の非active stagingへfsyncしてから`link(2)`で公開するため、途中終了した部分ファイルをactive authorizationとして読みません。受理した各カテゴリは`reports/<category>.json`とdigest付き`<category>.receipt.json`として保存します。通常の失敗draftは`drafts/<attemptId>.<category>.json`とdigest付きreceiptとして不変保存し、本文link直後の停止でreceiptだけが欠けた場合は次回runが同じ検証を再実行してreceiptを追記します。本文取得不能draftだけは、暫定report、固定候補receipt、attempt stage、snapshot・runtime・runId、report digestを1個のcontent-addressed `*.source-draft.json` envelopeへ入れて排他的に公開します。この関連付けは単一原子的artifactなので、ホスト停止時にもsource draftを通常修復draftへ誤分類しません。追記専用のretry監査eventだけが欠けた場合はenvelopeから再構成します。モデル試行は`attempts/*.json`、公開試行は`publication/*.json`へ追記し、content-addressedな`.writes/*.blob`も含め既存記録を削除・置換しません。

次の定時runでは、public latestDateと一致するactive authorizationを自動検出し、同じsnapshot、runtime fingerprint、evaluationRunIdのjobを開きます。同じanchorのauthorizationが複数ある、digest・0600 mode・canonical内容が変わった、公開anchorやruntimeが一致しない場合はfail closedです。完成済みカテゴリのdigestとschemaを再検証し、有効なカテゴリはCodexを呼ばず再利用して、`quant-ph`、`gr-qc`、`hep-th`の順で最初の未完了カテゴリから再開します。

本文取得receiptに結び付いた有効な暫定draftがあれば、固定候補のbackoffとホストprefetchを先に行い、その後は全abstract評価を繰り返さない`source_resume`へ切り替えます。初期screening時だけ固定候補が暫定上位N件と一致することを検証し、部分的な全文再採点後に候補が現在順位N位より下へ落ちてもreceiptの同じID集合を維持して続行します。版固定PDFだけが確認できる候補はPDF経路で再開します。`category_source_resume`の通常失敗と5時間以上terminal eventのない開始記録も18→36→72時間のbackoff対象にし、無制限にモデルを再起動しません。その他の有効な失敗draftは、新規調査、arXiv再取得、再採点、再順位付けを禁止した修復専用runへ切り替えます。許可するのは欠けた`arxivVersion`、`submissionType`、`url`の決定的追加と、既存の事実・根拠を変えない読者向け日本語の修復だけです。同じcheckpoint job・カテゴリの修復系列で終端失敗が4回に達すると、各失敗で有効な後継draftのdigestが変わっていても回数をリセットせず、最新draftをcontent-addressed checkpointに残したまま自動的に新規generationへ切り替えます。修復失敗も共通retry履歴へ数えるため、この切替は直ちにモデルを再起動せず、最新失敗から最大72時間のtoken-free backoffを必ず通ります。最初の切替時だけ`CATEGORY_REGENERATION_FALLBACK`、`AUTOMATIC_RECOVERY_NOTICE`とmacOS通知を出し、その後も定時runが自動再試行します。開始記録だけでstreamが切れた修復試行は4回の回数へ加えません。通常修復runは高コストな新規generationではないため4回まではgeneration backoffとsource prefetchを迂回します。通常のdraftなしgeneration失敗にも同じbackoffを適用し、11:30と16:30に高コストな全件評価をblindに繰り返しません。レビュー済みruntimeまたは固定Codex identityが変わった場合はauthorizationと一致しないため自動継続せず安全停止します。3カテゴリがすべて有効になった後だけ、空のhost stagingへmaterializeして公開します。公開のネットワーク処理だけが失敗または延期された場合は、次回runでモデルを起動せず公開処理だけを再試行します。`published`記録が一度追記されたjobからは二重公開しません。

### Codexの固定条件

```text
model = gpt-5.6-sol
reasoning effort = high
permissions profile = daily_arxiv_model（Beta、fail closed）
approval policy = never
filesystem = agent worktree・認証保存領域・ホスト制御領域は書込不可
             run固有rootは書込可能、macOS system tempは非信頼scratch
shell network = arxiv.org / export.arxiv.orgだけ
web search = arxiv.org / export.arxiv.orgだけ
login shell、Apps、Plugins、MCP、browser、computer use = 無効
```

ChatGPT認証情報、SSH agent、APIキー名、GitHub token名はモデル側shell環境から除外します。モデルのGit push URLも無効化し、`.codex/rules`でadd/commit/push/publisherを拒否します。ネットワークallowlistだけを秘密情報保護とみなさず、BetaのCodex permissions profileでリポジトリを読取り専用にし、ChatGPT認証保存領域の読取りを明示的に拒否します。

現在のmacOS版Codexが共通ツール実行に使う`:minimal`プロファイルはsystem tempへのscratch書込みを保持するため、`/tmp`全体をrun固有の厳密な境界とはみなしません。モデルには指定run root以外へ書かないよう要求しつつ、system tempはすべて非信頼領域として扱います。秘密情報、lock、履歴、ログ、publisher、ホストstagingはそこへ置かず、ホストstagingは`~/Library/Application Support/Daily arXiv/host-staging/`へ分離します。これによりsystem temp内の内容がモデルに変更されても、公開に使うコピーはモデル終了後に保護領域へ新規作成し、独立検証します。

## ホスト側の決定的な検証

AIの評価内容を機械的に証明することはできませんが、次はホストが独立確認します。

- 公式3カテゴリが同じannouncement dateであること
- 未来日でなく、公開済みlatestDateより新しいこと
- `New submissions`を全件表示した公式ページであること
- 中間日復元では、公開済み日が公式pastweekの発表日列にあり、選択日まで欠落がないこと
- aged checkpoint復旧では、公開済み日 → 保存target → 現在windowの最古完全日がそれぞれ直後の平日で、現在windowの全発表日が完全かつtargetより新しく、`/new`とpastweekのheadが一致すること
- aged sourceがsnapshot-onlyで、固定date・snapshot・runtime・evaluationRunId・ローカルprovenance digestを再開時と公開直前に再検証できること
- reportの全ID集合、カテゴリ、`v1`、New件数、Cross件数が公式snapshotと完全一致すること
- generation前後で、選択したpastweek日付のsnapshot fingerprintが同一であること
- 各モデル終了後もoutboxが空で、カテゴリ専用stagingがホストsnapshotの日付・カテゴリに対応する正確な1レポートだけを含むこと
- 各カテゴリで`<category>-structure-audit-1.json`から番号順に最大4回の固定構造監査を実行し、非ゼロの監査1〜3の後だけ最大3回の一括修正を行い、最初の`issues=0`で後続の構造監査を作らず終了したこと。得点分布と得点・順位・上位10件の全文確認tuple・件数・URLの修正はこの構造段階だけで完了したこと。その後、現在のレポート構造とrun IDを各pass直前に正規validatorで再検証する文章専用の番号付き言語監査が5回以内に`issues=0`となり（非ゼロ言語監査後のwhole-field一括修正は4回以内）、単一カテゴリvalidatorが成功し、その後にホストが公式ID集合・件数・digestを独立検証してcheckpointしたこと
- 完成した3レポートがschema 1.4、Daily arXiv rubric 3.0、同じrunId、固定モデル情報を持つこと
- checkpointのjob・snapshot・receipt・report digestが整合し、3カテゴリすべてが揃うまでpublisherを起動しないこと
- 全論文が4軸と正確に対応する4キーの`scoreReasons`を持ち、`audit.scoreRubric`が`Daily arXiv rubric 3.0`で始まること
- 各最終上位10件に全文確認記録があること
- 各カテゴリの全文確認件数が12件以下であること
- 秘密情報、PDF、symlink、nested `.git`、10 MiB超ファイルがないこと
- commit対象が日付に対応する正確な6ファイルだけであること
- push直前までHEADと`origin/main`が競合していないこと。公開失敗後の再試行でも同じcheckpointを再検証すること

長時間run中に新しい発表日が追加されても、選択済みの日付がpastweek内にある間は毎回fingerprintを完全照合します。選択日が後に範囲外へ落ちた場合は、作成時にライブ照合したdurable authorization、保護済みsnapshot fingerprint、変更されていないpublic latestDate、後退していない公式head、現在の`/new`とpastweek headの完全一致を再検証して同じjobだけを継続できます。公開直前にも同じ条件を再取得して検証します。

選択時点で既にpastweek外のaged targetは、専用の明示的復旧で封印したsource provenanceと欠落のない完全windowをさらに必須とします。これらも再開時と公開直前に再検証します。

## このMacで必要な前提

- Node.js 22以上
- ChatGPTアカウントで認証したCodex CLI
- `gpt-5.6-sol` / `high`を利用可能
- originが`hiroki-takeda/daily-arxiv-data`
- macOSシステムtimezoneが`Asia/Tokyo`
- APIキー、GitHub PAT、`gh` CLIは不使用
- PDF全文確認用のHomebrew、Poppler、Python packageは不要（同梱helperが公式e-printをrun固有`/tmp`へ安全に抽出）

Codex CLIは更新され得るため、厳格config preflightに失敗した場合は自動runを開始しません。
登録時はVS Code拡張内の候補を実行・SHA-256・version・ChatGPT認証・doctor・実機sandbox probeまで確認した後、`~/Library/Application Support/Daily arXiv/runtimes/codex/<SHA-256>/codex`へ0500の実体を原子的に複製します。複製先でも同じpreflightを再実行し、plistはこの固定pathを参照します。したがって、その後にVS Code拡張が更新・削除されても定時runの実行ファイルは消えません。毎runは固定実体のSHA-256とversionを再計算し、改変時は停止します。旧runtimeを自動削除せず、異なる既存plistも上書きしません。service・plist・publisherの変更前には別途承認します。

## 一度だけ行う登録

自動化コードとUI改善が`origin/main`へpush済みで、main checkoutがcleanであることが前提です。未commit状態では診断が意図的に失敗します。

### 1. 非公開・非登録の事前診断

```bash
cd /Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data
node scripts/configure-macos-schedule.mjs check
node scripts/run-local-automation.mjs --check
```

`check`は次を確認します。

- main checkoutがcleanで、認証付き`git ls-remote`の`origin/main`と同じHEAD
- Node.jsとmacOS timezone
- launchd相当の限定PATHから候補Codex CLIを発見でき、固定runtime予定pathを内容SHA-256から決定できること
- ChatGPTログインでありAPIキーログインでないこと
- 固定モデル、filesystem sandbox、managed network proxyのconfigをCLIが認識すること
- macOS Seatbelt実機で実際のmain checkoutが読取り専用、runRootへの書込みが可能で、checkout書込みと認証ファイル読取りが拒否されること（成功時はcheckoutへファイルを作りません）
- sandbox内からarXiv公式通信だけ成功し、外部ドメイン通信が拒否されること
- 日次モデルrunではコードを変更せず、schemaとリポジトリ検証はモデル終了後に固定publisherが、全テストはpush後にGitHub Actionsが実行すること
- 既存publisher pathがある場合は正しいrepoのclean worktreeであること

この診断はcommit、push、worktree登録、plist登録、モデル実行を行いません。Codex config確認用の小さな一時ディレクトリだけを`/tmp`へ作る場合があります。

### 2. plistの確認

```bash
node scripts/configure-macos-schedule.mjs print | plutil -lint -- -
node scripts/configure-macos-schedule.mjs print
```

### 3. ユーザー承認後に登録

```bash
node scripts/configure-macos-schedule.mjs install
```

`install`は検証済みCodexを内容SHA-256別の固定runtimeへ複製し、その複製でも認証・設定・権限probeを通してからserviceを読み込みます。日次checkpointのruntime fingerprintにはリポジトリ内の固定runtime fileだけでなく、このCodex SHA-256とversionも含めます。直後にも追いつき確認が1回走ります。既に公開済みならCodexを呼ばず`NO_CHANGE`で終了します。当日一覧に対して公式本文の配信がまだなら、Codexを呼ばず`AUTOMATION_DEFERRED`で終了し、次の定時runに再確認します。

未公開日が複数ある場合は最古の1日だけを処理しますが、その時点で完全確認できた後続の非空snapshotも`expectedLatestDate → targetDate`の順序付きauthorizationと空checkpointへ先に保存します。各authorizationは直前のeditionが公開されたときだけactivateされます。したがって最古の1日がpastweek外へ落ちるほど遅延しても、既に捕捉済みの後続日はlive windowへ戻らず順に再開できます。定時runで公式headが進んだ場合も、既存キュー末尾がpastweek内にある間に新しい後続日を追加します。Macがpastweek全体より長く停止して未捕捉の日が生じた場合だけは、日付を推測せず手動確認で停止します。途中で終了しても次の定時runは有効なcheckpointを再利用し、同じ日付の未完了カテゴリから続けます。以後もMac再起動後のユーザーログイン時に同じ確認を行います。

公式`pastweek`は直近5発表日の見出しを提供しますが、最古日は一覧の時間境界で一部だけの場合があります。最古日は公開済み日を特定する基準として使い、復元には3カテゴリすべてが完全表示された後続日だけを使います。公開済み日が5発表日の範囲外なら、自動で日付を飛ばさず手動確認を求めます。

直前の公開日だけが範囲外になり、その直後の未公開日について保護済みcheckpoint snapshotが残り、現在のpastweek最古完全snapshotと全ID・件数・URL・SHA-256が完全一致する場合に限り、一回限りの`--recover-checkpoint <expected-latest> <target> <snapshot-sha256> <source-runtime-sha256>`を人が確認して使用できます。latestDateがwindow外ならtargetは通常の次の平日でなければならず、長い欠落列を飛ばしません。旧jobのreport/draftは移植しませんが、承認済み条件と同時に確認できた後続snapshot列は耐久キューとして保存されます。そのrunが延期・失敗しても次の無引数runが同じ新runtime jobを再開し、対象公開後は次のauthorizationが自動でactivateされます。authorizationは削除せず、対応する`expectedLatestDate`が現在のpublic latestDateである間だけactiveになります。

この`--recover-checkpoint`はtargetが現在のpastweek内の最古完全snapshotである経路です。通常の自動選択とこのlive recoveryの条件は、範囲外のtargetを通すために緩めません。

target自体がpastweekから1発表日だけ外れた場合は、別の一回限りの`--recover-aged-checkpoint`を人が固定値を確認して実行します。今回の審査済みsource checkpointに対する完全なCLI構文は次のとおりです。

```bash
node scripts/run-local-automation.mjs --recover-aged-checkpoint \
  2026-07-24 \
  2026-07-27 \
  554489e6de889f4dbe5763c4e2b09c95780d9f33a827f2d2aa4e755bff4fff82 \
  667abaeb9b7f0468268087eddefc12236d38e5ca1933fc2a649fdfed36b0fc4e
```

受理条件は、公開済み日の直後の平日がtarget、targetの直後の平日が現在のpastweek最古日であること、現在windowの全発表日が3カテゴリで完全かつtargetより新しいこと、`/new`とpastweekのheadが一致することです。sourceは指定date・snapshot fingerprint・runtime fingerprint・evaluationRunIdで一意な、report・draft・publicationを含まないsnapshot-only checkpointに限ります。その所有者、0700/0400 mode、symlink不在、artifactとcontent-addressed blobのidentity・digest・時刻を、現runtimeのdestination checkpointを用意する前にprovenanceとして封印します。

モデル起動前かつdestination job作成前に、保存targetと現在windowの後続非空snapshot全部を最古から最新の連続durable planとして検証し、原子的に保存します。先頭は`aged_checkpoint_recovery`、最初のlive後続だけは`aged_window_continuation`、以後は`normal`とし、authorizationは最新側から作成してactive headを最後に原子的に公開します。このため途中停止で未完のheadはactivateされず、次の無引数runは保存済みplanから再開できます。旧jobのreport・draftは移植せず、現runtimeの新しいjobで評価します。初日の公開後は無引数の定時・login runが1回1日で次のauthorizationをactivateし、スリープや再起動の後も同じ連続planから再開します。中間日、部分window、source provenance不一致のどれかがあれば、モデルを起動せずfail closedです。

作成対象:

```text
/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publisher/
/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publication[-run-<runId>]/
~/Library/Application Support/Daily arXiv/
~/Library/LaunchAgents/com.hiroki.daily-arxiv.plist
```

`daily-arxiv-data-agent`と最初の`daily-arxiv-data-publication`は必要になった新着run時に作ります。publication候補は成功後もcleanでorigin/mainと一致すれば再利用します。対象pathが既に別フォルダなら触らず、run固有の別pathを使います。異なる既存plist、別repoのworktree、dirty publisher control、同名service衝突は上書きせず停止します。中断でdirtyまたはlocal-aheadになったpublication候補も上書き・整理せず保存します。

登録確認:

```bash
launchctl print gui/$(id -u)/com.hiroki.daily-arxiv
```

service停止、plist削除、古いdirty agent worktree整理は対象削除を伴うため自動uninstallを提供しません。必要になった時点で対象と理由を確認してから行います。

## スケジュールと日課

```text
月〜金 11:30 JST  主run
月〜金 16:30 JST  retry
ユーザーログイン時  最古の未公開1日を追いつき確認
```

日々の指示は不要です。通常の日課は公開ページを見るだけです。週1回程度、または通知が失敗を示した時に次を確認します。

ログイン直後にネットワークやSSH認証がまだ利用できなければ、その追いつき確認は安全に失敗します。常駐retryは行わず、次の11:30または16:30の定時runで再試行します。

```bash
tail -n 200 "$HOME/Library/Application Support/Daily arXiv/logs/launchd.stdout.log"
tail -n 200 "$HOME/Library/Application Support/Daily arXiv/logs/launchd.stderr.log"
git -C /Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data status --short --branch
```

正常時は`CHECKPOINT_CREATED`が日付jobの開始、`CATEGORY_CHECKPOINTED`がカテゴリ受理、`CHECKPOINT_RESUMED`と`CATEGORY_CHECKPOINT_REUSED`が完成済みカテゴリを使った再開を示します。report保存直後に異常終了して通常receiptだけが未作成だった場合は、次回runがreportを再検証して`CATEGORY_CHECKPOINT_RECOVERED`を記録し、モデルで再生成しません。本文取得不能draftでは暫定reportとsource receiptを単一の原子的envelopeとして保存し、別のretry監査eventが欠けた停止もenvelopeからsource associationを復元します。`DURABLE_CONTINUATION_AUTHORIZED`は公式照合済みの欠落日キュー保存、`DURABLE_CONTINUATION_QUEUE_VERIFIED`は既存キューと追加headの再検証、`DURABLE_CONTINUATION_SELECTED`は無引数runでの再開、`CHECKPOINT_RECOVERY_SELECTED`は人が確認した旧snapshot復旧を示します。`SOURCE_CANDIDATES_PREFETCHED`はcooldown後の固定候補本文先取りまたは版固定PDF fallback確認です。本文取得receipt時は全abstract評価済み暫定draftも保存し、次のモデルrunは`source_resume`で固定候補の全文評価から続けるため、全abstract評価を繰り返しません。`CATEGORY_REGENERATION_FALLBACK`は同じjob・カテゴリの修復系列で4回の終端失敗（途中の後継draft digest変更を含む）に達した後も最新draftを保護したまま、共通backoffを経由する新規generationへ自動移行したことを示します。`AUTOMATION_PUBLISHED`がpush完了、公開処理だけを再試行する場合は`PUBLISH_RETRY`です。

既発表、公式本文の配信待ち、カテゴリbackoff、候補prefetch未完了はいずれも`NO_CHANGE`または`AUTOMATION_DEFERRED`で、Codexを起動しません。通常の`NO_CHANGE`と`AUTOMATION_DEFERRED`ではデスクトップ通知を出しませんが、同一カテゴリのsource障害または当日full-text readiness延期が3回目、その後も3回増えるごとに通知し、自動bounded retry自体は維持します。また、同じjob・カテゴリの修復上限から新規generationへ自動移行した最初の1回だけ、draft保持とcooldown後の自動再試行を通知します。通常generation failureをsource障害の回数へ混ぜません。push完了時の通知はPages公開完了ではなく、GitHub Actionsによる検証・配信開始を示します。失敗時は`ACTION_REQUIRED:`で始まり、完成済みcheckpoint、`current.json`、`origin/main`を維持します。

異常終了したlockはすぐ削除せず保存します。元processが存在せず5時間以上経過したlockだけを`stale-locks`へ移し、午後または翌日のrunを継続します。正常lockも削除せず`lock-history`へ移して監査履歴にします。
ごく稀に、5時間超の有効なlockに記録されたPIDが別processへ再利用され、そのprocessが長時間存続している場合は、実行重複を避けるため`ACTION_REQUIRED`として停止し、lockと該当PIDを手動確認します。

`CHECKPOINT_RECOVERY_SELECTED`は現在のpastweek内targetをlive再検証した旧経路、`AGED_CHECKPOINT_RECOVERY_SELECTED`は封印済みsnapshot-only sourceの専用例外経路を示します。どちらも以後は`DURABLE_CONTINUATION_AUTHORIZED`、`DURABLE_CONTINUATION_SELECTED`、`DURABLE_CONTINUATION_QUEUE_VERIFIED`で連続planを追跡できます。

## 共用表示PC

- 公開ページ: https://hiroki-takeda.github.io/daily-arxiv-data/
- Actions: https://github.com/hiroki-takeda/daily-arxiv-data/actions

共用PCは表示端末であり、自動生成ホストではありません。ページは5分間隔でデータを再取得し、通信失敗時はその端末の最終正常版を表示します。上位10件は高密度一覧、選択した1件だけ詳細展開、11位以下も初回選択時に完全レポートを取得して全情報を表示します。

## Mac不要Cloud経路

API追加課金なしで無人commit・pushまで確実に行うCloud経路は、現時点では本番に採用しません。Daily arXivは上記のローカル`launchd`経路だけを使います。

## 公式仕様

- Scheduled Tasks: https://learn.chatgpt.com/docs/automations
- Codex Cloud: https://learn.chatgpt.com/docs/cloud
- Cloud environments: https://learn.chatgpt.com/docs/environments/cloud-environment
- ChatGPTプランでのCodex: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- ChatGPT GitHub連携: https://help.openai.com/en/articles/11145903-connecting-github-to-chatgpt-deep-research
- Codex config: https://learn.chatgpt.com/docs/config-file/config-reference
- Codex permissions: https://learn.chatgpt.com/docs/permissions
- arXiv announcement availability: https://info.arxiv.org/help/availability.html
- arXiv pastweek listing example: https://arxiv.org/list/hep-th/pastweek?skip=0&show=2000
