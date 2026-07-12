# Daily arXiv

研究室の共用ディスプレイ向けに、`hep-th`・`gr-qc`・`quant-ph`の新着論文をランキング表示する公開ダッシュボードです。

## 現行方式

- 評価モデル: 明示的に選択した `5.6 Sol Ultra`
- 一次評価: primary category の新着全件をタイトル・著者・アブストラクトで評価
- 最終評価: 各カテゴリ上位10件が安定するまでPDF全文を確認して再評価
- 採点: 物理学全体への影響、カテゴリ内の重要度、独創性、方法・結果の説得力を各25点
- 著者評価: 知名度は採点に使わず、検証済みの特別な著者だけ非加点マークで表示
- 保存: 日付別JSONをGitHubへ蓄積し、GitHub Pagesで公開
- 料金: OpenAI APIおよびOpenAlex APIは不使用
- 安全性: モデル設定、データ構造、全文確認条件が検証できない実行は公開しない

詳細は [Sol Ultra pipeline](docs/SOL_ULTRA_PIPELINE.md) を参照してください。

## GitHub Pages

リポジトリの `Settings` → `Pages` → `Build and deployment` → `Source` で `GitHub Actions` を選択します。`main` へpushされると、`public` フォルダが公開されます。

公開URL:

```text
https://hiroki-takeda.github.io/daily-arxiv-data/
```

画面は5分ごとに自動再読み込みします。更新に失敗した場合は、前回正常データを保持します。

## データ構造

```text
public/data/YYYY-MM-DD.json
public/data/current.json
public/data/index.json
```

arXiv PDF自体は保存せず、評価結果、要約、確認範囲、arXivへのリンクだけを保存します。

## 検証

```bash
npm install
npm run test:model-policy
npm run test:v2
npm run typecheck
```

過去のChatGPT Web Scheduled Tasks方式は停止済みです。`docs/SCHEDULED_*` は移行記録であり、現行運用には使用しません。
