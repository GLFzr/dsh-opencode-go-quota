# dsh-opencode-go-quota

OpenCode Go 额度圆环 —— DSH Web 的持久化插件。

在聊天输入框**模型选择器左侧**显示一个 22px 进度圆环：

- 中央字母 **5 / W / M**，点击循环切换 5小时 / 每周 / 每月 用量窗口
- 悬停显示「5小时 已用 X% · 重置倒计时」
- 颜色按紧急程度：绿 &lt;30% / 蓝 30-60% / 橙 60-80% / 红 ≥80%
- 每 5 分钟自动刷新，点击切换时若数据超过 1 分钟则强制刷新
- **额度告急（≥80%）时圆环红色脉冲闪烁**，悬停提示「⚠ 5小时额度即将用尽，建议暂停等重置」

## 对话内额度提醒（Codex CLI 式）

每次 agent 请求时，插件会把**当前额度状态动态注入 system prompt**：

agent 请求时插件会把额度状态动态注入 system prompt，**只在进入新档位时注入一次**（同档内后续请求不重复，prompt 前缀稳定、省 token、利于缓存命中）：

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

- Host 端通过 `node -`（stdin 脚本）读取 `~/.local/share/opencode/auth.json` 的 `opencode-go.key`
- 调用官方接口 `GET https://opencode.ai/zen/go/v1/usage`（Bearer 鉴权）
- 结果经 `/ocg-quota/usage` 路由（`cacheTtl` 秒节流缓存，响应含 `thresholds`）提供给浏览器端与 prompt 注入

## 安装

```bash
# 本地路径安装
dsh plugin --profile web add <本目录绝对路径>

# 或直接从 GitHub 安装
dsh plugin --profile web add github:GLFzr/dsh-opencode-go-quota

# 重启 dsh web 后生效
```

## 卸载

```bash
dsh plugin --profile web remove dsh-opencode-go-quota
```

## 许可

BSD-3-Clause
