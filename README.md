# YT Stream Resolver (Render)

Render にデプロイすると `https://<your-app>.onrender.com/api/video/<videoId>` で
yt-dlp 経由の googlevideo 直リンクを JSON で返します。UI (`/`) で確認可能。

## デプロイ手順
1. このフォルダ (`render-app/`) を GitHub リポジトリへ push
2. Render Dashboard → New → Blueprint → リポジトリを選択
3. `render.yaml` が検出されるのでそのまま Apply
4. デプロイ完了後、トップページで Video ID を入力

Docker イメージで `yt-dlp` / `ffmpeg` / `python3` を同梱しています。

## API
`GET /api/video/:id` →
```json
{ "id": "dQw4w9WgXcQ", "url": "https://...googlevideo.com/..." }
```
