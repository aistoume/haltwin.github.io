# sterlingai.net 部署说明（Cloudflare Worker：静态站 + API 代理）

官网 **https://sterlingai.net**（www 同）跑在 Ryanmo.photo@gmail.com 的 Cloudflare 账号（`f2a1cb443cfb87b526fac0886f1b34c8`）里的 Worker `sterlingai` 上：

- **静态站**：本仓库 `main` 的站点文件（`index.html`、`terminal.html`、`treasury/`、`discord/`、`favicon.svg`、`og-image.png`），由 `build.sh` 拷进 `cloudflare/dist` 后作为 Workers 静态资源发布。
- **`worker.js`**（必须一起发）：把 `/mcp`、`/health`、`/v1/*` 代理到后端 `sterling-asp.onrender.com`（OKX.AI 注册的 A2MCP endpoint 就是 `https://sterlingai.net/mcp`），并做 www/http → `https://sterlingai.net` 的 301。
- 域名以 Workers Custom Domain 挂载，DNS 与证书由 Cloudflare 自己维护。**不要**给 `sterlingai.net` / `www.sterlingai.net` 手工加 A/AAAA/CNAME（会触发 100117 部署失败）。

## 谁能发

Ryanmo 账号成员，角色 **Workers Editor + Workers Platform Admin**（brucelee202202、daniel.cs.tech 已生效）。用自己的账号 `npx wrangler@4 login`，`npx wrangler@4 whoami` 里必须能看到 `Ryanmo.photo@gmail.com's Account f2a1cb443cfb87b526fac0886f1b34c8`。

## 铁律（两次事故的教训：2026-09-13、2026-09-17）

1. **只用本目录的 `wrangler.jsonc` 发**（它带 `main: worker.js`）。用任何"纯静态资源"配置去发同一个 Worker，脚本会被抹掉：页面还在，但 `/mcp`、`/health`、`/v1/*` 全部 404，OKX 那边的 MCP endpoint 直接不通。两次都是这么坏的。
2. **只从 `main` 发，合并后再发**。不要从有未提交改动的工作副本发：线上会出现一份仓库里不存在的文件，下次谁发都会把它覆盖掉。
3. **一个人发一次**：本地跑过 `wrangler dev` 验证再发；发完立刻核对（下面的命令）。

## 发布步骤

```sh
git checkout main && git pull --ff-only
cloudflare/build.sh                      # -> cloudflare/dist；把 HTML 里残留的 sterlingai.xyz 改成 .net，缺关键文件会报错
cd cloudflare && npx wrangler@4 dev --port 8788 --local &   # 本地验证：/ /terminal /treasury/ /discord/ 200，/nope 404，/health 返回后端 JSON
npx wrangler@4 deploy                    # 输出末尾应有 sterlingai.net / www.sterlingai.net (custom domain) 和 Current Version ID
```

## 发布后核对

```sh
for u in / /terminal /treasury/ /discord/ /health /v1/manifest /nope; do printf '%-16s ' "$u"; curl -s -o /dev/null -w '%{http_code}\n' "https://sterlingai.net$u"; done   # 前六个 200，/nope 404
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://sterlingai.net/terminal              # 301 https://sterlingai.net/terminal
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://www.sterlingai.net/treasury/         # 301 https://sterlingai.net/treasury/
curl -s -o /dev/null -w '%{http_code} %{content_type}\n' -X POST https://sterlingai.net/mcp \
  -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'   # 200 text/event-stream
```

部署后头几秒边缘缓存可能还回旧页面（`cache-control: max-age=0, must-revalidate`），核对时多等几秒再抓。

## 国库页的节奏

`/treasury/` 由 kk 的刷新 bot 从 `sterling-asp` 渲染后提交到本仓库 `main`（合并 sterling-asp 的 PR 后通常 20 到 30 分钟）。所以 sterling-asp 那边合并了，要**等 bot 把新页面提交到 main**，再从 main 发；页面上的数字之后由页面自己每 10 分钟从 `treasury-data` 分支拉 `portfolio.json` 刷新，不需要为数字变化重新部署。

## 回滚与排查

```sh
npx wrangler@4 versions list --name sterlingai    # 谁在什么时候发了什么
npx wrangler@4 rollback --name sterlingai         # 回到上一个版本
```

zone 上开着 Always Use HTTPS 和 www→apex 的 Redirect Rule，所以就算脚本被抹掉，跳转也不会坏；坏的只会是 API 代理。zone 设置只有账号所有者能改。

## 其他注意

- `index.html` 里的 `og:url` / `og:image` 仍指向已停放的 `sterlingai.xyz`，`build.sh` 在构建时改写成 `.net`，源文件不动。
- `assets.run_worker_first: true` 不能去掉，否则资源路径绕过 `worker.js`，代理和跳转都失效。
- 本地 `wrangler dev` 下 `worker.js` 靠 `cf-visitor` 头判断 http/https，本地没有这个头所以直接出页面；生产由 Cloudflare 边缘补上。
- GitHub Pages（haltwin.github.io）仍从 `main` 构建同一批文件，和 sterlingai.net 互不影响。
