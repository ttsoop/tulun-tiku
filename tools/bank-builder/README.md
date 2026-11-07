# 超星题库生成器｜新手教程

这个工具可以从超星学习通的章节测验中读取题目、填写答案，并把结果导出成可以离线查看的题库。它连接你专门启动的 Chrome 窗口，使用你在窗口里手动登录的账号。

第一次使用，建议先用仓库自带的模拟测验试跑。已有的图论题库可以直接打开 [离线查看器](../../题库/图论全章节题库/index.html)。

## 1. 准备环境

下面以 Windows PowerShell 为例。打开 `tulun-tiku` 文件夹，在资源管理器地址栏输入 `powershell` 并回车。后续命令都从这个窗口执行。

安装 Node.js（例如 24.x）和 Google Chrome。装好 Node.js 后重新打开 PowerShell，逐行执行：

```powershell
node --version
npm.cmd --version
npm.cmd install --no-save --package-lock=false playwright-core
```

前两行应分别显示版本号。最后一行安装工具连接 Chrome 所需的依赖。安装完成后，当前目录应有 `node_modules\playwright-core`。

## 2. 用本地模拟测验试跑

把下面三行粘贴到 PowerShell。第一行应返回 `True`。如果返回 `False`，把引号里的路径改成你电脑上的 Chrome 安装路径。可在日常使用的 Chrome 地址栏打开 `chrome://version`，查看「可执行文件路径」。

```powershell
Test-Path "C:\Program Files\Google\Chrome\Application\chrome.exe"
$quizUrl = ([uri]((Resolve-Path ".\tools\bank-builder\quiz.html").Path)).AbsoluteUri
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 "--user-data-dir=$env:LOCALAPPDATA\tulun-bank-builder-chrome" --new-window $quizUrl
```

Chrome 会打开一个包含 6 道题的模拟页面。专用配置目录会单独保存这个窗口的登录状态，下次可以继续用同一个目录。

保持这个 Chrome 窗口打开，在 PowerShell 执行：

```powershell
node tools/bank-builder/index.mjs probe --url quiz.html
```

看到 `[定位] 题目数 6` 和前几道题的预览，就说明连接成功。这一步只读取题目，无需登录或配置 AI。想试试把原始题目保存到文件，可以继续执行：

```powershell
node tools/bank-builder/index.mjs extract --url quiz.html
```

成功后会生成 `tools/bank-builder/out/extract.json`。

## 3. 在自己的章节测验上试用

### 打开测验

在刚才启动的专用 Chrome 窗口里关闭模拟测验标签页，登录超星，然后进入课程的章节学习页。点开一个课程允许使用此工具的章节练习，等题目加载出来。

```powershell
node tools/bank-builder/index.mjs probe
```

先核对终端显示的页面地址和题目预览。调试窗口里同时打开多个测验时，可以用 `--url "地址里的关键字"` 缩小范围，或只保留目标测验标签页。

如果你只想提取题目，运行 `node tools/bank-builder/index.mjs extract` 即可。需要让工具填写答案时，继续配置 AI。

### 配置 AI 接口

首次配置时，把模板复制一份并用记事本打开：

```powershell
Copy-Item .\tools\bank-builder\config.example.json .\tools\bank-builder\config.json
notepad .\tools\bank-builder\config.json
```

在 `"ai"` 对象里，把 `baseUrl`、`apiKey` 和 `model` 换成服务商提供的接口地址、API 密钥和模型名称，保留文件里的引号和逗号。接口需兼容 `/chat/completions`，工具会在基础地址后补上这段路径。配置文件已列入 `.gitignore`，请把密钥留在本机。

### 先填写，再决定是否提交

```powershell
node tools/bank-builder/index.mjs run
```

这条命令会调用 AI、在浏览器里填写答案，并导出结果。查看浏览器里实际选中的答案，也可以打开导出的 `index.html` 检查。此时的答案通常标记为「未验证」。

只有课程明确允许自动作答与提交时，才使用下面的命令。`--submit` 会在你的账号上真实交卷，并可能消耗测验次数。第一次可以把轮数设为 1，先看平台反馈。

```powershell
node tools/bank-builder/index.mjs run --submit --rounds 1
```

## 4. 查看导出结果

单个测验默认导出到 `tools/bank-builder/out/`。用 `--out "tools/bank-builder/out/练习一"` 可以为这次运行指定独立目录。

| 文件 | 怎么用 |
| --- | --- |
| `index.html` | 双击打开，用浏览器查看题目、答案、解析和疑点 |
| `answers.csv` | 用 Excel 等表格软件打开 |
| `questions.json` | 保存结构化题库，可导入支持该格式的本地题库功能 |

先检查标有「未验证」「答案冲突」或「不支持题型」的题目。带图题也要人工核对，AI 作答时只收到文字和图片数量提示。

## 5. 可选操作

- **复用已有题库**。在 `run` 命令末尾加 `--bank "题库/图论全章节题库/questions.json"`。工具会优先复用匹配的答案，仍可能调用 AI 补解析。
- **按课程目录采集**。在专用 Chrome 打开课程的「章节学习」页，然后执行 `node tools/bank-builder/run-all.mjs --out "tools/bank-builder/out/我的课程"`。工具会遍历小节，采集可读取的题目和已有答案。加上 `--submit` 才会自动作答并提交未完成的测验。它会从输出目录的 `state.json` 载入已采集记录，每门课请使用单独的输出目录。
- **打包仓库自带的图论题库**。`package-bank.mjs` 专门用于图论题库，固定读取 `tools/bank-builder/out/all/questions.json`，并写入仓库的 `题库/图论全章节题库/`。其他课程可直接使用导出目录里的查看器。

## 常见问题

| 提示或现象 | 怎么处理 |
| --- | --- |
| 找不到 `node` 或 `npm.cmd` | 安装 Node.js 后重新打开 PowerShell，再检查版本号 |
| 找不到 `playwright-core` | 确认在 `tulun-tiku` 根目录，重新执行第 1 步的安装命令 |
| `ECONNREFUSED` 或 CDP 连接失败 | 确认专用 Chrome 窗口仍开着，且启动参数里的端口与工具使用的端口一致。也可以在该窗口打开 `http://127.0.0.1:9222/json/version` 检查是否能看到版本信息 |
| 已连上但没找到题目 | 点开具体小节的测验，等题目显示后重试。若使用了 `--url`，核对关键字是否在标签页地址里 |
| AI 返回 `401`、`404` 或超时 | 检查密钥、模型名和接口地址。若设了 `OCS_AI_API_KEY`、`OCS_AI_BASE_URL` 或 `OCS_AI_MODEL`，它们会优先于配置文件 |
| 提交时出现验证码 | 按浏览器页面提示手动处理，并先查看当前提交状态，再决定是否重试 |
