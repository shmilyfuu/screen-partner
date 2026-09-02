# Screen Partner 开发设计文档 v0.2

**项目名称:** Screen Partner  
**文档日期:** 2026-09-02  
**仓库:** `shmilyfuu/screen-partner`  
**目标平台:** Windows 10/11 x64、macOS Apple Silicon；预留 macOS Intel / Universal  
**首选技术栈:** Tauri 2 + Rust + HTML/CSS/Vanilla JavaScript  
**宠物资源协议:** 优先兼容 Codex `pet.json + spritesheet.webp`，第一阶段以 v1 图集为基准。

## 0. v0.2 变更摘要

v0.2 延续 v0.1 的产品范围与技术路线，补齐会直接影响实现的状态语义。

- `pendingState` 扩展为 `pendingDecision`，同时保存状态、优先级、来源、原因与请求时间。DEBUG 日志里能直接看到 `cpu_busy`、`double_click` 这类来源。
- 单击、双击、随机动作、拖动方向使用一次性锁存信号，直到动作边界消费或达到有效期。用户点一下宠物后，即使当前 `idle` 还剩几秒，动作结束后仍会看到一次挥手。
- CPU、RAM、Disk、Network、用户空闲时间使用持续型信号，每次 BehaviorArbiter 计算都允许刷新或撤销。任务管理器里短促的数值跳动不会留下很久以后才补播的动作。
- 动画时钟增加系统睡眠、WebView 长暂停与恢复规则。笔记本重新打开后，画面从合盖前当前帧的剩余时间继续。
- `NormalizedPet` 增加 `sourceFormat`，Codex v1 先转换成统一逐帧 `durationMs` 再进入播放器。播放器只需要理解“哪一格图、显示多久”。
- 设置文件区分正常安装模式与 Windows portable 模式。用户打开数据目录时能直接看到设置、宠物与日志文件夹。
- Debug 构建保留九状态手动触发入口，Release 构建隐藏开发菜单。测试包里可以连续点状态观察动作边界。
- Phase 0 增加 macOS 透明窗口常驻功耗观察。桌面静置一段时间后，需要记录透明窗口与普通窗口的资源差异。

---

## 1. 项目定义

Screen Partner 是独立运行的常驻桌面宠物应用。核心信号来自电脑自身运行状态，Codex、Claude、ComfyUI 等应用事件属于后续可选扩展。

关闭 Codex 或未安装 Agent 时，宠物仍能独立运行。CPU、内存、磁盘、网络、用户空闲时间等数据会交给行为系统，行为系统只提出下一动作。桌面角落的小角色会先把眼前动作完整播完，再从下一动作第 0 帧开始。

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
11. 任意状态变化等待当前动作完整结束。
12. CPU、RAM、Disk、Network 系统采样。
13. 系统状态驱动动作。
14. 普通状态下随机动作。
15. 鼠标单击、双击、拖动等基础互动。
16. GitHub Actions 自动测试与构建。
17. Windows 与 macOS 开发 Artifact 可下载测试。
18. Tag 构建生成 GitHub Release 安装文件。

MVP 运行时，用户启动编译任务或大型下载，宠物会先完成当前姿势，然后切到对应动作；任务结束后，同样等到动作边界再回到日常状态。

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

第一阶段界面保持轻量。桌面主要显示宠物本体，设置集中到托盘或菜单栏，屏幕上不长期悬挂系统仪表盘。

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

Windows 与 macOS 使用相同动画帧、动作边界和随机行为逻辑。平台差异集中于指标来源、窗口细节、启动项和签名发布。打开核心代码时，平台判断不应散落在动画播放器里。

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

当前动作一旦开始，必须显示全部帧，并让最后一帧完整显示自己的 duration。动作边界到达后才能应用下一状态。

系统指标、随机动作、单击、双击、拖动、Debug 手动状态与后续 Agent 事件都遵循同一规则。

### 8.2 Runtime

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
  pendingDecision: PendingDecision;
  currentFrameIndex: number;
  frameStartedAt: number;
  frameDeadline: number;
  actionCycleId: number;
}
```

### 8.3 单槽决策

`pendingDecision` 保存当前最新有效结果，不使用普通 FIFO 动作队列。CPU 升高后又迅速恢复时，动作边界读取恢复后的结果，早先瞬时状态不会排队到几十秒以后才出现。

### 8.4 优先级

```text
P0  用户正在拖动或明确交互
P1  系统压力 / 异常
P2  持续高负载
P3  外部应用事件
P4  自主随机动作
P5  普通 idle / waiting
```

优先级只影响待切换结果，没有中断当前动作的权限。

### 8.5 信号生命周期

```text
continuous
CPU / RAM / Disk / Network / 用户空闲状态
每次 BehaviorArbiter 计算都可刷新或撤销

latched
单击 / 双击 / 随机动作 / 拖动方向 / 后续一次性事件
保持到动作边界成功消费，或达到有效期
```

默认交互锁存信号有效期先设为 10 秒，后续通过体验测试调整。

### 8.6 睡眠与长暂停

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
  getCurrentState(): PetState;
  getPendingDecision(): PendingDecision;
  getCurrentFrame(): number;
  onActionBoundary(handler: ActionBoundaryHandler): void;
}
```

自动化测试必须证明：中间帧收到请求时 `currentState` 与 `currentFrameIndex` 不会立刻变化；最后一帧 duration 完整结束后的第一个 tick 才允许切换。

---

## 10. BehaviorArbiter

输入来自系统指标、用户活动、交互、外部事件和随机行为。输出统一为：

```ts
interface BehaviorDecision {
  state: PetState;
  priority: number;
  reason: string;
  source: StateSource;
  decidedAt: number;
}
```

BehaviorArbiter 建议每 500–1000 ms 计算一次。持续型信号每轮刷新，锁存型信号保留到消费或超时。最终结果写入 `pendingDecision`。

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

阈值、持续时间、滞回与行为分类放在行为层。`user_idle_seconds` 由平台 Adapter 获取，读取失败返回 `None`。第一阶段基础采样频率为 1000 ms。

---

## 12. 第一版系统状态规则

### Busy

建议初值：

- CPU >= 75%，持续 5 秒 → `review`。
- Disk 达到活跃阈值，持续 3 秒 → `running`。
- Network 达到活跃阈值，持续 3 秒 → `running`。

### Pressure

`failed` 用于明确资源压力。初值可采用 RAM >= 92%，持续 10–15 秒。普通游戏或持续高性能使用不应频繁触发负面动作。

### Waiting

系统低活动且用户无输入达到配置时长，同时没有更高优先级事件时使用 `waiting`。

### Idle

其余普通状态使用 `idle`。

---

## 13. 滞回与持续时间

进入与退出阈值分开：

```text
进入 CPU Busy:
CPU >= 75%，持续 5 秒

退出 CPU Busy:
CPU <= 60%，持续 8 秒
```

短促峰值只会出现在 DEBUG 指标里，宠物仍继续眼前日常动作；持续任务达到门槛后才提出 Busy。

---

## 14. 自主随机行为

普通状态随机间隔先采用 30–120 秒，每次触发后重新生成时间。

初始权重：

```text
waving   35%
jumping  20%
waiting  20%
review   10%
idle     15%
```

随机请求采用 latched 信号，并受到系统压力、拖动和高优先级外部事件抑制。

---

## 15. 用户互动

- 单击：请求一次 `waving`。
- 双击：请求一次 `jumping`。
- 拖动：窗口立即跟随指针，Sprite 状态等到动作边界后按方向请求 `running-left` / `running-right`。
- 右键：打开控制面板或上下文菜单。

正式菜单建议包含显示/隐藏、召回、大小、置顶、随机动作、系统感知、宠物选择、数据目录、开机启动、退出。

Debug 构建额外提供九组状态和“恢复自动”。连续点选时，屏幕仍应一套一套完整播放。

---

## 16. Windows 与 macOS

### Windows

第一阶段：透明窗口、WebView2、系统托盘、x64、启动项、CPU/RAM/Disk/Network、用户空闲时间。

### macOS

第一阶段：透明窗口、WebKit WebView、Menu Bar、Apple Silicon、CPU/RAM/Disk/Network、用户空闲时间。开发 Artifact 使用 ad-hoc 签名，正式公开分发后再加入 Developer ID 与 notarization。

### macOS 透明窗口风险

Tauri 2 的 macOS 透明窗口需要 `app.macOSPrivateApi`。该能力不面向 Mac App Store，本项目第一阶段也未计划 App Store。

2026 年 Tauri 公开 issue 仍有透明 WebView 持续触发 WindowServer / WebKit 合成并增加 GPU 活跃度的报告。Phase 0 需要记录静态透明窗口、播放 Sprite 的透明窗口、普通非透明窗口三种场景的资源表现。

若透明窗口长期驻留成本明显偏高，再评估 macOS 平台外壳；核心 Renderer、宠物协议与行为模型继续保持独立。

---

## 17. 设置与数据目录

建议设置结构继续使用 JSON，并采用临时文件 + 原子替换方式写入。

正常安装模式：

```text
Windows: 系统应用数据目录 / Screen Partner
macOS: ~/Library/Application Support/Screen Partner
```

Windows portable：

```text
ScreenPartner.exe
data/
  settings.json
  pets/
  logs/
```

macOS `.app` 内部资源保持只读，用户数据写入 Application Support。

---

## 18. 建议目录结构

```text
screen-partner/
├─ .github/workflows/
├─ docs/
├─ web/
│  ├─ index.html
│  ├─ styles.css
│  └─ main.js
├─ src/
│  ├─ renderer/
│  └─ tests/
├─ src-tauri/
│  ├─ Cargo.toml
│  ├─ tauri.conf.json
│  ├─ capabilities/
│  └─ src/
├─ resources/
├─ package.json
├─ README.md
└─ DEVELOPMENT.md
```

Phase 0A 允许 `web/` 保持最小静态 Renderer。进入 Phase 0B 后再逐步迁移到 `src/renderer` 的正式模块结构。

---

## 19. Rust 与 Renderer 通信

Tauri 后端只发送数据事件，不直接命令 Renderer 切换 Sprite。

建议事件：

```text
system-metrics
settings-changed
pet-changed
platform-event
```

Renderer 收到事件后交给 BehaviorArbiter，最终只向 AnimationPlayer 提交决策。

---

## 20. 日志

```text
INFO   启动、宠物切换、平台初始化
DEBUG  系统指标、Arbiter 判定、动作边界
WARN   指标读取失败、宠物资源字段缺失
ERROR  图集加载失败、设置文件写入失败
```

典型 DEBUG：

```text
[telemetry] cpu=81.2 ram=62.0 disk=18.4MB/s net=0.3MB/s
[arbiter] desired=review priority=2 reason=cpu_busy
[animation] current=idle frame=4 pending=review
[animation] boundary current=idle next=review
```

---

## 21. GitHub Actions

Phase 0 开始同步构建 Windows x64 与 macOS ARM64。首轮工作流使用 Node、Rust stable、Tauri CLI，生成平台图标后构建开发 Artifact。

后续 CI 再加入：

```text
JS tests
cargo fmt --check
cargo clippy
cargo test
```

Tag `v*` 的正式 Release 工作流放到 Phase 7。

---

## 22. 测试要求

### 动画边界

覆盖中间帧请求、最后一帧 duration、连续决策覆盖、高低优先级、latched 信号消费与超时。

### Codex 时间

Fake Clock 验证九组默认动画每一帧 duration。

### Telemetry

验证 CPU、RAM、Disk/Network delta、读取失败、睡眠恢复后的第一笔 delta。

### 设置

验证位置恢复、多显示器召回、损坏 JSON 回落、scale 边界。

---

## 23. 第一阶段验收

MVP 需要满足：

- Windows 与 macOS 都能显示透明宠物。
- 九组动作时间与 Codex 基准一致。
- 任意请求都等待动作边界。
- CPU、RAM、Disk、Network 能驱动行为。
- 系统阈值具备持续时间和滞回。
- 普通状态能产生随机动作。
- 可拖动、保存位置、召回、置顶、退出。
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

优先级、Busy / Pressure / Waiting、持续时间、滞回。

### Phase 5: RandomBehavior

随机定时、权重、冷却、高优先级抑制。

### Phase 6: Desktop UX

拖动、位置保存、托盘/Menu Bar、大小、置顶、召回、启动项。

### Phase 7: Release

Windows installer + portable、macOS DMG、Tag Release、更新日志。

---

## 25. 第二阶段扩展

Windows GPU 可优先研究 NVIDIA NVML；macOS GPU 单独调研。前台程序分类和 Codex/Claude/Gemini/ComfyUI 事件统一转换成 `BehaviorSignal`，禁止扩展模块直接调用 Sprite 切换接口。

---

## 26. 参考项目使用方式

### `jieyangxchen/codex-pet-desktop`

参考 Tauri 2 外壳、透明窗口、托盘、宠物资源管理和跨平台打包。其当前 `setState()` 会立即重置状态与帧，因此 Screen Partner 需要自己的 AnimationPlayer。

### `thanh-abaii/codex-pet`

参考 CPU、RAM、Disk、Network 采样与状态映射思路。具体实现改写为 Rust Adapter。

### OpenAI Codex

作为默认图集、帧位置、逐帧 duration、`pet.json` 动画字段的当前基准。

---

## 27. 交给 Codex 开发时的产品约束

1. 技术栈使用 Tauri 2 + Rust + Vanilla JavaScript。
2. Windows x64 与 macOS Apple Silicon 从项目初期同步构建。
3. 第一阶段使用 Codex v1 Sprite Sheet。
4. 默认动画使用第 7 节逐帧数值。
5. 状态请求只能进入 BehaviorArbiter / AnimationPlayer 的 `pendingDecision`。
6. 中间帧禁止切换状态。
7. 最后一帧必须完整显示自己的 duration。
8. 只有动作边界允许应用下一状态。
9. `pendingDecision` 保存优先级、来源、原因和时间。
10. 系统采样线程禁止直接修改 Sprite。
11. 随机动作不能覆盖更高优先级系统状态。
12. 指标读取失败时桌宠继续运行。
13. 平台专属功能通过 Adapter 隔离。
14. 第一阶段不引入 React、账号系统、数据库或大型状态管理库。
15. 每个阶段先补逻辑测试，再生成 Actions 测试 Artifact。
16. 一次性交互与随机动作使用 latched 信号。
17. 睡眠或长暂停后禁止快速补播欠下的帧。
18. Debug 构建可显示九状态开发菜单，Release 构建隐藏。
19. macOS 透明窗口在 Phase 0 留下常驻功耗观察结果。

---

## 28. 首批开发任务

```text
Task 1
初始化 Tauri 2 + Rust + Vanilla JS。
配置 Windows x64 / macOS ARM64 Actions。
建立透明窗口与静态占位宠物。
记录 macOS 透明窗口资源基线。

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
加入拖动、托盘/Menu Bar、大小、位置保存与召回。

Task 10
输出 Windows 与 macOS 发布产物。
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

Screen Partner 继续按 Windows + macOS 共用核心设计。Tauri 2 + Rust 仍为当前首选，GitHub Actions 承担跨平台原生构建。

动画层沿用 Codex 当前逐帧时间，并加入 Action Boundary、`pendingDecision`、信号生命周期和睡眠恢复规则。系统采样、随机行为、用户互动与后续 Agent 事件只提出下一决策。

第一阶段优先完成动画核心、CPU/RAM/Disk/Network、随机行为与桌面基础能力。GPU、温度和深度应用联动放到后续 Adapter。

macOS 透明窗口的常驻资源表现列为 Phase 0 必测项。桌面长期静置时的实际功耗结果会决定后续是否继续沿用当前 macOS 透明窗口实现。
