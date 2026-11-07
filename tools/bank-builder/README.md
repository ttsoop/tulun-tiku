# 题库生成器（接管 Chrome）

> 完整步骤见 **[USAGE.md](USAGE.md)**（启动 Chrome、配置 AI、采集、打包、导入油猴、排错）。

打开你**已登录**的 Chrome，读页面上的题目 → 自动作答 → 提交 → 读判分反馈 → 迭代到全对 → 导出题库（含答案、解析、疑点）。

不依赖油猴脚本，直接通过 Chrome 调试端口（CDP）操作，所以用的是你自己的登录态。

## 一、准备

1. 用调试端口启动 Chrome（**必须用独立 profile**，Chrome 136+ 不允许默认 profile 开调试端口）：

   ```powershell
   "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="D:\ocs-cdp"
   ```

2. 在这个新窗口里登录超星，打开要刷的**章节测验**页面，停在题目页。
3. 复制 `config.example.json` 为 `config.json`，填 AI 接口（也可以只设环境变量）：

   ```json
   { "ai": { "baseUrl": "https://api.deepseek.com", "apiKey": "sk-...", "model": "deepseek-chat" } }
   ```

   环境变量优先：`OCS_AI_BASE_URL` / `OCS_AI_API_KEY` / `OCS_AI_MODEL`。

## 二、三步用法

```powershell
# 1) 只读探测：确认能连上、能识别题目（不会点任何东西）
node tools/bank-builder/index.mjs probe

# 2) 只作答、不提交：先看看填得对不对（导出为"未验证"题库）
node tools/bank-builder/index.mjs run

# 3) 真迭代：作答 + 提交 + 读判分 + 回炉，直到全部判对
node tools/bank-builder/index.mjs run --submit --rounds 6
```

产物在 `tools/bank-builder/out/`（可用 `--out 目录` 改）：

```
out/
├─ questions.json   题库（题面/选项/答案/解析/疑点/逐轮证据）
├─ answers.csv      表格版
└─ index.html       离线查看器（搜索、题型筛选、只看疑点、高亮正确选项）
```

`questions.json` 结构与「图论章节题库」兼容，**可以直接导回油猴脚本的「本地题库」**使用。

## 三、迭代策略（按页面判分能力自动切换）

| 判分页给了什么 | 策略 |
|---|---|
| 逐题对错 + 正确答案 | 正确答案直接当 ground truth，不再问 AI |
| 逐题对错（无正确答案） | 错的/未知的题带上「上次答案 + 判错」喂 AI 重答；已判对的保持不动 |
| 只有「未及格」弹窗 | 整卷带反馈重评（含上次答案） |
| 什么都没有 | 只能按当前答案导出，全部标记「未验证」 |

停止条件：所有题都被判 `正确`，或达到 `--rounds`，或页面已不可编辑（提交后锁定）。

## 四、参数

| 参数 | 说明 |
|---|---|
| `--port 9222` | 调试端口 |
| `--url 关键字` | 只在 URL 含该关键字的页面里找题（多标签页时用） |
| `--submit` | **不加就只作答不提交** |
| `--rounds 6` | 最多几轮 |
| `--verbose` | 逐题打印「答案 / 判定 / 正解」 |
| `--mock` | 用 `config.mockAnswers` 代替 AI（离线自测用） |
| `--out 目录` | 导出目录 |
| `--bank 文件` | 已有题库（questions.json）当种子：命中就直接用，不消耗 AI |

## 五、超星特有的三件事（工具已处理）

1. **加密字体**：超星把题面字符换成别的字（如「下列」显示成「忬列」），只有渲染出的字形是对的。
   工具会把 `lib/font-decrypt.bundle.js`（仓库 `packages/scripts/src/utils/font-decrypt` 的打包件）
   注入页面，用 canvas 渲染字形并与 `lib/font_ref_cx.bin` 特征表比对，还原出明文后再抽题。
   这两个文件不需要随平台更新；重建方式：

   ```powershell
   node -e "require('esbuild').buildSync({entryPoints:['packages/scripts/src/utils/font-decrypt/index.ts'],bundle:true,format:'iife',globalName:'OCSFONT',outfile:'tools/bank-builder/lib/font-decrypt.bundle.js',target:'es2018'})"
   Invoke-WebRequest 'https://cdn.ocsjs.com/resources/font/font_ref_cx.bin' -OutFile tools/bank-builder/lib/font_ref_cx.bin
   ```

2. **选项不是 input**：超星的选项是 `<li onclick="addMultipleChoice(this)">`，选中状态在 `aria-checked` 上。
   工具直接点 `li`，但**提交时读的是隐藏域 `#answer<qid>`**，所以点完还会把隐藏域同步成目标答案
   （判断题写 `true/false`），否则界面看着选中了、提交上去还是旧答案。

3. **确认框在父页面**：`btnBlueSubmit()` 之后弹出的是父页面的 `.popDiv`（「确认提交？ 提交 / 取消」），
   不在 iframe 里；「未达到及格线，请重做」的提示同理。工具用 `clickPopupButton` 在父页面点。

## 六、疑点标记

导出时对每道题计算 `flags`：

- `未验证`：平台从未判过这题正确
- `答案冲突`：多轮答案不一致且没有被验证
- `半对半错`：多选题被平台判为部分正确（漏选/选错）
- `不支持题型`：连线/完形/阅读，当前自动作答不支持
- `未作答`：没拿到任何答案

## 七、限制（务必知道）

- 只适用于**允许重做的章节测验/作业**。一次性考试的提交即定局，`--submit` 前请确认。
- 平台会记录提交次数（超星常见 3 次），轮次别开太大。
- 题目图片目前只记录 URL（`images` 字段），AI 看不到图；图标题会退化为纯文字匹配。
- 判分页结构因学校/版本而异，选择器集中在 `lib/cx.mjs`，识别不到时用 `probe` + `--verbose` 定位。

## 八、自测

仓库内置一个模拟测验页（`mock/quiz.html`），可以不动真实账号验证全流程：

```powershell
# 另开一个 headless Chrome 加载模拟页
chrome --headless=new --remote-debugging-port=9336 --user-data-dir=%TEMP%\cdp-mock `
  "file:///<仓库路径>/tools/bank-builder/mock/quiz.html"
node tools/bank-builder/index.mjs run --port 9336 --submit --rounds 4 --mock --verbose
```



