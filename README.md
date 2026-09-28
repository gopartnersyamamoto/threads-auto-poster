# threads-auto-poster

Threads予約投稿のクラウド側（Macを閉じていても予約時刻に投稿する）。

- 予約はMacのダッシュボードで承認し、`queue.json` として暗号化してpushする（公開リポジトリのため中身は読めない）
- pushをきっかけにGitHub Actionsが起動し、次の予約時刻まで待って投稿するのを繰り返す。予約が残っていれば次の実行へ引き継ぐ
- 結果は `results.json`（投稿中／投稿済み／失敗／要確認）。ダッシュボードが取り込む
- Secrets：THREADS_TOKEN_KIMURA / THREADS_TOKEN_OFFICIAL / QUEUE_KEY
