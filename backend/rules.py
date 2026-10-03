"""桥梁微应变判定与应变片校准到期判定。"""

# 校准到期判定全系统只有这一份：报送写口（POST /api/readings 放行/挡回）
# 与校准到期专页（GET /api/calibrations 状态列）共用同一句 SQL 谓词，
# 两边对同一片号永远说同一句话，不会出现"专页未到期写口仍拦"或
# "写口已放行专页仍显示到期"的不一致。到期状态不落库存储，每次现算。
CALIBRATION_EXPIRED_SQL = "(expires_at < CURRENT_DATE)"


def judge_microstrain(microstrain: float) -> tuple[str, str]:
    if 80 <= microstrain <= 220:
        return "合格", "微应变处于 80～220 με 设计允许范围内"
    if microstrain < 80:
        return "越界", "微应变低于 80 με 设计下限"
    return "越界", "微应变高于 220 με 设计上限"


def calibration_status(expired: bool) -> str:
    """专页状态列与写口共用的状态文案。"""
    return "已到期" if expired else "未到期"


def block_reason_expired(gauge_code: str, expires_on) -> str:
    """到期挡回原因：回给提交人，同时写入拦截记录留痕。"""
    return f"应变片 {gauge_code} 校准已到期（到期日 {expires_on}），须续期后才可再报送"


BLOCK_REASON_UNREGISTERED = "应变片未登记校准到期日，请先登记校准信息"
