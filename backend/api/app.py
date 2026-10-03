import os
from datetime import date, datetime, timedelta, timezone
from urllib.parse import unquote

import jwt
from passlib.context import CryptContext
from sanic import Sanic
from sanic.response import json as sanic_json

from db import create_pool, ensure_schema, seed_if_empty

SECRET = os.environ.get("JWT_SECRET", "bridge-strain-dev-secret")
pwd = CryptContext(schemes=["bcrypt"], deprecated="auto")

USERS = {
    "surveyor": {"role": "writer", "password_hash": pwd.hash("surv123456")},
    "reviewer": {"role": "reader", "password_hash": pwd.hash("rev123456")},
}

app = Sanic("bridge-strain-shift")


def _auth_header(request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth[7:].strip()
    return None


def _decode_user(token: str | None) -> dict | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, SECRET, algorithms=["HS256"])
    except jwt.InvalidTokenError:
        return None
    sub = payload.get("sub")
    if sub not in USERS:
        return None
    return {"username": sub, "role": payload.get("role")}


def _require_user(request) -> dict:
    user = _decode_user(_auth_header(request))
    if not user:
        return None
    return user


def _iso(dt) -> str | None:
    if dt is None:
        return None
    return dt.isoformat()


def _gauge_out(r) -> dict:
    # expired 与 phrase 均由数据库函数 gauge_is_expired / gauge_phrase 算出，
    # 与写口拦截使用同一事实源，前端原样渲染，不自行拼句。
    return {
        "span_code": r["span_code"],
        "calibrated_until": r["calibrated_until"].isoformat(),
        "expired": r["expired"],
        "status_phrase": r["status_phrase"],
        "updated_by": r["updated_by"],
        "updated_at": _iso(r["updated_at"]),
    }


@app.before_server_start
async def setup(_app, _loop):
    pool = await create_pool()
    _app.ctx.pool = pool
    await ensure_schema(pool)
    await seed_if_empty(pool)


@app.after_server_stop
async def teardown(_app, _loop):
    pool = _app.ctx.pool
    if pool:
        await pool.close()


@app.get("/api/health")
async def health(_request):
    return sanic_json({"status": "ok", "service": "bridge-strain-shift"})


@app.post("/api/auth/login")
async def login(request):
    body = request.json or {}
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    user = USERS.get(username)
    if not user or not pwd.verify(password, user["password_hash"]):
        return sanic_json({"detail": "用户名或密码错误"}, status=401)
    exp = datetime.now(timezone.utc) + timedelta(hours=8)
    token = jwt.encode(
        {"sub": username, "role": user["role"], "exp": exp},
        SECRET,
        algorithm="HS256",
    )
    return sanic_json(
        {"access_token": token, "username": username, "role": user["role"]}
    )


@app.get("/api/readings")
async def list_readings(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT id, span_code, microstrain, verdict, reason, status,
                       created_by, created_at, processed_at
                FROM strain_readings
                ORDER BY id DESC
                """
            )
            rows = await cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "id": r["id"],
                "span_code": r["span_code"],
                "microstrain": r["microstrain"],
                "verdict": r["verdict"],
                "reason": r["reason"],
                "status": r["status"],
                "created_by": r["created_by"],
                "created_at": _iso(r["created_at"]),
                "processed_at": _iso(r["processed_at"]),
            }
        )
    return sanic_json(out)


@app.post("/api/readings")
async def create_reading(request):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    if user["role"] != "writer":
        return sanic_json({"detail": "观察岗只读，不能提交应变读数"}, status=403)
    body = request.json or {}
    span_code = str(body.get("span_code", "")).strip()
    if not span_code:
        return sanic_json({"detail": "跨段编号不能为空"}, status=400)
    try:
        microstrain = float(body.get("microstrain"))
    except (TypeError, ValueError):
        return sanic_json({"detail": "微应变必须是数字"}, status=400)

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                # 锁片号行后再判定：与续期事务互斥，
                # 报送与续期几乎同时撞上时由行锁串行化，只可能有一种结局。
                await cur.execute(
                    """
                    SELECT calibrated_until,
                           gauge_is_expired(calibrated_until) AS expired,
                           gauge_phrase(calibrated_until) AS status_phrase
                    FROM gauges
                    WHERE span_code = %s
                    FOR UPDATE
                    """,
                    (span_code,),
                )
                gauge = await cur.fetchone()
                if gauge is None:
                    return sanic_json(
                        {"detail": f"片号 {span_code} 未登记，请先在校准到期专页维护到期日"},
                        status=400,
                    )

                if gauge["expired"]:
                    reason = gauge["status_phrase"]
                    await cur.execute(
                        """
                        INSERT INTO submission_blocks
                            (span_code, microstrain, blocked_by, reason, calibrated_until)
                        VALUES (%s, %s, %s, %s, %s)
                        RETURNING id, blocked_at
                        """,
                        (
                            span_code,
                            microstrain,
                            user["username"],
                            reason,
                            gauge["calibrated_until"],
                        ),
                    )
                    block = await cur.fetchone()
                    return sanic_json(
                        {
                            "detail": reason,
                            "blocked": True,
                            "block_id": block["id"],
                            "span_code": span_code,
                            "calibrated_until": gauge["calibrated_until"].isoformat(),
                        },
                        status=409,
                    )

                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, status, created_by, created_at)
                    VALUES (%s, %s, 'pending', %s, now())
                    RETURNING id, span_code, microstrain, verdict, reason, status,
                              created_by, created_at, processed_at
                    """,
                    (span_code, microstrain, user["username"]),
                )
                row = await cur.fetchone()

    return sanic_json(
        {
            "id": row["id"],
            "span_code": row["span_code"],
            "microstrain": row["microstrain"],
            "verdict": row["verdict"],
            "reason": row["reason"],
            "status": row["status"],
            "created_by": row["created_by"],
            "created_at": _iso(row["created_at"]),
            "processed_at": None,
            "message": "已入队，后台工人将认领并判定",
        },
        status=201,
    )


@app.get("/api/gauges")
async def list_gauges(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT span_code, calibrated_until, updated_by, updated_at,
                       gauge_is_expired(calibrated_until) AS expired,
                       gauge_phrase(calibrated_until) AS status_phrase
                FROM gauges
                ORDER BY expired DESC, span_code
                """
            )
            rows = await cur.fetchall()
    return sanic_json([_gauge_out(r) for r in rows])


def _parse_until(raw) -> date | None:
    try:
        return datetime.strptime(str(raw).strip(), "%Y-%m-%d").date()
    except (TypeError, ValueError):
        return None


@app.put("/api/gauges/<span_code>")
async def upsert_gauge(request, span_code: str):
    user = _require_user(request)
    if not user:
        return sanic_json({"detail": "未登录"}, status=401)
    # 观察岗只读：片号到期日只有测量员能维护。
    if user["role"] != "writer":
        return sanic_json({"detail": "观察岗只读，不能维护校准到期日"}, status=403)
    # 浏览器/nginx 会把路径中的片号百分号编码，Sanic 路径参数原样给出，需统一解码。
    span_code = unquote(span_code).strip()
    if not span_code:
        return sanic_json({"detail": "片号不能为空"}, status=400)
    body = request.json or {}
    until = _parse_until(body.get("calibrated_until"))
    if until is None:
        return sanic_json(
            {"detail": "校准到期日格式应为 YYYY-MM-DD"}, status=400
        )

    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.transaction():
            async with conn.cursor() as cur:
                # 与报送事务争同一行锁：先到先定，续期与报送撞车只许一种结局。
                await cur.execute(
                    """
                    INSERT INTO gauges (span_code, calibrated_until, updated_by, updated_at)
                    VALUES (%s, %s, %s, now())
                    ON CONFLICT (span_code) DO UPDATE
                        SET calibrated_until = EXCLUDED.calibrated_until,
                            updated_by = EXCLUDED.updated_by,
                            updated_at = now()
                    RETURNING span_code, calibrated_until, updated_by, updated_at,
                              gauge_is_expired(calibrated_until) AS expired,
                              gauge_phrase(calibrated_until) AS status_phrase
                    """,
                    (span_code, until, user["username"]),
                )
                gauge = await cur.fetchone()
                note = str(body.get("note", "")).strip()
                if not note:
                    note = "续期" if not gauge["expired"] else "修改到期日"
                await cur.execute(
                    """
                    INSERT INTO calibration_log
                        (span_code, calibrated_until, changed_by, note)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (span_code, until, user["username"], note),
                )

    return sanic_json(_gauge_out(gauge))


@app.get("/api/blocks")
async def list_blocks(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT b.id, b.span_code, b.microstrain, b.blocked_by,
                       b.blocked_at, b.reason, b.calibrated_until,
                       gauge_is_expired(b.calibrated_until) AS now_expired
                FROM submission_blocks b
                ORDER BY b.id DESC
                LIMIT 200
                """
            )
            rows = await cur.fetchall()
    out = [
        {
            "id": r["id"],
            "span_code": r["span_code"],
            "microstrain": r["microstrain"],
            "blocked_by": r["blocked_by"],
            "blocked_at": _iso(r["blocked_at"]),
            "reason": r["reason"],
            "calibrated_until": r["calibrated_until"].isoformat(),
            "now_expired": r["now_expired"],
        }
        for r in rows
    ]
    return sanic_json(out)


@app.get("/api/calibration-log")
async def list_calibration_log(request):
    if not _require_user(request):
        return sanic_json({"detail": "未登录"}, status=401)
    span_code = str(request.args.get("span_code", "")).strip()
    pool = request.app.ctx.pool
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            if span_code:
                await cur.execute(
                    """
                    SELECT id, span_code, calibrated_until, changed_by,
                           changed_at, note
                    FROM calibration_log
                    WHERE span_code = %s
                    ORDER BY id DESC
                    LIMIT 200
                    """,
                    (span_code,),
                )
            else:
                await cur.execute(
                    """
                    SELECT id, span_code, calibrated_until, changed_by,
                           changed_at, note
                    FROM calibration_log
                    ORDER BY id DESC
                    LIMIT 200
                    """
                )
            rows = await cur.fetchall()
    out = [
        {
            "id": r["id"],
            "span_code": r["span_code"],
            "calibrated_until": r["calibrated_until"].isoformat(),
            "changed_by": r["changed_by"],
            "changed_at": _iso(r["changed_at"]),
            "note": r["note"],
        }
        for r in rows
    ]
    return sanic_json(out)
