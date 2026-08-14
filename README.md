# dsh-opencode-go-quota

OpenCode Go 额度圆环 —— DSH Web 的持久化插件。

在聊天输入框**模型选择器左侧**显示一个 22px 进度圆环：

- 中央字母 **5 / W / M**，点击循环切换 5小时 / 每周 / 每月 用量窗口
- 悬停显示「5小时 已用 X% · 重置倒计时」
- 颜色按紧急程度：绿 <30% / 蓝 30~60% / 橙 60~80% / 红 ≥80%
- 每 5 分钟自动刷新，点击切换时若数据超过 1 分钟则强制刷新

## 数据来源

- Host 端通过 `node -`（stdin 脚本）读取 `~/.local/share/opencode/auth.json` 的 `opencode-go.key`
- 调用官方接口 `GET https://opencode.ai/zen/go/v1/usage`（Bearer 鉴权）
- 结果经 `/ocg-quota/usage` 路由（60 秒节流缓存）提供给浏览器端

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
