# dsh-opencode-go-quota

OpenCode Go 额度圆环 —— DSH 的持久化插件，**Web 与桌面端（DSH Desktop）通用**。

在聊天输入框**模型选择器左侧**显示一个 22px 进度圆环：

- 中央字母 **5 / W / M**，点击循环切换 5小时 / 每周 / 每月 用量窗口
- 悬停显示「5小时 已用 X% · 重置倒计时」
- 颜色按紧急程度：绿 &lt;30% / 蓝 30-60% / 橙 60-80% / 红 ≥80%
- 每 5 分钟自动刷新，点击切换时若数据超过 1 分钟则强制刷新
- **额度告急（≥80%）时圆环红色脉冲闪烁**，悬停提示「⚠ 5小时额度即将用尽，建议暂停等重置」

## 配合 dsh-token-ledger 使用

额度（钱）与 token 用量是两回事：本插件回答「还剩多少额度」，
[dsh-token-ledger](https://github.com/GLFzr/dsh-token-ledger) 则逐请求记录
真实的**输入 / 输出 / 缓存命中 token 数**（会话顶部「用量」页，堆叠柱状图，
支持按请求/按小时/按天/按轮次查看）。两个插件可同时安装、互不依赖：
额度圆环在输入框左侧，token 用量在「用量」页。

## 对话内额度提醒（Codex CLI 式）

每次 agent 请求时，插件会把**当前额度状态动态注入 system prompt**，**只在进入新档位时注入一次**（同档内后续请求不重复，prompt 前缀稳定、省 token、利于缓存命中）：

| 5小时用量 | 行为 |
|---|---|
| <60%（warnAt） | **不注入**（零 prompt 成本） |
| 60%-79% | 注入一次：注意档——建议在合适节点提醒用户、暂停待恢复 |
| 80%-89% | 注入一次：告急档——主动提醒、任务边界暂停 |
| 90% 起 | **每增长 2% 递进一档**（90/92/94/...），措辞紧急程度递增：严重 → 濒临耗尽 → 即将耗尽 → 几乎耗尽 → 近极限 → 已用尽（100%），每档只提醒一次 |

窗口重置回 60% 以下后，升档记忆自动清除，下次爬升会重新按档提醒。

阈值可通过 cordis.yml 配置（`warnAt` / `criticalAt` / `escalateFrom` / `escalateStep`，默认 60 / 80 / 90 / 2；`cacheTtl` 为用量缓存秒数，默认 60；`weeklyWarnAt` / `monthlyWarnAt` 为周/月圆环警示阈值，默认 90 / 95）：

```yaml
- id: dsh-opencode-go-quota
  config:
    warnAt: 60
    criticalAt: 80
    escalateFrom: 90
    escalateStep: 2
    cacheTtl: 60
    weeklyWarnAt: 90
    monthlyWarnAt: 95
```

数据不可用（无 key / 接口失败）时注入为空，不产生 prompt 噪声；圆环显示灰色 `!`，悬停可见错误原因，宿主进程与浏览器控制台均有调试日志。

## 数据来源

- Host 端通过 `node -`（stdin 脚本）读取 `~/.local/share/opencode/auth.json` 的 `opencode-go.key`（环境变量 `OPENCODE_GO_API_KEY` 优先；auth.json 容忍 UTF-8 BOM，文件缺失 / 解析失败 / 无 key 分别报错）
- 调用官方接口 `GET https://opencode.ai/zen/go/v1/usage`（Bearer 鉴权）
- 结果经 `/ocg-quota/usage` 路由（`cacheTtl` 秒节流缓存，失败结果按 `errorCacheTtl` 秒短缓存，默认 5；响应含 `thresholds`）提供给浏览器端与 prompt 注入

## 安装

### DSH Desktop（桌面端）

桌面端自带的 `dsh` CLI 是唯一能管理 `desktop` profile 的入口（该 profile 禁止用 CLI 直接启动）：

```powershell
# Windows：用安装目录里的 CLI，把插件装进 desktop profile
& '<安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add <本目录绝对路径>
# 或直接从 GitHub 安装
& '<安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add github:GLFzr/dsh-opencode-go-quota
```

然后**完全退出并重启 DSH Desktop**：插件行在启动时装配，热装载不生效。

### DSH Web

```bash
# 本地路径安装
dsh plugin --profile web add <本目录绝对路径>

# 或直接从 GitHub 安装
dsh plugin --profile web add github:GLFzr/dsh-opencode-go-quota

# 重启 dsh web 后生效
```

## 卸载

```bash
dsh plugin --profile <web|desktop> remove dsh-opencode-go-quota
```

## 常见问题

### 圆环显示灰色感叹号（宿主报 shell failed / windows-acl-run ...）

插件需要宿主 shell 能运行子进程。DSH 的 Windows ACL 沙箱要求
`sandbox-policy.workspaceRoot` 不包含系统 TEMP 目录。

- **桌面端**：workspace 根默认是 `~/.dsh/profiles/desktop`，本身不含 TEMP，通常无需处理；
  若系统 TEMP 被改到该目录下，按下面的方式固定 workspaceRoot。
- **Web 端**：workspace 根默认取 `dsh web` 的启动目录，从用户主目录等位置启动即会触发（插件会显示友好提示）。

解决：在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 固定 workspace 根目录：

    - id: sandbox-policy
      config:
        workspaceRoot: <你的 workspace 绝对路径>

然后重启 DSH。Web 端也可临时改为在 workspace 目录内启动 `dsh web`。

### 一直提示 "opencode-go key not found"

- 检查 `~/.local/share/opencode/auth.json` 是否存在且含 `opencode-go.key`（已登录 OpenCode Go 即自动生成）；
- 或设置环境变量 `OPENCODE_GO_API_KEY`（优先于 auth.json）后重启 DSH；
- auth.json 带 UTF-8 BOM 或损坏也会导致取 key 失败（0.3.2 起已容忍 BOM 并区分错误）。

### 本地 `link:` 安装时如何改代码即生效

profile 的**配置**变更（`package.json` / `cordis.patch.yml`）本来就会触发热重载，**但模块热重载默认关闭**：
`dsh-base` 里 `hmr` 这一行的配置是 `root: []`（"Profile configuration reloads by default; module roots are opt-in"），
且默认 `ignored` 含 `**/node_modules` —— 插件经 `link:` 挂在 `node_modules` 下，源码改动不会被监听。

把插件的真实目录加进 `root`，之后改 `lib/*.js` 就会在运行中的 DSH 里重新 import 并重载该插件（免重启）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: hmr
  config:
    base: 'file:///<盘符>:/<插件父目录>'   # 必须是 file: URL
    root:
      - '<插件绝对路径>'
```

`base` 是监听基准目录：相对它计算出的路径若带 `../..` 段，会被默认 `ignored` 里的 `**/.*` 当成点开头目录匹配掉、改动被静默忽略。
另外 `new URL(config.base, ctx.baseUrl)` 会把裸写的 `E:/x` 里的 `E:` 解析成协议，所以必须写 `file:///E:/x`。

## 兼容性

宿主 shell 执行器在 DSH 0.2 由 `ShellExecutor.run(spec)` 改为 `execute(spec)`
（返回句柄，`handle.result()` 才携带退出码与输出）。插件同时支持两代 API，
0.1.x 与 0.2+（含桌面端）均可运行。

## 许可

MIT
