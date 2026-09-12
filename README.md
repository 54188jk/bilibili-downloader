# BiliGrab · B 站视频 / 音频下载器

一个基于 **Electron** 的桌面应用，按照 B 站官方 API 解析视频信息 → 获取播放地址 → 下载 → 用 `ffmpeg` 抽音频。

## ✨ 功能

- 输入 B 站链接或 BV 号，自动解析视频标题、封面、UP 主、播放量等元数据
- 一键列出可用画质（240P / 360P / 480P / 720P / 1080P / 1080P+ / 1080P60 / 4K …）
- **支持 B 站登录（可选）**：登录后可解锁 1080P+、1080P60、4K 等高画质；不登录也可免费下载低画质
- 一键下载视频（mp4）
- 一键下载音频（mp3，ffmpeg 抽取 libmp3lame 编码）
- 一键下载纯视频流（无声，ffmpeg `-an -c:v copy`）
- 自定义保存目录，进度条实时显示
- 自定义无边框玻璃拟态界面，深色霓虹风格
- **已捆绑 ffmpeg**：免去用户单独安装

## 📁 项目结构

```
bilibili-downloader/
├── package.json
├── README.md
└── src/
    ├── main.js           # Electron 主进程（窗口、IPC、下载、ffmpeg）
    ├── preload.js        # 上下文桥接（安全暴露 API）
    ├── bilibili.js       # B 站 API 封装（视频信息 + 播放地址）
    └── renderer/
        ├── index.html    # GUI 页面骨架
        ├── styles.css    # 视觉设计
        └── renderer.js   # 渲染进程逻辑（UI 状态、任务列表）
```

## 🚀 启动步骤

### 1. 安装 Node.js
建议 Node.js 18+，到 https://nodejs.org 下载安装。

### 2. 安装 ffmpeg
ffmpeg 用于抽音频 / 去音轨。

- **Windows**：到 https://www.gyan.dev/ffmpeg/builds/ 下载 `ffmpeg-release-essentials.zip`，解压后把 `bin` 目录加入系统 `PATH`
- **macOS**：`brew install ffmpeg`
- **Linux**：`sudo apt install ffmpeg`

启动应用后右上角会显示 ffmpeg 状态，绿点 = 就绪。

### 3. 安装依赖并启动

```bash
cd bilibili-downloader
npm install
npm start
```

如果想要把 ffmpeg 一起打包（无需用户单独安装），可以：

```bash
npm install ffmpeg-static
```

主进程会自动检测 `ffmpeg-static`，否则回退到系统 PATH。

### 4. 打包成可执行文件

```bash
npm run build
```

会在 `dist/` 目录生成：

| 产物 | 说明 |
|---|---|
| `BiliGrab Setup 1.0.0.exe` | Windows 安装版（向导式安装） |
| `BiliGrab-portable.exe` | 免安装便携版（双击即用） |
| `win-unpacked/BiliGrab.exe` | 解包目录，可直接运行 |

ffmpeg 已捆绑进 `resources/ffmpeg.exe`，目标电脑无需再安装 ffmpeg。

## 📖 使用流程

1. 启动应用（标题栏右上角可点击 **登录 B站**，可选）
   - **不登录**：可以解析并下载免费画质（最高 720P~1080P 视视频而定）
   - **登录**：弹出 B 站官方登录窗口，支持扫码 / 账号密码；登录后自动解锁 1080P+、1080P60、4K 等高画质；登录态本地安全加密保存，下次启动自动恢复
2. 左侧面板输入框中粘贴 B 站视频链接（如 `https://www.bilibili.com/video/BVxxxxxx`）或直接输入 BV 号
3. 点击 **解析** 按钮
4. 解析完成后会显示视频信息卡片（标题、UP 主、播放量等）
5. **选择保存目录**（点击"选择目录"按钮）
6. 右侧面板出现画质列表，点击想要的画质切换
7. 点击对应按钮下载：
   - **下载视频（mp4）**：保留原视频+音频
   - **下载音频（mp3）**：先下载原文件，再 ffmpeg 抽音频
   - **仅下载视频流**：去音轨的纯视频

## ⚠️ 注意事项

- **画质限制**：1080P+、1080P60、4K 等高画质**必须登录账号（高码率/杜比还需大会员）**，登录后自动解锁；未登录时只会显示免费画质。
- **登录态安全**：登录成功后 Cookie 使用系统级加密（Windows DPAPI）保存在应用用户目录，只有当前 Windows 用户可解密；点击右上角退出按钮可一键清除。
- **AV 号暂不支持**：只识别 BV 号。如需支持，可在 `bilibili.js` 中扩展 `extractBvid`。
- **短链（b23.tv）暂不支持**：粘贴完整 URL 即可。
- 仅供个人学习使用，请勿用于商业用途或侵犯版权。

## 🛠️ 技术细节

### B 站 API
- 视频信息：`GET https://api.bilibili.com/x/web-interface/view?bvid=BVxxxxxx`
- 播放地址：`GET https://api.bilibili.com/x/player/playurl?bvid=…&cid=…&qn=80&fnval=1&fnver=0&fourk=1&platform=html5`
  - Header `Referer: https://www.bilibili.com` 必须带，否则返回 -403

### ffmpeg 调用
- 抽音频：`ffmpeg -i input.mp4 -vn -acodec libmp3lame -q:a 2 output.mp3`
- 去音轨：`ffmpeg -i input.mp4 -an -c:v copy output.mp4`

### 签名 URL
playurl 返回的 mp4 URL 包含签名参数，**几小时内有效**，所以不要缓存，每次解析都重新拉一次。
