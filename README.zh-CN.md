# dsh-notion-knowledge

[English](README.md) | 中文

`dsh-notion-knowledge` 是用于在 Web profile 中搜索和读取企业 Notion 知识的 DeepSeek Harness 组合包。`0.1.0-rc.1` 是候选版本：配置和包兼容性在 `0.1.0` 前可能发生变化。该组合包维护本地 SQLite 索引，提供 `notion_search`、`notion_read` 模型工具以及 `/notion-sync`、`/notion-status` 命令。索引只读，不会写回 Notion。

## 要求

- Node.js `^22.19.0 || >=24.0.0`
- DeepSeek Harness `>=0.1.0-rc.5 <0.2.0`
- 由 `credentialRef` 引用的 Notion 集成令牌

## 安装

把已发布组合包安装到 Web profile：

```sh
dsh plugin --profile web add dsh-notion-knowledge
```

若使用本地 checkout，请把同一命令的包名替换为 checkout 路径。该包声明了 `dsh.bundle.patch`，因此 profile 会在现有 Web 组合包之后追加其 patch。

## 快速开始

1. 通过 DSH 凭据界面或环境变量把 Notion 集成 token 保存到 `NOTION_API_KEY` 凭据引用。
2. 把组合包安装到 Web profile：

   ```sh
   dsh plugin --profile web add dsh-notion-knowledge
   ```

3. 在 profile 的 `cordis.patch.yml` 中配置 `notion-knowledge` 行。把下面的 URL 换成你要作为根范围的 Notion 页面 URL：

   ```yaml
   - id: notion-knowledge
     name: dsh-notion-knowledge
     config:
       credentialRef: NOTION_API_KEY
       rootPages:
         - https://www.notion.so/<workspace>/<page-title>-<page-id>
   ```

4. 启动 profile，运行 `/notion-sync`，再运行 `/notion-status`。首次同步成功后，模型即可使用搜索和读取工具。

## 配置

组合包插入 `rootPages: []` 的 `notion-knowledge` 配置行。空根页面列表是唯一的未配置状态，只注册 `/notion-sync` 和 `/notion-status`。配置 `rootPages` 后，还会注册 `notion_search`、`notion_read` 以及系统提示段落。Cordis patch 会替换整个 `config`，不会合并其中的字段，因此后续 profile patch 必须配置完整的配置行。

| 字段 | 默认值 | 含义 |
|---|---:|---|
| `credentialRef` | `NOTION_API_KEY` | Notion 集成令牌的 DSH 凭据引用。 |
| `rootPages` | `[]` | 根页面 UUID 或 HTTPS Notion 页面 URL；值会规范化并按 UUID 去重。 |
| `indexPath` | `$DSH_HOME/knowledge/notion.sqlite` | 解析后的 SQLite 索引路径。 |
| `baseUrl` | `https://api.notion.com` | Notion API origin；生产配置必须使用 HTTPS。 |
| `staleAfterMinutes` | `60` | 索引内容变为陈旧内容的时间。 |
| `maxStaleHours` | `24` | 刷新失败后仍可提供的索引内容最大年龄。 |
| `searchMaxResults` | `8` | 搜索结果数量上限。 |
| `snippetChars` | `600` | 搜索摘要字符数上限。 |
| `readMaxLines` | `200` | 单次读取返回的行数上限。 |
| `readMaxChars` | `30000` | 单次读取返回的字符数上限。 |
| `maxPageChars` | `2000000` | 单个页面的索引字符数上限。 |
| `maxCatalogItems` | `50000` | 单个目录允许的条目数上限。 |
| `requestTimeoutMs` | `60000` | 单次 Notion API 请求超时。 |
| `syncConcurrency` | `2` | 并发同步 worker 数量。 |
| `requestsPerSecond` | `3` | Notion API 请求总速率。 |

`baseUrl` 只接受 origin，不允许凭据、路径、查询参数或 fragment。所有数值字段都必须是正安全整数。`staleAfterMinutes` 换算后的秒数必须小于 `maxStaleHours`。无效配置会阻止插件加载。包导出 Notion API 版本常量 `2026-03-11`；Notion SDK transport 会在每次请求时使用该常量。

## 本地索引开发

包导出 `openIndexStore(indexPath)`，作为独立的本地 API。该模块使用 Node 内置的 `node:sqlite`，保存状态、页面 Markdown 与元数据以及 FTS5 投影。页面写入、更新、删除和完整目录裁剪在同一事务内同步页面行与 FTS 行。搜索和受限行读取只访问此本地数据库，不请求 Notion。

格式由 SQLite `application_id` `0x4453484e`（`DSHN`）和 `user_version` `1` 标识。每个可写连接都启用外键，并使用 `DELETE` journal 和 `FULL` 同步。在 POSIX 系统上，新父目录使用 `0700`，数据库文件使用 `0600`；已有最终父目录必须属于当前用户，且不得允许 group 或 world 写入，由当前用户控制的 `0755` 父目录会在不 chmod 的情况下使用。parent 路径中的每个目录项还必须受属于 root 或当前用户的所在目录保护，不能被重命名。若所在目录允许 group 或 world 写入，它还必须带 sticky bit，且子目录必须属于当前用户。parent 路径中的符号链接或 junction、有多个 hard link 的数据库文件，以及非普通文件或有多个 hard link 的当前 SQLite sidecar 都会被拒绝。Windows 的机密性依赖当前用户的 DSH home ACL 和 BitLocker 等主机磁盘加密；此 RC 不管理 Windows ACL。

含有 schema 或数据但未声明归属的数据库、其他非零 application ID 的数据库、损坏内容和非 SQLite 内容都会被拒绝，文件内容与权限保持不变。索引只包含派生数据，因此属于本插件但版本不兼容或 schema 不完整的索引会被重建。replacement 会先在同父目录的私有目录中完成初始化与 integrity check，再清理精确 sidecar 并原子安装；构建或安装失败会保留旧主数据库。存在 hot rollback journal 时，store 会先在私有副本中恢复并执行 integrity check，恢复失败不会修改原文件。正常的当前 schema 打开只验证归属和 schema 对象白名单，不执行全库扫描。

FTS5 使用 `unicode61` 和 store 生成的普通词/CJK 投影，因此 `版本2`、`中文ABC` 等相邻混排文本可以检索。CJK 双字通过 Unicode Script Extensions 识别 Han、Hiragana、Katakana 和 Hangul，保留日文长音符，并在标点或普通文本处结束 run。查询文本先分词，再作为参数传给 `MATCH`，不接受原始 FTS 操作符。普通 token 与 CJK 双字 token 各自使用 AND 语义；混合查询必须同时满足两组，BM25 使用 `5:1` 的标题与正文权重，同分时按页面 ID 稳定排序。返回的页面对象不暴露内部 token 列。

本地 store 不拉取、清洗或鉴权 Notion 内容；同步层负责这些来源和范围检查。当前的格式归属和重建规则见[架构文档](docs/architecture.zh-CN.md#本地索引)。

## Notion 同步

配置 `rootPages` 后，运行 `/notion-sync` 创建或刷新本地索引。该命令每次运行都从 `credentialRef` 解析凭据，验证 token 身份，枚举页面和 data source，筛选配置根页面及其后代，并为新增或变更页面保存清洗后的 Markdown。失败或不完整的目录绝不会删除已有索引页面。`/notion-status` 只报告本地索引事实，不暴露 token 或绝对索引路径。

搜索和读取工具只查询本地索引。结果和正文属于普通模型可见内容，因此会进入标准 DSH session log。Notion 内容只是数据而非指令；组合包提示会要求模型在引用 Notion 材料时引用返回的页面 URL。

## 开发

```sh
pnpm install
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run build
```

npm 包包含预构建的 `lib/` 产物；安装过程不会编译 TypeScript。

## Roadmap

- 增加引导式初始化命令（`dsh plugin` 或小脚本），用少量交互代替手写 profile patch。
- 增加可选的真实 API 验收套件；未提供 `NOTION_API_KEY` 和 `NOTION_TEST_ROOT_PAGE` 时自动跳过。

## 许可证

[MIT](LICENSE)
