# ZeroAgent 内置能力标识

## 当前资产：2026-11-05 用户再次修订

用户要求重设计四个能力，并按ChatGPT的紧凑品牌展示校准输入框。当前四枚WebP已经替换为透明底平面标记；
不再使用下面历史记录中的银白珐琅底板。16px直接显示品牌标记，52px详情由共享组件提供统一容器。
四枚标记和一份背景共113168 bytes（约110.5KiB），均已纳入项目构建，未引用临时目录。

| 当前文件 | 含义 | 本轮生成源 |
| --- | --- | --- |
| create-plugin.webp | 蓝/浅蓝互锁模块，创建插件 | `01a1a877-03b2-7d93-aca7-bbe71d5c7a09/exec-13120b37-caaa-40b2-bc52-8d5b7747bcfe.png` |
| create-skill.webp | 暖金折页与两条指令，创建技能 | `01a1a877-03b2-7d93-aca7-bbe71d5c7a09/exec-0cbbf6ff-d521-41bf-8e16-0fcf2e8268d3.png` |
| product-design.webp | 紫红四模块与中央留白，产品设计 | 原始 `01a1a876-dcf1-7090-b5b1-46795cddb28f/exec-15e0c5cd-fe6e-4dc6-ad6f-cfba9ad820e6.png` 的一次精确修正，接受源为证据目录 `brand/product-design-flat-source.png` |
| generate-image.webp | 青色图框、山形与暖黄太阳，生成图像 | 证据目录 `brand/generate-image-original.png` |
| starters-backdrop.webp | 蓝/淡紫柔和折面，详情起步提示背景 | 证据目录 `brand/plugin-starters-backdrop-source.png` |

生成工具为内置image_gen，标记 `transparent_background:true`，背景false。
标记1254×1254源图经FFmpeg缩小为256×256无损alpha WebP；背景2172×724源图缩放/裁切为1440×400 WebP。
没有手绘SVG、CSS图案或后期重画。证据及源图保留在 `.codex-artifacts/mention-redesign-20261105/brand/`；
所有原始生成仍在 `C:/Users/25834/.codex/generated_images/` 各生成会话内。
已实际检查16/32/52px与浅深底：没有可见噪点；模型源图仍有极低alpha边缘和轻微色调变化，不能称为数学纯色矢量。
产品设计第一稿左下模块有异常孔洞，经一次内置编辑消除，未采用该第一稿。

### 本轮提示词

共同约束：Use case logo-brand; original ZeroAgent compact brand mark, flat crisp vector-like raster, strong optical mass,
one centered mark fills about86% of a square with equal transparent margins, readable16px. Truly transparent background.
No letters/text, enclosing app tile, shadow,3D, silver, bevel or microdetails. Do not copy Figma or OpenAI logos.

- 创建插件：Two broad rounded modular links interlocking diagonally. Cobalt blue #3978D5 with lighter azure #56B3DF section.
  Bold connected silhouette with clear central negative spaces.
- 创建技能：Warm amber folded instruction sheet, broad rounded sheet with a strong folded upper-right corner,
  two substantial light-gold strokes and one dark-gold check-like fold. Minimal2–3bold shapes, #BD863B/#E2AC57.
- 产品设计：Four substantial rounded violet/magenta modules arranged into an open-center design grid, one warmer pink module.
  #8050CD/#C44DAD, simple solid fills. 编辑修正：Preserve exact composition/colors/four silhouettes; fill the bottom-left
  alpha hole and every module interior fully opaque, uniform color. No holes/highlights/specular/shadows/bevel/texture/noise.
  Preserve transparency outside shapes and in the central negative space. No extra shapes or tile.
- 生成图像：Broad cyan/teal landscape-frame outline, one aqua mountain folded into the lower edge, warm golden sun upper right.
  Two or three bold shapes and large transparent negative spaces; no outer app tile.
- 背景：Original horizontal background displayed720×200, soft blue and lavender translucent folded fabric/paper waves,
  diffuse ambient light, broad flowing folds, quiet low-contrast center for three white prompt pills. Pale blue left,
  muted lavender right. Fully opaque. No text, icons, logos, controls, cards, pills, watermark or interface elements.

## 前轮设计记录（已被本轮替换）

2026-11-05 根据用户提供的 ChatGPT 录屏制作。使用内置 `image_gen`，不是从图标库临时挑选的品牌替身，
也不是 OpenAI 或第三方服务标志。四枚标识遵循 ZeroAgent 原有银白立体品牌质感：同一正视视角、圆角底板、
左上柔光、银白主体和光学重量；识别色区分用途，背景外部真实透明。

| 文件 | 能力 | 生成源文件 |
| --- | --- | --- |
| create-plugin.webp | 创建插件 | exec-1d08a6db-fa06-409b-8c97-03fcf0537c62.png |
| generate-image.webp | 生成图像 | exec-85842435-1981-4d59-a7bb-0286d605eba0.png |
| product-design.webp | 产品设计 | exec-aaa55774-f204-4c16-a153-604d6fb7657d.png |
| create-skill.webp | 创建技能 | exec-925f2bf9-9ac0-40a2-9bff-99990b14a61e.png |

原始PNG保留在 `C:/Users/25834/.codex/generated_images/01a1a7a5-830b-74e2-9f13-5d922eb785a3/`。
项目内是256×256无损WebP，通过FFmpeg缩小和格式转换，保留alpha，没有重新绘制或替换图案。
四份资源合计约154KiB，由UI库统一导入、两个前端各自打包，不依赖开发机路径。
资源通过 `lib/extensions/presentation.ts` 注册，同一份文件用于20px侧栏、32px目录、52px详情和16px引用。
个人内容尚无上传品牌资产的契约，使用明确的中性包标回退，不冒充内置或第三方身份。

## 生成提示词

每份资源各用一次内置生成调用，`transparent_background=true`。共同提示词：

> Use case: logo-brand. Create ONE final production-ready square app/plugin icon for ZeroAgent, a restrained AI work product whose main brand is a sculpted satin-silver loop. A coherent family style: a single rounded-square enamel tile with radius 23% of side, front-facing orthographic view, occupies 92% of image with equal transparent margin on all sides. Single large sculpted satin-white/silver ribbon emblem centered, covering 62% of tile. Very subtle bevel, gentle upper-left lighting and depth, restrained refined 3D relief, extremely clean silhouette, no micro-detail, no noise, no text, no letters, no watermark, no extra objects, no background scene, no mockup. Legible at 16px and 20px. Emblem visually substantial, same optical mass as a rounded capital O. Tile has slight tonal shading only, not rainbow. TRUE transparent background outside tile. Export ONE centered icon only, square composition.

分别追加：

- 创建插件：Deep clear blue tile (#3278CA). Emblem: two broad continuous satin-white rounded rectangular ribbon loops interlocked diagonally, showing modular connection and building a plugin. Only two loops, carefully joined and optically balanced.
- 生成图像：Deep teal tile (#238D89). Emblem: one rounded landscape frame, its lower inner edge a single broad folded silver ribbon forming two hills, and one simple round silver sun in the upper-right interior. Frame and hills feel like a single coherent sculptural emblem.
- 产品设计：Refined violet tile (#8053B8). Emblem: four broad rounded satin-white ribbon modules interlocking into a balanced open-center four-petal geometric design grid. Simple square silhouette, clear central negative space; not a flower illustration or star. Original product design emblem.
- 创建技能：Warm muted amber tile (#B77D37). Emblem: one satin-white folded instruction card with a strong folded upper-right corner, and two broad recessed horizontal strokes. A simple distinctive sculpted sheet, no tiny lines, no extra sparkles.
