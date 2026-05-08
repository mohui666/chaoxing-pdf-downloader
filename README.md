# 学习通 PDF 下载按钮

一个用于学习通 / 超星页面的 Chrome Manifest V3 扩展。插件会从学习通文档接口返回的数据中提取 `filename` 和 `pdf` 字段，在页面右下角显示 PDF 下载面板，并调用 Chrome 下载真实 PDF 文件。

## 功能

- 自动捕获学习通文档配置中的 PDF 资源。
- 只识别 `filename` / `fileName` 以 `.pdf` 结尾的文件。
- 只使用同一条文件记录里的 `pdf` 字段作为下载来源。
- 自动规范学习通 PDF 地址，例如 `https://s3.ananas.chaoxing.com/.../pdf/<objectid>.pdf`。
- 右下角显示全局 PDF 面板。
- 支持单个文件下载和全部下载。
- 文件保存名与接口中的 `filename` 字段一致。
- 下载前校验响应内容，避免把 `.htm`、`.json` 等非 PDF 文件保存成 PDF。
- 切换章节时自动清空上一章节记录。
- 面板支持拖动、调节大小、收起和展开，并记住展开时的尺寸。

## 安装

1. 下载或克隆本仓库。
2. 打开 Chrome，进入 `chrome://extensions/`。
3. 打开右上角的“开发者模式”。
4. 点击“加载已解压的扩展程序”。
5. 选择本项目文件夹。

加载成功后，扩展列表中会出现“学习通PDF下载按钮”。

## 使用

1. 打开学习通课程页面。
2. 进入包含 PDF 资料的章节或文档预览页。
3. 等待页面加载文档资源。
4. 右下角出现“学习通PDF”面板后，可点击文件后的“下载PDF”下载单个文件，也可以点击“全部下载”顺序下载当前列表中的全部 PDF。

面板标题栏可以拖动。展开状态下，右下角斜线手柄可以调整面板大小。点击右上角 `-` 可以收起，点击 `+` 可以展开。

## 支持范围

插件会在以下相关页面运行：

- `chaoxing.com`
- `cldisk.com`
- `ananas.chaoxing.com`
- `ananas.com`
- `xueyinonline.com`

## 项目结构

```text
.
├── manifest.json      # Chrome MV3 扩展配置
├── background.js      # 下载、接口转发、跨 frame 数据同步
├── content.js         # PDF 捕获、面板渲染、交互逻辑
├── page-bridge.js     # 注入页面环境，捕获 fetch / XHR / JSON.parse 数据
├── styles.css         # 面板和提示样式
└── README.md
```

## 说明

插件不会扫描普通页面上的任意链接，也不会把预览页、缩略图、JSON 或 HTML 当作 PDF 下载。它只处理学习通文档接口中明确出现的 PDF 文件记录。

本项目仅用于下载当前账号有权限访问的学习资料。使用时请遵守学校、课程平台和资料版权方的相关规定。
