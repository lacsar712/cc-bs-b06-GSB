# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 应变片校准到期拦截

- 报送读数必须带**应变片片号**；该片**校准到期后禁止再报**，写口直接挡回（HTTP 409），并说明"已到期，须续期后才可再报送"；未登记校准信息的片号同样挡回。
- 顶栏**「校准到期」专页**：片号到期日一览（片号 / 到期日 / 状态 / 维护人 / 维护时间）+ 拦截记录留痕。
- **测量员**（surveyor）在专页维护到期日：登记新片号、改期、续期都是同一个保存入口；**复核员为观察岗，只读**。
- **写口与专页同一句话**：到期判定只有一份 —— `rules.CALIBRATION_EXPIRED_SQL = "(expires_at < CURRENT_DATE)"`，写口放行检查与专页状态列都拼这同一句 SQL；到期状态不落库，每次现算，不会出现"专页未到期写口仍拦"或"写口放行专页仍显示到期"。
- **续期与报送撞单只许一种结局**：报送写口与续期/改期写口都先取片号级事务锁（`pg_advisory_xact_lock(hashtext(片号))`）串行化，检查与落库同事务提交，锁只放行一方先完成，另一方读到已提交的新到期日。
- 每次被挡回的报送都写入 `calibration_blocks` 拦截记录（时间 / 片号 / 跨段 / 微应变 / 原因 / 提交人），专页可查。

### 验收流程（片号甲）

种子数据预置片号 **甲**（到期日 = 今天 + 365 天）：

1. 甲未到期 → 提交读数 → **收下**（201，入队判定）；
2. 专页把甲的到期日改到**昨天** → 再提交 → **挡回**（409：校准已到期，须续期后才可再报送），拦截记录留痕；
3. 专页给甲**续期**到未来日期 → 再提交 → **收下**；
4. 专页状态列与写口放行结果始终一致。

## 技术栈

| 层 | 选型 |
|----|------|
| 接口 | Python Sanic + psycopg（异步连接池） |
| 工人 | `worker.py`（psycopg 同步，`FOR UPDATE SKIP LOCKED`） |
| 页面 | Mithril.js + Vite，nginx 反代 `/api` |
| 数据库 | PostgreSQL 16 |

## 端口

| 服务 | 地址 |
|------|------|
| 页面 | http://localhost:3198 |
| 接口 | http://localhost:8198 |
| PostgreSQL | localhost:54398（库名 `bridgestrain`） |

## 账号

| 用户 | 密码 | 权限 |
|------|------|------|
| surveyor | surv123456 | 测量员，可提交读数、维护校准到期日 |
| reviewer | rev123456 | 复核员（观察岗），只读列表与校准专页 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
