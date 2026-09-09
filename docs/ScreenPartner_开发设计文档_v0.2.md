# Screen Partner 开发设计文档 v0.2

**项目名称:** Screen Partner  
**文档日期:** 2026-09-02  
**最后同步:** 2026-09-09  
**仓库:** `shmilyfuu/screen-partner`  
**目标平台:** Windows 10/11 x64、macOS Apple Silicon；预留 macOS Intel / Universal  
**首选技术栈:** Tauri 2 + Rust + HTML/CSS/Vanilla JavaScript  
**宠物资源协议:** 优先兼容 Codex `pet.json + spritesheet.webp`，第一阶段以 v1 图集为基准。

## 0. v0.2 变更摘要

v0.2 延续 v0.1 的产品范围与技术路线，并补齐会直接影响实现的状态语义。

- `pendingState` 扩展为 `pendingDecision`，同时保存状态、优先级、来源、原因与请求时间。DEBUG 日志可以直接看到 `cpu_busy`、`double_click` 这类来源。
- 系统状态、随机行为、Debug 状态与后续 Agent 事件继续遵循 Action Boundary。
- 活跃拖动和已经完成单击/双击分类的用户交互具备即时中断能力。拖动开始后立即切换 `running-left` / `running-right`；单击识别完成后立即播放 `waving`；双击识别完成后立即播放 `jumping`。
- 单击先等待最多 300 ms 的双击分类窗口。第二次点击在窗口内到达时直接判定双击，取消单击动作。
- 拖动使用持续型 P0 信号。单击与双击属于一次性 P0 即时动作；动作播放一轮后重新读取实时 BehaviorArbiter 结果。拖动可以中断正在播放的 `waving` / `jumping`。
- 随机动作使用锁存信号。CPU、RAM、Disk、Network、用户空闲时间使用持续型信号，每次 BehaviorArbiter 计算都允许刷新或撤销。
- 动画时钟增加系统睡眠、WebView 长暂停与恢复规则。恢复后从暂停前当前帧的剩余时间继续。
- `NormalizedPet` 增加 `sourceFormat`，Codex v1 先转换成统一逐帧 `durationMs` 再进入播放器。
- 设置模型升级到 schema v2，统一保存窗口位置和 DesktopSettings。Windows portable 使用程序目录 `data/settings.json`；正常安装模式和 macOS 使用系统应用配置目录。
- Phase 6 增加正式设置窗口，第一批提供宠物大小、始终置顶、随机动作、系统感知、开机启动、显示/隐藏和召回。系统阈值编辑继续由 Issue #8 跟踪并接入同一设置模型。
- Debug 构建保留九状态手动触发入口，Release 构建隐藏开发菜单。

---

## 1. 项目定义

Screen Partner 是独立运行的常驻桌面宠物应用。核心信号来自电脑自身运行状态，Codex、Claude、ComfyUI 等应用事件属于后续可选扩展。

关闭 Codex 或未安装 Agent 时，宠物仍能独立运行。CPU、内存、磁盘、网络、用户空闲时间等数据交给行为系统，行为系统计算当前有效动作。系统和自动行为通常等当前动作完整结束后切换；明确的用户即时交互使用第 8 节规定的中断路径。

第一阶段继续采用 Codex 当前九行动画及逐帧时间，使已有 v1 宠物资源可以直接复用。屏幕上的节奏应与 Codex 资源本身一致。

---

## 2. 第一阶段目标

1. Windows 10/11 x64 独立桌宠。
2. macOS Apple Silicon 同步可运行。
3. 透明无边框宠物窗口。
4. 可选始终置顶。
5. 托盘或菜单栏入口。
6. 宠物位置记忆与召回。
7. 宠物大小调节。
8. Codex v1 `pet.json + spritesheet.webp` 加载。
9. Codex 九组默认动画播放。
10. 默认动画逐帧时间与 Codex 当前源码一致。
11. 系统状态、随机行为和普通状态变化遵循 Action Boundary；明确用户即时交互遵循第 8.2 节。
12. CPU、RAM、Disk、Network 系统采样。
13. 系统状态驱动动作。
14. 普通状态下随机动作。
15. 鼠标单击、双击、拖动等基础互动。
16. 正式设置窗口与基础 DesktopSettings。
17. GitHub Actions 自动测试与构建。
18. Windows 与 macOS 开发 Artifact 可下载测试。
19. Tag 构建生成 GitHub Release 安装文件。

MVP 运行时，用户启动编译任务或大型下载，宠物会先完成当前姿势，然后切到对应动作；任务结束后同样在动作边界回到当前有效状态。用户拖动、单击或双击时使用即时反馈规则。

---

## 3. 第一阶段暂缓内容

- Agent Hook 深度联动。
- Codex、Claude、Gemini、ComfyUI 专属动作规则。
- 在线宠物商店与账号系统。
- 云同步。
- 成长、经验、等级、排行榜。
- 多宠物同时存在。
- 高复杂度路径寻路。
- macOS App Store 发布。
- Windows Store 发布。
- GPU 跨厂商统一采样。
- macOS GPU 深度采样。
- 高权限硬件温度读取。

第一阶段界面保持轻量。桌面主要显示宠物本体，设置集中到独立设置窗口与托盘/Menu Bar，屏幕上不长期悬挂系统仪表盘。

---

## 4. 技术栈决策

### 4.1 Tauri 2 + Rust

Tauri 2 继续作为当前首选。Rust 负责系统能力、平台 Adapter 与文件读写，HTML/CSS/Vanilla JavaScript 负责 Sprite 渲染、动画时间与行为仲裁。

主要理由：

- Windows 使用系统 WebView2，macOS 使用系统 WebKit WebView。
- Sprite Sheet 适合通过 CSS `background-position` 或等价裁切方式显示。
- Rust 适合处理系统指标、窗口、托盘、启动项和平台 API。
- GitHub Actions 可以直接在 Windows/macOS Runner 构建原生产物。
- 用户本机无需先安装 Rust，开发阶段可以直接下载 Actions Artifact 验证。

### 4.2 Electron

Electron 保留为备选。`thanh-abaii/codex-pet` 已验证 CPU、RAM、磁盘、网络驱动桌宠动作的可行性。Screen Partner 的主窗口面积很小，系统采样与轻量渲染占主体，因此当前继续采用 Tauri 2。

### 4.3 .NET / WinUI 3

WinUI 3 对 Windows 原生能力友好，跨 macOS 会形成第二套客户端。当前项目希望共享同一套 Renderer 与行为引擎，因此第一阶段不采用这条路线。

---

## 5. 跨平台分层

```text
Screen Partner
├─ Core
│  ├─ AnimationPlayer
│  ├─ BehaviorArbiter
│  ├─ RandomBehavior
│  ├─ PetManifest
│  └─ SettingsModel
├─ Renderer
│  ├─ SpriteRenderer
│  ├─ InteractionController
│  └─ SettingsUI
├─ Telemetry
│  ├─ CommonMetrics
│  ├─ WindowsAdapter
│  └─ MacOSAdapter
└─ Platform
   ├─ Window
   ├─ TrayOrMenuBar
   ├─ Startup
   └─ FileSystem
```

Windows 与 macOS 使用相同动画帧、动作边界、即时交互和随机行为逻辑。平台差异集中于指标来源、窗口细节、启动项和签名发布。平台判断不进入动画播放器核心逻辑。

---

## 6. 宠物资源协议

### 6.1 Codex v1 图集

```text
spritesheet.webp
尺寸: 1536 x 1872
网格: 8 列 x 9 行
单帧: 192 x 208
```

| 行 | 状态 | 帧数 |
|---:|---|---:|
| 0 | `idle` | 6 |
| 1 | `running-right` | 8 |
| 2 | `running-left` | 8 |
| 3 | `waving` | 4 |
| 4 | `jumping` | 5 |
| 5 | `failed` | 8 |
| 6 | `waiting` | 6 |
| 7 | `running` | 6 |
| 8 | `review` | 6 |

### 6.2 标准化模型

```ts
interface NormalizedPet {
  sourceFormat: "codex-v1" | string;
  id: string;
  displayName: string;
  spritesheetPath: string;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: Record<string, AnimationDefinition>;
}

interface NormalizedAnimationFrame {
  spriteIndex: number;
  durationMs: number;
}

interface AnimationDefinition {
  frames: NormalizedAnimationFrame[];
}
```

Codex v1 自定义动画若使用 `fps`，Manifest Loader 先换算成 `durationMs`。默认九行动画使用第 7 节的特殊逐帧时间。

### 6.3 路径限制

资源路径只允许宠物目录内部的相对路径。`../`、绝对路径与跨目录读取直接拒绝。资源加载失败时显示可读的空状态提示，窗口继续运行。

---

## 7. Codex 默认动画时间

以 2026-09-02 核对到的 OpenAI Codex `codex-rs/tui/src/pets/model.rs` 为基准。

### 7.1 `idle`

```text
frame 0: 1680 ms
frame 1:  660 ms
frame 2:  660 ms
frame 3:  840 ms
frame 4:  840 ms
frame 5: 1920 ms
总计:   6600 ms
```

### 7.2 其他动作

| 动作 | 帧时间 | 一轮时长 |
|---|---|---:|
| `running-right` | 7 x 120 ms + 220 ms | 1060 ms |
| `running-left` | 7 x 120 ms + 220 ms | 1060 ms |
| `waving` | 3 x 140 ms + 280 ms | 700 ms |
| `jumping` | 4 x 140 ms + 280 ms | 840 ms |
| `failed` | 7 x 140 ms + 240 ms | 1220 ms |
| `waiting` | 5 x 150 ms + 260 ms | 1010 ms |
| `running` | 5 x 120 ms + 220 ms | 820 ms |
| `review` | 5 x 150 ms + 280 ms | 1030 ms |

Screen Partner 继承帧顺序与每帧时长。动作持续多久由实时行为状态决定。

---

## 8. AnimationPlayer 硬约束

### 8.1 Action Boundary

系统指标、随机动作、Debug 手动状态与后续 Agent 事件进入普通决策路径。当前动作开始后显示全部帧，并让最后一帧完整显示自己的 duration；动作边界到达后应用最新 `pendingDecision`。

普通决策不会中断当前动作。

### 8.2 用户即时交互

以下交互具备专用即时中断路径：

- 活跃拖动。
- 已经完成分类的单击。
- 已经完成分类的双击。

即时中断调用 `AnimationPlayer.interruptState(state)`，直接丢弃当前动作和原 `pendingDecision`，从目标动作第 0 帧开始。被中断动作不继续旧帧，也不产生“已正常完成”的 Action Boundary。

拖动属于持续型 P0 interaction。方向变化时只在实际左右方向变化后重新切换 `running-left` / `running-right`。松手立即清除拖动 P0，并重新读取当前 BehaviorArbiter 结果。

单击与双击属于一次性 P0 interaction。分类完成后立即播放对应动作一轮；播放器的 `pendingDecision` 保存动作结束时应恢复的实时 BehaviorArbiter 结果。系统信号在这段时间继续刷新，因此动作结束时可以使用最新结果。

拖动可以立即中断正在播放的 `waving` 或 `jumping`。

### 8.3 Runtime

```ts
type PetState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

interface PendingDecision {
  state: PetState;
  priority: number;
  source: StateSource;
  reason: string;
  requestedAt: number;
}

interface AnimationRuntime {
  currentState: PetState;
  pendingDecision: PendingDecision | null;
  currentFrameIndex: number;
  frameStartedAt: number;
  frameDeadline: number;
  actionCycleId: number;
}
```

### 8.4 单槽决策

`pendingDecision` 保存当前最新有效结果，不使用普通 FIFO 动作队列。CPU 升高后又迅速恢复时，动作边界读取恢复后的结果，早先瞬时状态不会排队到几十秒以后才出现。

即时交互开始时会清除被中断动作留下的 `pendingDecision`，随后根据交互类型重新建立恢复目标。

### 8.5 优先级

```text
交互语义顺序
Drag > 已识别 Click / Double Click > System > Random > Idle

BehaviorArbiter 数值优先级
P0  用户即时交互 / Debug
P1  系统压力 / 异常
P2  持续高负载
P3  外部应用事件
P4  自主随机动作
P5  普通 idle / waiting
```

P0 自身仍区分交互语义。Drag 是持续位置操作，可以中断单击/双击动作。单击和双击完成分类后拥有一次即时中断权限。Debug 保持普通 Action Boundary 行为。

### 8.6 信号生命周期

```text
continuous
CPU / RAM / Disk / Network / 用户空闲状态 / 活跃拖动
每次 BehaviorArbiter 计算都可刷新或撤销

latched
随机动作 / 后续一次性自动事件
保持到动作边界成功消费，或达到有效期

immediate one-shot
已识别单击 / 已识别双击
即时启动一轮动作，动作结束后恢复实时决策
```

随机动作继续使用锁存 TTL。单击和双击不再依赖 10 秒交互锁存。

### 8.7 睡眠与长暂停

播放器使用 `requestAnimationFrame` 与绝对 `frameDeadline`。系统睡眠、WebView 长暂停或明显调度冻结发生时，记录当前帧剩余时间；恢复后继续显示剩余 duration，禁止快速补播欠下的多帧。

```text
idle frame 4 尚余 420 ms
→ 系统睡眠
→ 唤醒
→ frame 4 再显示 420 ms
→ frame 5
```

---

## 9. AnimationPlayer 接口

```ts
interface AnimationPlayer {
  loadPet(pet: NormalizedPet): Promise<void>;
  start(initialState: PetState): void;
  requestDecision(next: PendingDecision): void;
  interruptState(state: PetState): AnimationSnapshot;
  getCurrentState(): PetState;
  getPendingDecision(): PendingDecision | null;
  getCurrentFrame(): number;
  onActionBoundary(handler: ActionBoundaryHandler): void;
}
```

自动化测试需要同时覆盖普通 Action Boundary 和即时中断：普通请求在中间帧不改变 `currentState`；即时交互从目标动作第 0 帧开始，并清除被中断动作的旧恢复目标。

---

## 10. BehaviorArbiter

输入来自系统指标、用户活动、交互、外部事件和随机行为。普通输出统一为：

```ts
interface BehaviorDecision {
  state: PetState;
  priority: number;
  reason: string;
  source: StateSource;
  decidedAt: number;
}
```

持续型信号每轮刷新，锁存型信号保留到消费或超时。普通结果写入 `pendingDecision`。

活跃拖动作为 P0 continuous signal 进入 BehaviorArbiter。已识别单击/双击通过明确的 immediate interaction 入口启动动作，同时保留 BehaviorArbiter 作为动作结束后的恢复来源。系统采样线程依然禁止直接修改 Sprite。

---

## 11. 系统采样模型

Rust 统一输出原始数据：

```rust
pub struct SystemMetrics {
    pub timestamp_ms: u64,
    pub cpu_usage_percent: f32,
    pub memory_usage_percent: f32,
    pub disk_read_bps: u64,
    pub disk_write_bps: u64,
    pub network_rx_bps: u64,
    pub network_tx_bps: u64,
    pub user_idle_seconds: Option<u64>,
}
```

实际实现还包含 GPU、磁盘压力与平台反馈字段。阈值、持续时间、滞回与行为分类放在行为层。`user_idle_seconds` 由平台 Adapter 获取，读取失败返回 `None`。基础采样频率为 1000 ms。

---

## 12. 当前系统状态规则

以下数值为 Phase 4 已通过人工测试的正式默认值，后续设置窗口允许修改这些值时继续以本节作为“恢复默认”的来源。

### Compute Busy

- CPU enter：`>= 60%`，持续 `5s` → `review` P2。
- CPU exit：`<= 50%`，持续 `4s`。
- GPU enter：`>= 75%`，持续 `5s` → `review` P2。
- GPU exit：`<= 55%`，持续 `4s`。

### Memory Pressure

- RAM enter：`>= 92%`，持续 `12s` → `failed` P1。
- RAM exit：`<= 90%`，持续 `5s`。

### Disk Activity

- enter：总读写吞吐 `>= 4,000,000 B/s`，持续 `3s` → `running` P2。
- exit threshold：`max(3,000,000 B/s, observed peak × 15%)`。
- exit dwell：`3s`。
- draining rearm：达到 `max(64,000,000 B/s, prior peak × 25%)`，或吞吐 `<= 3,000,000 B/s` 持续 `5s`。

### Disk Pressure

- enter：Busy `>= 70%` 或 latency `>= 20ms`，持续 `2s` → `running` P2。
- exit：Busy `<= 35%` 且 latency `<= 8ms`，持续 `2s`。

### Network Activity

- enter：总收发 `>= 1,500,000 B/s`，持续 `3s` → `running` P2。
- exit：`<= 750,000 B/s`，持续 `3s`。

### Platform Feedback

- Windows `IDC_WAIT` → `waiting` P1。
- Windows `IDC_APPSTARTING` → `running` P2。
- macOS spinning wait cursor 实验反馈 → `waiting` P1。
- cursor exit debounce：`1s`。

### Waiting

用户空闲 `>= 60s` 且系统低活动，同时没有更高优先级行为时进入 `waiting`。

### Idle

其余普通状态使用 `idle`。

---

## 13. 滞回与持续时间

进入与退出阈值独立定义。持续时间必须达到规则要求才改变 gate 状态。长时间 telemetry gap 会重置 dwell 计时，避免睡眠恢复后把暂停时间误算成持续负载时间。

短促峰值只出现在 DEBUG 指标里；持续任务达到门槛后才产生对应行为决策。

---

## 14. 自主随机行为

普通状态随机间隔采用 30–120 秒，每次触发后重新生成时间。

当前权重：

```text
waving   35%
jumping  20%
waiting  20%
review   10%
idle     15%
```

随机请求采用 P4 latched 信号，并受到 P0–P3 行为抑制。拖动、点击分类窗口、已识别用户动作和系统高优先级行为都会阻止随机动作插入。随机动作被高优先级行为清除后生成新的未来 deadline，禁止延迟补播旧随机动作。

正式设置可以关闭 RandomBehavior。关闭后清除待执行随机信号并停止生成新 deadline；当前已经开始播放的完整动作按现有动作规则结束。

---

## 15. 用户互动

### 单击

- pointer 释放后进入最多 `300ms` 的双击分类窗口。
- 300ms 内没有第二次有效点击时确认单击。
- 确认后立即中断当前 Sprite 动作，从 `waving` 第 0 帧开始。
- `waving` 完整播放一轮后恢复当时最新的 BehaviorArbiter 结果。

### 双击

- 第二次有效点击在 300ms 分类窗口内到达时确认双击。
- 取消第一下尚未确认的单击。
- 立即中断当前 Sprite 动作，从 `jumping` 第 0 帧开始。
- `jumping` 完整播放一轮后恢复当时最新的 BehaviorArbiter 结果。

### 拖动

- 左键 pointer 位移达到 `4px` 后确认真实拖动，避免普通点击因轻微抖动被识别为拖动。
- 确认拖动后立即中断当前 Sprite 动作。
- 向右移动使用 `running-right`，向左移动使用 `running-left`。
- 同一拖动手势内方向改变时立即更新方向动画。
- 拖动持续期间使用 P0 continuous signal。
- 松手后立即清除拖动状态并重新读取实时行为。
- 被拖动中断的旧动作直接结束。

### 右键

右键宠物打开正式设置窗口。

### Tray / Menu Bar

正式菜单包含显示宠物、隐藏宠物、召回到主屏幕、设置和退出。设置窗口承载大小、置顶、随机动作、系统感知、开机启动等配置。

Debug 构建额外提供九组状态和“恢复自动”。Debug 手动状态继续验证普通 Action Boundary。

---

## 16. Windows 与 macOS

### Windows

第一阶段：透明窗口、WebView2、系统托盘、x64、启动项、CPU/RAM/Disk/Network、用户空闲时间、GPU/磁盘压力和 cursor feedback。

Windows portable 构建使用编译标记 `SCREEN_PARTNER_PORTABLE=1`，配置写入 exe 同目录的 `data/settings.json`。后续 installer 构建写系统应用配置目录，避免安装目录写权限问题。

### macOS

第一阶段：透明窗口、WebKit WebView、Menu Bar、Apple Silicon、CPU/RAM/Disk/Network、用户空闲时间和实验性 cursor feedback。开发 Artifact 使用 ad-hoc 签名，正式公开分发后再加入 Developer ID 与 notarization。

启动项使用 Tauri autostart 插件的 macOS LaunchAgent 路径。

### macOS 透明窗口风险

Tauri 2 的 macOS 透明窗口需要 `app.macOSPrivateApi`。该能力不面向 Mac App Store，本项目第一阶段也未计划 App Store。

2026 年 Tauri 公开 issue 仍有透明 WebView 持续触发 WindowServer / WebKit 合成并增加 GPU 活跃度的报告。桌面长期运行阶段继续观察透明窗口资源表现。

---

## 17. 设置与数据目录

### 17.1 Settings schema v2

当前统一设置结构：

```ts
interface Settings {
  schemaVersion: 2;
  window: { x: number; y: number } | null;
  desktop: {
    petScale: 0.75 | 1 | 1.25 | 1.5;
    alwaysOnTop: boolean;
    randomBehaviorEnabled: boolean;
    systemAwarenessEnabled: boolean;
    launchAtStartup: boolean;
  };
}
```

当前默认值：

```text
petScale = 1.0
alwaysOnTop = true
randomBehaviorEnabled = true
systemAwarenessEnabled = true
launchAtStartup = false
```

schema v1 读取后迁移到 v2，并保留原窗口位置。未知的未来 schema 版本拒绝读取并回退默认设置。非法 petScale 回退到 1.0。

### 17.2 正式设置窗口

Phase 6 第一批设置：

- 宠物大小：75% / 100% / 125% / 150%。
- 始终置顶。
- 随机动作。
- 系统感知。
- 开机启动。
- 显示宠物。
- 隐藏宠物。
- 召回主屏幕。
- 恢复默认桌面设置。

设置变更通过 `settings-changed` 广播给 Renderer，并立即更新运行时行为。大小变化同时调整透明主窗口和 Sprite Sheet 渲染比例，保持当前帧与背景偏移一致。

Issue #8 继续在同一 SettingsModel 上增加 CPU/GPU/RAM/Disk/Network/cursor/user-idle 等高级阈值字段，并使用第 12 节数值作为默认值。

### 17.3 数据目录

正常安装模式：

```text
Windows: Tauri app config directory / settings.json
macOS: ~/Library/Application Support/... / settings.json
```

Windows portable：

```text
ScreenPartner.exe
data/
  settings.json
  logs/
```

宠物资源目录管理在后续正式宠物选择功能中接入。macOS `.app` 内部资源保持只读，用户配置写入 Application Support。

---

## 18. 当前目录结构

```text
screen-partner/
├─ .github/workflows/
├─ docs/
├─ src/
│  └─ renderer/
│     ├─ core/
│     ├─ pets/
│     ├─ index.html
│     ├─ main.js
│     ├─ settings.html
│     ├─ settings.js
│     ├─ settings.css
│     ├─ sprite-renderer.js
│     └─ styles.css
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/
│  └─ src/
├─ test/
├─ web/
├─ package.json
├─ README.md
└─ DEVELOPMENT.md
```

---

## 19. Rust 与 Renderer 通信

Tauri 后端发送原始系统数据和设置事件，不直接用 telemetry 命令 Renderer 切换 Sprite。

当前/预留事件：

```text
system-metrics
settings-changed
pet-changed
platform-event
```

`settings-changed` 属于配置同步事件。Renderer 收到后更新 Sprite scale、RandomBehavior 和 system-awareness gate。系统行为仍交给 BehaviorArbiter。

用户即时交互来自 Renderer pointer 事件，通过明确的 interaction interruption API 修改 AnimationPlayer；该路径只开放给本设计规定的交互类型。

---

## 20. 日志

```text
INFO   启动、宠物切换、平台初始化
DEBUG  系统指标、Arbiter 判定、动作边界、即时交互、设置变化
WARN   指标读取失败、宠物资源字段缺失
ERROR  图集加载失败、设置文件写入失败
```

诊断日志记录 telemetry gate、arbiter winner、当前动画状态、随机调度和即时中断来源，供人工测试定位状态切换问题。

---

## 21. GitHub Actions

当前 CI 同步构建 Windows x64 与 macOS ARM64，执行：

```text
JS tests
cargo fmt --check
cargo test
cargo clippy -- -D warnings
Windows portable release build
macOS ARM64 DMG build
Artifact upload
```

Windows 测试 Artifact 使用 `SCREEN_PARTNER_DEV_UI=1` 和 `SCREEN_PARTNER_PORTABLE=1`。macOS 测试 Artifact 使用 `SCREEN_PARTNER_DEV_UI=1`。

Tag `v*` 的正式 Release 工作流放到 Phase 7。

---

## 22. 测试要求

### 动画边界

覆盖中间帧请求、最后一帧 duration、连续决策覆盖、高低优先级、latched 信号消费与超时。

### 即时交互

覆盖：

- 中断从目标动作第 0 帧开始。
- 被中断动作的旧 `pendingDecision` 被清除。
- 单击动作只播放一轮并恢复系统行为。
- 拖动 P0 持续压过实时系统行为。
- 松手恢复当前系统行为。
- 拖动可以中断点击动作。

双击 300ms 分类、4px drag threshold、同手势左右方向变化继续进行 Win/macOS 人工验证。

### Codex 时间

Fake Clock 验证九组默认动画每一帧 duration。

### Telemetry

验证 CPU、RAM、Disk/Network delta、GPU 可用/不可用、磁盘压力、cursor feedback、读取失败、睡眠恢复后的第一笔 delta。

### 设置

自动验证：

- schema v1 → v2 迁移。
- 默认 DesktopSettings。
- 非法 scale 回退。
- Sprite scale 同步改变帧尺寸、sheet 尺寸和 background offset。
- main/settings 两个 Renderer 入口通过语法检查。

人工验证：

- 75/100/125/150% 实际显示与位置保持。
- 始终置顶即时切换。
- 随机行为和系统感知开关。
- 开机启动。
- 显示/隐藏/召回。
- 重启后设置持久化。
- Windows portable `data/settings.json`。

---

## 23. 第一阶段验收

MVP 需要满足：

- Windows 与 macOS 都能显示透明宠物。
- 九组动作时间与 Codex 基准一致。
- 系统、随机、Debug 等普通请求遵循动作边界。
- 拖动和已识别单/双击按第 8.2 节立即响应。
- CPU、GPU、RAM、Disk、Network 与平台反馈能驱动行为。
- 系统阈值具备持续时间和滞回。
- 普通状态能产生随机动作。
- 可拖动、保存位置、召回、调节大小、切换置顶和退出。
- 正式设置窗口可以保存基础 DesktopSettings。
- GitHub Actions 生成 Windows 与 macOS Artifact。

---

## 24. 推荐开发阶段

### Phase 0A: 仓库与桌面外壳

- Tauri 2 + Rust + Vanilla JS。
- Windows x64 / macOS ARM64 Actions。
- 透明无边框窗口。
- 静态占位宠物。
- macOS 透明窗口常驻功耗观察。

### Phase 0B: 纯 JS 动画核心

- `NormalizedPet`。
- `CodexDefaultAnimations`。
- Fake Clock。
- frame deadline。
- 睡眠与长暂停恢复。

### Phase 1: Codex Sprite Renderer

- v1 图集解析与标准化。
- 九组动作。
- Codex 逐帧 duration。
- Debug 手动状态菜单。

### Phase 2: Action Boundary

- `currentState`。
- `pendingDecision`。
- continuous / latched 信号。
- 单槽决策。
- 自动化测试。

### Phase 3: Telemetry

CPU、RAM、Disk、Network 与 Rust → Renderer 事件。

### Phase 4: BehaviorArbiter

优先级、Busy / Pressure / Waiting、持续时间、滞回、GPU、磁盘压力与平台反馈。

### Phase 5: RandomBehavior

随机定时、权重、冷却、高优先级抑制。

### Phase 6: Desktop UX

- 应用控制拖动与位置保存。
- 拖动即时 Sprite 反馈。
- 单击/双击分类与即时动作。
- 托盘/Menu Bar、显示/隐藏、召回。
- 正式设置窗口。
- 宠物大小、置顶、随机动作、系统感知、启动项。
- Settings schema v2。
- Issue #8 高级行为阈值设置。

### Phase 7: Release

Windows installer + portable、macOS DMG、Tag Release、更新日志。

---

## 25. 第二阶段扩展

前台程序分类和 Codex/Claude/Gemini/ComfyUI 事件统一转换成 `BehaviorSignal`。扩展模块禁止直接调用 Sprite 即时中断接口。即时中断权限保留给本设计明确列出的用户交互。

---

## 26. 参考项目使用方式

### `jieyangxchen/codex-pet-desktop`

参考 Tauri 2 外壳、透明窗口、托盘、宠物资源管理和跨平台打包。Screen Partner 使用自己的 AnimationPlayer、Action Boundary 和 interaction interrupt 规则。

### `thanh-abaii/codex-pet`

参考 CPU、RAM、Disk、Network 采样与状态映射思路。具体实现改写为 Rust Adapter。

### OpenAI Codex

作为默认图集、帧位置、逐帧 duration、`pet.json` 动画字段的当前基准。

---

## 27. 交给 Codex 开发时的产品约束

1. 技术栈使用 Tauri 2 + Rust + Vanilla JavaScript。
2. Windows x64 与 macOS Apple Silicon 同步构建。
3. 第一阶段使用 Codex v1 Sprite Sheet。
4. 默认动画使用第 7 节逐帧数值。
5. 普通状态请求进入 BehaviorArbiter / AnimationPlayer 的 `pendingDecision`。
6. 普通状态请求禁止在中间帧切换。
7. 普通动作最后一帧完整显示自己的 duration。
8. 普通状态切换在 Action Boundary 应用。
9. `pendingDecision` 保存优先级、来源、原因和时间。
10. 系统采样线程禁止直接修改 Sprite。
11. 随机动作不能覆盖更高优先级状态。
12. 指标读取失败时桌宠继续运行。
13. 平台专属功能通过 Adapter 隔离。
14. 第一阶段不引入 React、账号系统、数据库或大型状态管理库。
15. 每个阶段先补逻辑测试，再生成 Actions 测试 Artifact。
16. 随机动作和后续普通一次性自动事件使用 latched signal。
17. 睡眠或长暂停后禁止快速补播欠下的帧。
18. Debug 构建可显示九状态开发菜单，Release 构建隐藏。
19. 活跃拖动使用专用 P0 immediate interaction，并保留 continuous drag signal。
20. 单击先进行 300ms 双击分类，分类完成后立即播放一次 `waving`。
21. 双击分类完成后立即播放一次 `jumping`，取消尚未确认的单击。
22. Drag 可以立即中断 `waving` / `jumping`；松手重新读取实时行为。
23. Debug 手动状态继续遵循 Action Boundary，禁止把通用 P0 都改成即时中断。
24. Settings schema 变更必须提供旧版本迁移或明确回退规则。
25. Windows portable 与安装模式使用独立且可写的设置路径。

---

## 28. 首批开发任务

```text
Task 1
初始化 Tauri 2 + Rust + Vanilla JS。
配置 Windows x64 / macOS ARM64 Actions。
建立透明窗口与静态占位宠物。

Task 2
建立 NormalizedPet 与 CodexDefaultAnimations。

Task 3
实现 AnimationPlayer 与 Fake Clock。

Task 4
实现 pendingDecision、Action Boundary、continuous / latched 信号。

Task 5
加入 Codex v1 Sprite Renderer。

Task 6
实现 Rust Telemetry。

Task 7
实现 BehaviorArbiter、持续时间与滞回。

Task 8
加入 RandomBehavior。

Task 9
完成 Phase 6 Desktop UX：即时拖动、点击交互、正式设置窗口、大小、置顶、位置保存、召回和启动项。

Task 10
将 Issue #8 的可配置行为阈值接入 SettingsModel / SettingsUI。

Task 11
输出 Windows 与 macOS 正式发布产物。
```

---

## 29. 参考资料

1. OpenAI Codex pet model source  
   https://github.com/openai/codex/blob/main/codex-rs/tui/src/pets/model.rs
2. Tauri 2 GitHub Actions  
   https://v2.tauri.app/distribute/pipelines/github/
3. Tauri 2 create project  
   https://v2.tauri.app/start/create-project/
4. Tauri macOS signing  
   https://v2.tauri.app/distribute/sign/macos/
5. Tauri Window API  
   https://v2.tauri.app/reference/javascript/api/namespacewindow/
6. Tauri transparent window power issue #15471  
   https://github.com/tauri-apps/tauri/issues/15471
7. Rust `sysinfo`  
   https://docs.rs/sysinfo/latest/
8. `jieyangxchen/codex-pet-desktop`  
   https://github.com/jieyangxchen/codex-pet-desktop
9. `thanh-abaii/codex-pet`  
   https://github.com/thanh-abaii/codex-pet

---

## 30. 当前决策摘要

Screen Partner 继续使用 Windows + macOS 共用核心设计。Tauri 2 + Rust 负责平台外壳和系统能力，Vanilla JavaScript Renderer 负责 Sprite、行为仲裁和交互语义。

Action Boundary 继续约束系统状态、随机动作、Debug 和未来自动事件。活跃拖动与已经完成分类的单击/双击使用明确的即时交互入口。Drag 的语义优先于点击动作；点击动作完成一轮后恢复实时 BehaviorArbiter 结果。

Phase 6 使用 Settings schema v2 和独立设置窗口承载 Desktop UX。当前基础字段包括大小、置顶、随机动作、系统感知和开机启动。Issue #8 将 Phase 4 已验收阈值作为默认值接入同一设置模型。

Windows portable 配置保持在 exe 同目录 `data/settings.json`；后续安装版和 macOS 使用系统应用配置目录。Phase 6 完成人工验收后进入 Release 阶段。
