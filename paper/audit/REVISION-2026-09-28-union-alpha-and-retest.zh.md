# union-alpha 补充配置与跨轮稳定性记录

## 本轮新增的证据

- union-alpha（运行时为 OpenRouter stealth 匿名模型，256K 上下文，知识截止未公开，归档于 2026-09-17；2026-09-18 Unbiased 声称其为 "Pareto"（composite model），属厂商声明、未经核实，且为组合/路由模型；免费 stealth 路由已无法重跑，见 run-manifest 的 `identity_disclosed` 字段）单轮 S1--S22 两臂补充跑：GLM-5.3-Flash 判官（身份为 harness 声明；经 dsh web 会话内子代理运行，与 focal 的 ZCode 宿主不同，44/44 verdicts），按钉定 rubric（e0a9ff5）从原始 verdicts 复算，断言与归档 aggregate 逐题一致。
- 全 22 题均值 98.07 vs 99.55（+1.48，任务配对 bootstrap 区间 [-0.80, +4.32]，seed 20260907），仅 5 题非零差；剔除 6 个输入暴露题（S1--S3 no-skill 引用 skill references、S17 查阅本机已装包源、S20 越界搜索、S8 with-skill grep 命中 benchmark 材料）后 16 题均值 98.44 vs 99.38（+0.94 [-1.88, +4.69]），16 题中 14 题零差——比 focal 更极端的天花板集中。运行清单另记录：no-skill 臂 S1、S3、S9、S14、S16、S17、S20 与 with-skill 臂 S9、S13 出现静默失败（无收尾消息、无报告）后重派；两臂均有其他未产出报告的尝试；运行中途放宽重试上限、并发由 1 提到 2；仓库 HEAD 在运行中由 f8ab0145 移到 dbca8e45（pilot gate 记录，任务与 skill 输入无变化）。
- GLM-5.2 / GLM-5.3 各三轮归档分数的跨轮稳定性：仅作描述、未做显著性检验：三轮极差中位数四格中三格为 0；均值极差 no-skill/with-skill 分别为 10.0/6.1（5.2）与 10.2/4.9（5.3）。GLM-5.3 两臂极差中位数（0/0）与三轮精确一致率（64%/64%）相同，均值极差之差主要来自 S17 no-skill 的 100 分摆动（第三轮矛盾封顶 + 换判官）；剔除 S17 后 21 题均值极差为 6.0/4.6。with-skill 分数贴近天花板，极差较小部分是机械效应，不据此宣称任一臂更稳；波动集中在少数任务（GLM-5.3 no-skill 最宽 S17=100 即已披露的 zero-cap 案例、S4=62.5；GLM-5.2 S13=40、S4=38）；三轮精确一致率 41%/55%（5.2）与 64%/64%（5.3）；六轮臂级增益方向一致为正。

## 行文落点

- 附录「Newer supplementary configurations」新增两段（union-alpha 段 + 跨轮稳定性段）。
- Threats construct validity 中「test--retest reliability is unmeasured」改为指向新附录的有限声明（run+judge 合并稳定性的界，而非判官单独重测信度）。
- Artifact map 登记两个新脚本。

## 哪些不能宣称

| 声明 | 状态 |
|---|---|
| union-alpha 证明效果跨模型家族 | 不能：单轮、匿名模型、区间含零；仅方向与 focal 一致的描述性补充 |
| 跨轮一致性 = 判官重测信度 | 不能：轮间判官与协议有差异，只能界定 run+judge 合并稳定性 |
| with-skill 臂更稳 | 不能：GLM-5.3 两臂中位极差与精确一致率相同，均值差主要由 S17 驱动，且有天花板效应；未做检验 |

## 工件

- `paper/scripts/analyze-union-alpha-supplement.mjs`（--check 幂等）→ `paper/generated/union-alpha-supplement.json`
- `paper/scripts/analyze-round-reliability.mjs`（--check 幂等）→ `paper/generated/round-reliability.json`
- 两个 `check:paper-union-alpha` / `check:paper-reliability` 已接入 `validate` 链（随 `npm test` 在 CI 执行）。
