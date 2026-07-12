# Daily arXiv 自動運用ガイド

## 結論

データ生成はChatGPTデスクトップのStandalone Scheduled Taskを、専用Worktreeで実行します。Web版Scheduled TaskはMac上のリポジトリを直接扱えないため使用しません。

共用表示PCは公開URLを開いておくだけです。データ取得は5分間隔で、通信に失敗した場合はその端末に保存した最終正常版を表示します。

## Sol Ultraの確認

このMacでは2026-07-12に次を確認済みです。

- モデル一覧に`gpt-5.6-sol`（表示名`GPT-5.6-Sol`）が存在
- 対応推論レベルに`ultra`が存在
- 同じChatGPT認証による読み取り専用の一時実行が`SOL_ULTRA_OK`で完了

Scheduled Taskの作成画面でも、モデルを`GPT-5.6-Sol`、推論を`Ultra`へ明示設定してください。選択肢が表示されない場合はタスクを有効化せず、ChatGPTアプリの更新とアカウントのモデル利用可否を確認します。`High`へ自動降格させません。

リポジトリは出力メタデータを検証しますが、Scheduled画面で実際に選択されたモデルを暗号学的に証明するものではありません。このためモデル設定は初回とアプリ更新後に人が画面で確認します。

## 一度だけ行う設定

1. ChatGPTデスクトップアプリを開きます。
2. このローカルプロジェクトを選びます。

   ```text
   /Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data
   ```

3. Standalone Scheduled Taskを新規作成します。
4. 実行先は`Dedicated worktree`、基準ブランチは`main`を選びます。Local projectは使用しません。
5. モデルを`GPT-5.6-Sol`、推論を`Ultra`へ明示設定します。
6. 時刻をAsia/Tokyoで平日11:30と16:30にします。

   ```text
   RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=11,16;BYMINUTE=30;BYSECOND=0
   ```

   1タスクで複数時刻を設定できない場合は、同じプロンプトの`Daily arXiv morning`（11:30）と`Daily arXiv retry`（16:30）を作成します。

7. プロンプトに次だけを貼り付けます。

   ```text
   Run the complete Daily arXiv production workflow in AGENTS.md and docs/SCHEDULED_TASK_PROMPT.md exactly. This task is configured for GPT-5.6-Sol with Ultra reasoning and runs in a dedicated worktree. Do not weaken any validation or publish by another path.
   ```

8. プロジェクトを信頼し、固定スクリプト`node scripts/prepare-worktree.mjs`と`node scripts/publish-edition.mjs`の実行だけを許可します。任意のshell、任意の`git push`、full accessは許可しません。
9. macOSとChatGPTのScheduled通知を有効にします。
10. 最初の3回はScheduledの実行結果とGitHub Actionsを確認します。

プロジェクトローカルの`.codex/rules/daily-arxiv.rules`は上記2スクリプトだけをallowします。ルールを読み込ませるため、初回設定前にChatGPTアプリを再起動してください。

## 実行条件

- 自動処理を行うMacが電源オンであること
- Macがスリープしていないこと
- ChatGPTデスクトップアプリが起動していること
- ローカルリポジトリとSSH認証が残っていること
- インターネットへ接続できること

共用表示PCと実行Macは別でも構いません。表示PC側にGit、Node.js、ChatGPTログインは不要です。

## 正常時の結果

成功時はScheduledに次の情報が残ります。

```text
PUBLISHED
announcement date
3カテゴリの新着件数・全文確認件数
runId
commit
public URL
```

既に公開済み、または新しい発表がない場合は`ALREADY_PUBLISHED`または`NO_NEW_ANNOUNCEMENT`で正常終了し、評価、commit、pushを行いません。午後タスクは通常この経路になります。

## 失敗時

失敗報告は`ACTION_REQUIRED:`で始まり、`current.json unchanged; no push`を明記します。前回正常版は公開されたままです。

よくある確認:

```bash
cd /Users/hiroki/Desktop/Daily_arXiv/daily-arxiv-data
git pull --ff-only
npm test
npm run validate
git status --short --branch
```

`git reset --hard`、force push、`git add -A`は使用しません。失敗したScheduled Worktreeは本番checkoutから隔離されています。

## GitHub Pagesと共用画面

GitHub Actionsはpushされた内容を再度検証し、成功時だけ`public/`をPagesへ配置します。

- リポジトリ: https://github.com/hiroki-takeda/daily-arxiv-data
- Actions: https://github.com/hiroki-takeda/daily-arxiv-data/actions
- 公開ページ: https://hiroki-takeda.github.io/daily-arxiv-data/

共用PCでは公開ページを全画面で開き、OSの自動スリープを無効にします。ページは5分ごとにデータを再取得し、画面全体の再読み込みは不要です。

## 公式仕様上の制約

ChatGPTデスクトップのローカルScheduled Taskは、実行時にMacとアプリが稼働している必要があります。Scheduled Taskは無人実行時のsandbox設定を使うため、権限は固定publisherに限定しています。

- Scheduled Tasks: https://developers.openai.com/codex/app/automations
- arXiv announcement availability: https://info.arxiv.org/help/availability.html
