import os
from datetime import date, timedelta

from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool

from rules import judge_microstrain

DSN = os.environ.get(
    "DATABASE_URL", "postgresql://app:app@localhost:54398/bridgestrain"
)

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS gauges (
    span_code text PRIMARY KEY,
    calibrated_until date NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS calibration_log (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    calibrated_until date NOT NULL,
    changed_by text NOT NULL,
    changed_at timestamptz NOT NULL DEFAULT now(),
    note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_calibration_log_span ON calibration_log (span_code, id DESC);

CREATE TABLE IF NOT EXISTS submission_blocks (
    id serial PRIMARY KEY,
    span_code text NOT NULL,
    microstrain double precision,
    blocked_by text NOT NULL,
    blocked_at timestamptz NOT NULL DEFAULT now(),
    reason text NOT NULL,
    calibrated_until date NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_blocks_time ON submission_blocks (id DESC);

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
"""

# 到期状态的唯一事实源：校准有效期 < 今天 即已到期。
# 写口拦截与专页列表都调用同一个函数，保证两边说同一句话。
STATUS_SQL = """
CREATE OR REPLACE FUNCTION gauge_is_expired(p_until date)
RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
    SELECT p_until < CURRENT_DATE
$$;

CREATE OR REPLACE FUNCTION gauge_phrase(p_until date)
RETURNS text
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE
        WHEN gauge_is_expired(p_until)
            THEN '校准已于 ' || to_char(p_until, 'YYYY-MM-DD') || ' 到期，禁止报送；续期后才许再报'
        ELSE '校准有效期至 ' || to_char(p_until, 'YYYY-MM-DD') || '，未到期，放行'
    END
$$;
"""


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
        await conn.execute(STATUS_SQL)
        await conn.commit()


SEED_GAUGES = [
    ("片号甲", timedelta(days=30)),
    ("片号乙", timedelta(days=-1)),
    ("跨中S1", timedelta(days=90)),
    ("支座S2", timedelta(days=90)),
]


async def seed_if_empty(pool: AsyncConnectionPool) -> None:
    async with pool.connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute("SELECT COUNT(*) AS n FROM strain_readings")
            if (await cur.fetchone())["n"] == 0:
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

            await cur.execute("SELECT COUNT(*) AS n FROM gauges")
            if (await cur.fetchone())["n"] == 0:
                today = date.today()
                for span_code, delta in SEED_GAUGES:
                    until = today + delta
                    await cur.execute(
                        """
                        INSERT INTO gauges (span_code, calibrated_until, updated_by)
                        VALUES (%s, %s, 'system')
                        """,
                        (span_code, until),
                    )
                    await cur.execute(
                        """
                        INSERT INTO calibration_log
                            (span_code, calibrated_until, changed_by, note)
                        VALUES (%s, %s, 'system', '种子数据：初始校准有效期')
                        """,
                        (span_code, until),
                    )
        await conn.commit()


def connect_sync():
    import psycopg

    return psycopg.connect(DSN, row_factory=dict_row)


def ensure_schema_sync(conn) -> None:
    conn.execute(SCHEMA_SQL)
    conn.execute(STATUS_SQL)


def seed_if_empty_sync(conn) -> None:
    row = conn.execute("SELECT COUNT(*) AS n FROM strain_readings").fetchone()
    if row["n"] == 0:
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

    row = conn.execute("SELECT COUNT(*) AS n FROM gauges").fetchone()
    if row["n"] == 0:
        today = date.today()
        for span_code, delta in SEED_GAUGES:
            until = today + delta
            conn.execute(
                """
                INSERT INTO gauges (span_code, calibrated_until, updated_by)
                VALUES (%s, %s, 'system')
                """,
                (span_code, until),
            )
            conn.execute(
                """
                INSERT INTO calibration_log
                    (span_code, calibrated_until, changed_by, note)
                VALUES (%s, %s, 'system', '种子数据：初始校准有效期')
                """,
                (span_code, until),
            )
    conn.commit()
