# 最初に行うこと

このZIPは、GitHubリポジトリ `hiroki-takeda/daily-arxiv-data` に入れるDaily arXiv一式です。

1. ZIPをダブルクリックして展開します。
2. 展開後の `daily-arxiv-data` フォルダを開きます。
3. 中にあるファイルとフォルダをすべて選択してコピーします。
4. GitHub Desktopでcloneした個人Mac上の `daily-arxiv-data` フォルダをFinderで開きます。
5. コピーした内容を貼り付けます。既存のREADMEを置き換える確認が出たら「置き換える」を選びます。
6. GitHub Desktopへ戻ります。
7. 左下のSummaryに `Install Daily arXiv dashboard` と入力します。
8. `Commit to main` を押し、続いて上部の `Push origin` を押します。

認証情報、APIキー、arXiv PDFは含まれていません。

Push後、GitHubのリポジトリ画面で次を設定します。

1. `Settings` を開きます。
2. 左側の `Pages` を開きます。
3. `Build and deployment` の `Source` で `GitHub Actions` を選びます。
4. 1〜3分待ち、次のURLを開きます。

https://hiroki-takeda.github.io/daily-arxiv-data/

この時点では保存済みの2026-07-10版が表示されます。Sol Ultraによる日次評価の自動実行設定は、公開画面を確認したあとに行います。
