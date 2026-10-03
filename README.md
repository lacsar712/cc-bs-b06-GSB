# 桥梁应变班交台

测量员上报跨段编号与微应变读数，后台工人用 `FOR UPDATE SKIP LOCKED` 认领待处理队列，按 **80～220 με** 判定 **合格** 或 **越界**。

## 应变片校准到期管理

- 顶栏「校准到期」专页：片号到期日一览、拦截记录、续期/到期日维护留痕。
- 片号校准有效期 **早于当天即到期**，到期后报送写口一律 **409 挡回**，提示「已到期，续期后才许再报」，不入队并写入拦截记录。
- 到期状态由数据库函数 `gauge_is_expired()` / `gauge_phrase()` 单一派生，**写口拦截提示与专页状态是同一句话**，不存在两边不一致。
- 报送事务内 `SELECT ... FOR UPDATE` 锁片号行后再判定，与续期事务互斥；续期与报送同时撞上时由行锁串行化，结局唯一。
- 测量员（writer）可登记片号、维护到期日/续期；复核员（reader，观察岗）只读。

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
| surveyor | surv123456 | 测量员，可提交读数、维护片号到期日 |
| reviewer | rev123456 | 复核员（观察岗），只读 |

## 启动

```bash
cd projects/19-bridge-strain-shift
docker compose up --build
```

健康检查：`GET http://localhost:8198/api/health` → `{"status":"ok","service":"bridge-strain-shift"}`

## 接口

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| POST | `/api/auth/login` | - | 登录取 token |
| GET | `/api/readings` | 登录 | 读数列表 |
| POST | `/api/readings` | 测量员 | 提交读数；片号到期返回 409 并留拦截记录 |
| GET | `/api/gauges` | 登录 | 片号到期日一览（含同源到期状态句） |
| PUT | `/api/gauges/<片号>` | 测量员 | 登记/维护到期日，续期留痕 |
| GET | `/api/blocks` | 登录 | 拦截记录 |
| GET | `/api/calibration-log` | 登录 | 续期/到期日维护留痕（可按 `?span_code=` 过滤） |

## 种子数据

| 跨段 | 微应变 | 结论 |
|------|--------|------|
| 跨中S1 | 150 με | 合格 |
| 支座S2 | 40 με | 越界 |

片号种子：片号甲（30 天后到期，可正常报送）、片号乙（已到期，报送即挡回）、跨中S1 / 支座S2。

## 本地开发（可选）

```bash
cd backend && pip install -r requirements.txt
python -m sanic api.app --host=0.0.0.0 --port=8000 --single-process
python worker.py
cd frontend && npm install && npm run dev
```

接口进程默认监听容器内 **8000**，对外映射 **8198**。
