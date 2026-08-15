# Notion Enterprise Knowledge v1 实施计划

## 目标与交付方式

本仓库交付一个可安装到 DeepSeek Harness Web profile 的只读 Notion 企业知识 Bundle。六个任务各自执行严格的 RED → 最小实现 → GREEN，并以独立提交结束；不得把后续能力压入较早提交，也不得修改 Harness 主仓。

## 固定配置

| 字段 | 默认值 | 加载约束 |
|---|---:|---|
| `credentialRef` | `NOTION_API_KEY` | 合法 DSH credential ref。 |
| `rootPages` | `[]` | UUID 或 Notion 页面 URL；加载时规范化并去重。空数组是唯一未配置状态。 |
| `indexPath` | `$DSH_HOME/knowledge/notion.sqlite` | 通过 DSH home-paths 解析为实际路径。 |
| `baseUrl` | `https://api.notion.com` | 生产配置只允许 HTTPS；显式测试解析入口只允许 loopback HTTP。 |
| `staleAfterMinutes` | `60` | 正安全整数。 |
| `maxStaleHours` | `24` | 正安全整数，且 `staleAfterMinutes * 60 < maxStaleHours * 3600`。 |
| `searchMaxResults` | `8` | 正安全整数。 |
| `snippetChars` | `600` | 正安全整数。 |
| `readMaxLines` | `200` | 正安全整数。 |
| `readMaxChars` | `30000` | 正安全整数。 |
| `maxPageChars` | `2000000` | 正安全整数。 |
| `maxCatalogItems` | `50000` | 正安全整数。 |
| `requestTimeoutMs` | `60000` | 正安全整数。 |
| `syncConcurrency` | `2` | 正安全整数。 |
| `requestsPerSecond` | `3` | 正安全整数。 |

所有 Notion 请求固定发送 API 版本 `2026-03-11`。无效配置在插件加载时失败，不延迟到首次调用。

## 任务 1：工程骨架与 Bundle 装配

初始化独立 Git 仓库、严格 TypeScript、Vitest、ESLint、tsdown、GitHub CI、MIT License 和双语 README。npm 包发布预构建产物，安装时不执行源码构建；运行依赖限定为 `@notionhq/client` 与 `p-queue`，DSH API 通过 peer dependencies 绑定 `>=0.1.0-rc.5 <0.2.0`，Cordis 绑定 4.x。

`cordis.patch.yml` 作为 Web profile 后置 Bundle 层插入插件行，并声明 `credentials`、`commands`、`tools`、`systemPrompt` 注入。Config 公共接口一次定义完整；manifest、patch、默认值、规范化和跨字段约束由单元测试覆盖。真实 Cordis/Loader 测试启动并停止空配置插件，证明 `rootPages: []` 不注册工具、系统提示或命令。

提交：`chore: scaffold DSH Notion knowledge bundle`。

## 任务 2：安全 SQLite 索引

使用 `node:sqlite` 建立派生索引，固定专属 `application_id`、`user_version=1`、`foreign_keys=ON`、`journal_mode=DELETE`、`synchronous=FULL`，并创建 `state`、`pages`、`pages_fts`。新建父目录权限为 `0700`，数据库文件权限为 `0600`；现有路径权限不被静默改写。

FTS 使用 `unicode61` 处理拉丁文本，并为连续 CJK 文本生成重叠双字 token。普通查询词和 CJK token 各自使用 AND 语义，候选结果通过 BM25 合并。属于本插件但格式不兼容的数据库可重建，因为索引是派生数据；其他应用的数据库必须拒绝覆盖。

提交：`feat: add secure local knowledge index`。

## 任务 3：Notion 身份、范围和同步

每次操作都通过 `ctx.credentials` 重新解析 credential，token 不缓存、不记录。数据库保存随机盐派生的 token HMAC 绑定；token、workspace 或根页面指纹变化时，旧索引停止查询，并在新同步写入前清理旧范围。`users.me` 记录 `workspace_id`、主体 ID 和显示名。PAT 与内部集成都使用同一 Bearer 请求实现。

同步分页枚举 page 与 data source，补齐 database 父节点，并沿递归父链判断是否属于配置根页面的后代。任何根页面不可访问都会使整次同步失败。只有新页面或 `last_edited_time` 变化的页面重新拉取 Markdown。入库前清除预签名媒体 URL、NUL 和危险控制字符；超过 `maxPageChars` 的正文截断并标记 `content_incomplete`。

只有目录枚举完整且没有致命失败时，同步才删除已移出范围、进入回收站或撤权的页面，并推进 `last_success_at`。目录、网络或页面处理部分失败时保留旧内容且不误删。未知 block、超长行、超大页面和取消路径由确定性测试固定为数据安全的结果。

提交：`feat: sync scoped Notion page content`。

## 任务 4：搜索、读取与提示安全

先覆盖英文、中文双字、混合查询、FTS 转义、排序、片段和读取边界，再实现 `notion_search` 与 `notion_read`。两个工具只读取本地索引，不在模型调用路径访问 Notion。索引缺失、绑定变化或超过最大陈旧时间时返回可操作错误。

`notion_search({ query })` 要求至少两个非空白 Unicode 字符。每项结果返回 `page_id`、`title`、`url`、`snippet`、`last_edited_time`、`content_incomplete`；顶层返回 `truncated`、`synced_at`、`stale`。

`notion_read({ page_id, start_line = 1 })` 返回页面元数据、受 `readMaxLines` 和 `readMaxChars` 限制的正文窗口、总行数、下一窗口位置、同步时间与完整性状态。正文使用明确的不可信数据边界，不能作为系统或用户指令解释。

系统提示声明 Notion 内容是数据而非指令、优先最小检索，并要求回答引用结果中的 Notion URL。工具使用 DSH 通用 search/read 卡片，不冒用 Web 卡片，也不增加自定义 UI。工具结果进入 DSH Session log；Loader 组合测试证明回放保留 URL 和引用所需字段。

提交：`feat: expose read-only Notion knowledge tools`。

## 任务 5：命令、后台同步和生命周期

`/notion-sync` 启动一次手动同步；同一插件实例只允许一个同步，重复请求返回 `sync-in-progress`。命令支持取消并返回新增、更新、删除、保留和失败的摘要。`/notion-status` 只披露安全状态：是否配置、workspace 身份、根范围、页面计数、上次成功时间、陈旧状态、运行中同步和最近错误；不返回 token 或 Authorization 数据。

首次同步必须由用户手动触发。插件只有在存在成功索引且启动时已经过期时，才非阻塞启动后台同步。卸载或 HMR 依次停止接收新任务、取消队列、等待已开始任务结算、关闭 SQLite，再撤销命令、工具和提示注册。卸载不删除索引；README 要求停止 Host 后再人工清理文件。

提交：`feat: add Notion sync commands and refresh lifecycle`。

## 任务 6：打包、文档和发布

文档覆盖安装、PAT 与内部集成、根页面范围、落盘位置、Session log 披露、撤权清理延迟、磁盘加密依赖和限制，并补充本计划与架构说明。tarball 安装到临时 Web profile 后，验证 `--dump-config`、命令发现、工具发现和卸载。版本先发布 `0.1.0-rc.1`，真实用户验收后再发布 `0.1.0`。

提交：`docs: prepare Notion knowledge bundle release`。

## 错误码

公开工具与命令使用稳定错误码：`not-configured`、`credential-missing`、`index-missing`、`index-stale`、`token-changed`、`scope-changed`、`query-invalid`、`page-not-found`、`sync-in-progress`、`catalog-incomplete`、`provider-failed`。错误消息说明可执行的恢复动作，但不包含 token、Authorization header 或预签名 URL。

## 产品与安全边界

v1 面向单用户本地 Web Host，不支持共享 Host、多租户、OAuth、Webhook、向量检索、Notion 写回或自定义设置 UI。只有第二个 provider 证明共同 Consumer 后，才提炼 `ctx.knowledge` capability seam。

文件机密性依赖目录和文件权限以及 FileVault、BitLocker 等主机磁盘加密；插件不宣称提供应用层加密。返回给模型的 Notion 内容会进入 DSH Session log，启用前必须披露。撤权无法追回已经保存的本地副本；24 小时最大陈旧窗口和下一次完整同步清理只能降低暴露时间。

## 验证命令

每个任务运行与变更范围匹配的聚焦 RED/GREEN 用例，并在提交前通过以下门禁：

```sh
pnpm test
pnpm run test:composition
pnpm run typecheck
pnpm run lint
pnpm run build
pnpm run pack:check
```

## 验收矩阵

- 英文、CJK 与混合正文可检索，范围外页面不进入索引；多层子页面和 data source 正确归属。
- 页面移动、回收站和撤权在完整同步后移除；目录或网络失败不误删旧内容。
- token、workspace 或 root 变化禁止查询旧索引。
- Markdown 截断、未知 block、超长行、超大页、恶意 FTS 输入和取消产生确定结果。
- 数据库、日志和工具结果不包含 token、Authorization header 或预签名媒体 URL。
- 同步并发、后台刷新、HMR 和关闭路径结算完成且无未处理错误。
- Loader 组合证明工具结果进入 Session log，回放保留 URL 和引用字段。
- 可选真实 API 测试读取 `NOTION_API_KEY` 与 `NOTION_TEST_ROOT_PAGE`，只读运行，缺少变量时自跳过。
- 人工验收从临时 Web profile 完成安装、配置、同步、问答、读取和 URL 点击，不修改 Harness 主仓。
