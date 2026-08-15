# Changelog

## [0.3.1] - 2026-08-15

### 修复

- **Prompt 注入不再依赖浏览器轮询**：system prompt 求值时若用量缓存缺失或过期，会在后台自动刷新（并发去重）。GUI 未打开（headless / API 会话）时额度提醒也能正常生效。
- **瞬时失败不再清空提醒记忆**：用量接口临时失败（网络/401/404 等）时保持静默且保留已提醒档位，恢复后不会重复提醒同一档；仅窗口重置（真实回落至警示阈值以下）才清除记忆。
- **阈值配置合法性检查**：`warnAt < criticalAt < escalateFrom` 不成立时打印 console.warn，避免档位阶梯被静默压平（如 75%/85% 全判为 0 档）。
- **`readBody` 超限响应修复**：请求体超过 4KB 上限时改为排空请求流并正常返回 400，此前 `req.destroy()` 会掐断连接，客户端收到的是 ECONNRESET。
- **圆环键盘可达性**：增加 `role="button"` / `tabIndex` / `aria-label`，支持 Enter / Space 切换 5h / 周 / 月窗口。
- **标签页唤醒刷新**：后台标签页唤醒且数据超过 1 分钟时强制刷新，不再展示过期额度。
- **README**：许可统一为 MIT（与 LICENSE、package.json 一致），删除重复段落。
- **CI 跨平台**：测试命令改为 `node --test "tests/*.test.mjs"`，修复 Windows 下 `node --test tests/` 目录参数失败的问题。

### 测试

- 新增 host 半测试 `tests/index.test.mjs`：路由注册、用量归一化、缓存 TTL、强制刷新、错误映射（404/401/403/5xx/子进程退出）、405/400、档位状态机、无数据记忆保留与 headless 自刷新回归、自定义阈值下发。全量 **21/21 通过**。

## [0.3.0] - 2026-08

- 新增 GitHub Actions CI（node --check + node --test）。
- 宿主错误日志与可配置 `cacheTtl`。
- 浏览器 console 调试日志（用量加载失败时）。
- 文档：`cacheTtl` 与错误行为说明。

## [0.2.0] - 2026-08

- 额度分级提醒（Codex CLI 式）：60% 注意 / 80% 告急 / 90% 起每 2% 递进一档，每档仅注入一次。
- 按窗口警示阈值（周 / 月圆环分别警示）。
- `lib/usage-text.js` 提示文案模块与对应单测。
