# Daily arXiv 自動運用ガイド

## 結論

OpenAI API課金なしで現在もっとも確実な本番経路は、ChatGPTアカウントで認証したCodex CLIをmacOS標準の`launchd`から実行する方式です。APIキー、GitHub PAT、ChatGPTデスクトップ、Atlas、Chrome、共用表示PCを起動しておく必要はありません。

自動処理用Macは電源オンかつユーザーがログイン済みである必要があります。画面ロックとディスプレイスリープは問題ありません。予定時刻にシステムがスリープ中なら、`launchd`は次の起床時に実行します。完全シャットダウン中やログアウト中には動きません。

次回ログイン時は、arXiv公式`pastweek`の直近5発表日に公開済み日が含まれていれば、抜けた日のうち最古の1日を復元します。1回の起動では1日だけを処理し、次の定時runで次の日へ進みます。これにより中間日を飛ばさず、長時間runとChatGPT利用枠の集中を避けます。公開済み日が公式範囲より古い場合は、最新日へ飛ばず安全停止します。

普段ChatGPTを使う画面は`chatgpt.com`をChrome等の通常ブラウザで開く形が長期的な基準です。デスクトップアプリはローカルフォルダを対話操作したい時だけで構いません。このDaily arXivの登録済み自動処理は、どちらの画面にも依存しません。

## 課金と利用枠

- OpenAI APIキーとAPI従量課金は使いません。
- ChatGPTログイン済みCodex CLIを使うため、契約中ChatGPTプランのCodex利用枠を消費します。
- 全abstractと各カテゴリ最終上位10件のPDFを扱う重いrunです。利用枠、モデル利用可否、ネットワークのいずれかで失敗した場合は公開せず、午後または翌営業日に再試行します。
- 公式一覧の日付が既に公開済みならCodexを起動しないため、午後runを含め利用枠を消費しません。

## 本番構成

```text
launchd（平日11:30・16:30 JST）
  → daily-arxiv-data-publisher/scripts/run-local-automation.mjs
  → origin/mainを認証付きで確認
  → ホストがarXiv公式3一覧を取得
     日付・New ID全件・New/Cross件数をsnapshot化
  → 未公開日が複数ならpastweekから最古の完全な1日を選択
  → 公開済みならNO_CHANGE（Codex未使用）
  → 別のdaily-arxiv-data-agent worktree
  → Codex CLI（GPT-5.6-Sol / Ultra）
  → run固有/tmpへ3 JSON + manifest
  → ホスト専用stagingへ安全にコピー
  → schemaと公式snapshotを完全照合
  → pastweekを再取得し、選択した日付のID・件数が同一か確認
  → モデルが触れないpublisher worktreeの固定publisher
  → 6ファイルだけcommitしてorigin/mainへpush
  → GitHub Actions再検証
  → GitHub Pages
```

### 分離する領域

```text
/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data
  人が変更を確認してcommitするmain checkout

/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publisher
  launchdとpublisherだけが使うpristine worktree
  Codex sandboxから書込不可

/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-agent
  モデル専用worktree
  汚れた場合は残して、次回はrun固有の新しいworktreeを使用

~/Library/Application Support/Daily arXiv/
  モデルから書込不可のlock、lock履歴、Codex/launchdログ

/tmp/daily-arxiv-automation-<uid>/run-.../
  そのrunだけモデルに許可するstaging、manifest、一時HOME/TMPDIR
```

モデルとpublisherを同じworktreeで動かしません。Codexは独立process groupで起動し、終了時には残存childも停止します。万一background processが残っても、publisher、ホストlock、ホストstagingへ書けない構成です。公開成功後は、そのrunが作成したrun固有`/tmp`、ホストstaging、Codexログだけを削除します。失敗時の調査資料、既存フォルダ、worktreeを自動削除・上書きして復旧する処理はありません。
Codexのstdout/stderrはホストが20 MiBで打ち切り、上限超過runは公開しません。モデル出力がログ領域を無制限に埋めることも防ぎます。

### Codexの固定条件

```text
model = gpt-5.6-sol
reasoning effort = ultra
permissions profile = daily_arxiv_model（Beta、fail closed）
approval policy = never
filesystem = agent worktreeは読取り専用、run固有rootだけ書込可能
shell network = arxiv.org / export.arxiv.orgだけ
web search = arxiv.org / export.arxiv.orgだけ
login shell、Apps、Plugins、MCP、browser、computer use = 無効
```

ChatGPT認証情報、SSH agent、APIキー名、GitHub token名はモデル側shell環境から除外します。モデルのGit push URLも無効化し、`.codex/rules`でadd/commit/push/publisherを拒否します。ネットワークallowlistだけを秘密情報保護とみなさず、BetaのCodex permissions profileでリポジトリを読取り専用、run固有領域だけを書込可能にし、ChatGPT認証保存領域の読取りを明示的に拒否します。秘密情報、lock、履歴は`/tmp`へ置きません。ホストstagingは同じ自動化専用temp base内でもモデルへ許可したrunRootの外に分離し、モデルからの読書きを拒否します。

## ホスト側の決定的な検証

AIの評価内容を機械的に証明することはできませんが、次はホストが独立確認します。

- 公式3カテゴリが同じannouncement dateであること
- 未来日でなく、公開済みlatestDateより新しいこと
- `New submissions`を全件表示した公式ページであること
- 中間日復元では、公開済み日が公式pastweekの発表日列にあり、選択日まで欠落がないこと
- reportの全ID集合、カテゴリ、`v1`、New件数、Cross件数が公式snapshotと完全一致すること
- generation前後で、選択したpastweek日付のsnapshot fingerprintが同一であること
- 3レポートがschema 1.3、同じrunId、固定モデル情報を持つこと
- 各最終上位10件に全文確認記録があること
- 秘密情報、PDF、symlink、nested `.git`、10 MiB超ファイルがないこと
- commit対象が日付に対応する正確な6ファイルだけであること
- push直前までHEADと`origin/main`が競合していないこと

長時間run中に新しい発表日が追加されても、選択済みの過去日が公式pastweek内に完全な形で残り、fingerprintが同一ならその過去日を公開できます。選択日が範囲外へ落ちた、部分表示になった、または内容が変わった場合は公開せず、次回runまたは手動確認へ回します。

## このMacで必要な前提

- Node.js 22以上
- ChatGPTアカウントで認証したCodex CLI
- `gpt-5.6-sol` / `ultra`を利用可能
- originが`hiroki-takeda/daily-arxiv-data`
- macOSシステムtimezoneが`Asia/Tokyo`
- APIキー、GitHub PAT、`gh` CLIは不使用

Codex CLIは更新され得るため、厳格config preflightに失敗した場合は自動runを開始しません。
登録時に実体path、SHA-256、versionをplistへ固定し、毎runで再計算します。VS Code拡張やCLIが更新・置換された場合は、新バイナリを無検証で使わず停止します。service・plist・publisherを安全に同時更新する自動コマンドは意図的に設けません。失敗通知を受けたら既存物を削除せず、Daily arXivのスケジュール更新をCodexへ依頼し、実行中jobと差分を確認したうえで変更前に別途承認します。

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
- launchd相当の限定PATHからCodex CLIを発見できること
- ChatGPTログインでありAPIキーログインでないこと
- 固定モデル、filesystem sandbox、managed network proxyのconfigをCLIが認識すること
- macOS Seatbelt実機で使い捨て模擬workspaceが読取り専用、runRootだけが書込可能で、workspace書込みと認証ファイル読取りが拒否されること
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

`install`でserviceを読み込んだ直後にも追いつき確認が1回走ります。既に公開済みならCodexを呼ばず`NO_CHANGE`で終了します。未公開日が複数ある場合は最古の1日を評価・公開し、次の定時runで次の日へ進みます。以後もMac再起動後のユーザーログイン時に同じ確認を行います。

公式`pastweek`は直近5発表日の見出しを提供しますが、最古日は一覧の時間境界で一部だけの場合があります。最古日は公開済み日を特定する基準として使い、復元には3カテゴリすべてが完全表示された後続日だけを使います。公開済み日が5発表日の範囲外なら、自動で日付を飛ばさず手動確認を求めます。

作成対象:

```text
/Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data-publisher/
~/Library/Application Support/Daily arXiv/
~/Library/LaunchAgents/com.hiroki.daily-arxiv.plist
```

`daily-arxiv-data-agent`は最初の新着run時に作ります。対象pathが既に別フォルダなら触らず、run固有の別pathを使います。異なる既存plist、別repoのworktree、dirty publisher、同名service衝突は上書きせず停止します。

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

正常時は`AUTOMATION_PUBLISHED`、既発表なら`NO_CHANGE`です。`NO_CHANGE`ではデスクトップ通知を出しません。push完了時の通知はPages公開完了ではなく、GitHub Actionsによる検証・配信開始を示します。失敗時は`ACTION_REQUIRED:`で始まり、`current.json`と`origin/main`を維持します。

異常終了したlockはすぐ削除せず保存します。元processが存在せず5時間以上経過したlockだけを`stale-locks`へ移し、午後または翌日のrunを継続します。正常lockも削除せず`lock-history`へ移して監査履歴にします。

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
