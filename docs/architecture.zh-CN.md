# 架构

## 本地索引

本地索引是 `src/index-store/` 导出的文件型同步 SQLite 模块。`IndexedPage` 输入把 provider 获取和规范化与持久化分开，读取 API 则把本地检索与面向模型的展示分开。store 保存记录，并提供本地搜索、页面元数据、裁剪和受限读取；它不发起网络请求、不决定 Notion 范围、不校验页面 UUID，也不清洗 provider 内容。

### 数据与事务

`state` 保存供后续凭据绑定、范围和同步 cursor 使用的文本 key/value 元数据。`pages` 保存 opaque 页面 ID、标题、URL、provider 编辑时间、Markdown、不完整标记、内容 hash 和索引时间。`pages_fts` 保存来源标题和 Markdown，并为普通词及 CJK 双字分别保存标题和 Markdown 投影；page ID 列不参与分词。FTS 表的固定 shadow table 也属于本索引 schema。

每次插入或内容更新都在一个 immediate 事务中写入 `pages` 与 `pages_fts`。更新先删除旧 FTS 行，再插入新行。页面删除和完整目录裁剪在同一事务中删除两种表示。未变化的 upsert 保留原 `indexed_at`。空裁剪保留集合会明确删除全部已索引页面。

### 格式归属与权限

数据库格式使用 `application_id` `0x4453484e`（四字节 ASCII `DSHN`）和 `user_version` `1`。进入可写打开前，分类过程读取固定 SQLite header，并通过只读连接查询文件。正常的当前 schema 打开只检查归属、版本、完整 schema 和对象白名单，不扫描数据库的每一页。若 owned header 带有 hot rollback journal，且 SQLite 返回 `SQLITE_READONLY_ROLLBACK`，分类过程会把主文件和普通文件类型的 sidecar 复制到同父目录的私有临时目录，在副本中完成恢复，并在接受其 application ID、版本和 schema 前执行完整 integrity check。恢复失败不会改变原主文件、sidecar 或权限；sidecar 符号链接和其他非普通文件不会被跟随。非零外部 application ID、application ID 为零但含有 schema 的数据库，以及无法确认 SQLite 或插件归属的文件都会在 chmod 或替换前失败。

store 拒绝 index parent 路径中的符号链接和 junction。在 POSIX 系统上，每个路径目录项都必须受属于 root 或当前用户的所在目录保护，不能被重命名。若所在目录允许 group 或 world 写入，它还必须带 sticky bit，且子目录必须属于当前用户。创建缺失子目录前会先执行这些检查。新父目录使用 `0700`；已有最终父目录必须属于当前用户，且不得允许 group 或 world 写入；由当前用户控制的 `0755` 最终父目录仍然有效且不会被修改。数据库文件使用 `0600`，主数据库必须是只有一个 hard link 的普通文件。分类过程记录主文件的 device 和 inode，并对精确的 `-journal`、`-wal` 和 `-shm` 路径身份创建快照。当前索引进入可写打开前，store 会复验 parent、主数据库和完整 sidecar 集合；每个已有 sidecar 都必须保持为同一个只有一个 hard link 的普通文件。替换前的同一快照会拒绝 sidecar 出现、消失或身份交换；精确 unlink 清理仍可在不跟随链接的前提下移除身份未变的 dangling sidecar。每个可写连接都验证 `foreign_keys=ON`、`journal_mode=DELETE`、`synchronous=FULL`、归属标识和 schema。schema 校验覆盖 owned table 定义、列类型与约束、STRICT 与 WITHOUT ROWID、内容标记 CHECK、未索引的 FTS page ID、`unicode61` tokenizer、固定 FTS5 shadow table，以及不存在未知 table、index、view 或 trigger。受限的只读 row ID probe 还会验证 FTS5 能否使用这些 shadow object 构造虚表。

Windows 不把 POSIX mode bit 作为机密性保证。索引依赖当前用户的 DSH home ACL 和 BitLocker 等主机磁盘加密；v1 不创建或管理 Windows ACL。

### 重建策略

数据库是派生索引，不是 Notion 内容的来源。属于本插件但 schema 版本不同或 version 1 schema 不兼容的数据库会被替换，而不是迁移。版本不同或 schema 元数据不兼容的候选在获得替换授权前会执行完整 integrity check。若 application ID 与主 FTS 定义精确匹配，但受限 operational probe 无法构造 FTS 虚表，该失败探针会直接把派生索引分类为可重建；损坏的虚表会阻止 integrity check 本身，因此不会尝试全库扫描。随后，初始化在同父目录的随机私有临时目录中构建完整数据库，关闭后再只读打开，验证归属、schema 和完整 integrity。只有这些检查通过后，store 才会复验路径身份、删除已确认 owned index 的精确 `-journal`、`-wal` 和 `-shm` 路径，并通过 rename 原子替换最终路径。清理依据路径元数据，不跟随符号链接，因此也会移除 dangling sidecar link。构建、验证、身份、sidecar 或 rename 任一环节失败时，旧主数据库都会保留。重建不使用 glob 或递归删除。

### 搜索与 CJK token

FTS5 使用 `unicode61`，但搜索只匹配 store tokenizer 生成的投影，因此 `版本2`、`中文ABC` 和 `企业Knowledge图谱` 等相邻混排文本在索引与查询时具有相同 token 边界。纯 tokenizer 通过 Unicode Script Extensions 识别 Han、Hiragana、Katakana 和 Hangul，保留日文长音符等文本延续字符，并在每个连续 run 内生成重叠的双 Unicode code point token。单 code point run 不生成伪双字，标点或普通文本会结束 run。普通词与 CJK token 的标题和 Markdown 投影分别存放，使 BM25 可以使用 `5:1` 的标题与正文权重。页面 API 不返回内部投影。

搜索不会把输入 query 直接作为 FTS 语法。它在排除 CJK code point 后提取小写拉丁与数字词，另行生成 CJK 双字，对 token 加引号，把两组分别限定到各自的两个投影列，并将完整表达式作为 `MATCH` 参数绑定。同组 token 使用 AND，混合 query 必须同时满足两组；rank 相同时按 page ID 稳定排序。snippet 从已保存 Markdown 的最早匹配附近确定，并按 Unicode code point 限长。

### 受限读取

页面读取把 CRLF、CR 和 LF 切分为逻辑行，并返回以 LF 连接的窗口。行数与 Unicode code point 预算都会严格执行。末尾的一个换行符不会产生虚构行。若一个逻辑行本身超过字符预算，store 返回其受限前缀、标记 `lineTruncated`，并把 `nextStartLine` 推进到下一真实行，避免重复返回该截断行。内容清洗仍由同步层负责。
