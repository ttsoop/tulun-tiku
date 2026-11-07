# 使用教程：接管 Chrome 采集题库

这套工具（`tools/bank-builder`）不依赖油猴脚本，直接通过 Chrome 调试端口（CDP）操作**你自己的浏览器**，
用的是你已登录的会话，所以不需要处理账号密码和验证码（提交时的滑块/图形码除外，见文末）。

它可以：

- 读取页面上的题目（含超星加密字体）
- 用已有题库 / AI 作答
- 提交并从判分页读反馈，**不及格就带着反馈重答**，直到满分
- 把题目、答案、解析、疑点导出成题库

---

## 一、前置条件

| 项 | 要求 |
|---|---|
| Node.js | ≥ 18（本仓库自带 `node_modules`，用 `node` 直接跑即可） |
| 依赖 | `playwright-core`（已随仓库安装） |
| 浏览器 | Chrome（用**独立配置目录**启动调试端口，登录态会保存在该目录） |
| AI | 任意 OpenAI 兼容接口（DeepSeek / 豆包方舟 / 通义 / Kimi / 本地 Ollama） |

---

## 二、启动可调试的 Chrome

> Chrome 136+ 不允许用默认配置目录开调试端口，必须指定 `--user-data-dir`。

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\ocs-cdp" `
  --new-window "https://i.chaoxing.com"
```

1. 在这个新窗口里**登录超星**（只需登录一次，profile 会记住）。
2. 打开你的课程 → 进入「章节学习」页面（URL 形如 `mooc1.chaoxing.com/mycourse/studentstudy?...`）。
3. 之后工具就是在这个窗口里点目录、点提交，**不要手动关掉它**。

---

## 三、配置 AI

复制一份配置：

```powershell
Copy-Item tools\bank-builder\config.example.json tools\bank-builder\config.json
```

编辑 `tools/bank-builder/config.json`：

```json
{
  "ai": {
    "baseUrl": "https://api.deepseek.com",
    "apiKey": "在这里填入你的 API Key",
    "model": "deepseek-chat"
  }
}
```

也可以用环境变量（优先级更高，避免把密钥写进文件）：

```powershell
$env:OCS_AI_API_KEY = "你的key"
$env:OCS_AI_BASE_URL = "https://api.deepseek.com"
$env:OCS_AI_MODEL = "deepseek-chat"
```

`config.json` 已被 `.gitignore` 忽略，**不会**进 git。

---

## 四、采集

### 1. 先探一探（只读，不点任何东西）

```powershell
node tools/bank-builder/index.mjs probe
```

输出会告诉你：连上了哪个页面、找到几个题目 frame、前几道题长什么样。
如果提示「没找到含题目的页面」，说明当前页没有测验，或 Chrome 没开调试端口。

### 2. 单个测验：先不提交，看看填得对不对

```powershell
node tools/bank-builder/index.mjs run
```

只填答案、不提交，导出为「未验证」题库。适合一次性考试（不能重做）的场景。

### 3. 单个测验：作答 + 提交 + 判分回炉

```powershell
node tools/bank-builder/index.mjs run --submit --rounds 3
```

### 4. 整门课：逐小节遍历

```powershell
node tools/bank-builder/run-all.mjs --submit --rounds 3
```

行为：

- 依次点开目录里每个小节
- 有小节测验 → 已完成的只采集答案；未完成的作答并提交
- 没有测验的小节 → 跳过
- 进度写入 `out/all/state.json`，中途失败可重跑（会接着已采集的继续）

常用参数：

| 参数 | 说明 |
|---|---|
| `--only "6\."` | 只处理名字匹配正则的小节 |
| `--bank "图论章节题库\questions.json"` | 用已有题库当种子，命中就不花 AI |
| `--submit` | 允许提交（**不加只填不提交**） |
| `--rounds 3` | 每个测验最多提交几轮 |
| `--export-only` | 不访问浏览器，直接用 `state.json` 重新导出 |
| `--out 目录` | 导出目录 |

### 5. 打包成可入库的题库

```powershell
node tools/bank-builder/package-bank.mjs
```

打包时会把**题干/选项里的图片下载到 images/**（平台图片需要登录，URL 会失效，必须本地化）。

产物在 `题库/图论全章节题库/`：

```
questions.json   题目 + 答案 + 解析 + 图片路径 + 验证状态 + 疑点
answers.csv      表格版
index.html       离线查看器（含题干图片）
images/          题干图片（打包时自动下载）
README.md        题库说明
```

---

## 五、导入油猴脚本

1. 安装仓库里的 [dist/ocs.user.js](../../dist/ocs.user.js)（或先 `pnpm build` 自行构建）。
2. 打开脚本面板 →「⚙️ 全局设置」→「本地题库（离线）」。
3. 点「导入题库文件」，选择 `题库/图论全章节题库/questions.json`。
4. 勾选「启用本地题库」。之后答题会先查本地题库，命中直接作答（不耗 AI）。

> 匹配方式是「归一化题面 + 选项文本」，所以平台打乱选项顺序也不会答错。
> 连线题（归类题）在脚本里会自动跳过，交给 AI 或人工。

---

## 六、工作原理（为什么这些坑要这么处理）

| 现象 | 原因 | 工具怎么处理 |
|---|---|---|
| 题面显示成「忬列忩项…」 | 超星加密字体，只有渲染出的字形是对的 | 注入 `font-decrypt` 打包件，canvas 渲染字形 + 特征表比对还原明文 |
| 界面看着选中了，提交却是旧答案 | 提交读的是隐藏域 `#answer<qid>`，不是 `aria-checked` | 点完选项后同步隐藏域（判断题写 `true/false`） |
| 点「提交」没反应 | 「确认提交？」弹窗在**父页面**，不在 iframe 里 | 在父页面找可见 `.popDiv` 点「提交」 |
| 提交后仍显示「未达到及格线，请重做」 | 那是上一次的结果页；重做要先确认弹窗 | 自动点「确定」进入新一次作答 |
| 题目数量比页面少 | 题面相同、选项不同的题被当成同一题 | 去重键 = 题面 + 选项 |
| 刷新后页面跳到个人空间 | 超星偶发重定向 | 每次切换小节前检测，必要时重新打开课程页 |

---

## 七、常见问题

| 症状 | 处理 |
|---|---|
| `没找到含题目的页面` | Chrome 没带 `--remote-debugging-port` 启动，或当前页没有测验 |
| `CDP 连接超时` | 浏览器卡死或弹了原生对话框；关掉标签页重开 Chrome（profile 里有登录态） |
| 提交时弹出图形/滑块验证码 | 工具无法自动识别：这时手动在浏览器里完成验证码，再重新运行 |
| 一直「未达到及格线」 | 用 `--verbose` 看逐题判定；也可能是题库答案与当前页面选项顺序不匹配 |
| 导出题数是 0 | 该小节没有测验；或 `state.json` 被删了（重跑即可） |
| AI 报 401/超时 | 检查 `config.json` 的 `apiKey` / `baseUrl` / `model` |

---

## 八、注意事项

- **只对允许重做的章节测验/作业有意义**。一次性考试请只跑 `run`（不提交），由你自己决定是否交卷。
- 反复提交会在教师端留下记录；超星一般限制提交次数（页面上 `#limitWorkSubmitTimes`）。
- 采集过程会**真实提交**到你的账号，请确认课程允许重做再使用 `--submit`。
- 题库产物中的 `verified` 表示平台判分确认过；`flags` 标记疑点（未验证、答案冲突、部分分等）。


---

## 九、脚本自测（可选）

想验证「油猴脚本能不能在本机启动」而不动真实账号，可以跑冒烟测试：

```powershell
node tools/bank-builder/mock/smoke-userscript.mjs
```

它会用最小 GM 桩把 `dist/ocs.user.js` 注入一个真实超星页面（只读，不点任何按钮），
然后检查：`OCS` 是否初始化、有没有运行时错误、面板是否渲染。
`mock/gm-harness.html` 是一个纯本地页面，可用于对比。
