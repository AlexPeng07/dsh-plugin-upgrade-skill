# union-alpha 补充配置与跨轮稳定性记录

## 本轮新增的证据

- union-alpha（OpenRouter stealth 匿名内测模型，256K 上下文，知识截止未公开，归档于 2026-09-17）单轮 S1--S22 两臂补充跑：与 focal 同源的 GLM-5.3-Flash 判官（44/44 verdicts），按钉定 rubric（e0a9ff5）从原始 verdicts 复算，断言与归档 aggregate 逐题一致。
- 全 22 题均值 98.07 vs 99.55（+1.48，任务配对 bootstrap 区间 [-0.80, +4.32]，seed 20260907），仅 5 题非零差；剔除 6 个输入暴露题（S1--S3 no-skill 引用 skill references、S17 查阅本机已装包源、S20 越界搜索、S8 with-skill grep 命中 benchmark 材料）后 16 题均值 98.44 vs 99.38（+0.94 [-1.88, +4.69]），16 题中 14 题零差——比 focal 更极端的天花板集中。
- GLM-5.2 / GLM-5.3 各三轮归档分数的跨轮稳定性：with-skill 臂显著稳于 no-skill 臂（三轮极差中位数四格中三格为 0；均值极差 no-skill/with-skill 分别为 10.0/6.1 与 10.2/4.9）；波动集中在少数任务（GLM-5.3 no-skill 最宽 S17=100 即已披露的 zero-cap 案例、S4=62.5；GLM-5.2 S13=40、S4=38）；三轮精确一致率 41%/55%（5.2）与 64%/64%（5.3）；六轮臂级增益方向一致为正。

## 行文落点

- 附录「Newer supplementary configurations」新增两段（union-alpha 段 + 跨轮稳定性段）。
- Threats construct validity 中「test--retest reliability is unmeasured」改为指向新附录的有限声明（run+judge 合并稳定性的界，而非判官单独重测信度）。
- Artifact map 登记两个新脚本。

## 哪些不能宣称

| 声明 | 状态 |
|---|---|
| union-alpha 证明效果跨模型家族 | 不能：单轮、匿名模型、区间含零；仅方向与 focal 一致的描述性补充 |
| 跨轮一致性 = 判官重测信度 | 不能：轮间判官与协议有差异，只能界定 run+judge 合并稳定性 |
| with-skill 更稳是因果结论 | 不能：描述性差异，未控制任务难度与轮间协议变化 |

## 工件

- `paper/scripts/analyze-union-alpha-supplement.mjs`（--check 幂等）→ `paper/generated/union-alpha-supplement.json`
- `paper/scripts/analyze-round-reliability.mjs`（--check 幂等）→ `paper/generated/round-reliability.json`
- 两个 `check:paper-union-alpha` / `check:paper-reliability` 已接入 `validate` 链（随 `npm test` 在 CI 执行）。
