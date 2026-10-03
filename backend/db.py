import os
from datetime import date, timedelta

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from rules import judge_microstrain

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54398/bridgestrain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS strain_readings (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    verdict text,
    reason text,
    status text NOT NULL DEFAULT 'pending',
    created_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_strain_readings_status ON strain_readings (status, id);

-- 报送须带应变片片号（老数据允许为空，新报送由接口强制必填）
ALTER TABLE strain_readings ADD COLUMN IF NOT EXISTS gauge_code text;

-- 片号 -> 校准到期日。到期状态不落地存储，一律按 expires_at 现算
-- （见 rules.CALIBRATION_EXPIRED_SQL），保证写口与专页说同一句话。
CREATE TABLE IF NOT EXISTS gauge_calibrations (
    gauge_code text PRIMARY KEY,
    expires_at date NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- 拦截记录：每次被挡回的报送都留痕
CREATE TABLE IF NOT EXISTS calibration_blocks (
    id serial PRIMARY KEY,
    gauge_code text NOT NULL,
    span_code text NOT NULL,
    microstrain double precision NOT NULL,
    reason text NOT NULL,
    expires_at date,
    attempted_by text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_calibration_blocks_id ON calibration_blocks (id DESC);
"""

# 种子片号：验收流程"片号甲未到期交应收下"开箱可跑
SEED_GAUGE_CODE = "甲"
SEED_GAUGE_VALID_DAYS = 365


async def create_pool() -> AsyncConnectionPool:
    pool = AsyncConnectionPool(
        conninfo=DSN,
        min_size=1,
        max_size=5,
        kwargs={"row_factory": dict_row},
        open=False,
    )
    await pool.open()
    return pool


async def ensure_schema(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        await conn.execute(SCHEMA_SQL)
        await conn.commit()


async def seed_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM strain_readings")
            row = await cur.fetchone()
            if row["n"] > 0:
                return
            samples = [
                ("跨中S1", 150.0),
                ("支座S2", 40.0),
            ]
            for span_code, microstrain in samples:
                verdict, reason = judge_microstrain(microstrain)
                await cur.execute(
                    """
                    INSERT INTO strain_readings
                        (span_code, microstrain, verdict, reason, status, created_by, processed_at)
                    VALUES (%s, %s, %s, %s, 'done', 'surveyor', now())
                    """,
                    (span_code, microstrain, verdict, reason),
                )
        await conn.commit()


async def seed_calibrations_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM gauge_calibrations")
            row = await cur.fetchone()
            if row["n"] > 0:
                return
            await cur.execute(
                """
                INSERT INTO gauge_calibrations (gauge_code, expires_at, updated_by)
                VALUES (%s, %s, %s)
                ON CONFLICT (gauge_code) DO NOTHING
                """,
                (
                    SEED_GAUGE_CODE,
                    date.today() + timedelta(days=SEED_GAUGE_VALID_DAYS),
                    "system",
                ),
            )
        await conn.commit()


def connect_sync():
    import psycopg

    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM strain_readings").fetchone()
    if row["n"] > 0:
        return
    samples = [
        ("跨中S1", 150.0),
        ("支座S2", 40.0),
    ]
    for span_code, microstrain in samples:
        verdict, reason = judge_microstrain(microstrain)
        conn.execute(
            """
            INSERT INTO strain_readings
                (span_code, microstrain, verdict, reason, status, created_by, processed_at)
            VALUES (%s, %s, %s, %s, 'done', 'surveyor', now())
            """,
            (span_code, microstrain, verdict, reason),
        )
    conn.commit()


def seed_calibrations_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM gauge_calibrations").fetchone()
    if row["n"] > 0:
        return
    conn.execute(
        """
        INSERT INTO gauge_calibrations (gauge_code, expires_at, updated_by)
        VALUES (%s, %s, %s)
        ON CONFLICT (gauge_code) DO NOTHING
        """,
        (
            SEED_GAUGE_CODE,
            date.today() + timedelta(days=SEED_GAUGE_VALID_DAYS),
            "system",
        ),
    )
    conn.commit()
