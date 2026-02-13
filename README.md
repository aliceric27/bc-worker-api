# bc-api-gsheet-json-worker

這是一個 Cloudflare Worker（wrangler 專案），用途是把指定的 Google Sheet（CSV export）轉成乾淨的 JSON，方便給 AI/程式讀取。

## API

預設會把 `TABS_JSON` 內所有分頁資料**合併**後回傳完整 payload（含 meta/header/items）：

- `GET /`

列出目前設定的分頁清單：

- `GET /tabs`

留言區（獨立 API，不併入預設合併）：

- `GET /comments`

用「路由」指定特定分頁（對應 `TABS_JSON.key`）：

- `GET /taipei`
- `GET /taichung`
- `GET /kaohsiung`
- `GET /tainan`
- `GET /overseas`

也支援直接用分頁 `name` 當路由（例如 `GET /台北`、`GET /海外`）。

常用參數：

- `gid`：工作表 gid（預設 `0`）
- `tab`：用分頁 `key` 或 `name` 指定（例如 `tab=taipei` 或 `tab=台北`）
- `merge=0`：關閉合併模式（此時會回單一分頁；會使用 `gid` / `tab`，或回到預設 `DEFAULT_GID`）
- `tabs=taipei,taichung`：合併模式下只合併指定分頁（用 `key` 或 `name`）
- `shape=items`：只回傳資料陣列（較適合直接餵給 AI）
- `pretty=1`：JSON pretty print
- `omitEmpty=0`：保留空字串欄位（預設會省略空值欄位）
- `limit=100`：限制回傳筆數
- `headerRow=2`：指定表頭列（1-based；預設會自動推斷）
- `withTab=1`：在合併後的每筆資料加上 `__tab` 與 `__gid` 方便追來源
- `format=csv` 或 `GET /raw`：回傳上游 CSV 原文（除錯用）

## 設定

可在 `wrangler.toml` 調整：

- `SHEET_ID`：Google Sheet id
- `DEFAULT_GID`：預設 gid
- `CACHE_TTL_SECONDS`：快取秒數（同時用於上游 CSV fetch 與本 Worker 輸出）
- `TABS_JSON`：分頁清單（合併模式用，也用於 `/taipei` 這類路由）
- `COMMENTS_GID`：留言區 gid（`/comments` 用）

## 在本機測試（Windows）

```bash
npm install
npm run dev
```

或使用 pnpm（在 Windows）：

```bash
pnpm install
pnpm dev
```

啟動後可用：

```bash
curl "http://localhost:8787/?shape=items&pretty=1"
```

## 部署

在 Windows 端登入並部署：

```bash
npx wrangler login
npm run deploy
```
